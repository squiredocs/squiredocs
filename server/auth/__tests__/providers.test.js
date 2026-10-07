/**
 * Feature 059 (T010, T054): the provider registry, the boot check, and the
 * public projection served by GET /auth/providers.
 */
const fs = require('fs');
const path = require('path');
const { _resetInstanceConfigForTests } = require('../../instance-config');
const {
  getProviders,
  getConfiguredButInactive,
  checkBootProviders,
  assertBootable,
  getPublicProviderInfo,
} = require('../providers');

const GOOGLE = { GOOGLE_CLIENT_ID: 'id-123', GOOGLE_CLIENT_SECRET: 'secret-456' };

describe('provider registry', () => {
  const saved = {};
  const KEYS = ['SQUIRE_MODE', 'ENABLE_DEV_ENDPOINTS', 'NODE_ENV', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetInstanceConfigForTests();
  });

  const noFaucet = () => { delete process.env.ENABLE_DEV_ENDPOINTS; };

  test('team with no boot-counting provider names both Google variables', () => {
    noFaucet();
    const providers = getProviders({ mode: 'team', env: {} });
    expect(providers).toEqual([]);
    const check = checkBootProviders({ mode: 'team', providers });
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/GOOGLE_CLIENT_ID/);
    expect(check.message).toMatch(/GOOGLE_CLIENT_SECRET/);
  });

  test('team with the faucet only passes the boot check', () => {
    process.env.ENABLE_DEV_ENDPOINTS = '1';
    process.env.NODE_ENV = 'test';
    const providers = getProviders({ mode: 'team', env: {} });
    expect(providers.map((p) => p.id)).toEqual(['dev']);
    expect(checkBootProviders({ mode: 'team', providers }).ok).toBe(true);
  });

  test('the faucet counts for boot only when devEndpointsEnabled(), and is never listed', () => {
    process.env.ENABLE_DEV_ENDPOINTS = '1';
    process.env.NODE_ENV = 'production';
    expect(getProviders({ mode: 'team', env: {} })).toEqual([]);
    process.env.NODE_ENV = 'test';
    const [dev] = getProviders({ mode: 'local', env: {} });
    expect(dev).toMatchObject({ id: 'dev', listed: false, countsForBoot: true });
  });

  test('team plus Google credentials lists Google only', () => {
    noFaucet();
    expect(getProviders({ mode: 'team', env: GOOGLE })).toEqual([
      { id: 'google', label: 'Google', startPath: '/auth/google', listed: true, countsForBoot: true },
    ]);
  });

  test('team without credentials (or with only one) lists nothing', () => {
    noFaucet();
    expect(getProviders({ mode: 'team', env: {} })).toEqual([]);
    expect(getProviders({ mode: 'team', env: { GOOGLE_CLIENT_ID: 'x' } })).toEqual([]);
  });

  test('local lists nothing even with credentials, and reports Google as configured but inactive', () => {
    noFaucet();
    expect(getProviders({ mode: 'local', env: GOOGLE })).toEqual([]);
    expect(getConfiguredButInactive({ mode: 'local', env: GOOGLE })).toEqual([{ id: 'google', label: 'Google' }]);
    expect(getConfiguredButInactive({ mode: 'team', env: GOOGLE })).toEqual([]);
    expect(getConfiguredButInactive({ mode: 'local', env: {} })).toEqual([]);
  });

  describe('assertBootable', () => {
    const logger = () => ({ log: jest.fn(), error: jest.fn() });

    test('calls the injected exit(1) and logs the FATAL line on error', () => {
      noFaucet();
      process.env.SQUIRE_MODE = 'team';
      _resetInstanceConfigForTests();
      const log = logger();
      const exit = jest.fn();
      expect(assertBootable({ log, exit, env: {} })).toBe(false);
      expect(exit).toHaveBeenCalledWith(1);
      expect(log.error).toHaveBeenCalledWith(
        '[Auth] FATAL: SQUIRE_MODE=team needs at least one sign-in provider. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or use SQUIRE_MODE=local.'
      );
    });

    test('team with Google logs exactly one mode line', () => {
      noFaucet();
      process.env.SQUIRE_MODE = 'team';
      _resetInstanceConfigForTests();
      const log = logger();
      const exit = jest.fn();
      expect(assertBootable({ log, exit, env: GOOGLE })).toBe(true);
      expect(exit).not.toHaveBeenCalled();
      expect(log.log.mock.calls).toEqual([['[Auth] Instance mode: team (providers: google)']]);
    });

    test('local with Google credentials logs the mode line and the inactive line', () => {
      noFaucet();
      process.env.SQUIRE_MODE = 'local';
      _resetInstanceConfigForTests();
      const log = logger();
      assertBootable({ log, exit: jest.fn(), env: GOOGLE });
      const lines = log.log.mock.calls.map((c) => c[0]);
      expect(lines.filter((l) => l.startsWith('[Auth] Instance mode:'))).toEqual([
        '[Auth] Instance mode: local (sign in with: docker compose exec app squire claim-link)',
      ]);
      expect(lines).toContain(
        '[Auth] Google sign-in is configured but inactive in local mode (set SQUIRE_MODE=team to enable it)'
      );
    });
  });

  describe('public projection (FR-016, FR-047)', () => {
    const db = (owner) => ({
      query: jest.fn(async (sql) => {
        if (/app_settings/.test(sql)) return { rows: owner ? [{ id: 'u1' }] : [] };
        return { rows: [] };
      }),
    });

    test('team with Google: exactly id, label, startPath per provider', async () => {
      noFaucet();
      process.env.SQUIRE_MODE = 'team';
      Object.assign(process.env, GOOGLE);
      _resetInstanceConfigForTests();
      const info = await getPublicProviderInfo(db(true));
      expect(Object.keys(info).sort()).toEqual(['hasOwner', 'mode', 'providers', 'signupOpen']);
      expect(info).toEqual({
        mode: 'team',
        hasOwner: true,
        signupOpen: true,
        providers: [{ id: 'google', label: 'Google', startPath: '/auth/google' }],
      });
      expect(JSON.stringify(info)).not.toMatch(/id-123|secret-456/);
    });

    test('local: no providers, sign-up closed; the faucet never appears', async () => {
      process.env.ENABLE_DEV_ENDPOINTS = '1';
      process.env.SQUIRE_MODE = 'local';
      _resetInstanceConfigForTests();
      const info = await getPublicProviderInfo(db(false));
      expect(info).toEqual({ mode: 'local', hasOwner: false, signupOpen: false, providers: [] });
    });

    test('an owner-probe failure reports hasOwner false and logs', async () => {
      process.env.SQUIRE_MODE = 'local';
      _resetInstanceConfigForTests();
      const log = { error: jest.fn() };
      const broken = { query: jest.fn().mockRejectedValue(new Error('db down')) };
      const info = await getPublicProviderInfo(broken, { log });
      expect(info.hasOwner).toBe(false);
      expect(log.error).toHaveBeenCalled();
    });
  });
});

describe('boot wiring (T054)', () => {
  test('server/index.js calls assertBootable( before the first app.listen(', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
    const boot = src.indexOf('assertBootable(');
    const listen = src.indexOf('.listen(');
    expect(boot).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(listen);
  });
});
