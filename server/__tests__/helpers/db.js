/**
 * Shared test database configuration
 *
 * Provides a single source of truth for database connections in tests.
 * All tests should import from this module instead of creating their own pools.
 */

const { Pool } = require('pg');
const { PostgresPersistence } = require('../../postgres-persistence');

const TEST_DB_NAME = 'collab_test_db';

/**
 * Build a DATABASE_URL for the test database.
 * Uses the same host/port/credentials as the app, but always targets collab_test_db.
 * Respects DATABASE_URL if already set (e.g., in CI).
 */
function getTestDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || 5432;
  const user = process.env.DB_USER || process.env.USER || 'postgres';
  const password = process.env.DB_PASSWORD || '';
  const auth = password ? `${user}:${password}` : user;
  return `postgresql://${auth}@${host}:${port}/${TEST_DB_NAME}`;
}

/**
 * Get database config at call time (not module load time)
 * This ensures DATABASE_URL is checked when the function is called,
 * not when the module is first imported.
 */
function getDbConfig() {
  return { connectionString: getTestDatabaseUrl() };
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
  return new PostgresPersistence(getDbConfig());
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
  await pool.query('DELETE FROM ai_extra_credits WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM agent_activity_log WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM document_shares WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM documents WHERE creator_id = $1', [userId]); // Note: documents uses creator_id
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
}

/**
 * ── SUITE CLEANUP CONVENTION (feature 043, US8/FR-010, ledger D3) ───────────
 *
 * EVERY suite that causes `yjs_updates` rows to exist — by raw INSERT, by
 * `storeUpdate`, or INDIRECTLY through a WebSocket connection, a restore or an
 * undo — MUST delete them by `doc_guid` in `finally` / `afterAll`, using this
 * helper.
 *
 * WHY. The backend test database is shared and serial (Constitution II), and
 * `cleanupTestUser` above does NOT touch `yjs_updates` or `search_index` — it
 * only clears ai_extra_credits, agent_activity_log, agent_delegations,
 * document_shares, documents and users. So update-log rows written by a suite
 * outlive it, with no matching `search_index` row. The search indexer's global
 * `reindexStale` scan later finds those orphans and works on them, which is the
 * known CI flake where suites go red on CI while passing locally (auto-memory
 * `ci-reindexstale-shared-db-flakiness`). Orphans from one suite surface as a
 * failure in an unrelated one, which is the worst possible failure to debug.
 *
 * WHY NOT a per-suite search_index heal. Inserting matching `search_index` rows
 * would make the orphan well-formed instead of removing it — it papers over the
 * shape rather than deleting it, and leaves the rows to accumulate anyway. The
 * real fix is per-run database isolation, which is tracked separately; until
 * then, deleting what you created is both cheaper and complete (D3).
 *
 * IN `finally`/`afterAll`, NOT INLINE: a suite whose server crashes or whose
 * client disconnects mid-test must still clean up, and inline cleanup is
 * skipped exactly when the test failed — which is when the orphans matter most.
 *
 * @param {import('pg').Pool} pool
 * @param {string|string[]} docGuid - one guid, or every guid the suite created
 */
async function cleanupDocRows(pool, docGuid) {
  const guids = (Array.isArray(docGuid) ? docGuid : [docGuid]).filter(Boolean);
  if (guids.length === 0) return;
  // Only `yjs_updates` needs deleting by hand. `document_search_index` and
  // `document_embeddings` are both `REFERENCES documents(id) ON DELETE CASCADE`,
  // so they vanish with the document row that `cleanupTestUser` removes — which
  // is precisely why the ORPHAN is an update-log row with no index row, and not
  // the other way round.
  await pool.query('DELETE FROM yjs_updates WHERE doc_guid = ANY($1::uuid[])', [guids]);
}

module.exports = {
  TEST_DB_NAME,
  getTestDatabaseUrl,
  getDbConfig,
  createPool,
  createPersistence,
  createTestUser,
  cleanupTestUser,
  cleanupDocRows,
};
