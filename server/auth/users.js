/**
 * User database operations
 */

// Database pool - set by init function
let pool = null;

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
async function findOrCreateUser({ googleId, email, name, picture }) {
  // Atomic upsert: insert or update in a single query to prevent race conditions
  const result = await ensurePool().query(
    `INSERT INTO users (google_id, email, name, picture, token_version)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (google_id) DO UPDATE
     SET email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture
     RETURNING *, (xmax = 0) AS is_new`,
    [googleId, email, name, picture]
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

module.exports = {
  init,
  findOrCreateUser,
  findById,
  incrementTokenVersion,
  getTokenVersion,
  updateName,
  updateLastLogin,
  setWelcomeDocId,
  markOnboarded,
};
