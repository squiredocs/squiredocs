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

/**
 * Find or create a user from Google OAuth profile
 * @param {object} profile - User profile from Google
 * @param {string} profile.googleId - Google's unique user ID
 * @param {string} profile.email - User's email
 * @param {string} profile.name - User's display name
 * @param {string} profile.picture - Profile picture URL
 * @param {object} [context] - optional capture context (feature 034)
 * @param {string} [context.signupSource] - 'browser' | 'agent_oauth'
 * @param {string|null} [context.ip] - client IP from authContext(req)
 * @param {string|null} [context.userAgent] - user-agent from authContext(req)
 * @returns {Promise<object>} User record from database
 */
async function findOrCreateUser(
  { googleId, email, name, picture },
  { signupSource = 'browser', ip = null, userAgent = null } = {}
) {
  // Feature 029 (FR-012, RBD-10): stamp provenance ONCE at creation. Written
  // only in the INSERT column list — deliberately NOT in the ON CONFLICT DO
  // UPDATE SET clause, so a returning user's provenance is never overwritten by
  // a later login. Guard the value to the CHECK-constrained domain.
  const source = signupSource === 'agent_oauth' ? 'agent_oauth' : 'browser';

  // Atomic upsert: insert or update in a single query to prevent race conditions.
  //
  // Feature 034 (FR-001): signup_ip / signup_user_agent ride the SAME
  // write-once mechanism as signup_source — present in the INSERT column list,
  // absent from ON CONFLICT DO UPDATE SET — so a returning user's signup
  // capture is never overwritten by a later login through this same path.
  // Values arrive already validated and truncated by auth-context.js; a null
  // pair (context omitted) simply stores NULL. This helper appends NO
  // auth_events row — the single row per authentication is written by
  // updateLastLogin (RBD-7).
  const result = await ensurePool().query(
    `INSERT INTO users (google_id, email, name, picture, token_version, signup_source, signup_ip, signup_user_agent)
     VALUES ($1, $2, $3, $4, 0, $5, $6, $7)
     ON CONFLICT (google_id) DO UPDATE
     SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture
     RETURNING *, (xmax = 0) AS is_new`,
    [googleId, email, name, picture, source, ip, userAgent]
  );

  const user = result.rows[0];
  user.isNew = user.is_new;
  delete user.is_new;

  // Convert any pending share invites addressed to this user's email into real
  // shares. Runs on every login (not just signup), so invites created after a
  // user already exists are also picked up the next time they log in.
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

module.exports = {
  init,
  SYNTHETIC,
  isSyntheticEmail,
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
