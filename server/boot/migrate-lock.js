/**
 * Migrations on boot under a Postgres advisory lock (feature 058, research R5).
 *
 * Two replicas starting together each call runMigrationsWithLock; the second
 * waits on the lock while the first runs script/migrate.js, then runs it too
 * and finds nothing to do. The lock wraps the whole script, including its
 * pgmigrations dedupe pre-step.
 *
 * `pg` is required lazily inside the function, so a boot with
 * MIGRATE_ON_BOOT=false never loads it before OpenTelemetry's hooks matter
 * (RBD-058-32).
 */
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * The boot migration lock key. It must differ from node-pg-migrate's own
 * advisory lock key (7241865325823964): node-pg-migrate takes that lock on a
 * separate connection in the child process, and reusing it here would make
 * the child wait forever on its own parent (RBD-058-24). The value is the
 * first 8 bytes of sha256("squire-docs:boot-migrate") read as a signed int64.
 */
const MIGRATE_LOCK_KEY = '3728990676630059578';
const NODE_PG_MIGRATE_LOCK_KEY = '7241865325823964';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** pg connection config from DATABASE_URL or DB_* (same defaults as server/index.js). Never mutates env. */
function connectionConfig(env) {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL };
  return {
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME || 'collab_db',
    user: env.DB_USER || env.USER || 'postgres',
    password: env.DB_PASSWORD || '',
  };
}

function describeTarget(env) {
  if (env.DATABASE_URL) {
    try {
      const u = new URL(env.DATABASE_URL);
      return `${u.hostname}:${u.port || 5432}`;
    } catch {
      return 'DATABASE_URL';
    }
  }
  return `${env.DB_HOST || 'localhost'}:${env.DB_PORT || 5432}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connect with exponential backoff (500 ms doubling, capped at 5 s) within `budgetMs`. */
async function connectWithRetry(env, budgetMs, log) {
  const { Client } = require('pg');
  const deadline = Date.now() + budgetMs;
  let delay = 500;
  let lastError;
  for (;;) {
    const client = new Client({
      ...connectionConfig(env),
      connectionTimeoutMillis: Math.max(250, Math.min(5000, deadline - Date.now())),
    });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      try { await client.end(); } catch { /* ignore */ }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    log.log?.(`[Migrate] waiting for Postgres at ${describeTarget(env)} (${lastError.message})`);
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, 5000);
  }
  const seconds = budgetMs / 1000;
  const err = new Error(
    `Postgres at ${describeTarget(env)} did not accept connections within ${seconds}s` +
    (lastError ? ` (${lastError.message})` : '')
  );
  err.cause = lastError;
  throw err;
}

/**
 * Default migration runner: `node script/migrate.js` with the parent's
 * environment, exactly what the Kubernetes Job runs through `npm run migrate`.
 * The child builds its own DATABASE_URL (script/setup-db-env.js). npm puts
 * node_modules/.bin on PATH for the Job; a direct spawn has to do it here so
 * migrate.js can find the node-pg-migrate binary.
 */
function defaultRunMigrate({ env, stdio = 'inherit' }) {
  return new Promise((resolve, reject) => {
    const childEnv = {
      ...env,
      PATH: [path.join(REPO_ROOT, 'node_modules', '.bin'), env.PATH || process.env.PATH || '']
        .filter(Boolean).join(path.delimiter),
    };
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'script', 'migrate.js')], {
      cwd: REPO_ROOT,
      env: childEnv,
      stdio,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) return resolve();
      const err = new Error(`Migration failed (script/migrate.js exited with ${signal || `code ${code}`})`);
      err.exitCode = code;
      reject(err);
    });
  });
}

/**
 * Run migrations while holding the boot advisory lock.
 * @param {object} opts
 * @param {object} [opts.env=process.env]
 * @param {object} [opts.log=console]
 * @param {number} [opts.connectTimeoutMs=60000]
 * @param {Function} [opts.runMigrate] - ({ env }) => Promise<void>
 */
async function runMigrationsWithLock({
  env = process.env,
  log = console,
  connectTimeoutMs = 60000,
  runMigrate = defaultRunMigrate,
} = {}) {
  const client = await connectWithRetry(env, connectTimeoutMs, log);
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATE_LOCK_KEY]);
    locked = true;
    log.log?.('[Migrate] running migrations');
    await runMigrate({ env });
    log.log?.('[Migrate] migrations complete');
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATE_LOCK_KEY]);
      } catch { /* the session end below releases it anyway */ }
    }
    try { await client.end(); } catch { /* ignore */ }
  }
}

module.exports = {
  MIGRATE_LOCK_KEY,
  NODE_PG_MIGRATE_LOCK_KEY,
  runMigrationsWithLock,
  defaultRunMigrate,
  connectionConfig,
};
