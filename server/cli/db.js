/**
 * Database access for the `squire` CLI (feature 059, FR-038, FR-044).
 *
 * The pool uses the same configuration as the server: DATABASE_URL, which
 * script/setup-db-env.js builds from DB_HOST/DB_PORT/DB_NAME/DB_USER/
 * DB_PASSWORD when it is not set (bin/squire.js runs it first).
 */
const { Pool } = require('pg');
const { msg } = require('./messages');

const CONNECT_TIMEOUT_MS = 2000;

/** Where the CLI is trying to connect, for the error message. */
function describeTarget(env = process.env) {
  let host = env.DB_HOST || 'localhost';
  let port = env.DB_PORT || '5432';
  let name = env.DB_NAME || 'collab_db';
  if (env.DATABASE_URL) {
    try {
      const u = new URL(env.DATABASE_URL);
      host = u.hostname || host;
      port = u.port || '5432';
      name = decodeURIComponent(u.pathname.replace(/^\//, '')) || name;
    } catch { /* keep the DB_* values */ }
  }
  return { host, port, name };
}

/** @returns {import('pg').Pool} */
function createCliPool(env = process.env) {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
}

/** The FR-044 database message for this environment. */
function dbUnreachableMessage(env = process.env) {
  return msg('dbUnreachable', describeTarget(env));
}

/**
 * `SELECT 1` with a hard 2 s bound.
 * @returns {Promise<boolean>}
 */
async function canConnect(pool, timeoutMs = CONNECT_TIMEOUT_MS) {
  let timer;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { CONNECT_TIMEOUT_MS, describeTarget, createCliPool, dbUnreachableMessage, canConnect };
