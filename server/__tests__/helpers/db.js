/**
 * Shared test database configuration
 *
 * Provides a single source of truth for database connections in tests.
 * All tests should import from this module instead of creating their own pools.
 *
 * ── PER-WORKER ISOLATION (feature 052) ──────────────────────────────────────
 * Every Jest worker runs against its own database, copied from a per-run
 * template. A URL is never used verbatim: the URL the run starts from is a
 * BASE, and this module derives `<base>_w<JEST_WORKER_ID>` from it. Under
 * `--runInBand` there is no JEST_WORKER_ID, so the run is worker 1.
 */

const { Pool } = require('pg');
const { PostgresPersistence } = require('../../postgres-persistence');

/**
 * The BASE database name — the name the run derives FROM, not the name tests
 * connect to. A suite that connects to this database directly is on the wrong
 * database: it is deliberately left empty, and under parallel execution it is
 * not even migrated. Use `getTestDatabaseUrl()` / `getDbConfig()` instead.
 */
const TEST_DB_NAME = 'collab_test_db';

/**
 * Legal base database names. Derived names are always double-quoted into DDL
 * (so a hyphenated worktree base like `collab_test_db_agent-1` works), but a
 * positive charset check still runs first so a misconfigured DATABASE_URL fails
 * with an actionable message rather than a baffling syntax error (research R6).
 */
const BASE_DB_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_$-]*$/;

/**
 * Longest base name whose every derivative still fits Postgres's 63-byte
 * identifier limit: `_template` is the longest suffix (9 chars), 63 - 9 = 54.
 * Beyond the limit Postgres TRUNCATES with only a NOTICE, so over-long bases
 * would collapse `<base>_w1..wN` into one colliding 63-byte prefix and
 * silently defeat worker isolation (review 052 LOW-1).
 */
const MAX_BASE_DB_NAME_LENGTH = 54;

/** Throw a message naming the offending value and the accepted charset. */
function assertValidBaseDbName(name) {
  if (typeof name !== 'string' || !BASE_DB_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid test database base name: ${JSON.stringify(name)}. ` +
      `Base names must match the charset ${BASE_DB_NAME_PATTERN.source} ` +
      '(letter, digit or underscore first; then letters, digits, underscore, $ or -). ' +
      'Fix the database segment of DATABASE_URL.'
    );
  }
  // 63 = Postgres identifier max. Derived names (base + _template / _wN) are
  // re-checked here via quoteDatabaseIdentifier, so this catches any name that
  // would silently truncate; the tighter base-specific bound lives in
  // getBaseDatabaseName.
  if (name.length > 63) {
    throw new Error(
      `Test database name ${JSON.stringify(name)} is ${name.length} chars; ` +
      'Postgres truncates identifiers to 63 bytes with only a NOTICE, which ' +
      'would collapse per-worker databases into colliding names.'
    );
  }
  return name;
}

/**
 * Double-quote an identifier for safe interpolation into DDL (INV-11).
 * Derived names are built from an already-validated base plus a `_wN` /
 * `_template` suffix, so they satisfy the same charset; re-checking here means
 * nothing reaches DDL unvalidated regardless of the call path.
 */
function quoteDatabaseIdentifier(name) {
  return `"${assertValidBaseDbName(name)}"`;
}

/**
 * The BASE URL this run derives from.
 *
 * Order: the frozen base published by globalSetup, then an externally supplied
 * DATABASE_URL (CI, pipeline worktrees), then the built-in local default. The
 * frozen base comes first so derivation is idempotent: setup.js pins
 * DATABASE_URL to the worker's URL, and without the frozen base the next call
 * would derive `..._w3_w3` from it (INV-5, research R3).
 */
function getBaseDatabaseUrl() {
  if (process.env.TEST_BASE_DATABASE_URL) return process.env.TEST_BASE_DATABASE_URL;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || 5432;
  const user = process.env.DB_USER || process.env.USER || 'postgres';
  const password = process.env.DB_PASSWORD || '';
  const auth = password ? `${user}:${password}` : user;
  return `postgresql://${auth}@${host}:${port}/${TEST_DB_NAME}`;
}

/** The database name in a base URL, validated. */
function getBaseDatabaseName(baseUrl = getBaseDatabaseUrl()) {
  const name = decodeURIComponent(new URL(baseUrl).pathname.replace(/^\//, ''));
  assertValidBaseDbName(name);
  if (name.length > MAX_BASE_DB_NAME_LENGTH) {
    throw new Error(
      `Test database base name ${JSON.stringify(name)} is ${name.length} chars; ` +
      `the maximum is ${MAX_BASE_DB_NAME_LENGTH} so every derivative ` +
      '(_template, _wN) fits Postgres\'s 63-byte identifier limit without ' +
      'silent truncation. Shorten the database segment of DATABASE_URL.'
    );
  }
  return name;
}

/** This process's Jest worker id. Unset (i.e. --runInBand) means worker 1. */
function getWorkerId() {
  return Number(process.env.JEST_WORKER_ID || 1);
}

/** `<base>_w<N>` — the database exactly one worker owns. */
function getWorkerDatabaseName(baseName, workerId) {
  return `${assertValidBaseDbName(baseName)}_w${Number(workerId)}`;
}

/**
 * `<base>_template` — derived per base, not a global literal, so two concurrent
 * worktree runs with different bases never race on one template (RBD-052-1).
 */
function getTemplateDatabaseName(baseName) {
  return `${assertValidBaseDbName(baseName)}_template`;
}

/**
 * Splice a database name into a base URL, replacing ONLY the pathname so
 * credentials, host, port and query string survive byte-for-byte (INV-4).
 */
function deriveDatabaseUrl(baseUrl, dbName) {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

/**
 * Build a DATABASE_URL for THIS worker's test database.
 * Same host/port/credentials as the base; the database name is the base's plus
 * this worker's suffix (FR-002).
 */
function getTestDatabaseUrl() {
  const baseUrl = getBaseDatabaseUrl();
  const workerDbName = getWorkerDatabaseName(getBaseDatabaseName(baseUrl), getWorkerId());
  return deriveDatabaseUrl(baseUrl, workerDbName);
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
 * ── SUITE CLEANUP CONVENTION (feature 043 US8; rationale updated by 052) ────
 *
 * EVERY suite that causes `yjs_updates` rows to exist — by raw INSERT, by
 * `storeUpdate`, or INDIRECTLY through a WebSocket connection, a restore or an
 * undo — MUST delete them by `doc_guid` in `finally` / `afterAll`, using this
 * helper.
 *
 * WHY, STILL (rewritten for feature 052). Within one worker, suites run
 * sequentially against one database, and `cleanupTestUser` above does NOT touch
 * `yjs_updates` or `search_index` — it only clears ai_extra_credits,
 * agent_activity_log, agent_delegations, document_shares, documents and users.
 * So update-log rows written by a suite outlive it, with no matching
 * `search_index` row, and the search indexer's global `reindexStale` scan in a
 * LATER SUITE ON THE SAME WORKER finds those orphans and works on them. A suite
 * still gets to poison its own worker's later suites, and that is the failure
 * this convention exists to prevent.
 *
 * WHAT NO LONGER APPLIES. The convention used to be the whole defense against a
 * shared, serial database (the old Constitution II), where every suite in the
 * run shared one database and orphans crossed freely between them and between
 * runs. Neither is true now: each worker owns its own database, so orphans can
 * never reach a suite on a different worker, and each worker's database is
 * created fresh from the template at run start, so nothing accumulates across
 * runs at all. Do not cite either as the live threat — the live threat is
 * within-worker suite ordering, and it is enough on its own.
 *
 * WHY NOT a per-suite search_index heal. Inserting matching `search_index` rows
 * would make the orphan well-formed instead of removing it — it papers over the
 * shape rather than deleting it. Deleting what you created is cheaper and
 * complete (feature 043 ledger D3).
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
  BASE_DB_NAME_PATTERN,
  getBaseDatabaseUrl,
  getBaseDatabaseName,
  getWorkerId,
  getWorkerDatabaseName,
  getTemplateDatabaseName,
  deriveDatabaseUrl,
  quoteDatabaseIdentifier,
  getTestDatabaseUrl,
  getDbConfig,
  createPool,
  createPersistence,
  createTestUser,
  cleanupTestUser,
  cleanupDocRows,
};
