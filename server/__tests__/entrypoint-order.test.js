/**
 * Feature 058 (T008): the entrypoint puts secrets in the environment before
 * the server's require-time guards run. The probe fixture requires the real
 * auth/jwt.js, mcp/auth/jwt.js, and crypto.js; every require happens inside
 * jest.isolateModules so those guards execute fresh each time.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROBE = require.resolve('./fixtures/entrypoint-probe-server.js');
const SECRET_NAMES = ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET', 'MCP_JWT_SECRET', 'API_KEY_ENCRYPTION_KEY'];
const NO_DOTENV = path.join(os.tmpdir(), 'squire-entrypoint-no-such-dotenv');
const quietLog = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let savedEnv;
let dataDir;

beforeEach(() => {
  savedEnv = { ...process.env };
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-entrypoint-'));
  process.env.NODE_ENV = 'production';
  process.env.SQUIRE_DATA_DIR = dataDir;
  process.env.MIGRATE_ON_BOOT = 'false';
  for (const n of SECRET_NAMES) delete process.env[n];
  delete process.env.API_KEY_ENCRYPTION_KEYS;
  delete global.__entrypointProbe;
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete global.__entrypointProbe;
  jest.restoreAllMocks();
  jest.dontMock('../boot/migrate-lock');
});

/** Run main() with a fresh module registry; resolves to what main resolves to. */
function runMain(extra = {}) {
  let p;
  jest.isolateModules(() => {
    const { main } = require('../boot/entrypoint');
    p = main({ serverModule: PROBE, dotenvPath: NO_DOTENV, log: quietLog, ...extra });
  });
  return p;
}

test('control: the probe alone throws the production secret guard', () => {
  expect(() => {
    jest.isolateModules(() => { require(PROBE); });
  }).toThrow('FATAL: ACCESS_TOKEN_SECRET');
});

test('main() resolves secrets before the server loads; the real guards pass', async () => {
  await runMain();
  expect(global.__entrypointProbe).toEqual({
    ok: true,
    env: Object.fromEntries(SECRET_NAMES.map((n) => [n, true])),
  });
  expect(fs.existsSync(path.join(dataDir, 'secrets.json'))).toBe(true);
});

test('an invalid STORAGE_DRIVER rejects before any secrets file is written', async () => {
  process.env.STORAGE_DRIVER = 'gcs';
  await expect(runMain()).rejects.toThrow('STORAGE_DRIVER must be one of: local, s3');
  expect(fs.readdirSync(dataDir)).toEqual([]);
  expect(global.__entrypointProbe).toBeUndefined();
});

test('order: telemetry, secrets, migrate, then the server', async () => {
  process.env.MIGRATE_ON_BOOT = 'true';
  const calls = [];
  let p;
  jest.isolateModules(() => {
    jest.doMock('../boot/migrate-lock', () => ({
      runMigrationsWithLock: jest.fn(async () => {
        calls.push(['migrate', fs.existsSync(path.join(dataDir, 'secrets.json')), Boolean(process.env.ACCESS_TOKEN_SECRET)]);
      }),
    }));
    const telemetry = require('../telemetry');
    jest.spyOn(telemetry, 'start').mockImplementation(() => {
      calls.push(['telemetry', fs.existsSync(path.join(dataDir, 'secrets.json'))]);
      return { mode: 'off' };
    });
    const { main } = require('../boot/entrypoint');
    p = main({ serverModule: PROBE, dotenvPath: NO_DOTENV, log: quietLog });
  });
  await p;
  calls.push(['server', Boolean(global.__entrypointProbe && global.__entrypointProbe.ok)]);
  expect(calls).toEqual([
    ['telemetry', false],
    ['migrate', true, true],
    ['server', true],
  ]);
});

test('a migration failure means the server is never required', async () => {
  process.env.MIGRATE_ON_BOOT = 'true';
  let p;
  jest.isolateModules(() => {
    jest.doMock('../boot/migrate-lock', () => ({
      runMigrationsWithLock: jest.fn(async () => { throw new Error('Migration failed (code 1)'); }),
    }));
    const { main } = require('../boot/entrypoint');
    p = main({ serverModule: PROBE, dotenvPath: NO_DOTENV, log: quietLog });
  });
  await expect(p).rejects.toThrow('Migration failed');
  expect(global.__entrypointProbe).toBeUndefined();
});

test('a .env value beats the secrets file (dotenv runs first, RBD-058-25)', async () => {
  const dotenvPath = path.join(dataDir, '..', `squire-entrypoint-dotenv-${process.pid}`);
  fs.writeFileSync(dotenvPath, 'ACCESS_TOKEN_SECRET=from-dotenv-0123456789abcdef0123456789abcdef\n');
  try {
    await runMain({ dotenvPath });
    expect(process.env.ACCESS_TOKEN_SECRET).toBe('from-dotenv-0123456789abcdef0123456789abcdef');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8'));
    expect(onDisk.ACCESS_TOKEN_SECRET).toBeUndefined();
  } finally {
    fs.rmSync(dotenvPath, { force: true });
  }
});
