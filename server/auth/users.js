/**
 * User database operations
 */

const authEvents = require('./auth-events');
const spaces = require('../spaces');

// Database pool - set by init function
let pool = null;

/**
 * Feature 029: the single synthetic-namespace boundary (I1 — exactly ONE code
 * location; the wipe and the consent auto-approve both import this, never
 * re-derive it). Bounded form per RBD-1/RBD-2 and the endpoint contracts:
 *   local part `test+<nonce>`, nonce = 1..32 chars of [a-z0-9-], host test.local.
 * Anchored, so it is the WHOLE address. This is the security perimeter keeping a
 * mass-delete + session-forgery primitive off real accounts.
 */
const SYNTHETIC = /^test\+[a-z0-9-]{1,32}@test\.local$/;

/**
 * @param {*} email - candidate address
 * @returns {boolean} true iff email is in the synthetic test namespace.
 */
function isSyntheticEmail(email) {
  return typeof email === 'string' && SYNTHETIC.test(email);
}

/**
 * Initialize the users module with a database pool
 * @param {Pool} dbPool - PostgreSQL connection pool
 */
function init(dbPool) {
  pool = dbPool;
  // Feature 034: the auth-event trail rides the same pool. Wiring it here means
  // every existing init path (app boot and every test calling users.init(pool))
  // initializes the trail with no new call site.
  authEvents.init(dbPool);
}

/**
 * Get the initialized pool or throw if not initialized
 */
function ensurePool() {
  if (!pool) throw new Error('Users module not initialized. Call init(pool) first.');
  return pool;
}

// Feature 059: issuers user identities are stored under. GOOGLE_ISSUER matches
// server/auth/google.js (which this module does not require: the CLI loads
// users.js and must stay free of the Google client).
const GOOGLE_ISSUER = 'https://accounts.google.com';
const DEV_ISSUER = 'dev';

const SIGNUP_SOURCES = ['browser', 'agent_oauth', 'signin_link'];

/** Guard a signup source to the CHECK-constrained domain (default browser). */
function safeSignupSource(signupSource) {
  return SIGNUP_SOURCES.includes(signupSource) ? signupSource : 'browser';
}

/**
 * Feature 059 (FR-004, RBD-059-3): an unknown identity whose email already
 * belongs to an account. Sign-in is refused and nothing is created; there is
 * no silent linking by email.
 */
class AccountExistsError extends Error {
  constructor(message = 'An account with this email already exists') {
    super(message);
    this.name = 'AccountExistsError';
    this.code = 'account_exists';
  }
}

/**
 * Resolve the user for an identity (issuer, subject), creating both on a first
 * sign-in. Feature 059, research R1/R2, contracts/identity-and-post-auth.md.
 *
 * One transaction:
 *   1. a transaction-scoped advisory lock on the (issuer, subject) pair, so two
 *      concurrent first sign-ins for one identity serialize (FR-005, I5) and
 *      nothing else waits;
 *   2. lookup by (issuer, subject) ONLY, never by email (FR-004, I1). Found:
 *      refresh email, name, picture (the columns the old upsert refreshed,
 *      FR-007, I3) and the identity's last_used_at / email_verified;
 *   3. unknown pair whose email exists (case-insensitive, RBD-059-17): throw
 *      AccountExistsError, roll back, create nothing;
 *   4. otherwise INSERT the user (signup_source, signup_ip, signup_user_agent
 *      only here, so a returning sign-in never changes them, I2; google_id
 *      NULL, I4) and the identity.
 *
 * Writes no auth_events row and converts no invites (I6): both belong to the
 * shared post-sign-in path (server/auth/post-auth.js).
 *
 * @param {{ issuer: string, subject: string, email: string, name: string,
 *   picture?: string|null, emailVerified?: boolean }} identity
 * @param {{ signupSource?: string, ip?: string|null, userAgent?: string|null }} [ctx]
 * @returns {Promise<object>} the users row plus `isNew`
 */
async function resolveIdentityUser(
  { issuer, subject, email, name, picture = null, emailVerified = undefined },
  { signupSource = 'browser', ip = null, userAgent = null } = {}
) {
  const source = safeSignupSource(signupSource);
  const verified = typeof emailVerified === 'boolean' ? emailVerified : null;
  const client = await ensurePool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('identity:' || $1 || ':' || $2, 0))",
      [issuer, subject]
    );

    const found = await client.query(
      'SELECT id, user_id FROM user_identities WHERE issuer = $1 AND subject = $2',
      [issuer, subject]
    );

    let user;
    let isNew;
    if (found.rows.length > 0) {
      const identity = found.rows[0];
      const updated = await client.query(
        'UPDATE users SET email = $2, name = $3, picture = $4 WHERE id = $1 RETURNING *',
        [identity.user_id, email, name, picture]
      );
      await client.query(
        `UPDATE user_identities
            SET last_used_at = now(), email_verified = COALESCE($2, email_verified)
          WHERE id = $1`,
        [identity.id, verified]
      );
      user = updated.rows[0];
      isNew = false;
    } else {
      const collision = await client.query(
        'SELECT 1 FROM users WHERE lower(email) = lower($1) LIMIT 1',
        [email]
      );
      if (collision.rows.length > 0) throw new AccountExistsError();

      const inserted = await client.query(
        `INSERT INTO users (email, name, picture, token_version, signup_source, signup_ip, signup_user_agent)
         VALUES ($1, $2, $3, 0, $4, $5, $6)
         RETURNING *`,
        [email, name, picture, source, ip, userAgent]
      );
      user = inserted.rows[0];
      await client.query(
        `INSERT INTO user_identities (user_id, issuer, subject, email_verified, last_used_at)
         VALUES ($1, $2, $3, $4, now())`,
        [user.id, issuer, subject, verified]
      );
      isNew = true;
    }

    await client.query('COMMIT');
    user.isNew = isNew;
    return user;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('resolveIdentityUser rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Create the instance owner inside the claim transaction (feature 059,
 * FR-030). Only server/auth/signin-links.js calls it, with the client that
 * holds the users table lock. is_admin true, signup_source signin_link,
 * google_id NULL, the capture pair from the redeeming request.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ name: string, email: string, ctx?: { ip?: string|null, userAgent?: string|null } }} args
 * @returns {Promise<object>} the users row
 */
async function createOwnerUser(client, { name, email, ctx = {} }) {
  const { rows } = await client.query(
    `INSERT INTO users (email, name, picture, token_version, is_admin, signup_source, signup_ip, signup_user_agent)
     VALUES ($1, $2, NULL, 0, true, 'signin_link', $3, $4)
     RETURNING *`,
    [email, name, ctx.ip ?? null, ctx.userAgent ?? null]
  );
  return rows[0];
}

/**
 * Case-insensitive lookup by email (feature 059: `squire login-link`,
 * `squire token create`). Oldest row first when case variants exist.
 * @param {{ query: Function }} db
 * @param {string} email
 * @returns {Promise<object|null>}
 */
async function findUserByEmail(db, email) {
  const { rows } = await db.query(
    'SELECT * FROM users WHERE lower(email) = lower($1) ORDER BY created_at LIMIT 1',
    [email]
  );
  return rows[0] || null;
}

/**
 * @deprecated Test-fixture wrapper only (feature 059, RBD-059-18). No
 * production route calls it; identity-regression.test.js pins that with a
 * source check. Sign-in paths call resolveIdentityUser and then the shared
 * post-sign-in path (server/auth/post-auth.js).
 *
 * Keeps its pre-059 contract so the fixture suites that call it stay
 * unchanged: resolve a Google identity (googleId as the subject), then convert
 * pending invites. Writes no auth_events row (that is updateLastLogin's).
 * Rows inserted the old way (with google_id) are found through the identity
 * the compatibility trigger gave them (RBD-059-24).
 *
 * @param {{ googleId: string, email: string, name: string, picture?: string|null }} profile
 * @param {{ signupSource?: string, ip?: string|null, userAgent?: string|null }} [context]
 * @returns {Promise<object>} the users row plus `isNew`
 */
async function findOrCreateUser({ googleId, email, name, picture }, context = {}) {
  const user = await resolveIdentityUser(
    { issuer: GOOGLE_ISSUER, subject: googleId, email, name, picture: picture ?? null },
    context
  );
  await convertPendingInvites(user);
  return user;
}

/**
 * Promote pending document_share_invites matching a user's email into real
 * document_shares rows, then delete the consumed invites.
 *
 * Defensive by design: wrapped in a transaction and never throws — a failure
 * here must not break login. Worst case the invites stay pending and convert on
 * the next login. Uses ON CONFLICT DO NOTHING so an existing (possibly stronger)
 * role is never downgraded by a pending invite.
 *
 * SQL is inlined here (rather than calling documents.js) to avoid introducing a
 * circular require between the users and documents modules.
 *
 * SPACE INVITES CONVERT IN THE SAME TRANSACTION (feature 053, FR-018): a login
 * either converts everything or nothing, and a space-invite problem can never
 * cost a user their document invites or their login — one try, one rollback,
 * one swallow. `server/spaces.js` has no circular-require problem, so that half
 * is a call rather than more inlined SQL.
 *
 * `granted_by` needs the backfill's own fallback chain (RBD-053-13):
 * `document_share_invites.invited_by_user_id` is NULLABLE (ON DELETE SET NULL)
 * while `document_shares.granted_by` is NOT NULL, so an invite whose inviter
 * deleted their account would otherwise fail a login here. The final term is
 * the invitee themselves, which always exists.
 *
 * @param {object} user - User record (must have id and email)
 */
async function convertPendingInvites(user) {
  if (!user?.email) return;

  const client = await ensurePool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO document_shares (doc_id, user_id, role, granted_by)
       SELECT i.doc_id, $1, i.role,
              COALESCE(i.invited_by_user_id,
                       (SELECT o.user_id FROM document_shares o
                         WHERE o.doc_id = i.doc_id AND o.role = 'owner' LIMIT 1),
                       $1)
       FROM document_share_invites i
       WHERE lower(i.email) = lower($2)
       ON CONFLICT (doc_id, user_id) DO NOTHING`,
      [user.id, user.email]
    );
    await client.query(
      'DELETE FROM document_share_invites WHERE lower(email) = lower($1)',
      [user.email]
    );
    await spaces.convertPendingSpaceInvites(client, user);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Failed to roll back invite conversion:', rollbackErr.message);
    }
    console.error('Failed to convert pending invites for', user.email, '-', err.message);
  } finally {
    client.release();
  }
}

/**
 * Find user by ID
 * @param {string} userId - User's UUID
 * @returns {Promise<object|null>} User record or null
 */
async function findById(userId) {
  const result = await ensurePool().query(
    'SELECT * FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Increment user's token version (invalidates all refresh tokens)
 * @param {string} userId - User's UUID
 * @returns {Promise<object>} Updated user record
 */
async function incrementTokenVersion(userId) {
  const result = await ensurePool().query(
    `UPDATE users
     SET token_version = token_version + 1
     WHERE id = $1
     RETURNING *`,
    [userId]
  );

  if (result.rows.length === 0) {
    throw new Error('User not found');
  }

  return result.rows[0];
}

/**
 * Get user's current token version
 * @param {string} userId - User's UUID
 * @returns {Promise<number>} Current token version
 */
async function getTokenVersion(userId) {
  const result = await ensurePool().query(
    'SELECT token_version FROM users WHERE id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    throw new Error('User not found');
  }

  return result.rows[0].token_version;
}

/**
 * Update a user's display name
 * @param {string} userId - User's UUID
 * @param {string} name - New display name
 * @returns {Promise<object>} Updated user record
 */
async function updateName(userId, name) {
  const result = await ensurePool().query(
    `UPDATE users SET name = $1 WHERE id = $2 RETURNING *`,
    [name, userId]
  );

  if (result.rows.length === 0) {
    throw new Error('User not found');
  }

  return result.rows[0];
}

/**
 * Update last_login_at (and, feature 034, the last-login capture pair) for a
 * user, then append the ONE auth_events row for this authentication.
 *
 * NOTE ON THE NAME (RBD-7): despite being called updateLastLogin, this is also
 * where the `signup` trail event is emitted — because this helper is called
 * exactly once per completed authentication on every auth path (browser OAuth,
 * agent OAuth, dev-login) and never by token refresh. Putting the append here
 * makes "exactly one event per completed auth" true by construction; if
 * findOrCreateUser appended its own row too, a signup would produce two rows and
 * the spec's "a signup and two logins ⇒ three entries" would be wrong. The
 * caller passes `isNew` (already computed by findOrCreateUser via xmax = 0) and
 * this picks event = isNew ? 'signup' : 'login'. Renaming the function is a
 * refactor deliberately out of this feature's scope.
 *
 * Capture is best-effort (FR-008): the trail write is delegated to
 * authEvents.record(), which never throws, so a trail failure can neither
 * prevent the users update nor fail the sign-in.
 *
 * @param {string} userId - User's UUID
 * @param {object} [context] - optional capture context (feature 034)
 * @param {string|null} [context.ip] - client IP from authContext(req)
 * @param {string|null} [context.userAgent] - user-agent from authContext(req)
 * @param {string} [context.signupSource] - auth channel of THIS event
 * @param {boolean} [context.isNew] - true when the account was just created
 */
async function updateLastLogin(
  userId,
  { ip = null, userAgent = null, signupSource = 'browser', isNew = false } = {}
) {
  // One statement — the capture pair folds into the existing UPDATE, so the
  // snapshot costs no extra round trip (FR-002).
  await ensurePool().query(
    `UPDATE users
     SET last_login_at = now(), last_login_ip = $2, last_login_user_agent = $3
     WHERE id = $1`,
    [userId, ip, userAgent]
  );

  // Exactly one immutable trail row per completed authentication (FR-003).
  // record() already swallows its own failures; the .catch() is belt-and-braces
  // so this await can never surface a rejection into the sign-in path even if a
  // future change to auth-events.js loses that guarantee (FR-008).
  await authEvents
    .record({
      userId,
      event: isNew ? 'signup' : 'login',
      signupSource,
      ip,
      userAgent,
    })
    .catch((err) => {
      console.error('[AuthEvents] record rejected unexpectedly:', err?.message || err);
      return false;
    });
}

/**
 * Set a user's welcome document id, but only if one isn't already set.
 * The conditional WHERE makes this safe against concurrent logins (two tabs
 * racing to seed) — only the first writer wins, the rest become no-ops.
 * @param {string} userId - User's UUID
 * @param {string} docId - Welcome document UUID
 * @returns {Promise<string|null>} The winning welcome_doc_id (this call's or the existing one)
 */
async function setWelcomeDocId(userId, docId) {
  const result = await ensurePool().query(
    `UPDATE users SET welcome_doc_id = $2
     WHERE id = $1 AND welcome_doc_id IS NULL
     RETURNING welcome_doc_id`,
    [userId, docId]
  );
  if (result.rows.length > 0) return result.rows[0].welcome_doc_id;
  // Someone else won the race (or it was already set) — return the existing value.
  const existing = await ensurePool().query('SELECT welcome_doc_id FROM users WHERE id = $1', [userId]);
  return existing.rows[0]?.welcome_doc_id || null;
}

/**
 * Mark a user as onboarded (engaged). Idempotent — only sets the timestamp once.
 * @param {string} userId - User's UUID
 */
async function markOnboarded(userId) {
  await ensurePool().query(
    'UPDATE users SET onboarded_at = now() WHERE id = $1 AND onboarded_at IS NULL',
    [userId]
  );
}

/**
 * Feature 029 (FR-008/FR-010/FR-011): hard-delete a user and EVERYTHING hanging
 * off the row so the identity's next sign-in is a genuine first run with zero
 * residue. Shared by the synthetic wipe (US1) and the prod single-account reset
 * (US5). Callers enforce their OWN target rule (synthetic namespace vs hardcoded
 * constant) BEFORE calling — this helper does not widen targets and does not
 * consult any pattern; it deletes exactly the one address it is given.
 *
 * Why a plain `DELETE FROM users` is not enough (verified against live schema
 * 2026-07-22, research.md R3): `documents.owner_id` was dropped (migration 006 —
 * ownership now lives in `document_shares role='owner'`), and `documents.creator_id`
 * is ON DELETE SET NULL, so a user delete ORPHANS their documents rather than
 * removing them. `yjs_updates` (the CRDT content, keyed by `doc_guid`) and
 * `document_versions` (keyed by `doc_id`) have no FK to `documents` at all, so
 * they survive even a `documents` delete. This helper therefore, in one
 * transaction: enumerates the user's owned/created doc ids, sweeps the
 * non-cascading doc-keyed content, deletes those `documents` (cascading
 * embeddings/images/search-index/shares/invites), then deletes the user
 * (cascading delegations/api-tokens/auth-codes/chats/usage/edits/activity).
 *
 * Spaces this account is the LAST owner of are deleted too (feature 053,
 * RBD-053-17) — their documents revert to personal, nobody is promoted. Spaces
 * with another owner just lose this account's membership by cascade.
 *
 * Registered OAuth *client* rows (`registered_agents`) are global/not user-scoped
 * and are intentionally NOT touched; the user's grants (`agent_delegations`,
 * `mcp_auth_codes`) cascade with the user row.
 *
 * Idempotent: an address with no user row is a no-op success.
 *
 * @param {string} email - the exact address to hard-delete.
 * @returns {Promise<{deleted: boolean, userId: string|null, docCount: number}>}
 */
async function deleteUserByEmail(email) {
  const client = await ensurePool().connect();
  try {
    await client.query('BEGIN');

    const userRes = await client.query(
      'SELECT id FROM users WHERE lower(email) = lower($1)',
      [email]
    );
    if (userRes.rows.length === 0) {
      await client.query('COMMIT');
      return { deleted: false, userId: null, docCount: 0 };
    }
    const userId = userRes.rows[0].id;

    // Owned (document_shares role='owner') UNION created (documents.creator_id).
    //
    // FEATURE 053 CONSTRAINT — this enumeration MUST stay DIRECT-share-scoped.
    // Do NOT reroute it through `document_access`. Since spaces exist, a space
    // owner has passthrough owner on every document in their space (D5), so the
    // view would report documents that merely LIVE NEAR this account as owned
    // by it — and wiping the account would delete other people's documents.
    // "Owned" means a direct owner share, here and everywhere else (I10).
    const docRes = await client.query(
      `SELECT id AS doc_id FROM documents WHERE creator_id = $1
       UNION
       SELECT doc_id FROM document_shares WHERE user_id = $1 AND role = 'owner'`,
      [userId]
    );
    const docIds = docRes.rows.map((r) => r.doc_id);

    if (docIds.length > 0) {
      // Non-cascading doc-keyed content (no FK to documents) — sweep explicitly.
      await client.query('DELETE FROM yjs_updates WHERE doc_guid = ANY($1::uuid[])', [docIds]);
      await client.query('DELETE FROM document_versions WHERE doc_id = ANY($1::uuid[])', [docIds]);
      await client.query('DELETE FROM agent_edits WHERE doc_guid = ANY($1::uuid[])', [docIds]);
      await client.query('DELETE FROM agent_activity_log WHERE doc_guid = ANY($1::uuid[])', [docIds]);
      // Deleting the documents cascades embeddings/images/search-index/shares/invites.
      await client.query('DELETE FROM documents WHERE id = ANY($1::uuid[])', [docIds]);
    }

    // Feature 053 (RBD-053-17, design/spaces.md § Edge Cases): spaces where
    // this account is the LAST owner are deleted with it. `space_members`
    // CASCADEs on the user row, so without this a sole-owner wipe left a space
    // with members and zero owners — every owner-only operation (rename,
    // delete, invite at owner, member management) refused forever, with no
    // path back. Documents in it revert to personal through
    // `documents.space_id ON DELETE SET NULL` and are NOT deleted; direct
    // shares on them survive.
    //
    // Deliberately NO promotion: under D5's uncapped passthrough, promoting a
    // surviving member would hand them owner over every document in the space,
    // a grant nobody made.
    //
    // Runs BEFORE the granted_by reassignment below so members of a doomed
    // space are not first reattributed and then deleted anyway.
    await client.query(
      `DELETE FROM spaces s
        WHERE EXISTS (
                SELECT 1 FROM space_members m
                 WHERE m.space_id = s.id AND m.user_id = $1 AND m.role = 'owner')
          AND NOT EXISTS (
                SELECT 1 FROM space_members o
                 WHERE o.space_id = s.id AND o.user_id <> $1 AND o.role = 'owner')`,
      [userId]
    );

    // Feature 053 (D8 / RBD-053-11): `granted_by` is NOT NULL with ON DELETE
    // NO ACTION on both document_shares and space_members, so the delete below
    // raises a foreign-key violation for any grant this account made on
    // something it does not own — reachable today, because REQUIRED_ROLES.share
    // is 'viewer' and any collaborator can share onward. Reassign those grants
    // to the current owner (the design's own backfill rule), falling back to
    // the grant's holder. This runs AFTER the account's own documents are
    // deleted (their shares went with them), so only cross-owner residue is
    // touched, and BEFORE the user row goes.
    //
    // This is not optional polish: without it the synthetic-namespace wipe
    // (server/auth/routes.js) and the prod single-account reset both fail.
    await client.query(
      `UPDATE document_shares s
          SET granted_by = COALESCE(
                (SELECT o.user_id FROM document_shares o
                  WHERE o.doc_id = s.doc_id AND o.role = 'owner' AND o.user_id <> $1 LIMIT 1),
                s.user_id)
        WHERE s.granted_by = $1`,
      [userId]
    );
    await client.query(
      `UPDATE space_members m
          SET granted_by = COALESCE(
                (SELECT o.user_id FROM space_members o
                  WHERE o.space_id = m.space_id AND o.role = 'owner' AND o.user_id <> $1 LIMIT 1),
                m.user_id)
        WHERE m.granted_by = $1`,
      [userId]
    );

    // Deleting the user cascades the user-keyed rows (delegations, api tokens,
    // auth codes, chats, ai usage/credits, support requests, remaining shares).
    await client.query('DELETE FROM users WHERE id = $1', [userId]);

    await client.query('COMMIT');
    return { deleted: true, userId, docCount: docIds.length };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('deleteUserByEmail rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Feature 029: hard-delete ALL synthetic-namespace users (harness cleanup
 * convenience, RBD-2 `all:true`). Deletes only rows matching the SYNTHETIC
 * boundary, one full cascade each. Returns the count deleted.
 * @returns {Promise<number>}
 */
async function deleteAllSyntheticUsers() {
  const res = await ensurePool().query(
    // Bound the SQL scan to the same shape the JS predicate enforces.
    `SELECT email FROM users WHERE email ~ '^test\\+[a-z0-9-]{1,32}@test\\.local$'`
  );
  let count = 0;
  for (const row of res.rows) {
    // Defense in depth: re-check each address against the JS predicate before
    // deleting, so the boundary is enforced by the single source of truth.
    if (!isSyntheticEmail(row.email)) continue;
    const { deleted } = await deleteUserByEmail(row.email);
    if (deleted) count += 1;
  }
  return count;
}

/**
 * True when the users table has at least one row (059 review M2: the dev
 * faucet refuses to create the first user of an unclaimed local instance).
 * @returns {Promise<boolean>}
 */
async function hasAnyUser() {
  const { rows } = await ensurePool().query('SELECT 1 FROM users LIMIT 1');
  return rows.length > 0;
}

module.exports = {
  hasAnyUser,
  init,
  getPool: ensurePool,
  SYNTHETIC,
  isSyntheticEmail,
  GOOGLE_ISSUER,
  DEV_ISSUER,
  AccountExistsError,
  resolveIdentityUser,
  createOwnerUser,
  findUserByEmail,
  convertPendingInvites,
  findOrCreateUser,
  findById,
  incrementTokenVersion,
  getTokenVersion,
  updateName,
  updateLastLogin,
  setWelcomeDocId,
  markOnboarded,
  deleteUserByEmail,
  deleteAllSyntheticUsers,
};
