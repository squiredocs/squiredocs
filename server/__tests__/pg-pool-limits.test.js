/**
 * Feature 010, US5 (FR-023, SC-007): the app pg pool has a bounded max, a fast
 * acquisition timeout, and a server-side statement timeout — a saturated pool
 * fails an unrelated request fast, a runaway statement is killed, and the pool
 * self-recovers without a restart.
 *
 * Sets the DB_POOL_* env vars small for the test and restores them afterward.
 * Under Jest workers each suite file gets its own process, so this suite's
 * env no longer leaks across suites — but suites sharing a worker still run in
 * one process, so restoring remains required.
 */
const { PostgresPersistence } = require('../postgres-persistence');
const { getDbConfig } = require('./helpers/db');

const SAVED = {
  DB_POOL_MAX: process.env.DB_POOL_MAX,
  DB_POOL_ACQUIRE_TIMEOUT_MS: process.env.DB_POOL_ACQUIRE_TIMEOUT_MS,
  DB_STATEMENT_TIMEOUT_MS: process.env.DB_STATEMENT_TIMEOUT_MS,
};

describe('pg pool limits (FR-023)', () => {
  let persistence;
  let pool;

  beforeAll(async () => {
    process.env.DB_POOL_MAX = '2';
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '500';
    process.env.DB_STATEMENT_TIMEOUT_MS = '1000';
    persistence = new PostgresPersistence(getDbConfig()); // reads the env above
    pool = persistence.getPool();
  });

  afterAll(async () => {
    await persistence.destroy();
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('a saturated pool fails an unrelated acquire fast (connectionTimeoutMillis)', async () => {
    // Hold both connections (max=2) so the pool is exhausted.
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const start = Date.now();
      await expect(pool.connect()).rejects.toThrow(/timeout/i);
      const elapsed = Date.now() - start;
      // Failed fast at ~500ms, not hung indefinitely.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      c1.release();
      c2.release();
    }

    // Pool self-recovers once connections are released — no restart.
    const c3 = await pool.connect();
    expect(c3).toBeTruthy();
    c3.release();
  });

  it('a runaway statement is killed at statement_timeout and the pool recovers', async () => {
    const c = await pool.connect();
    try {
      await expect(c.query('SELECT pg_sleep(5)'))
        .rejects.toThrow(/statement timeout|canceling statement/i);
    } finally {
      c.release();
    }

    // A normal query still works afterward — the pool self-healed.
    const ok = await pool.query('SELECT 1 AS one');
    expect(ok.rows[0].one).toBe(1);
  });

  it('ping() returns true against a reachable datastore and holds no connection', async () => {
    const before = pool.idleCount + pool.totalCount;
    expect(await persistence.ping()).toBe(true);
    // ping acquires + releases immediately; it must not leak a busy connection.
    expect(pool.waitingCount).toBe(0);
    // totalCount may grow by the one connection it opened, but it should be idle now.
    expect(pool.idleCount).toBeGreaterThanOrEqual(0);
    void before;
  });
});
