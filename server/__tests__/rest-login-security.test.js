/**
 * REST login security parity (feature 009, US2 / SC-002, T011+T012): the new
 * door inherits 008's contract with NO budget doubled, no oracle, and one-shot
 * semantics held jointly across every channel.
 *
 * (The canonical-vs-alias shared claim:ip budget is proven in
 * mcp-login-claim.test.js; here we prove the login:ip budget is shared between
 * the MCP login tool and REST start, the pending caps are flow-wide, the no-
 * oracle collapse holds for consumed/expired/fabricated/auth-defect inputs, the
 * inline token-limit carve-out surfaces, and delivery is exactly-once across
 * channels.) Serial DB; deterministic in-memory rate-limit counter.
 */
process.env.LOGIN_RATE_LIMIT_FORCE_MEMORY = '1';

const express = require('express');
const request = require('supertest');
const { createPool, createPersistence } = require('./helpers/db');
const { createLoginRouter } = require('../api/login');
const { createLoginClaimRouter } = require('../api/mcp-login-claim');
const loginTool = require('../mcp/tools/login');
const loginService = require('../mcp/auth/login-service');
const delegation = require('../mcp/auth/delegation');
const apiTokens = require('../mcp/auth/api-tokens');
const rateLimit = require('../mcp/auth/rate-limit');

const pool = createPool();
const persistence = createPersistence();

describe('REST login security parity (shared budgets, no oracle, one-shot)', () => {
  let app;
  let userId;

  beforeAll(async () => {
    loginService.init(pool);
    delegation.init(pool);
    apiTokens.init(pool);
    const u = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('rest-sec-test', 'rest-sec@example.com', 'REST Sec User', NULL)
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

  const IP = '203.0.113.200';
  const restStart = (agentName, ip = IP) =>
    request(app).post('/api/login/start').set('X-Forwarded-For', ip).send({ agentName });
  const restStatus = (handle, inline = false) => {
    let r = request(app).get('/api/login/status');
    if (inline) r = r.query({ inline: 'true' });
    return r.set('Authorization', `Bearer ${handle}`);
  };
  const claimCanonical = (handle) =>
    request(app).get('/api/login/claim').set('Authorization', `Bearer ${handle}`);

  async function approve(userCode) {
    const entered = await loginService.enterCode(userCode, userId);
    const approved = await loginService.approveAuthorization(entered.authorizationId, userId);
    expect(approved.status).toBe('approved');
  }
  async function ageLastPoll(handle) {
    await pool.query(
      "UPDATE mcp_pending_authorizations SET last_polled_at = NOW() - interval '60 seconds' WHERE handle_hash = $1",
      [loginService.hashHandle(handle)]
    );
  }

  // ── T011: shared budgets (RD-8) ────────────────────────────────────────────

  // Clearing pendings between iterations isolates the login:ip budget (the per-IP
  // PENDING cap of 5 is a separate gate); each start still spends the login gate.
  const clearPendings = () => pool.query('DELETE FROM mcp_pending_authorizations');

  test('login:ip budget is SHARED: 10 starts via the tool, then REST start on the same IP → 429', async () => {
    // Spend the whole per-IP login budget through the MCP tool handler…
    for (let i = 0; i < 10; i += 1) {
      const r = await loginTool.handler(
        { agentName: `Tool ${i}` },
        { isAnonymous: true, baseUrl: 'https://squiredocs.com', clientIp: IP }
      );
      expect(r.status).toBe('pending_authorization');
      await clearPendings();
    }
    // …the REST door on the same IP does NOT get a fresh 10 — it is already spent.
    const res = await restStart('RestOverflow');
    expect(res.status).toBe(429);
    expect(res.body.status).toBe('rate_limited');
    expect(res.headers['retry-after']).toBeDefined();
  });

  test('mixed tool+REST starts share one budget: 10 mixed from one IP, 11th blocked on either channel', async () => {
    for (let i = 0; i < 10; i += 1) {
      if (i % 2 === 0) {
        const r = await loginTool.handler(
          { agentName: `Mix ${i}` },
          { isAnonymous: true, baseUrl: 'https://squiredocs.com', clientIp: IP }
        );
        expect(r.status).toBe('pending_authorization');
      } else {
        const r = await restStart(`Mix ${i}`);
        expect(r.status).toBe(200);
      }
      await clearPendings();
    }
    // The 11th start on the same IP is blocked on the shared login budget,
    // whichever door it comes through.
    const eleventh = await restStart('Mix 11');
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.status).toBe('rate_limited');
  });

  test('per-IP pending cap is flow-wide: the 6th pending from one IP → uniform rate-limited 429', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await restStart(`Pending ${i}`);
      expect(r.status).toBe(200);
    }
    const sixth = await restStart('Pending 6');
    expect(sixth.status).toBe(429);
    expect(sixth.body.status).toBe('rate_limited');
  });

  // ── T012: no oracle / one-shot across channels ─────────────────────────────

  test('fabricated / expired / consumed handle + auth-header defects are all indistinguishable', async () => {
    const fabricated = await restStatus('sqlh_made-up');
    expect(fabricated.body.status).toBe('expired');

    // Expired: an approved pairing past its claim window collapses to the same body.
    const sExp = await restStart('Expired');
    await approve(sExp.body.userCode);
    await pool.query(
      "UPDATE mcp_pending_authorizations SET claim_expires_at = NOW() - interval '1 second' WHERE handle_hash = $1",
      [loginService.hashHandle(sExp.body.handle)]
    );
    const expired = await restStatus(sExp.body.handle);

    // Consumed: claim it, then status + claim collapse to the uniform outcomes.
    const sCon = await restStart('Consumed');
    await approve(sCon.body.userCode);
    const firstApproved = await restStatus(sCon.body.handle);
    expect(firstApproved.body.status).toBe('approved');
    const claimed = await claimCanonical(sCon.body.handle);
    expect(claimed.status).toBe(200);
    await ageLastPoll(sCon.body.handle);
    const consumedStatus = await restStatus(sCon.body.handle);

    for (const r of [expired, consumedStatus]) {
      expect(r.body).toEqual(fabricated.body);
    }
    // Auth-header defects match the fabricated body too (RD-6).
    const missing = await request(app).get('/api/login/status');
    const wrongScheme = await request(app)
      .get('/api/login/status')
      .set('Authorization', 'Basic Zm9vOmJhcg==');
    for (const r of [missing, wrongScheme]) expect(r.body).toEqual(fabricated.body);

    // Claim on a consumed handle is the uniform 404, same as a fabricated one.
    const claimConsumed = await claimCanonical(sCon.body.handle);
    const claimFabricated = await claimCanonical('sqlh_made-up');
    expect(claimConsumed.status).toBe(404);
    expect(claimConsumed.body).toEqual(claimFabricated.body);
  });

  test('double delivery across channels → exactly one credential ever (REST claim then inline expired)', async () => {
    const s = await restStart('DoubleDeliver');
    await approve(s.body.userCode);
    const approved = await restStatus(s.body.handle);
    expect(approved.body.status).toBe('approved');
    const claim1 = await claimCanonical(s.body.handle);
    expect(claim1.status).toBe(200);
    // A later inline poll on the SAME pairing gets no second credential.
    await ageLastPoll(s.body.handle);
    const inlineAfter = await restStatus(s.body.handle, true);
    expect(inlineAfter.body.status).toBe('expired');
    expect(inlineAfter.body.credential).toBeUndefined();
  });

  test('inline token-limit carve-out (008 D13): actionable token_limit, approval stays valid', async () => {
    const s = await restStart('InlineTokenLimit');
    await approve(s.body.userCode);
    // Fill the user to the active-token cap so the inline mint fails.
    for (let i = 0; i < apiTokens.MAX_TOKENS_PER_USER; i += 1) {
      await apiTokens.createToken(userId, `filler-inline-${i}`, {
        expiresAt: new Date(Date.now() + 3600_000),
      });
    }
    const capped = await restStatus(s.body.handle, true);
    expect(capped.status).toBe(200);
    expect(capped.body.status).toBe('token_limit');
    expect(capped.body.message).toMatch(/API-token limit/i);
    // The approval is untouched — still 'approved' in the DB, retriable in-window.
    const row = await pool.query(
      'SELECT state FROM mcp_pending_authorizations WHERE handle_hash = $1',
      [loginService.hashHandle(s.body.handle)]
    );
    expect(row.rows[0].state).toBe('approved');
  });

  test('inline on an unknown handle collapses to uniform expired (no credential path)', async () => {
    const res = await restStatus('sqlh_made-up', true);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('expired');
    expect(res.body.credential).toBeUndefined();
    // 009 review: no-store is now stamped on EVERY /api/login response (start
    // carries handle+code; non-inline approved embeds the handle in
    // claimCommand), not just credential-bearing ones.
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
