// Jest global setup - runs once before all test suites.
//
// ── PER-WORKER ISOLATION (feature 052) ──────────────────────────────────────
// The URL this run starts from is a BASE, never the database tests use. Setup
// migrates one template (`<base>_template`) and then copies it into one
// database per Jest worker (`<base>_w1` … `<base>_wN`). Nothing here writes to
// the base database itself; it exists only to name the family.
//
// This runs strictly before any worker is spawned, and jest-worker builds each
// child's env from `process.env` at spawn time, so the frozen base published
// below reaches every worker.
const path = require('path');
const { execSync } = require('child_process');
const { Pool } = require('pg');
const {
  getBaseDatabaseUrl,
  getBaseDatabaseName,
  getTemplateDatabaseName,
  getWorkerDatabaseName,
  deriveDatabaseUrl,
  quoteDatabaseIdentifier,
} = require('./helpers/db');

// Redis ships 16 logical databases and DB 0 is reserved for non-test consumers
// (the dev server, Minikube's shared Redis), so 15 workers is the ceiling at
// which each worker can still own one (RBD-052-2, RBD-052-3).
const MAX_PARALLEL_WORKERS = 15;

/**
 * Abort a run configured beyond the isolatable worker count. Never silently
 * share a logical database, never silently clamp — a 16th worker would land on
 * another worker's Redis keyspace and present as a mystery flake (INV-10).
 */
function assertWorkerCountWithinRedisCap(workerCount) {
  if (workerCount > MAX_PARALLEL_WORKERS) {
    throw new Error(
      `Backend test run configured for ${workerCount} workers, but the cap is ${MAX_PARALLEL_WORKERS}. ` +
      'Redis has 16 logical databases and DB 0 is reserved for non-test consumers, so at most ' +
      `${MAX_PARALLEL_WORKERS} workers can be isolated from each other. ` +
      `Re-run with JEST_MAX_WORKERS=${MAX_PARALLEL_WORKERS} (or --maxWorkers=${MAX_PARALLEL_WORKERS}) or fewer.`
    );
  }
  return workerCount;
}

/** Create a database if it is not already there. Returns true if it created one. */
async function createDatabaseIfAbsent(adminPool, name) {
  const existing = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (existing.rows.length > 0) return false;
  try {
    await adminPool.query(`CREATE DATABASE ${quoteDatabaseIdentifier(name)}`);
    return true;
  } catch (error) {
    if (error.code === '42P04') return false; // raced with someone else; fine
    throw error;
  }
}

/** Run the project's migrations against one specific database. */
function migrateDatabase(baseUrl, dbName) {
  execSync('npm run migrate', {
    cwd: path.join(__dirname, '../..'),
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: deriveDatabaseUrl(baseUrl, dbName) },
  });
}

/**
 * Bring the template to a fully migrated state, or abort (RBD-052-5, INV-3).
 *
 * Migrate-forward is the cheap common path and inherits everything
 * `script/migrate.js` already handles, including the phantom-`pgmigrations`
 * guards. A template left at a wrong schema state — from a run on another
 * branch, or a crash mid-migration — surfaces as a loud migration error
 * (node-pg-migrate's checkOrder throws), which is what makes the one-shot
 * drop-and-rebuild a reliable self-heal rather than a guess. If the rebuild
 * fails too, the run aborts with the ORIGINAL error: a copy is only ever taken
 * from a template that finished migrating.
 */
async function prepareTemplate(adminPool, baseUrl, templateName) {
  await createDatabaseIfAbsent(adminPool, templateName);
  try {
    migrateDatabase(baseUrl, templateName);
    return;
  } catch (firstError) {
    console.warn(
      `\n⚠️  Migrating template ${templateName} failed; rebuilding it from scratch once.\n` +
      `    ${firstError.message}`
    );
    try {
      await dropTemplate(adminPool, templateName);
      await createDatabaseIfAbsent(adminPool, templateName);
      migrateDatabase(baseUrl, templateName);
      console.log(`✅ Template ${templateName} rebuilt.`);
      return;
    } catch (secondError) {
      const error = new Error(
        `Could not build the test template database ${templateName}. The rebuild attempt also ` +
        `failed (${secondError.message}), so no per-worker database can be created from it. ` +
        `Original migration error: ${firstError.message}`
      );
      error.cause = firstError;
      throw error;
    }
  }
}

/**
 * Drop the template WITHOUT `WITH (FORCE)`. Unlike a per-worker copy, the
 * template is the run's shared root: if something still holds a connection to
 * it, that must fail loudly rather than be killed silently. Postgres fails
 * immediately here (55006), so no timeout is needed — only a message that says
 * what to look for.
 */
async function dropTemplate(adminPool, templateName) {
  try {
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(templateName)}`);
  } catch (error) {
    if (error.code === '55006') {
      throw new Error(
        `Cannot drop the test template database ${templateName}: another connection is using it. ` +
        'Backend test runs are one-at-a-time per base database (Constitution II / D3) — check for ' +
        'another test run or a leaked process against this base, then retry. ' +
        `Query the holders with: SELECT pid, application_name FROM pg_stat_activity WHERE datname = '${templateName}'. ` +
        `(${error.message})`
      );
    }
    throw error;
  }
}

/**
 * One database per worker, always freshly copied from the template. The drop is
 * `WITH (FORCE)`: a stale `_wN` copy belongs to a previous run of this suite, so
 * a lingering connection means a leaked process from a crash, and forcing is
 * both correct and the only self-service recovery from a wedged run.
 */
async function provisionWorkerDatabases(adminPool, baseName, templateName, workerCount) {
  for (let workerId = 1; workerId <= workerCount; workerId++) {
    const workerDb = getWorkerDatabaseName(baseName, workerId);
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(workerDb)} WITH (FORCE)`);
    } catch (error) {
      throw new Error(
        `Could not drop the stale per-worker test database ${workerDb}, even with FORCE. ` +
        'The usual cause is a leaked process from a crashed test run still holding it open. ' +
        `Find it with: SELECT pid, application_name FROM pg_stat_activity WHERE datname = '${workerDb}'. ` +
        `(${error.message})`
      );
    }
    try {
      await adminPool.query(
        `CREATE DATABASE ${quoteDatabaseIdentifier(workerDb)} TEMPLATE ${quoteDatabaseIdentifier(templateName)}`
      );
    } catch (error) {
      if (error.code === '55006') {
        throw new Error(
          `Cannot copy ${templateName} into ${workerDb}: another connection is using the template. ` +
          'Backend test runs are one-at-a-time per base database (Constitution II / D3) — a second ' +
          'run against this same base is the usual cause. Give each concurrent run its own base ' +
          'DATABASE_URL, or wait for the other run to finish. ' +
          `(${error.message})`
        );
      }
      throw error;
    }
  }
}

module.exports = async (globalConfig = {}) => {
  const baseUrl = getBaseDatabaseUrl();
  const baseName = getBaseDatabaseName(baseUrl);
  const workerCount = assertWorkerCountWithinRedisCap(
    Math.max(1, Number(globalConfig.maxWorkers) || 1)
  );

  // Freeze the base BEFORE any worker exists, so every worker derives its names
  // from the same immutable input and never from an already-derived URL.
  process.env.TEST_BASE_DATABASE_URL = baseUrl;

  const templateName = getTemplateDatabaseName(baseName);
  const adminPool = new Pool({ connectionString: deriveDatabaseUrl(baseUrl, 'postgres') });
  try {
    console.log(`\n🔄 Preparing test databases (base ${baseName}, ${workerCount} worker(s))...`);
    await prepareTemplate(adminPool, baseUrl, templateName);
    await provisionWorkerDatabases(adminPool, baseName, templateName, workerCount);
    console.log(`✅ ${templateName} migrated; ${baseName}_w1..w${workerCount} created.\n`);
  } finally {
    await adminPool.end();
  }
};

module.exports.MAX_PARALLEL_WORKERS = MAX_PARALLEL_WORKERS;
module.exports.assertWorkerCountWithinRedisCap = assertWorkerCountWithinRedisCap;
