/**
 * Feature 058 (T006): server/boot/migrate-lock.js against real Postgres.
 *
 * Every connection goes to this worker's own database (helpers/db.js), except
 * the empty-database case, which creates and drops a scratch database whose
 * name is derived from this worker's database name, so it is just as private
 * to this run and this worker.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const {
  runMigrationsWithLock,
  defaultRunMigrate,
  MIGRATE_LOCK_KEY,
  NODE_PG_MIGRATE_LOCK_KEY,
} = require('../boot/migrate-lock');
const {
  getTestDatabaseUrl,
  deriveDatabaseUrl,
  quoteDatabaseIdentifier,
} = require('./helpers/db');

const quietLog = { log: () => {}, info: () => {}, warn: () => {} };
const workerEnv = () => ({ ...process.env, DATABASE_URL: getTestDatabaseUrl() });
// The production runner with its child's output silenced for the test log.
const quietRunMigrate = (opts) => defaultRunMigrate({ ...opts, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A runMigrate wrapper that records when each run enters and exits. */
function recorder(inner) {
  const intervals = [];
  const fn = async (opts) => {
    const entry = { start: Date.now() };
    intervals.push(entry);
    try {
      await inner(opts);
    } finally {
      entry.end = Date.now();
    }
  };
  return { fn, intervals };
}

function expectNoOverlap(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
  }
}

describe('runMigrationsWithLock', () => {
  test('lock key differs from node-pg-migrate\'s own key', () => {
    expect(MIGRATE_LOCK_KEY).not.toBe('7241865325823964');
    expect(MIGRATE_LOCK_KEY).not.toBe(NODE_PG_MIGRATE_LOCK_KEY);
    expect(BigInt(MIGRATE_LOCK_KEY)).not.toBe(7241865325823964n);
  });

  test('two concurrent calls never overlap their migration runs', async () => {
    const { fn, intervals } = recorder(() => sleep(200));
    await Promise.all([
      runMigrationsWithLock({ env: workerEnv(), log: quietLog, runMigrate: fn }),
      runMigrationsWithLock({ env: workerEnv(), log: quietLog, runMigrate: fn }),
    ]);
    expect(intervals).toHaveLength(2);
    expectNoOverlap(intervals);
  });

  test('the default runner (script/migrate.js) resolves against the migrated worker database', async () => {
    await expect(runMigrationsWithLock({ env: workerEnv(), log: quietLog, runMigrate: quietRunMigrate })).resolves.toBeUndefined();
  }, 60_000);

  test('two concurrent boots with the real runner serialize and both succeed', async () => {
    const { fn, intervals } = recorder(quietRunMigrate);
    await Promise.all([
      runMigrationsWithLock({ env: workerEnv(), log: quietLog, runMigrate: fn }),
      runMigrationsWithLock({ env: workerEnv(), log: quietLog, runMigrate: fn }),
    ]);
    expect(intervals).toHaveLength(2);
    expectNoOverlap(intervals);
  }, 90_000);

  test('a failing run rejects and releases the lock', async () => {
    await expect(runMigrationsWithLock({
      env: workerEnv(),
      log: quietLog,
      runMigrate: async () => { throw new Error('boom'); },
    })).rejects.toThrow('boom');

    const t0 = Date.now();
    await runMigrationsWithLock({ env: workerEnv(), log: quietLog, runMigrate: async () => {} });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('an unreachable database rejects with the connect-timeout message', async () => {
    const env = { DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'nope', DB_USER: 'nobody', DB_PASSWORD: 'x' };
    const t0 = Date.now();
    await expect(runMigrationsWithLock({ env, log: quietLog, connectTimeoutMs: 1500, runMigrate: async () => {} }))
      .rejects.toThrow(/Postgres at 127\.0\.0\.1:1 did not accept connections within 1.5s/);
    expect(Date.now() - t0).toBeLessThan(8000);
  });
});

describe('empty database boot (US1 scenario 4)', () => {
  const workerUrl = getTestDatabaseUrl();
  const scratchName = `${new URL(workerUrl).pathname.slice(1)}_boot`;
  const scratchUrl = deriveDatabaseUrl(workerUrl, scratchName);
  const adminUrl = deriveDatabaseUrl(workerUrl, 'postgres');

  async function admin(sql) {
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
  }

  beforeAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(scratchName)} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${quoteDatabaseIdentifier(scratchName)}`);
  });
  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(scratchName)} WITH (FORCE)`);
  });

  test('two replicas booting at once on an empty database migrate it exactly once', async () => {
    const env = { ...process.env, DATABASE_URL: scratchUrl };
    const { fn, intervals } = recorder(quietRunMigrate);
    await Promise.all([
      runMigrationsWithLock({ env, log: quietLog, runMigrate: fn }),
      runMigrationsWithLock({ env, log: quietLog, runMigrate: fn }),
    ]);
    expectNoOverlap(intervals);

    const files = fs.readdirSync(path.join(__dirname, '../../migrations')).filter((f) => /\.(js|sql)$/.test(f));
    const c = new Client({ connectionString: scratchUrl });
    await c.connect();
    try {
      const { rows } = await c.query('SELECT name, count(*)::int AS n FROM pgmigrations GROUP BY name');
      expect(rows).toHaveLength(files.length);
      expect(rows.every((r) => r.n === 1)).toBe(true);
    } finally {
      await c.end();
    }
  }, 180_000);
});
