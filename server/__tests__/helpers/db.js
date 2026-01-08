/**
 * Shared test database configuration
 *
 * Provides a single source of truth for database connections in tests.
 * All tests should import from this module instead of creating their own pools.
 */

const { Pool } = require('pg');
const { PostgresPersistence } = require('../../postgres-persistence');

/**
 * Get database config at call time (not module load time)
 * This ensures DATABASE_URL is checked when the function is called,
 * not when the module is first imported.
 */
function getDbConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }
  return {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'collab_db',
    user: process.env.DB_USER || process.env.USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  };
}

/**
 * Create a new database pool
 * Tests can share a single pool or create their own if needed
 */
function createPool() {
  return new Pool(getDbConfig());
}

/**
 * Create a new PostgresPersistence instance
 */
function createPersistence() {
  const config = getDbConfig();
  return new PostgresPersistence(config);
}

/**
 * Helper to create a test user
 * @param {Pool} pool - Database pool
 * @param {string} email - User email (should be unique per test)
 * @returns {Promise<string>} User ID (UUID)
 */
async function createTestUser(pool, email) {
  const result = await pool.query(
    `INSERT INTO users (id, google_id, email, name)
     VALUES (uuid_generate_v4(), 'test-google-id-' || random(), $1, 'Test User')
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [email]
  );
  return result.rows[0].id;
}

/**
 * Helper to clean up test user and related data
 * @param {Pool} pool - Database pool
 * @param {string} userId - User ID to clean up
 */
async function cleanupTestUser(pool, userId) {
  // Clean up in order of dependencies
  await pool.query('DELETE FROM agent_activity_log WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM document_shares WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM documents WHERE creator_id = $1', [userId]); // Note: documents uses creator_id
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
}

module.exports = {
  getDbConfig,
  createPool,
  createPersistence,
  createTestUser,
  cleanupTestUser,
};
