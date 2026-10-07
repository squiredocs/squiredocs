/**
 * Feature 059 (T063, FR-039, SC-006): `squire doctor`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const { createFreshInstanceDb, dropFreshInstanceDb } = require('../../__tests__/helpers/db');
const { _resetInstanceConfigForTests } = require('../../instance-config');
const { runCli } = require('./helpers');

describe('squire doctor', () => {
  let fresh;
  let readyServer;
  let readyUrl;
  let readyStatus = 200;
  const KEYS = ['SQUIRE_MODE', 'APP_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ENABLE_DEV_ENDPOINTS', 'GOOGLE_GENERATIVE_AI_API_KEY', 'REDIS_HOST'];
  const saved = {};

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    fresh = await createFreshInstanceDb();
    readyServer = http.createServer((req, res) => {
      res.statusCode = req.url === '/ready' ? readyStatus : 404;
      res.end();
    });
    await new Promise((r) => readyServer.listen(0, '127.0.0.1', r));
    readyUrl = `http://127.0.0.1:${readyServer.address().port}/ready`;
  });

  afterAll(async () => {
    await new Promise((r) => readyServer.close(r));
    await dropFreshInstanceDb(fresh);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetInstanceConfigForTests();
  });

  beforeEach(() => {
    readyStatus = 200;
    process.env.SQUIRE_MODE = 'local';
    process.env.APP_URL = 'http://localhost:3910';
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.REDIS_HOST;
    _resetInstanceConfigForTests();
  });

  const doctor = (extra = {}, argv = ['doctor', '--json']) =>
    runCli(argv, { url: fresh.url, readyUrl, ...extra });
  const json = (r) => JSON.parse(r.out);

  test('healthy: ok true, exit 0, one JSON document with every check and info field', async () => {
    const r = await doctor();
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n')).toHaveLength(1);
    const d = json(r);
    expect(d.ok).toBe(true);
    expect(d.failed).toEqual([]);
    expect(Object.keys(d.checks).sort()).toEqual(['appUrl', 'database', 'migrations', 'mode', 'owner', 'server'].sort());
    expect(d.checks.migrations).toEqual({ ok: true, pending: 0 });
    expect(d.checks.mode).toMatchObject({ ok: true, mode: 'local', providers: [] });
    expect(d.checks.owner).toEqual({ ok: true, hasOwner: false });
    expect(Object.keys(d.info).sort()).toEqual(['assistantKeys', 'email', 'imageStorage', 'redis', 'semanticSearch'].sort());
  });

  test('no embedding key is reported off with the reason and leaves ok true', async () => {
    const d = json(await doctor());
    expect(d.info.semanticSearch).toEqual({ on: false, reason: 'no embedding key (GOOGLE_GENERATIVE_AI_API_KEY)' });
    expect(d.ok).toBe(true);
  });

  const expectFailure = (r, check) => {
    expect(r.code).toBe(1);
    const d = json(r);
    expect(d.ok).toBe(false);
    expect(d.failed).toContain(check);
    expect(d.checks[check].ok).toBe(false);
    expect(typeof d.checks[check].message).toBe('string');
    return d;
  };

  test('unreachable database: ok false, next action, and the whole command under 5 s', async () => {
    const started = Date.now();
    const r = await runCli(['doctor', '--json'], {
      url: 'postgres://nobody:nothing@127.0.0.1:1/none',
      readyUrl,
      createPool: () => new Pool({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', connectionTimeoutMillis: 2000 }),
    });
    expect(Date.now() - started).toBeLessThan(5000);
    const d = expectFailure(r, 'database');
    expect(d.checks.database.message).toMatch(/docker compose ps/);
  });

  test('pending migrations: ok false, the count, and the restart command', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-mig-'));
    try {
      for (const f of fs.readdirSync(path.join(__dirname, '..', '..', '..', 'migrations'))) {
        fs.writeFileSync(path.join(dir, f), '');
      }
      fs.writeFileSync(path.join(dir, '9999999999999_future.js'), '');
      const d = expectFailure(await doctor({ migrationsDir: dir }), 'migrations');
      expect(d.checks.migrations.pending).toBe(1);
      expect(d.checks.migrations.message).toMatch(/docker compose restart app/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('team mode with no provider: ok false naming the Google variables', async () => {
    process.env.SQUIRE_MODE = 'team';
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.ENABLE_DEV_ENDPOINTS;
    _resetInstanceConfigForTests();
    try {
      const d = expectFailure(await doctor(), 'mode');
      expect(d.checks.mode.message).toMatch(/GOOGLE_CLIENT_ID/);
    } finally {
      process.env.ENABLE_DEV_ENDPOINTS = saved.ENABLE_DEV_ENDPOINTS;
    }
  });

  test('APP_URL on a LAN http address: ok false, and failed says it is appUrl while server is ok', async () => {
    process.env.APP_URL = 'http://192.168.1.5:3910';
    _resetInstanceConfigForTests();
    const d = expectFailure(await doctor(), 'appUrl');
    expect(d.failed).toEqual(['appUrl']);
    expect(d.checks.server.ok).toBe(true);
    expect(d.checks.appUrl.message).toMatch(/https APP_URL/);
  });

  test('/ready not listening or not 200: ok false with the log command', async () => {
    let d = expectFailure(await doctor({ readyUrl: 'http://127.0.0.1:1/ready' }), 'server');
    expect(d.checks.server.message).toMatch(/docker compose logs app/);
    readyStatus = 503;
    d = expectFailure(await doctor(), 'server');
    expect(d.checks.server.message).toMatch(/HTTP 503/);
  });

  test('a bad SQUIRE_MODE is a failing check with its message, not a crash', async () => {
    process.env.SQUIRE_MODE = 'teams';
    _resetInstanceConfigForTests();
    const d = expectFailure(await doctor(), 'mode');
    expect(d.checks.mode.message).toMatch(/SQUIRE_MODE must be "local" or "team"/);
  });

  test('human output: one line per check and the info lines', async () => {
    const r = await doctor({}, ['doctor']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ok {3}database/m);
    expect(r.out).toMatch(/^info semantic search: off/m);
    expect(r.out).toMatch(/Squire Docs is ready\./);
  });
});
