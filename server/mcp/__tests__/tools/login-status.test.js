/**
 * login_status tool handler contract tests (feature 008, T016).
 */
process.env.LOGIN_RATE_LIMIT_FORCE_MEMORY = '1';

const { createPool } = require('../../../__tests__/helpers/db');
const login = require('../../tools/login');
const loginStatus = require('../../tools/login-status');
const loginService = require('../../auth/login-service');
const delegation = require('../../auth/delegation');
const apiTokens = require('../../auth/api-tokens');
const rateLimit = require('../../auth/rate-limit');

const pool = createPool();
const ctx = { isAnonymous: true, baseUrl: 'https://squiredocs.com', clientIp: '203.0.113.9' };

async function freshHandle() {
  await pool.query('UPDATE mcp_pending_authorizations SET last_polled_at = NULL');
  const res = await login.handler({ agentName: 'Status Agent' }, ctx);
  return res.handle;
}

describe('login_status tool handler', () => {
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

  test('a fresh handle polls as pending', async () => {
    const handle = await freshHandle();
    const res = await loginStatus.handler({ handle }, ctx);
    expect(res.status).toBe('pending');
    expect(res.expiresInSeconds).toBeGreaterThan(0);
    expect(res.pollIntervalSeconds).toBe(5);
  });

  test('an unknown / fabricated handle is uniform expired (no oracle)', async () => {
    const res = await loginStatus.handler({ handle: 'sqlh_totally-made-up' }, ctx);
    expect(res.status).toBe('expired');
    expect(res.message).toMatch(/Expired or unknown/);
  });

  test('inline: true while still pending returns plain pending', async () => {
    const handle = await freshHandle();
    const res = await loginStatus.handler({ handle, inline: true }, ctx);
    expect(res.status).toBe('pending');
  });

  test('a premature second poll returns slow_down with a raised interval (D8)', async () => {
    const handle = await freshHandle();
    const first = await loginStatus.handler({ handle }, ctx);
    expect(first.status).toBe('pending');
    const second = await loginStatus.handler({ handle }, ctx);
    expect(second.status).toBe('slow_down');
    expect(second.pollIntervalSeconds).toBe(10);
  });
});
