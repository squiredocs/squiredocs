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

  // Try to find existing user by Google ID
  const existingResult = await pool.query(
    'SELECT * FROM users WHERE google_id = $1',
    [googleId]
  );

  if (existingResult.rows.length > 0) {
    // Update user profile in case it changed
    const updateResult = await pool.query(
      `UPDATE users 
       SET email = $1, name = $2, picture = $3
       WHERE google_id = $4
       RETURNING *`,
      [email, name, picture, googleId]
    );
    const existingUser = updateResult.rows[0];
    existingUser.isNew = false;
    return existingUser;
  }

  // Create new user
  const insertResult = await pool.query(
    `INSERT INTO users (google_id, email, name, picture, token_version)
     VALUES ($1, $2, $3, $4, 0)
     RETURNING *`,
    [googleId, email, name, picture]
  );

  const newUser = insertResult.rows[0];
  newUser.isNew = true;
  return newUser;
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

module.exports = {
  init,
  findOrCreateUser,
  findById,
  incrementTokenVersion,
  getTokenVersion,
};




