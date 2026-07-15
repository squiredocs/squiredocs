/**
 * Abuse-resistance suite (feature 008, T025).
 *
 * Rate limits, caps, slow_down escalation, anti-enumeration uniformity, and
 * inert hostile input. The limiter is forced to its in-process backend and
 * reset per case for determinism. The global pending cap is lowered via the
 * LOGIN_MAX_PENDING_GLOBAL seam (analyze C2) so the cap is exercised without
 * inserting ~500 rows.
 */
process.env.LOGIN_RATE_LIMIT_FORCE_MEMORY = '1';
process.env.LOGIN_MAX_PENDING_GLOBAL = '6';

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');
const { generateAccessToken } = require('../../../auth/jwt');
const login = require('../../tools/login');
const loginService = require('../../auth/login-service');
const delegation = require('../../auth/delegation');
const apiTokens = require('../../auth/api-tokens');
const rateLimit = require('../../auth/rate-limit');
const mcpLoginRouter = require('../../auth/login-router');
const { createLoginClaimRouter } = require('../../../api/mcp-login-claim');
const { MAX_PENDING_PER_IP, MAX_PENDING_GLOBAL } = require('../../auth/login-constants');

const pool = createPool();
const persistence = createPersistence();

const UNIFORM_CLAIM_404 = { error: 'invalid_or_expired' };

async function insertPending(ip) {
  await pool.query(
    `INSERT INTO mcp_pending_authorizations (handle_hash, user_code_hash, agent_name, origin_ip, expires_at)
     VALUES ($1, $2, 'Filler', $3, NOW() + interval '10 minutes')`,
    [crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16).toString('hex'), ip]
  );
}

describe('login abuse resistance', () => {
  let app;
  let users; // [{ id, token }]

  beforeAll(async () => {
    loginService.init(pool);
    delegation.init(pool);
    apiTokens.init(pool);

    users = [];
    for (let i = 0; i < 6; i += 1) {
      const u = await pool.query(
        `INSERT INTO users (google_id, email, name, picture)
         VALUES ($1, $2, 'Abuse User', NULL)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, email, name, picture, is_admin`,
        [`abuse-user-${i}`, `abuse-user-${i}@example.com`]
      );
      users.push({ id: u.rows[0].id, token: generateAccessToken(u.rows[0]) });
    }

    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/mcp/login', mcpLoginRouter);
    app.use(createLoginClaimRouter(persistence));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM mcp_pending_authorizations');
    for (const u of users) {
      await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [u.id]);
      await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [u.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
    }
    await persistence.destroy();
    await pool.end();
    delete process.env.LOGIN_MAX_PENDING_GLOBAL;
  });

  beforeEach(async () => {
    rateLimit._reset();
    await pool.query('DELETE FROM mcp_pending_authorizations');
  });

  const codeReq = (code, token, ip) =>
    request(app).post('/mcp/login/code').set('Authorization', `Bearer ${token}`)
      .set('X-Forwarded-For', ip).send({ code });
  const claimReq = (handle, ip) =>
    request(app).get('/api/mcp/login/claim').set('Authorization', `Bearer ${handle}`)
      .set('X-Forwarded-For', ip);

  test('the 11th login/minute from one IP is rate_limited', async () => {
    const ctx = { baseUrl: 'https://x', clientIp: '11.11.11.11' };
    for (let i = 0; i < 10; i += 1) {
      const ok = await login.handler({ agentName: `A${i}` }, ctx);
      expect(ok.status).toBe('pending_authorization');
      await pool.query('DELETE FROM mcp_pending_authorizations'); // isolate from the per-IP cap
    }
    const limited = await login.handler({ agentName: 'Over' }, ctx);
    expect(limited.status).toBe('rate_limited');
    expect(limited.retryable).toBe(true);
  });

  test(`the ${MAX_PENDING_PER_IP + 1}th outstanding pending per IP is rate_limited and creates no row`, async () => {
    const ctx = { baseUrl: 'https://x', clientIp: '22.22.22.22' };
    for (let i = 0; i < MAX_PENDING_PER_IP; i += 1) {
      const ok = await login.handler({ agentName: `A${i}` }, ctx);
      expect(ok.status).toBe('pending_authorization');
    }
    const limited = await login.handler({ agentName: 'Over' }, ctx);
    expect(limited.status).toBe('rate_limited');
    const count = await pool.query('SELECT COUNT(*)::int AS c FROM mcp_pending_authorizations');
    expect(count.rows[0].c).toBe(MAX_PENDING_PER_IP);
  });

  test('the global pending cap rate-limits a fresh IP once the ceiling is reached', async () => {
    expect(MAX_PENDING_GLOBAL).toBe(6); // seam applied
    // Fill the global cap with rows spread across IPs (≤ per-IP cap each).
    for (let i = 0; i < MAX_PENDING_GLOBAL; i += 1) {
      await insertPending(`10.0.0.${i}`);
    }
    const limited = await login.handler(
      { agentName: 'Fresh IP' },
      { baseUrl: 'https://x', clientIp: '33.33.33.33' }
    );
    expect(limited.status).toBe('rate_limited');
  });

  test('premature polls escalate the interval +5s each without invalidating the handle (D8)', async () => {
    const { handle } = await login.handler(
      { agentName: 'Poller' },
      { baseUrl: 'https://x', clientIp: '44.44.44.44' }
    );
    const opts = { baseUrl: 'https://x' };
    const p1 = await loginService.getStatus(handle, opts); // compliant (first)
    expect(p1.status).toBe('pending');
    const p2 = await loginService.getStatus(handle, opts); // premature → 10
    expect(p2.status).toBe('slow_down');
    expect(p2.pollIntervalSeconds).toBe(10);
    const p3 = await loginService.getStatus(handle, opts); // premature → 15
    expect(p3.status).toBe('slow_down');
    expect(p3.pollIntervalSeconds).toBe(15);

    // A compliant poll (agent waited) still works — the handle was never invalidated.
    await pool.query('UPDATE mcp_pending_authorizations SET last_polled_at = NULL');
    const p4 = await loginService.getStatus(handle, opts);
    expect(p4.status).toBe('pending');
  });

  test('code entry: 6th attempt/minute/user → 429', async () => {
    const { token } = users[0];
    for (let i = 0; i < 5; i += 1) {
      const r = await codeReq('BCDF-GHJK', token, '55.0.0.1'); // wrong code → 400
      expect(r.status).toBe(400);
    }
    const limited = await codeReq('BCDF-GHJK', token, '55.0.0.1');
    expect(limited.status).toBe(429);
  });

  test('code entry: 21st attempt/hour/IP → 429', async () => {
    const ip = '66.0.0.1';
    // 21 attempts spread over 6 users (≤ 5/user/min) from one IP.
    let last;
    for (let i = 0; i < 21; i += 1) {
      last = await codeReq('BCDF-GHJK', users[i % users.length].token, ip);
    }
    expect(last.status).toBe(429);
  });

  test('claim: 11th/minute/IP → 429 keyed before handle inspection; a valid handle claims after cooldown', async () => {
    const ip = '77.0.0.1';
    for (let i = 0; i < 10; i += 1) {
      const r = await claimReq('sqlh_made-up', ip);
      expect(r.status).toBe(404);
    }
    const limited = await claimReq('sqlh_made-up', ip);
    expect(limited.status).toBe(429);

    // Cooldown, then a genuinely approved handle claims.
    rateLimit._reset();
    const p = await loginService.createPendingAuthorization({ agentName: 'Valid', ip: '77.9.9.9', baseUrl: 'https://x' });
    const entered = await loginService.enterCode(p.userCode, users[0].id);
    await loginService.approveAuthorization(entered.authorizationId, users[0].id);
    const ok = await claimReq(p.handle, ip);
    expect(ok.status).toBe(200);
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [users[0].id]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [users[0].id]);
  });

  test('consumed / denied / expired / fabricated handles claim byte-identical (404)', async () => {
    // claimed
    const c = await loginService.createPendingAuthorization({ agentName: 'C', ip: '88.0.0.1', baseUrl: 'https://x' });
    let e = await loginService.enterCode(c.userCode, users[1].id);
    await loginService.approveAuthorization(e.authorizationId, users[1].id);
    await loginService.claimCredential(c.handle, 'rest'); // now claimed
    // denied
    const d = await loginService.createPendingAuthorization({ agentName: 'D', ip: '88.0.0.2', baseUrl: 'https://x' });
    e = await loginService.enterCode(d.userCode, users[1].id);
    await loginService.denyAuthorization(e.authorizationId, users[1].id);
    // expired (past TTL, never approved)
    const x = await loginService.createPendingAuthorization({ agentName: 'X', ip: '88.0.0.3', baseUrl: 'https://x' });
    await pool.query("UPDATE mcp_pending_authorizations SET expires_at = NOW() - interval '1 second' WHERE handle_hash = $1", [loginService.hashHandle(x.handle)]);

    rateLimit._reset();
    for (const handle of [c.handle, d.handle, x.handle, 'sqlh_fabricated']) {
      const r = await claimReq(handle, '88.9.9.9');
      expect(r.status).toBe(404);
      expect(r.body).toEqual(UNIFORM_CLAIM_404);
    }
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [users[1].id]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [users[1].id]);
  });

  test('consumed / expired / fabricated handles poll byte-identical (expired); denied stays distinct', async () => {
    // claimed
    const c = await loginService.createPendingAuthorization({ agentName: 'C', ip: '99.0.0.1', baseUrl: 'https://x' });
    let e = await loginService.enterCode(c.userCode, users[2].id);
    await loginService.approveAuthorization(e.authorizationId, users[2].id);
    await loginService.claimCredential(c.handle, 'rest');
    // expired
    const x = await loginService.createPendingAuthorization({ agentName: 'X', ip: '99.0.0.2', baseUrl: 'https://x' });
    await pool.query("UPDATE mcp_pending_authorizations SET expires_at = NOW() - interval '1 second' WHERE handle_hash = $1", [loginService.hashHandle(x.handle)]);
    // denied
    const d = await loginService.createPendingAuthorization({ agentName: 'D', ip: '99.0.0.3', baseUrl: 'https://x' });
    e = await loginService.enterCode(d.userCode, users[2].id);
    await loginService.denyAuthorization(e.authorizationId, users[2].id);

    const opts = { baseUrl: 'https://x' };
    const claimed = await loginService.getStatus(c.handle, opts);
    const expired = await loginService.getStatus(x.handle, opts);
    const fabricated = await loginService.getStatus('sqlh_fabricated', opts);
    expect(claimed).toEqual(expired);
    expect(fabricated).toEqual(expired);
    expect(expired.status).toBe('expired');

    const denied = await loginService.getStatus(d.handle, opts);
    expect(denied.status).toBe('denied');
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [users[2].id]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [users[2].id]);
  });

  test('hostile agentName: control chars rejected; a 100-char markup name is accepted and stored raw', async () => {
    const ctx = { baseUrl: 'https://x', clientIp: '123.0.0.1' };
    await expect(login.handler({ agentName: 'bad\x00name' }, ctx)).rejects.toThrow(/control characters/);

    const markup = `<b>${'x'.repeat(90)}</b>`.slice(0, 100);
    const res = await login.handler({ agentName: markup }, ctx);
    expect(res.status).toBe('pending_authorization');
    const row = await pool.query('SELECT agent_name FROM mcp_pending_authorizations ORDER BY created_at DESC LIMIT 1');
    expect(row.rows[0].agent_name).toBe(markup);
  });
});
