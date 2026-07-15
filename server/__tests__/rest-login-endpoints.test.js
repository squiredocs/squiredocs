/**
 * REST login endpoints (feature 009, T008): POST /api/login/start and
 * GET /api/login/status as first-class plain-REST wrappers over the one
 * login-service state machine.
 *
 * Pins the start happy-path superset + no JSON-RPC envelope, agentName
 * validation (400, no pending), every status decision-table outcome at HTTP 200,
 * the canonical claimCommand + nextSteps on approval, RD-6 uniform-expired on any
 * auth-header defect, and the ?inline=true one-time credential (no-store,
 * do-not-echo warning). Serial DB; deterministic in-memory rate-limit counter.
 */
process.env.LOGIN_RATE_LIMIT_FORCE_MEMORY = '1';

const express = require('express');
const request = require('supertest');
const { createPool, createPersistence } = require('./helpers/db');
const { createLoginRouter } = require('../api/login');
const { createLoginClaimRouter } = require('../api/mcp-login-claim');
const loginService = require('../mcp/auth/login-service');
const delegation = require('../mcp/auth/delegation');
const apiTokens = require('../mcp/auth/api-tokens');
const rateLimit = require('../mcp/auth/rate-limit');

const pool = createPool();
const persistence = createPersistence();

describe('REST login endpoints (start / status)', () => {
  let app;
  let userId;

  beforeAll(async () => {
    loginService.init(pool);
    delegation.init(pool);
    apiTokens.init(pool);
    const u = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('rest-login-test', 'rest-login@example.com', 'REST Login User', NULL)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`
    );
    userId = u.rows[0].id;

    app = express();
    app.set('trust proxy', true);
    app.use(createLoginRouter(persistence));
    app.use(createLoginClaimRouter(persistence));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM mcp_pending_authorizations');
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await persistence.destroy();
    await pool.end();
  });

  beforeEach(async () => {
    rateLimit._reset();
    await pool.query('DELETE FROM mcp_pending_authorizations');
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [userId]);
  });

  const start = (agentName) =>
    request(app).post('/api/login/start').send({ agentName });
  const status = (handle, opts = {}) => {
    let r = request(app).get('/api/login/status');
    if (opts.inline) r = r.query({ inline: 'true' });
    if (handle !== undefined) r = r.set('Authorization', `Bearer ${handle}`);
    return r;
  };

  // Approve a started pairing directly through the service (no browser).
  async function approve(userCode) {
    const entered = await loginService.enterCode(userCode, userId);
    const approved = await loginService.approveAuthorization(entered.authorizationId, userId);
    expect(approved.status).toBe('approved');
    return entered.authorizationId;
  }

  test('start: HTTP 200 plain JSON superset, no JSON-RPC envelope, REST-phrased instructions', async () => {
    const res = await start('Demo');
    expect(res.status).toBe(200);
    // Enumerated minimum (design) + superset (RD-1).
    expect(res.body.status).toBe('pending_authorization');
    expect(res.body.handle).toMatch(/^sqlh_/);
    expect(res.body.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(res.body.verificationUri).toMatch(/\/activate$/);
    expect(res.body.expiresInSeconds).toBe(600);
    expect(res.body.pollIntervalSeconds).toBe(5);
    // No JSON-RPC envelope, no double-encoded text blocks.
    expect(res.body.jsonrpc).toBeUndefined();
    expect(res.body.result).toBeUndefined();
    expect(res.body.content).toBeUndefined();
    // Instructions rephrased for the REST channel (poll the status URL, not the tool).
    expect(res.body.instructions).toContain('GET');
    expect(res.body.instructions).toContain('/api/login/status');
    expect(res.body.instructions).not.toContain('login_status(');
  });

  test('start: invalid agentName → HTTP 400 and NO pending authorization created', async () => {
    const before = await pool.query('SELECT COUNT(*)::int AS n FROM mcp_pending_authorizations');
    const res = await start('   ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_agent_name');
    const after = await pool.query('SELECT COUNT(*)::int AS n FROM mcp_pending_authorizations');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test('status: pending → HTTP 200 status:pending', async () => {
    const s = await start('Pend');
    const res = await status(s.body.handle);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.pollIntervalSeconds).toBe(5);
  });

  test('status: premature second poll → HTTP 200 status:slow_down (interval raised)', async () => {
    const s = await start('Fast');
    await status(s.body.handle); // first poll primes last_polled_at
    const res = await status(s.body.handle); // immediate second poll is premature
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('slow_down');
    expect(res.body.pollIntervalSeconds).toBeGreaterThan(5);
  });

  test('status: denied → HTTP 200 status:denied', async () => {
    const s = await start('Deny');
    const entered = await loginService.enterCode(s.body.userCode, userId);
    await loginService.denyAuthorization(entered.authorizationId, userId);
    const res = await status(s.body.handle);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('denied');
  });

  test('status: approved (first delivery) → 200 canonical claimCommand + nextSteps, no credential', async () => {
    const s = await start('Approve');
    await approve(s.body.userCode);
    const res = await status(s.body.handle);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.claimCommand).toContain('/api/login/claim');
    expect(res.body.claimCommand).not.toContain('/api/mcp/login/claim');
    expect(res.body.nextSteps).toBeDefined();
    expect(res.body.nextSteps.registerMcp).toContain('--header');
    expect(JSON.stringify(res.body)).not.toContain('sk_sqd_');
  });

  test('status: second poll after approved delivery → HTTP 200 uniform expired (one-shot)', async () => {
    const s = await start('Once');
    await approve(s.body.userCode);
    const first = await status(s.body.handle);
    expect(first.body.status).toBe('approved');
    // Age last_polled_at so the second poll is not throttled as premature and we
    // observe the consumed one-shot (the approved payload is delivered exactly once).
    await pool.query(
      "UPDATE mcp_pending_authorizations SET last_polled_at = NOW() - interval '60 seconds' WHERE handle_hash = $1",
      [loginService.hashHandle(s.body.handle)]
    );
    const second = await status(s.body.handle);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('expired');
  });

  test('status RD-6: missing / malformed / wrong-scheme header ≡ fabricated handle (uniform expired)', async () => {
    const fabricated = await status('sqlh_totally-made-up');
    const missing = await request(app).get('/api/login/status');
    const emptyBearer = await request(app).get('/api/login/status').set('Authorization', 'Bearer ');
    const wrongScheme = await request(app)
      .get('/api/login/status')
      .set('Authorization', 'Basic c29tZTp0aGluZw==');
    for (const r of [fabricated, missing, emptyBearer, wrongScheme]) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual(fabricated.body);
      expect(r.body.status).toBe('expired');
    }
    // The handle is never accepted from the query string.
    const viaQuery = await request(app).get('/api/login/status').query({ handle: 'sqlh_x' });
    expect(viaQuery.body).toEqual(fabricated.body);
  });

  test('status ?inline=true: one-time in-band credential, no-store, do-not-echo warning + nextSteps', async () => {
    const s = await start('Inline');
    await approve(s.body.userCode);
    const res = await status(s.body.handle, { inline: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.credential).toMatch(/^sk_sqd_/);
    expect(res.body.warning).toMatch(/DO NOT ECHO/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.nextSteps).toBeDefined();
    // Inline is a claim through the polling channel — no recipe claimCommand.
    expect(res.body.claimCommand).toBeUndefined();
  });
});
