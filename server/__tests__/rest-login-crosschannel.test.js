/**
 * Cross-channel equivalence (feature 009, T010): the REST wrappers and the MCP
 * login tools are two doors on ONE state machine.
 *
 * Drives the same pairings through both the REST router (supertest) and the
 * `login` / `login_status` tool handlers (direct calls) and proves: a pairing is
 * one pairing regardless of which door starts or polls it; the poll interval is
 * per-handle and shared; the approved payload is delivered exactly once BETWEEN
 * the channels; the canonical and alias claim consume the same one-shot; and a
 * premature poll raises the shared interval without consuming the one-shot.
 * Serial DB; deterministic in-memory rate-limit counter.
 */
process.env.LOGIN_RATE_LIMIT_FORCE_MEMORY = '1';

const express = require('express');
const request = require('supertest');
const { createPool, createPersistence } = require('./helpers/db');
const { createLoginRouter } = require('../api/login');
const { createLoginClaimRouter } = require('../api/mcp-login-claim');
const loginTool = require('../mcp/tools/login');
const loginStatusTool = require('../mcp/tools/login-status');
const loginService = require('../mcp/auth/login-service');
const delegation = require('../mcp/auth/delegation');
const apiTokens = require('../mcp/auth/api-tokens');
const rateLimit = require('../mcp/auth/rate-limit');

const pool = createPool();
const persistence = createPersistence();

const TOOL_CTX = { isAnonymous: true, baseUrl: 'https://squiredocs.com', clientIp: '198.51.100.7' };

describe('REST ↔ MCP-tool cross-channel equivalence', () => {
  let app;
  let userId;

  beforeAll(async () => {
    loginService.init(pool);
    delegation.init(pool);
    apiTokens.init(pool);
    const u = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('xchan-test', 'xchan@example.com', 'Cross Channel User', NULL)
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

  // Doors.
  const restStart = (agentName) => request(app).post('/api/login/start').send({ agentName });
  const restStatus = (handle, inline = false) => {
    let r = request(app).get('/api/login/status');
    if (inline) r = r.query({ inline: 'true' });
    return r.set('Authorization', `Bearer ${handle}`);
  };
  const toolStart = (agentName) => loginTool.handler({ agentName }, TOOL_CTX);
  const toolStatus = (handle, inline = false) =>
    loginStatusTool.handler({ handle, inline }, TOOL_CTX);

  async function approve(userCode) {
    const entered = await loginService.enterCode(userCode, userId);
    const approved = await loginService.approveAuthorization(entered.authorizationId, userId);
    expect(approved.status).toBe('approved');
  }

  // Age last_polled_at so the NEXT poll is not throttled as premature — lets us
  // observe the post-delivery outcome (expired) rather than a slow_down.
  async function ageLastPoll(handle) {
    await pool.query(
      "UPDATE mcp_pending_authorizations SET last_polled_at = NOW() - interval '60 seconds' WHERE handle_hash = $1",
      [loginService.hashHandle(handle)]
    );
  }

  test('start over REST → poll via the tool observes the same pending pairing', async () => {
    const s = await restStart('RestStart');
    const viaTool = await toolStatus(s.body.handle);
    expect(viaTool.status).toBe('pending');
    expect(viaTool.expiresInSeconds).toBeGreaterThan(0);
  });

  test('start via the tool → poll over REST observes the same pending pairing', async () => {
    const started = await toolStart('ToolStart');
    expect(started.status).toBe('pending_authorization');
    const viaRest = await restStatus(started.handle);
    expect(viaRest.status).toBe(200);
    expect(viaRest.body.status).toBe('pending');
  });

  test('poll interval is per-handle and shared: prime over REST, premature poll via tool → slow_down', async () => {
    const s = await restStart('SharedInterval');
    await restStatus(s.body.handle); // primes last_polled_at
    const viaTool = await toolStatus(s.body.handle); // immediate → premature
    expect(viaTool.status).toBe('slow_down');
    expect(viaTool.pollIntervalSeconds).toBeGreaterThan(5);
  });

  test('exactly one approved delivery between channels: tool delivers, REST then expired', async () => {
    const started = await toolStart('OneDeliveryA');
    await approve(started.userCode);
    const viaTool = await toolStatus(started.handle);
    expect(viaTool.status).toBe('approved');
    expect(viaTool.claimCommand).toContain('/api/login/claim');
    await ageLastPoll(started.handle);
    const viaRest = await restStatus(started.handle);
    expect(viaRest.body.status).toBe('expired');
  });

  test('exactly one approved delivery between channels: REST delivers, tool then expired', async () => {
    const s = await restStart('OneDeliveryB');
    await approve(s.body.userCode);
    const viaRest = await restStatus(s.body.handle);
    expect(viaRest.body.status).toBe('approved');
    await ageLastPoll(s.body.handle);
    const viaTool = await toolStatus(s.body.handle);
    expect(viaTool.status).toBe('expired');
  });

  test('claim via canonical vs alias consumes the same one-shot (REST-approved pairing)', async () => {
    const s = await restStart('ClaimShare');
    await approve(s.body.userCode);
    const approved = await restStatus(s.body.handle);
    expect(approved.body.status).toBe('approved');

    const okCanonical = await request(app)
      .get('/api/login/claim')
      .set('Authorization', `Bearer ${s.body.handle}`);
    expect(okCanonical.status).toBe(200);
    expect(okCanonical.text.trim()).toMatch(/^sk_sqd_/);

    const thenAlias = await request(app)
      .get('/api/mcp/login/claim')
      .set('Authorization', `Bearer ${s.body.handle}`);
    expect(thenAlias.status).toBe(404);
    expect(thenAlias.body).toEqual({ error: 'invalid_or_expired' });
  });

  test('a premature poll raises the shared interval WITHOUT consuming the one-shot', async () => {
    const s = await restStart('NoConsume');
    await approve(s.body.userCode);
    const handleHash = loginService.hashHandle(s.body.handle);

    // Force the next poll to be premature (recent last_polled_at, 5s interval).
    await pool.query(
      "UPDATE mcp_pending_authorizations SET last_polled_at = NOW(), required_poll_interval_seconds = 5 WHERE handle_hash = $1",
      [handleHash]
    );
    const premature = await restStatus(s.body.handle);
    expect(premature.body.status).toBe('slow_down');
    expect(premature.body.pollIntervalSeconds).toBeGreaterThan(5);

    // Now allow a non-premature poll from the OTHER channel — the approved
    // one-shot is still there to be delivered exactly once.
    await pool.query(
      "UPDATE mcp_pending_authorizations SET last_polled_at = NOW() - interval '60 seconds' WHERE handle_hash = $1",
      [handleHash]
    );
    const viaTool = await toolStatus(s.body.handle);
    expect(viaTool.status).toBe('approved');
    // And it is now consumed for both channels.
    await ageLastPoll(s.body.handle);
    const after = await restStatus(s.body.handle);
    expect(after.body.status).toBe('expired');
  });
});
