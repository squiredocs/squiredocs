/**
 * Feature 052 — parallel test isolation.
 *
 * These tests assert the isolation machinery itself: the name/URL derivation
 * every worker uses, the Redis logical-database knob, and the guard that stops
 * a run configured beyond the number of isolatable Redis databases.
 *
 * FR-004 forbids fixing isolation by editing suites' own code, so this file is
 * the only place the isolation behavior is asserted directly.
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const {
  getBaseDatabaseUrl,
  getBaseDatabaseName,
  getWorkerId,
  getWorkerDatabaseName,
  getTemplateDatabaseName,
  deriveDatabaseUrl,
  getTestDatabaseUrl,
  quoteDatabaseIdentifier,
  BASE_DB_NAME_PATTERN,
} = require('./helpers/db');
const globalSetup = require('./globalSetup');

/** Run `fn` with the given env overrides, restoring the previous env after. */
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('052 US1: name and URL derivation', () => {
  test('INV-1: distinct workers resolve distinct database names', () => {
    expect(getWorkerDatabaseName('collab_test_db', 1)).toBe('collab_test_db_w1');
    expect(getWorkerDatabaseName('collab_test_db', 2)).toBe('collab_test_db_w2');
    expect(getWorkerDatabaseName('collab_test_db', 1))
      .not.toBe(getWorkerDatabaseName('collab_test_db', 2));

    const base = 'postgresql://u@h:5432/collab_test_db';
    const w1 = withEnv({ TEST_BASE_DATABASE_URL: base, JEST_WORKER_ID: '1' }, getTestDatabaseUrl);
    const w2 = withEnv({ TEST_BASE_DATABASE_URL: base, JEST_WORKER_ID: '2' }, getTestDatabaseUrl);
    expect(w1).toBe('postgresql://u@h:5432/collab_test_db_w1');
    expect(w2).toBe('postgresql://u@h:5432/collab_test_db_w2');
  });

  test('INV-2: an unset JEST_WORKER_ID is worker 1 (the --runInBand path)', () => {
    expect(withEnv({ JEST_WORKER_ID: undefined }, getWorkerId)).toBe(1);
    const url = withEnv(
      { TEST_BASE_DATABASE_URL: 'postgresql://u@h:5432/collab_test_db', JEST_WORKER_ID: undefined },
      getTestDatabaseUrl
    );
    expect(url).toBe('postgresql://u@h:5432/collab_test_db_w1');
  });

  test('INV-2: JEST_WORKER_ID is read verbatim as a number', () => {
    expect(withEnv({ JEST_WORKER_ID: '7' }, getWorkerId)).toBe(7);
  });

  test('INV-4: credentials, host, port and query string survive splicing', () => {
    const base = 'postgresql://postgres:p%40ss@db.example:6543/collab_test_db?sslmode=require&x=1';
    const derived = deriveDatabaseUrl(base, 'collab_test_db_w3');
    const parsed = new URL(derived);
    expect(parsed.username).toBe('postgres');
    expect(parsed.password).toBe('p%40ss');
    expect(parsed.hostname).toBe('db.example');
    expect(parsed.port).toBe('6543');
    expect(parsed.search).toBe('?sslmode=require&x=1');
    expect(parsed.pathname).toBe('/collab_test_db_w3');
    // Only the pathname differs from the base.
    const baseParsed = new URL(base);
    baseParsed.pathname = '/collab_test_db_w3';
    expect(derived).toBe(baseParsed.toString());
  });

  test('INV-5: derivation is idempotent — the frozen base wins over a derived DATABASE_URL', () => {
    const base = 'postgresql://u@h:5432/collab_test_db';
    const once = withEnv(
      { TEST_BASE_DATABASE_URL: base, DATABASE_URL: base, JEST_WORKER_ID: '3' },
      getTestDatabaseUrl
    );
    expect(once).toBe('postgresql://u@h:5432/collab_test_db_w3');

    // setup.js pins DATABASE_URL to the derived URL; deriving again must not
    // produce collab_test_db_w3_w3.
    const twice = withEnv(
      { TEST_BASE_DATABASE_URL: base, DATABASE_URL: once, JEST_WORKER_ID: '3' },
      getTestDatabaseUrl
    );
    expect(twice).toBe(once);
  });

  test('INV-5: base resolution order is TEST_BASE_DATABASE_URL, then DATABASE_URL, then the built-in default', () => {
    expect(withEnv(
      { TEST_BASE_DATABASE_URL: 'postgresql://u@h:5432/frozen', DATABASE_URL: 'postgresql://u@h:5432/env' },
      getBaseDatabaseUrl
    )).toBe('postgresql://u@h:5432/frozen');

    expect(withEnv(
      { TEST_BASE_DATABASE_URL: undefined, DATABASE_URL: 'postgresql://u@h:5432/env' },
      getBaseDatabaseUrl
    )).toBe('postgresql://u@h:5432/env');

    const fallback = withEnv(
      {
        TEST_BASE_DATABASE_URL: undefined,
        DATABASE_URL: undefined,
        DB_HOST: 'localhost',
        DB_PORT: '5432',
        DB_USER: 'postgres',
        DB_PASSWORD: undefined,
      },
      getBaseDatabaseUrl
    );
    expect(fallback).toBe('postgresql://postgres@localhost:5432/collab_test_db');
  });

  test('INV-6: distinct bases yield disjoint {template, worker} families', () => {
    const a = 'collab_test_db_a';
    const b = 'collab_test_db_b';
    const familyA = new Set([
      getTemplateDatabaseName(a),
      ...[1, 2, 3].map((n) => getWorkerDatabaseName(a, n)),
    ]);
    const familyB = new Set([
      getTemplateDatabaseName(b),
      ...[1, 2, 3].map((n) => getWorkerDatabaseName(b, n)),
    ]);
    for (const name of familyB) expect(familyA.has(name)).toBe(false);
    // The design's literals are the derived names of the default base, not a
    // special case (contract §2 rule 5).
    expect(getTemplateDatabaseName('collab_test_db')).toBe('collab_test_db_template');
    expect(getWorkerDatabaseName('collab_test_db', 4)).toBe('collab_test_db_w4');
  });

  test('INV-11: a base name outside the accepted charset is rejected, naming the value and the charset', () => {
    const bad = 'collab_test; DROP DATABASE postgres';
    expect(() => getWorkerDatabaseName(bad, 1)).toThrow(bad);
    expect(() => getWorkerDatabaseName(bad, 1)).toThrow(BASE_DB_NAME_PATTERN.source);
    expect(() => getTemplateDatabaseName(bad)).toThrow(bad);
    expect(() => getTemplateDatabaseName('')).toThrow(/charset|pattern|[A-Za-z]/);
    // Hyphens are legal in a base name (worktree agents use them) but only
    // because every derived name is double-quoted into DDL.
    expect(getWorkerDatabaseName('collab_test_db_agent-1', 2)).toBe('collab_test_db_agent-1_w2');
  });

  test('INV-11: identifiers are double-quoted for DDL interpolation', () => {
    expect(quoteDatabaseIdentifier('collab_test_db_w1')).toBe('"collab_test_db_w1"');
    expect(quoteDatabaseIdentifier('collab_test_db_agent-1_template'))
      .toBe('"collab_test_db_agent-1_template"');
  });

  test('a base name too long for its derivatives is rejected, never truncated (review 052 LOW-1)', () => {
    // 55 chars: charset-legal, but <base>_template would exceed Postgres's
    // 63-byte identifier limit, which truncates with only a NOTICE and would
    // collapse the per-worker family into colliding names.
    const tooLong = 'x'.repeat(55);
    expect(() => getBaseDatabaseName(`postgresql://u@h:5432/${tooLong}`)).toThrow(/54/);
    // 54 chars is the boundary and stays accepted.
    const atLimit = 'x'.repeat(54);
    expect(getBaseDatabaseName(`postgresql://u@h:5432/${atLimit}`)).toBe(atLimit);
  });
});

describe('052 US1: rows written by one worker are invisible to another', () => {
  // Two stand-in worker databases, built the same way globalSetup builds the
  // real ones. They are created here rather than reusing `_w1` / `_w2` because
  // `_w2` does not exist under --runInBand (maxWorkers is 1), and this test must
  // behave identically in both execution modes (SC-003).
  const baseUrl = getBaseDatabaseUrl();
  const baseName = getBaseDatabaseName(baseUrl);
  const templateName = getTemplateDatabaseName(baseName);
  const dbA = `${baseName}_isoprobea`;
  const dbB = `${baseName}_isoprobeb`;
  const FIXED_EMAIL = 'fixed-key-row@isolation-probe.test';

  let adminPool;
  let poolA;
  let poolB;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: deriveDatabaseUrl(baseUrl, 'postgres') });
    for (const db of [dbA, dbB]) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(db)} WITH (FORCE)`);
      await adminPool.query(
        `CREATE DATABASE ${quoteDatabaseIdentifier(db)} TEMPLATE ${quoteDatabaseIdentifier(templateName)}`
      );
    }
    poolA = new Pool({ connectionString: deriveDatabaseUrl(baseUrl, dbA) });
    poolB = new Pool({ connectionString: deriveDatabaseUrl(baseUrl, dbB) });
  }, 60000);

  afterAll(async () => {
    if (poolA) await poolA.end();
    if (poolB) await poolB.end();
    if (adminPool) {
      for (const db of [dbA, dbB]) {
        await adminPool.query(`DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(db)} WITH (FORCE)`);
      }
      await adminPool.end();
    }
  }, 60000);

  test('SC-005: the same fixed-key row inserts in both, and neither sees the other', async () => {
    const insert = (pool, name) => pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'isolation-probe-' || random(), $1, $2) RETURNING id`,
      [FIXED_EMAIL, name]
    );

    // A unique-key collision on this email is exactly the failure that made the
    // shared database unsafe for concurrent workers. Both inserts must succeed.
    const a = await insert(poolA, 'probe-worker-a');
    const b = await insert(poolB, 'probe-worker-b');
    expect(a.rows[0].id).not.toBe(b.rows[0].id);

    const seenByA = await poolA.query('SELECT name FROM users WHERE email = $1', [FIXED_EMAIL]);
    const seenByB = await poolB.query('SELECT name FROM users WHERE email = $1', [FIXED_EMAIL]);
    expect(seenByA.rows.map((r) => r.name)).toEqual(['probe-worker-a']);
    expect(seenByB.rows.map((r) => r.name)).toEqual(['probe-worker-b']);
  }, 30000);

  test('INV-3: a worker database is a copy of the migrated template, not an empty database', async () => {
    const { rows } = await poolA.query(
      "SELECT to_regclass('public.yjs_updates')::text AS t, to_regclass('public.documents')::text AS d"
    );
    expect(rows[0].t).toBe('yjs_updates');
    expect(rows[0].d).toBe('documents');
    // Template-fresh: no test data came across with the schema.
    const users = await poolB.query('SELECT count(*)::int AS n FROM users WHERE email <> $1', [FIXED_EMAIL]);
    expect(users.rows[0].n).toBe(0);
  }, 30000);
});

describe('052 US2: Redis logical-database isolation', () => {
  /**
   * Load server/redis.js fresh under a given environment and capture every
   * config object handed to `new Redis(...)`. Capturing at the constructor is
   * stronger evidence than reading an exported object: it is literally what the
   * client is built from.
   */
  function captureRedisConfigs(env, { pubsub = false } = {}) {
    const configs = [];
    jest.resetModules();
    jest.doMock('ioredis', () => class FakeRedis {
      constructor(config) { configs.push(config); }
      on() { return this; }
      quit() { return Promise.resolve(); }
    });
    withEnv({ REDIS_HOST: 'localhost', ...env }, () => {
      const redisModule = require('../redis');
      redisModule.getRedisClient();
      if (pubsub) redisModule.createPubSubClient();
    });
    jest.dontMock('ioredis');
    jest.resetModules();
    return configs;
  }

  test('SC-004/INV-7: with REDIS_DB unset the config has NO db key at all', () => {
    const [config] = captureRedisConfigs({ REDIS_DB: undefined });
    // `db: 0` and no `db` key are different objects, and only the latter is
    // byte-identical to the pre-feature config. Assert the absence.
    expect('db' in config).toBe(false);
    expect(Object.keys(config).sort()).toEqual(
      ['connectTimeout', 'host', 'maxRetriesPerRequest', 'port', 'retryStrategy']
    );
  });

  test('an explicit REDIS_DB=0 is honored — the string "0" is truthy', () => {
    const [config] = captureRedisConfigs({ REDIS_DB: '0' });
    expect(config.db).toBe(0);
    // Regression guard: nobody may "fix" the conditional spread into a numeric
    // truthiness check, which would silently drop this.
    expect('db' in config).toBe(true);
  });

  test('REDIS_DB selects the logical database, as a number', () => {
    const [config] = captureRedisConfigs({ REDIS_DB: '4' });
    expect(config.db).toBe(4);
  });

  test('INV-8: the shared client and every pub/sub client read one config', () => {
    const configs = captureRedisConfigs({ REDIS_DB: '4' }, { pubsub: true });
    expect(configs.length).toBe(2);
    expect(configs[0]).toBe(configs[1]); // same object, so the same logical DB
  });

  test('a key written in one logical database is invisible in another', async () => {
    // Deliberately high logical databases, above any worker count this suite
    // runs at, so the probe cannot disturb a concurrent worker's keyspace.
    const key = `isolation-probe:${process.pid}:${Date.now()}`;
    const host = process.env.REDIS_HOST || 'localhost';
    const inDb14 = new Redis({ host, db: 14 });
    const inDb15 = new Redis({ host, db: 15 });
    try {
      await inDb14.set(key, 'written-by-db14', 'EX', 30);
      expect(await inDb14.get(key)).toBe('written-by-db14');
      expect(await inDb15.get(key)).toBeNull();
      await inDb14.del(key);
    } finally {
      await Promise.all([inDb14.quit(), inDb15.quit()]);
    }
  }, 20000);

  test('KNOWN LIMITATION: Redis pub/sub is global, so REDIS_DB does not scope channels', async () => {
    // Verified against raw redis-cli during implementation, and pinned here so
    // the limitation is a tested fact rather than an assumption. Redis Pub/Sub
    // has no relation to the keyspace: a message published while SELECTed into
    // one logical database is delivered to subscribers in every other one.
    //
    // Consequence for this feature (see N-052-C in clarifications-needed.md):
    // per-worker Redis isolation covers KEYS, not channels. The suite is safe
    // in practice because every app channel is either document-scoped by a
    // random guid or carries a payload keyed to its own run, but this is an
    // operating property, not an invariant. If channel-level isolation is ever
    // needed, it takes a channel prefix, which is a design amendment.
    const channel = `isolation-probe:${process.pid}:${Date.now()}`;
    const host = process.env.REDIS_HOST || 'localhost';
    const publisher = new Redis({ host, db: 14 });
    const otherDb = new Redis({ host, db: 15 });
    const heard = [];
    try {
      otherDb.on('message', (_c, m) => heard.push(m));
      await otherDb.subscribe(channel);
      await publisher.publish(channel, 'hello');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(heard).toEqual(['hello']);
    } finally {
      await Promise.all([publisher.quit(), otherDb.quit()]);
    }
  }, 20000);

  test('INV-10: a run configured beyond 15 workers is rejected before any test runs', () => {
    const { assertWorkerCountWithinRedisCap, MAX_PARALLEL_WORKERS } = globalSetup;
    expect(MAX_PARALLEL_WORKERS).toBe(15);
    expect(assertWorkerCountWithinRedisCap(1)).toBe(1);
    expect(assertWorkerCountWithinRedisCap(15)).toBe(15);
    expect(() => assertWorkerCountWithinRedisCap(16)).toThrow(/16/);
    expect(() => assertWorkerCountWithinRedisCap(16)).toThrow(/cap is 15/);
    expect(() => assertWorkerCountWithinRedisCap(16)).toThrow(/16 logical databases/);
    expect(() => assertWorkerCountWithinRedisCap(16)).toThrow(/DB 0 is reserved/);
    expect(() => assertWorkerCountWithinRedisCap(16)).toThrow(/JEST_MAX_WORKERS/);
  });

  test('INV-9: this worker is assigned its own logical database, never 0', () => {
    expect(process.env.REDIS_DB).toBe(String(getWorkerId()));
    expect(Number(process.env.REDIS_DB)).toBeGreaterThanOrEqual(1);
  });
});
