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
 * Find or create a user from Google OAuth profile
 * @param {object} profile - User profile from Google
 * @param {string} profile.googleId - Google's unique user ID
 * @param {string} profile.email - User's email
 * @param {string} profile.name - User's display name
 * @param {string} profile.picture - Profile picture URL
 * @returns {Promise<object>} User record from database
 */
async function findOrCreateUser({ googleId, email, name, picture }) {
  if (!pool) {
    throw new Error('Users module not initialized. Call init(pool) first.');
  }

  // Atomic upsert: insert or update in a single query to prevent race conditions
  const result = await pool.query(
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
  return user;
}

/**
 * Find user by ID
 * @param {string} userId - User's UUID
 * @returns {Promise<object|null>} User record or null
 */
async function findById(userId) {
  if (!pool) {
    throw new Error('Users module not initialized. Call init(pool) first.');
  }

  const result = await pool.query(
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
  if (!pool) {
    throw new Error('Users module not initialized. Call init(pool) first.');
  }

  const result = await pool.query(
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
  if (!pool) {
    throw new Error('Users module not initialized. Call init(pool) first.');
  }

  const result = await pool.query(
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
  if (!pool) {
    throw new Error('Users module not initialized. Call init(pool) first.');
  }

  const result = await pool.query(
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
  if (!pool) {
    throw new Error('Users module not initialized. Call init(pool) first.');
  }
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

module.exports = {
  init,
  findOrCreateUser,
  findById,
  incrementTokenVersion,
  getTokenVersion,
  updateName,
  updateLastLogin,
};




