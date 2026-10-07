/**
 * Feature 059 (T016, research R15): createFreshInstanceDb() gives a suite a
 * zero-user clone of the run's migrated template, so "unclaimed instance"
 * behavior is tested against the real predicate without truncating the
 * shared worker database.
 */
const { createFreshInstanceDb, dropFreshInstanceDb, createPool } = require('./helpers/db');

describe('createFreshInstanceDb', () => {
  test('two clones in sequence each start with zero users and are migrated', async () => {
    const first = await createFreshInstanceDb();
    try {
      const { rows } = await first.pool.query('SELECT count(*)::int AS n FROM users');
      expect(rows[0].n).toBe(0);
      // Migrated through 059: the identity table exists.
      await first.pool.query('SELECT 1 FROM user_identities LIMIT 1');
      await first.pool.query(
        "INSERT INTO users (email, name) VALUES ('fresh-probe@example.com', 'Probe')"
      );
    } finally {
      await dropFreshInstanceDb(first);
    }

    const second = await createFreshInstanceDb();
    try {
      const { rows } = await second.pool.query('SELECT count(*)::int AS n FROM users');
      expect(rows[0].n).toBe(0);
    } finally {
      await dropFreshInstanceDb(second);
    }
  });

  test('the clone is not the worker database', async () => {
    const fresh = await createFreshInstanceDb();
    const worker = createPool();
    try {
      const a = await fresh.pool.query('SELECT current_database() AS d');
      const b = await worker.query('SELECT current_database() AS d');
      expect(a.rows[0].d).toBe(`${b.rows[0].d}_fresh`);
    } finally {
      await worker.end();
      await dropFreshInstanceDb(fresh);
    }
  });
});
