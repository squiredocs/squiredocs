/**
 * Feature 059 (T065, SC-008, FR-044): every failure message in
 * server/cli/messages.js is triggered through the real command functions,
 * and each printed message carries its next action. The table must cover
 * every key, so a new message cannot ship without a trigger here.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const { createFreshInstanceDb, dropFreshInstanceDb } = require('../../__tests__/helpers/db');
const { _resetInstanceConfigForTests } = require('../../instance-config');
const { MESSAGES } = require('../messages');
const { runCli } = require('./helpers');

describe('every CLI failure names its next action (SC-008)', () => {
  let fresh;
  let db;
  let readyServer;
  let readyUrl;
  let tmp;
  const KEYS = ['SQUIRE_MODE', 'APP_URL', 'SQUIRE_DATA_DIR', 'ENABLE_DEV_ENDPOINTS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
  const saved = {};

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    fresh = await createFreshInstanceDb();
    db = fresh.pool;
    readyServer = http.createServer((req, res) => { res.statusCode = 200; res.end(); });
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

  beforeEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-msg-'));
    process.env.SQUIRE_MODE = 'local';
    process.env.APP_URL = 'http://localhost:3910';
    process.env.SQUIRE_DATA_DIR = tmp;
    _resetInstanceConfigForTests();
    await db.query('DELETE FROM mcp_api_tokens');
    await db.query("DELETE FROM app_settings WHERE key = 'instance_owner_user_id'");
    await db.query('DELETE FROM users');
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const addUser = async (email, isAdmin = false) =>
    (await db.query('INSERT INTO users (email, name, is_admin) VALUES ($1, $2, $3) RETURNING *', [email, 'U', isAdmin])).rows[0];
  const twoAdmins = async () => {
    await addUser('a1@example.com', true);
    await addUser('a2@example.com', true);
  };
  const env = (vars) => () => {
    Object.assign(process.env, vars);
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
    _resetInstanceConfigForTests();
  };
  const badDb = {
    url: 'postgres://nobody:nothing@127.0.0.1:1/none',
    createPool: () => new Pool({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', connectionTimeoutMillis: 2000 }),
  };

  const CASES = {
    dbUnreachable: { argv: ['claim-link'], opts: badDb },
    badEmailFlag: { argv: ['claim-link', '--email', 'nope'] },
    ownerAmbiguous: { setup: twoAdmins, argv: ['claim-link'] },
    loginLinkNoUser: { setup: () => addUser('x@example.com'), argv: ['login-link', '--email', 'nobody@example.com'] },
    loginLinkNoUserUnclaimed: { argv: ['login-link', '--email', 'nobody@example.com'] },
    loginLinkEmailRequired: { argv: ['login-link'] },
    tokenNameRequired: { argv: ['token', 'create'] },
    tokenTeamNeedsEmail: { setup: env({ SQUIRE_MODE: 'team' }), argv: ['token', 'create', '--name', 'N'] },
    tokenNoOwner: { argv: ['token', 'create', '--name', 'N'] },
    tokenOwnerAmbiguous: { setup: twoAdmins, argv: ['token', 'create', '--name', 'N'] },
    tokenUnknownEmail: { argv: ['token', 'create', '--name', 'N', '--email', 'nobody@example.com'] },
    tokenBadScopes: { argv: ['token', 'create', '--name', 'N', '--scopes', 'admin'] },
    tokenBadExpiry: { argv: ['token', 'create', '--name', 'N', '--expires-in', 'forever'] },
    tokenFileExists: {
      setup: async () => {
        await addUser('o@example.com', true);
        fs.writeFileSync(path.join(tmp, 'exists.token'), 'x');
      },
      argv: () => ['token', 'create', '--name', 'N', '--out', path.join(tmp, 'exists.token')],
    },
    tokenFileError: {
      setup: async () => {
        await addUser('o@example.com', true);
        fs.writeFileSync(path.join(tmp, 'a-file'), 'x');
      },
      argv: () => ['token', 'create', '--name', 'N', '--out', path.join(tmp, 'a-file', 'under-a-file.token')],
    },
    tokenMintFailed: {
      setup: async () => {
        const o = await addUser('o@example.com', true);
        // Fill the per-user cap (250) so createToken refuses.
        await db.query(
          `INSERT INTO mcp_api_tokens (user_id, name, token_prefix, token_hash, scopes)
           SELECT $1, 'filler', 'sk_sqd_xxxx', md5(g::text || random()::text), ARRAY['documents:read']
             FROM generate_series(1, 250) g`,
          [o.id]
        );
      },
      argv: () => ['token', 'create', '--name', 'N', '--out', path.join(tmp, 'capped.token')],
    },
    doctorMigrations: {
      argv: ['doctor', '--json'],
      opts: () => {
        const dir = fs.mkdtempSync(path.join(tmp, 'mig-'));
        fs.writeFileSync(path.join(dir, '9999999999999_future.js'), '');
        for (const f of fs.readdirSync(path.join(__dirname, '..', '..', '..', 'migrations'))) fs.writeFileSync(path.join(dir, f), '');
        return { migrationsDir: dir };
      },
    },
    doctorServer: { argv: ['doctor', '--json'], opts: { readyUrl: 'http://127.0.0.1:1/ready' } },
    doctorNoProvider: {
      setup: env({ SQUIRE_MODE: 'team', ENABLE_DEV_ENDPOINTS: undefined, GOOGLE_CLIENT_ID: undefined }),
      argv: ['doctor', '--json'],
    },
    doctorAppUrl: { setup: env({ APP_URL: 'http://192.168.1.5:3910' }), argv: ['doctor', '--json'] },
    configError: { setup: env({ SQUIRE_MODE: 'teams' }), argv: ['mode'] },
    unknownCommand: { argv: ['frobnicate'] },
    usage: { argv: ['claim-link', '--bogus'] },
  };

  test('the table covers every message key', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(MESSAGES).sort());
  });

  test.each(Object.keys(MESSAGES))('%s', async (key) => {
    const c = CASES[key];
    if (c.setup) await c.setup();
    const argv = typeof c.argv === 'function' ? c.argv() : c.argv;
    const opts = typeof c.opts === 'function' ? c.opts() : c.opts || {};
    const r = await runCli(argv, { url: fresh.url, readyUrl, ...opts });
    expect(r.code).not.toBe(0);
    expect(`${r.err}${r.out}`).toContain(MESSAGES[key].next);
  });
});
