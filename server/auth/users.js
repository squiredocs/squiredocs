/**
 * User database operations
 */

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
 * @returns {Promise<object>} User record from database
 */
async function findOrCreateUser({ googleId, email, name, picture }, { signupSource = 'browser' } = {}) {
  // Feature 029 (FR-012, RBD-10): stamp provenance ONCE at creation. Written
  // only in the INSERT column list — deliberately NOT in the ON CONFLICT DO
  // UPDATE SET clause, so a returning user's provenance is never overwritten by
  // a later login. Guard the value to the CHECK-constrained domain.
  const source = signupSource === 'agent_oauth' ? 'agent_oauth' : 'browser';

  // Atomic upsert: insert or update in a single query to prevent race conditions
  const result = await ensurePool().query(
    `INSERT INTO users (google_id, email, name, picture, token_version, signup_source)
     VALUES ($1, $2, $3, $4, 0, $5)
     ON CONFLICT (google_id) DO UPDATE
     SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture
     RETURNING *, (xmax = 0) AS is_new`,
    [googleId, email, name, picture, source]
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
 * @param {object} user - User record (must have id and email)
 */
async function convertPendingInvites(user) {
  if (!user?.email) return;

  const client = await ensurePool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO document_shares (doc_id, user_id, role)
       SELECT i.doc_id, $1, i.role
       FROM document_share_invites i
       WHERE lower(i.email) = lower($2)
       ON CONFLICT (doc_id, user_id) DO NOTHING`,
      [user.id, user.email]
    );
    await client.query(
      'DELETE FROM document_share_invites WHERE lower(email) = lower($1)',
      [user.email]
    );
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
 * Update last_login_at timestamp for a user
 * @param {string} userId - User's UUID
 */
async function updateLastLogin(userId) {
  await ensurePool().query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
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
