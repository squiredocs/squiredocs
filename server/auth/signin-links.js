/**
 * Sign-in links (feature 059, design D5/D11, FR-026 to FR-037, FR-045,
 * research R6/R8, contracts/signin-links.md).
 *
 * A link is a single-use, 15-minute proof of control of the machine. It is
 * minted only inside the container: by the `squire` CLI (server/cli/) and by
 * the startup-log block below (D11). No HTTP route and no MCP tool mints one
 * (FR-033); a source check in signin-link.test.js pins that.
 *
 *   token   32 random bytes, base64url (43 characters, fragment-safe)
 *   stored  sha256(token) hex only; lookup is by hash equality
 *   URL     ${APP_URL}/claim#<token> — the token travels only in the fragment
 *           and in POST bodies, never a path, query, or Referer (FR-027)
 *
 * Kinds: `claim` (no user; creates the owner on an instance with zero users)
 * and `signin` (signs in one existing user). Logging names link ids only,
 * never a token or its hash; the startup block is the one deliberate
 * exception (it prints the URL).
 *
 * Requires no JWT module and has no load-time secret checks, so the CLI can
 * load it.
 */
const crypto = require('crypto');
const { getInstanceConfig } = require('../instance-config');
const { createOwnerUser } = require('./users');
const { recordOwner } = require('./instance-owner');

const LINK_TTL_MINUTES = 15;
const PRUNE_AFTER_HOURS = 24;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

class SigninLinkError extends Error {
  /**
   * @param {'link_invalid'|'instance_claimed'|'claim_invalid'} code
   * @param {{ field?: string }} [extra]
   */
  constructor(code, extra = {}) {
    super(code);
    this.name = 'SigninLinkError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** A string that could be a token (shape only; the hash decides validity). */
function isPlausibleToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

/**
 * Validate claim fields (FR-031). Trimmed name 1 to 255 characters; trimmed
 * email at most 255 characters and shaped like an address.
 * @returns {{ ok: true, name: string, email: string } | { ok: false, field: 'name'|'email' }}
 */
function validateClaimFields({ name, email }) {
  const n = typeof name === 'string' ? name.trim() : '';
  const e = typeof email === 'string' ? email.trim() : '';
  if (n.length < 1 || n.length > 255) return { ok: false, field: 'name' };
  if (e.length < 1 || e.length > 255 || !EMAIL_RE.test(e)) return { ok: false, field: 'email' };
  return { ok: true, name: n, email: e };
}

/** Delete rows used or expired more than 24 hours ago (RBD-059-12). */
async function pruneLinks(db) {
  await db.query(
    `DELETE FROM signin_links
      WHERE expires_at < now() - make_interval(hours => $1)
         OR used_at < now() - make_interval(hours => $1)`,
    [PRUNE_AFTER_HOURS]
  );
}

/**
 * Mint a link. Prunes old rows first.
 * @param {{ query: Function }} db
 * @param {{ kind: 'claim'|'signin', userId?: string|null, prefillName?: string|null,
 *   prefillEmail?: string|null, source: 'cli'|'startup' }} args
 * @returns {Promise<{ token: string, id: string, expiresAt: Date }>}
 */
async function mintLink(db, { kind, userId = null, prefillName = null, prefillEmail = null, source }) {
  await pruneLinks(db);
  const token = crypto.randomBytes(32).toString('base64url');
  const { rows } = await db.query(
    `INSERT INTO signin_links (token_hash, kind, user_id, prefill_name, prefill_email, source, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))
     RETURNING id, expires_at`,
    [
      hashToken(token),
      kind,
      kind === 'signin' ? userId : null,
      kind === 'claim' ? prefillName || null : null,
      kind === 'claim' ? prefillEmail || null : null,
      source,
      LINK_TTL_MINUTES,
    ]
  );
  return { token, id: rows[0].id, expiresAt: rows[0].expires_at };
}

/** `${APP_URL}/claim#<token>` (APP_URL from 058's instance configuration). */
function buildLinkUrl(token) {
  return `${getInstanceConfig().appUrl}/claim#${token}`;
}

/**
 * Read-only inspection for the claim page (RBD-059-5). Never writes.
 * Invalid (unknown, used or voided, expired, or a claim link on an instance
 * that now has users) returns only `{ valid: false }` (FR-047).
 * @returns {Promise<{ valid: false } | { valid: true, kind: string, expiresAt: string,
 *   prefill: { name: string|null, email: string|null } }>}
 */
async function peekLink(db, token) {
  if (!isPlausibleToken(token)) return { valid: false };
  const { rows } = await db.query(
    `SELECT l.kind, l.expires_at, l.prefill_name, l.prefill_email,
            u.name AS user_name, u.email AS user_email,
            (SELECT EXISTS (SELECT 1 FROM users)) AS has_users
       FROM signin_links l
       LEFT JOIN users u ON u.id = l.user_id
      WHERE l.token_hash = $1 AND l.used_at IS NULL AND l.expires_at > now()`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row) return { valid: false };
  if (row.kind === 'claim' && row.has_users) return { valid: false };
  if (row.kind === 'signin' && !row.user_email) return { valid: false };
  const prefill = row.kind === 'claim'
    ? { name: row.prefill_name, email: row.prefill_email }
    : { name: row.user_name, email: row.user_email };
  return { valid: true, kind: row.kind, expiresAt: new Date(row.expires_at).toISOString(), prefill };
}

/**
 * Redeem a link (FR-029, FR-030, FR-045). One transaction.
 *
 *   0. (before the transaction) a claim link on an unclaimed instance needs a
 *      valid name and email; a failure throws claim_invalid and does NOT spend
 *      the link (FR-031). The check is repeated inside the transaction.
 *   1. conditional UPDATE marks the row used in the statement that reads it;
 *      zero rows means unknown, used, voided, or expired: link_invalid.
 *   2. signin: load the target user (gone: link_invalid).
 *   3. claim: LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE, then require zero
 *      users (else instance_claimed), create the owner, record it, and void
 *      every other unused claim link. The lock blocks concurrent user inserts
 *      (a Google sign-up in team mode, a second claim) for the duration, so
 *      owner creation is impossible once any user exists, by construction.
 *
 * @param {import('pg').Pool} pool
 * @param {string} token
 * @param {{ name?: string, email?: string, ctx?: { ip: string|null, userAgent: string|null } }} [args]
 * @returns {Promise<{ user: object, isNew: boolean, linkId: string }>} user carries isNew
 */
async function redeemLink(pool, token, { name, email, ctx = { ip: null, userAgent: null } } = {}) {
  if (!isPlausibleToken(token)) throw new SigninLinkError('link_invalid');
  const tokenHash = hashToken(token);

  // Pre-validation (no writes): does this look like a live claim on an
  // unclaimed instance? Then the fields must be valid before anything is spent.
  const pre = await pool.query(
    `SELECT kind, (SELECT EXISTS (SELECT 1 FROM users)) AS has_users
       FROM signin_links WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  let fields = null;
  if (pre.rows[0]?.kind === 'claim' && !pre.rows[0].has_users) {
    const v = validateClaimFields({ name, email });
    if (!v.ok) throw new SigninLinkError('claim_invalid', { field: v.field });
    fields = v;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A claim takes the users table lock BEFORE it marks its own row used.
    // The lock mode conflicts with itself, so two claims serialize here; the
    // first voids the second's row and commits, and the second's conditional
    // UPDATE then finds nothing (link_invalid). Taking the lock after the
    // UPDATE would deadlock the two (each holding the row the other voids).
    const kindRow = await client.query('SELECT kind FROM signin_links WHERE token_hash = $1', [tokenHash]);
    if (kindRow.rows[0]?.kind === 'claim') {
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    }
    const used = await client.query(
      `UPDATE signin_links SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING id, kind, user_id`,
      [tokenHash]
    );
    const link = used.rows[0];
    if (!link) throw new SigninLinkError('link_invalid');

    let user;
    if (link.kind === 'signin') {
      const r = await client.query('SELECT * FROM users WHERE id = $1', [link.user_id]);
      if (!r.rows[0]) throw new SigninLinkError('link_invalid');
      user = r.rows[0];
      user.isNew = false;
    } else {
      // users is locked (above): no user can be inserted until COMMIT.
      const any = await client.query('SELECT 1 FROM users LIMIT 1');
      if (any.rows.length > 0) throw new SigninLinkError('instance_claimed');
      if (!fields) {
        // The instance was claimed when we pre-checked and is empty now (the
        // owner was deleted in between): validate here instead.
        const v = validateClaimFields({ name, email });
        if (!v.ok) throw new SigninLinkError('claim_invalid', { field: v.field });
        fields = v;
      }
      user = await createOwnerUser(client, { name: fields.name, email: fields.email, ctx });
      user.isNew = true;
      await recordOwner(client, user.id);
      await client.query(
        "UPDATE signin_links SET used_at = now() WHERE kind = 'claim' AND used_at IS NULL AND id <> $1",
        [link.id]
      );
    }

    await client.query('COMMIT');
    console.log(`[SigninLink] redeemed link ${link.id} (${link.kind})`);
    return { user, isNew: user.isNew, linkId: link.id };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[SigninLink] rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

const BANNER_TOP = '==================== Squire Docs: claim this instance ====================';
const BANNER_BOTTOM = '==========================================================================';

/**
 * D11 / FR-036: on a local instance with zero users, mint one claim link
 * (source startup, no prefill) and print it in a marked block. Anything else
 * (team mode, a user exists) prints nothing. Errors are logged and swallowed:
 * the boot never fails because of the link.
 *
 * @param {{ pool: { query: Function }, mode: string, log?: { log: Function, error: Function } }} args
 * @returns {Promise<boolean>} true when a link was printed
 */
async function maybeLogStartupClaimLink({ pool, mode, log = console }) {
  try {
    if (mode !== 'local') return false;
    const { rows } = await pool.query('SELECT 1 FROM users LIMIT 1');
    if (rows.length > 0) return false;
    const { token } = await mintLink(pool, { kind: 'claim', source: 'startup' });
    log.log(
      [
        BANNER_TOP,
        'Open this link within 15 minutes to create the owner account:',
        buildLinkUrl(token),
        'Expired? Run: docker compose exec app squire claim-link',
        BANNER_BOTTOM,
      ].join('\n')
    );
    return true;
  } catch (err) {
    log.error('[SigninLink] could not mint the startup claim link:', err?.message || err);
    return false;
  }
}

module.exports = {
  LINK_TTL_MINUTES,
  EMAIL_RE,
  SigninLinkError,
  hashToken,
  isPlausibleToken,
  validateClaimFields,
  pruneLinks,
  mintLink,
  buildLinkUrl,
  peekLink,
  redeemLink,
  maybeLogStartupClaimLink,
};
