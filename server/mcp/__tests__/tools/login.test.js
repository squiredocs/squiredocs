/**
 * login tool handler contract tests (feature 008, T016).
 */
process.env.LOGIN_RATE_LIMIT_FORCE_MEMORY = '1';

const { createPool } = require('../../../__tests__/helpers/db');
const login = require('../../tools/login');
const loginService = require('../../auth/login-service');
const delegation = require('../../auth/delegation');
const apiTokens = require('../../auth/api-tokens');
const rateLimit = require('../../auth/rate-limit');

const pool = createPool();
const ctx = { isAnonymous: true, baseUrl: 'https://squiredocs.com', clientIp: '203.0.113.42' };

async function countRows() {
  const r = await pool.query('SELECT COUNT(*)::int AS c FROM mcp_pending_authorizations');
  return r.rows[0].c;
}

describe('login tool handler', () => {
  beforeAll(() => {
    loginService.init(pool);
    delegation.init(pool);
    apiTokens.init(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM mcp_pending_authorizations');
    await pool.end();
  });

  beforeEach(async () => {
    rateLimit._reset();
    await pool.query('DELETE FROM mcp_pending_authorizations');
  });

  test('returns the pending_authorization payload shape', async () => {
    const res = await login.handler({ agentName: 'Contract Agent' }, ctx);
    expect(res.status).toBe('pending_authorization');
    expect(res.handle).toMatch(/^sqlh_[A-Za-z0-9_-]{43}$/);
    expect(res.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(res.verificationUri).toBe('https://squiredocs.com/activate');
    expect(res.expiresInSeconds).toBe(600);
    expect(res.pollIntervalSeconds).toBe(5);
    expect(res.instructions).toContain('/activate');
    // The verification URI never carries the code (D3).
    expect(res.verificationUri).not.toContain(res.userCode.replace('-', ''));
  });

  test('a validation failure throws and creates no row', async () => {
    const before = await countRows();
    await expect(login.handler({ agentName: '   ' }, ctx)).rejects.toThrow(
      /Invalid parameters for tool 'login'/
    );
    await expect(login.handler({ agentName: 'bad\x00name' }, ctx)).rejects.toThrow(/control characters/);
    await expect(login.handler({ agentName: 'a'.repeat(101) }, ctx)).rejects.toThrow(/100 characters/);
    expect(await countRows()).toBe(before);
  });

  test('accepts a hostile-but-legal agentName and stores it raw', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const res = await login.handler({ agentName: hostile }, ctx);
    expect(res.status).toBe('pending_authorization');
    const row = await pool.query('SELECT agent_name FROM mcp_pending_authorizations ORDER BY created_at DESC LIMIT 1');
    expect(row.rows[0].agent_name).toBe(hostile);
  });

  test('the 11th login in a minute from one IP is rate_limited (uniform, retriable)', async () => {
    // Clear pending rows between calls so the per-IP pending cap (5) — which
    // shares the same uniform shape — doesn't trip first; this isolates the
    // 10/min login rate limiter. (The pending cap is covered by the abuse suite.)
    for (let i = 0; i < 10; i += 1) {
      const ok = await login.handler({ agentName: `Agent ${i}` }, ctx);
      expect(ok.status).toBe('pending_authorization');
      await pool.query('DELETE FROM mcp_pending_authorizations');
    }
    const limited = await login.handler({ agentName: 'Over The Limit' }, ctx);
    expect(limited).toEqual({
      status: 'rate_limited',
      retryable: true,
      message: 'Too many login attempts. Wait a minute and try again.',
    });
    // Rate-limited login creates no pending row (gate fires before insert).
    expect(await countRows()).toBe(0);
  });

  test('works for an authenticated caller too (D2)', async () => {
    const authCtx = { userId: 'x', baseUrl: 'https://squiredocs.com', clientIp: '198.51.100.7' };
    const res = await login.handler({ agentName: 'Authed Agent' }, authCtx);
    expect(res.status).toBe('pending_authorization');
  });
});
