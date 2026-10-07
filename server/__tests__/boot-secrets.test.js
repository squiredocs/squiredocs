/**
 * Feature 058 (T005): server/boot/secrets.js against real temp directories.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveSecrets, SECRET_NAMES, SecretsError } = require('../boot/secrets');

const quietLog = () => ({ info: jest.fn(), log: jest.fn(), warn: jest.fn() });

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-secrets-'));
});
afterEach(() => {
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, 'secrets.json');

describe('resolveSecrets', () => {
  test('fresh dir generates four 64-hex values, mode 0600, mutates env', () => {
    const env = {};
    const log = quietLog();
    const res = resolveSecrets({ env, dataDir: dir, log });
    expect(res.generated).toEqual([...SECRET_NAMES]);
    for (const n of SECRET_NAMES) expect(env[n]).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(fs.readFileSync(file(), 'utf8'));
    for (const n of SECRET_NAMES) expect(onDisk[n]).toBe(env[n]);
    // No temp files left behind.
    expect(fs.readdirSync(dir)).toEqual(['secrets.json']);
  });

  test('log line lists names only, never values', () => {
    const env = {};
    const log = quietLog();
    resolveSecrets({ env, dataDir: dir, log });
    const lines = log.info.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(lines).toContain('[Secrets] generated ACCESS_TOKEN_SECRET');
    for (const n of SECRET_NAMES) expect(lines).not.toContain(env[n]);
  });

  test('second call reuses the file and writes nothing', () => {
    const env1 = {};
    resolveSecrets({ env: env1, dataDir: dir, log: quietLog() });
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file(), past, past);
    const before = fs.statSync(file()).mtimeMs;
    const env2 = {};
    const res = resolveSecrets({ env: env2, dataDir: dir, log: quietLog() });
    expect(res.generated).toEqual([]);
    expect(res.fromFile).toEqual([...SECRET_NAMES]);
    expect(env2).toEqual(env1);
    expect(fs.statSync(file()).mtimeMs).toBe(before);
  });

  test('env value wins and is never written', () => {
    const env = { ACCESS_TOKEN_SECRET: 'from-env-value' };
    const res = resolveSecrets({ env, dataDir: dir, log: quietLog() });
    expect(env.ACCESS_TOKEN_SECRET).toBe('from-env-value');
    expect(res.fromEnv).toEqual(['ACCESS_TOKEN_SECRET']);
    const onDisk = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(onDisk.ACCESS_TOKEN_SECRET).toBeUndefined();
    expect(fs.readFileSync(file(), 'utf8')).not.toContain('from-env-value');
  });

  test('all four in env: no file is created', () => {
    const env = Object.fromEntries(SECRET_NAMES.map((n) => [n, `v-${n}`]));
    resolveSecrets({ env, dataDir: dir, log: quietLog() });
    expect(fs.existsSync(file())).toBe(false);
  });

  test('a file missing one key gets only that key added; others preserved', () => {
    const existing = {
      ACCESS_TOKEN_SECRET: 'a'.repeat(64),
      REFRESH_TOKEN_SECRET: 'b'.repeat(64),
      MCP_JWT_SECRET: 'c'.repeat(64),
      FUTURE_KEY: 'keep-me',
    };
    fs.writeFileSync(file(), JSON.stringify(existing), { mode: 0o600 });
    const env = {};
    const res = resolveSecrets({ env, dataDir: dir, log: quietLog() });
    expect(res.generated).toEqual(['API_KEY_ENCRYPTION_KEY']);
    const onDisk = JSON.parse(fs.readFileSync(file(), 'utf8'));
    expect(onDisk).toEqual({ ...existing, API_KEY_ENCRYPTION_KEY: env.API_KEY_ENCRYPTION_KEY });
    expect(env.ACCESS_TOKEN_SECRET).toBe('a'.repeat(64));
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  test.each([
    ['unparseable', '{not json'],
    ['a JSON array', '["a"]'],
  ])('%s file throws naming the path and is left byte-identical', (_label, contents) => {
    fs.writeFileSync(file(), contents, { mode: 0o600 });
    expect(() => resolveSecrets({ env: {}, dataDir: dir, log: quietLog() })).toThrow(SecretsError);
    expect(() => resolveSecrets({ env: {}, dataDir: dir, log: quietLog() })).toThrow(file());
    expect(fs.readFileSync(file(), 'utf8')).toBe(contents);
  });

  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  (runningAsRoot ? test.skip : test)('unwritable dir throws naming the dir and the chown fix', () => {
    fs.chmodSync(dir, 0o500);
    let err;
    try { resolveSecrets({ env: {}, dataDir: dir, log: quietLog() }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SecretsError);
    expect(err.message).toContain(dir);
    expect(err.message).toContain('chown -R 100:101');
  });

  test('uncreatable dir (root-safe variant under /proc) throws naming the dir and the chown fix', () => {
    // Root ignores mode bits, so this variant uses a path no one can create.
    const unusable = `/proc/squire-secrets-test-${process.pid}`;
    let err;
    try { resolveSecrets({ env: {}, dataDir: unusable, log: quietLog() }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SecretsError);
    expect(err.message).toContain(unusable);
    expect(err.message).toContain('chown -R 100:101');
  });

  test('API_KEY_ENCRYPTION_KEYS set: an existing generated legacy key is still adopted (058 review M1)', () => {
    fs.writeFileSync(file(), JSON.stringify({ API_KEY_ENCRYPTION_KEY: 'f'.repeat(64) }), { mode: 0o600 });
    const env = { API_KEY_ENCRYPTION_KEYS: `k1:${'1'.repeat(64)}` };
    const res = resolveSecrets({ env, dataDir: dir, log: quietLog() });
    expect(env.API_KEY_ENCRYPTION_KEY).toBe('f'.repeat(64));
    expect(res.fromFile).toContain('API_KEY_ENCRYPTION_KEY');
    expect(res.generated).not.toContain('API_KEY_ENCRYPTION_KEY');
  });

  test('API_KEY_ENCRYPTION_KEYS set and no legacy key on file: none is generated (RBD-058-26)', () => {
    const env = { API_KEY_ENCRYPTION_KEYS: `k1:${'1'.repeat(64)}` };
    const res = resolveSecrets({ env, dataDir: dir, log: quietLog() });
    expect(env.API_KEY_ENCRYPTION_KEY).toBeUndefined();
    expect(res.generated).toEqual(['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET', 'MCP_JWT_SECRET']);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).API_KEY_ENCRYPTION_KEY).toBeUndefined();
  });

  test('a filesystem without hard links falls back to an exclusive create (058 review L1)', () => {
    const spy = jest.spyOn(fs, 'linkSync').mockImplementation(() => {
      const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e;
    });
    try {
      const env = {};
      const res = resolveSecrets({ env, dataDir: dir, log: quietLog() });
      expect(res.generated).toEqual([...SECRET_NAMES]);
      expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(file(), 'utf8')).MCP_JWT_SECRET).toBe(env.MCP_JWT_SECRET);
      expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test('generate: false reads but never creates', () => {
    const env = {};
    const res = resolveSecrets({ env, dataDir: dir, generate: false, log: quietLog() });
    expect(res.generated).toEqual([]);
    expect(fs.existsSync(file())).toBe(false);
    expect(env).toEqual({});

    fs.writeFileSync(file(), JSON.stringify({ MCP_JWT_SECRET: 'm'.repeat(64) }), { mode: 0o600 });
    const env2 = {};
    resolveSecrets({ env: env2, dataDir: dir, generate: false, log: quietLog() });
    expect(env2).toEqual({ MCP_JWT_SECRET: 'm'.repeat(64) });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ MCP_JWT_SECRET: 'm'.repeat(64) });
  });

  test('two racing first boots on one volume end with identical secrets (RBD-058-31)', () => {
    const envA = {};
    const envB = {};
    // A generates, and just before it publishes, B runs a whole boot and wins.
    resolveSecrets({
      env: envA,
      dataDir: dir,
      log: quietLog(),
      _hooks: {
        beforePublish: () => {
          resolveSecrets({ env: envB, dataDir: dir, log: quietLog() });
        },
      },
    });
    for (const n of SECRET_NAMES) {
      expect(envA[n]).toMatch(/^[0-9a-f]{64}$/);
      expect(envA[n]).toBe(envB[n]);
    }
    const onDisk = JSON.parse(fs.readFileSync(file(), 'utf8'));
    for (const n of SECRET_NAMES) expect(onDisk[n]).toBe(envA[n]);
    expect(fs.readdirSync(dir)).toEqual(['secrets.json']);
  });
});
