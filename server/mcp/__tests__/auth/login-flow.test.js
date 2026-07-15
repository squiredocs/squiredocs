/**
 * End-to-end login-flow state machine (feature 008, T015 + T019/T020/T024 extensions).
 *
 * Drives the full journey over supertest against the real MCP router, the
 * /mcp/login consent routes, and the REST claim endpoint, with approval driven
 * through the backend routes under a session token (no browser). Serial DB.
 */
// Deterministic limiter: force the in-process counter and reset per test so the
// handful of login/claim calls here never trip a shared/Redis counter.
process.env.LOGIN_RATE_LIMIT_FORCE_MEMORY = '1';

const express = require('express');
const request = require('supertest');
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');
const { generateAccessToken } = require('../../../auth/jwt');
const mcp = require('../../index');
const mcpLoginRouter = require('../../auth/login-router');
const { createLoginClaimRouter } = require('../../../api/mcp-login-claim');
const rateLimit = require('../../auth/rate-limit');
const documents = require('../../../documents');
const users = require('../../../auth/users');

const pool = createPool();
const persistence = createPersistence();

function buildApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/mcp/login', mcpLoginRouter);
  app.use('/mcp', mcp.router);
  app.use(createLoginClaimRouter(persistence));
  return app;
}

describe('login flow (end-to-end)', () => {
  let app;
  let userId;
  let sessionToken;

  beforeAll(async () => {
    mcp.init(persistence);
    documents.init(pool);
    users.init(pool);
    app = buildApp();

    const u = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('login-flow-test', 'login-flow@example.com', 'Login Flow User', NULL)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, email, name, picture, is_admin`
    );
    userId = u.rows[0].id;
    sessionToken = generateAccessToken(u.rows[0]);
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

  // ── helpers ────────────────────────────────────────────────────────────────
  function rpc(method, params, token) {
    const req = request(app).post('/mcp').set('Content-Type', 'application/json');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send({ jsonrpc: '2.0', id: 1, method, params });
  }
  const toolJson = (res) => JSON.parse(res.body.result.content[0].text);

  // Poll login_status as if the agent had waited out the interval: backdate
  // last_polled_at so the D8 slow_down guard (proven separately in the abuse
  // suite) doesn't fire between rapid in-test polls.
  async function pollStatus(handle, opts = {}) {
    await pool.query('UPDATE mcp_pending_authorizations SET last_polled_at = NULL');
    const args = { handle };
    if (opts.inline) args.inline = true;
    return toolJson(await rpc('tools/call', { name: 'login_status', arguments: args }));
  }

  async function startLogin(agentName = 'Flow Agent') {
    const res = await rpc('tools/call', { name: 'login', arguments: { agentName } });
    const payload = toolJson(res);
    expect(payload.status).toBe('pending_authorization');
    return payload; // { handle, userCode, ... }
  }

  function enterCode(code, token = sessionToken) {
    return request(app).post('/mcp/login/code').set('Authorization', `Bearer ${token}`).send({ code });
  }
  function decide(authorizationId, approved, token = sessionToken) {
    return request(app)
      .post('/mcp/login/decision')
      .set('Authorization', `Bearer ${token}`)
      .send({ authorizationId, approved });
  }
  function claim(handle) {
    return request(app).get('/api/mcp/login/claim').set('Authorization', `Bearer ${handle}`);
  }

  async function approveFlow(agentName = 'Flow Agent') {
    const { handle, userCode } = await startLogin(agentName);
    const codeRes = await enterCode(userCode);
    expect(codeRes.status).toBe(200);
    const decideRes = await decide(codeRes.body.authorizationId, true);
    expect(decideRes.status).toBe(200);
    return { handle, authorizationId: codeRes.body.authorizationId, agentName };
  }

  // ── anonymous surface ────────────────────────────────────────────────────
  test('anonymous initialize returns the anonymous instructions', async () => {
    const res = await rpc('initialize', {});
    expect(res.status).toBe(200);
    expect(res.body.result.instructions).toBe(mcp.ANON_SERVER_INSTRUCTIONS);
  });

  test('anonymous tools/list shows exactly login and login_status', async () => {
    const res = await rpc('tools/list', {});
    const names = res.body.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(['login', 'login_status']);
  });

  // ── happy path ─────────────────────────────────────────────────────────────
  test('login → pending → approve → approved payload once → claim → reconnect (18 tools)', async () => {
    const { handle, userCode } = await startLogin('Quickstart Agent');
    expect(handle).toMatch(/^sqlh_/);
    expect(userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);

    // Poll: pending
    const pending = await pollStatus(handle);
    expect(pending.status).toBe('pending');

    // Code entry + approve via the session routes
    const codeRes = await enterCode(userCode);
    expect(codeRes.status).toBe(200);
    expect(codeRes.body.agentName).toBe('Quickstart Agent');
    expect(codeRes.body.scopes).toEqual(['documents:read', 'documents:write']);
    const authorizationId = codeRes.body.authorizationId;

    const decideRes = await decide(authorizationId, true);
    expect(decideRes.status).toBe(200);
    expect(decideRes.body.status).toBe('approved');

    // Poll: approved payload exactly once — has claimCommand, NO credential
    const approved = await pollStatus(handle);
    expect(approved.status).toBe('approved');
    expect(approved.claimCommand).toContain('/api/mcp/login/claim');
    expect(approved.claimCommand).toContain(handle);
    expect(JSON.stringify(approved)).not.toContain('sk_sqd_');

    // Second poll: indistinguishable from expired (D12)
    const second = await pollStatus(handle);
    expect(second.status).toBe('expired');

    // Claim over REST: token bytes once
    const claimRes = await claim(handle);
    expect(claimRes.status).toBe(200);
    expect(claimRes.headers['content-type']).toMatch(/text\/plain/);
    expect(claimRes.headers['cache-control']).toBe('no-store');
    expect(claimRes.text.endsWith('\n')).toBe(true);
    const token = claimRes.text.trim();
    expect(token).toMatch(/^sk_sqd_/);

    // Second claim → 404
    const claim2 = await claim(handle);
    expect(claim2.status).toBe(404);
    expect(claim2.body).toEqual({ error: 'invalid_or_expired' });

    // Reconnect authenticated: full 18-tool set
    const listRes = await rpc('tools/list', {}, token);
    expect(listRes.body.result.tools).toHaveLength(18);

    // C1 / FR-027: drive a document-touching action with the claimed credential
    // and assert the standard delegation attribution.
    const listDocs = toolJson(await rpc('tools/call', { name: 'list_documents', arguments: {} }, token));
    expect(listDocs).toBeDefined();
    const errFlag = (await rpc('tools/call', { name: 'list_documents', arguments: {} }, token)).body.result.is_error;
    expect(errFlag).toBeFalsy();

    const del = await pool.query(
      'SELECT * FROM agent_delegations WHERE user_id = $1 AND agent_id = $2',
      [userId, `mcp-login:${authorizationId}`]
    );
    expect(del.rows).toHaveLength(1);
    expect(del.rows[0].agent_name).toBe('Quickstart Agent');
    expect(del.rows[0].scopes).toEqual(['documents:read', 'documents:write']);

    const tok = await pool.query(
      'SELECT * FROM mcp_api_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );
    expect(tok.rows).toHaveLength(1);
    expect(tok.rows[0].minted_by_delegation_id).toBe(del.rows[0].id);
    expect(tok.rows[0].name).toBe('Quickstart Agent (via MCP login)');
  });

  test('deny path is terminal', async () => {
    const { handle, userCode } = await startLogin();
    const codeRes = await enterCode(userCode);
    const decideRes = await decide(codeRes.body.authorizationId, false);
    expect(decideRes.status).toBe(200);
    expect(decideRes.body.status).toBe('denied');

    const status = await pollStatus(handle);
    expect(status.status).toBe('denied');

    // No delegation created on deny.
    const del = await pool.query('SELECT * FROM agent_delegations WHERE user_id = $1', [userId]);
    expect(del.rows).toHaveLength(0);
  });

  test('TTL-lapsed approve → 410 and no delegation row', async () => {
    const { userCode } = await startLogin();
    const codeRes = await enterCode(userCode);
    const authorizationId = codeRes.body.authorizationId;

    // Force the authorization TTL to have lapsed after code entry, before click.
    await pool.query(
      "UPDATE mcp_pending_authorizations SET expires_at = NOW() - interval '1 second' WHERE id = $1",
      [authorizationId]
    );

    const decideRes = await decide(authorizationId, true);
    expect(decideRes.status).toBe(410);
    expect(decideRes.body.error).toBe('expired');

    // The delegation creation was rolled back with the failed approve.
    const del = await pool.query(
      'SELECT * FROM agent_delegations WHERE agent_id = $1',
      [`mcp-login:${authorizationId}`]
    );
    expect(del.rows).toHaveLength(0);
  });

  test('an authenticated caller can also call login (D2)', async () => {
    // First obtain a real credential via the flow.
    const { handle } = await approveFlow('Rotator');
    const token = (await claim(handle)).text.trim();

    // Now call login again, authenticated with that credential.
    const res = await rpc('tools/call', { name: 'login', arguments: { agentName: 'Rotator 2' } }, token);
    const payload = toolJson(res);
    expect(payload.status).toBe('pending_authorization');
    expect(payload.handle).toMatch(/^sqlh_/);
  });

  // ── US2: inline delivery + one-shot channel (T019/T020) ──────────────────────
  test('inline delivery returns the credential once and forecloses REST', async () => {
    const { handle } = await approveFlow('Inline Agent');

    const inline = await pollStatus(handle, { inline: true });
    expect(inline.status).toBe('approved');
    expect(inline.warning).toMatch(/DO NOT ECHO/);
    expect(inline.credential).toMatch(/^sk_sqd_/);
    expect(inline.expiresInDays).toBe(30);

    // A REST claim afterward fails uniformly (channel already consumed).
    const claimRes = await claim(handle);
    expect(claimRes.status).toBe(404);

    // A second inline is also expired.
    const inline2 = await pollStatus(handle, { inline: true });
    expect(inline2.status).toBe('expired');
  });

  test('a REST claim forecloses inline delivery', async () => {
    const { handle } = await approveFlow('Rest First');
    const token = (await claim(handle)).text.trim();
    expect(token).toMatch(/^sk_sqd_/);

    const inline = await pollStatus(handle, { inline: true });
    expect(inline.status).toBe('expired');
  });

  test('inline: true while still pending returns plain pending', async () => {
    const { handle } = await startLogin('Still Pending');
    const status = await pollStatus(handle, { inline: true });
    expect(status.status).toBe('pending');
  });

  test('default approved payload carries recipe + guidance and no credential (FR-011)', async () => {
    const { handle } = await approveFlow('Payload Agent');
    const approved = await pollStatus(handle);
    expect(approved.status).toBe('approved');
    expect(approved.claimCommand).toContain('umask 077');
    expect(approved.claimCommand).toContain('chmod 600');
    expect(Array.isArray(approved.instructions)).toBe(true);
    expect(approved.instructions.join(' ')).toMatch(/persist and reconnect/i);
    expect(approved.instructions.join(' ')).toMatch(/NEVER print, echo, or paste/i);
    expect(JSON.stringify(approved)).not.toContain('sk_sqd_');
  });

  // T020: the "approved response lost in transit" recovery contract (D12).
  test('after the approved payload is delivered, polling says expired but the handle still claims', async () => {
    const { handle } = await approveFlow('Lost Payload');
    // Deliver the payload (simulating a response that never reached the agent).
    const approved = await pollStatus(handle);
    expect(approved.status).toBe('approved');
    // Polling now answers expired…
    const poll = await pollStatus(handle);
    expect(poll.status).toBe('expired');
    // …but the retained handle still claims successfully within the window.
    const claimRes = await claim(handle);
    expect(claimRes.status).toBe(200);
    expect(claimRes.text.trim()).toMatch(/^sk_sqd_/);
  });

  // ── US3: server-side consent semantics (T024) ────────────────────────────────
  test('code entry normalization matrix (case / hyphen / whitespace) server-side', async () => {
    for (const transform of [
      (c) => c.toLowerCase(),
      (c) => c.replace('-', ''),
      (c) => c.toLowerCase().replace('-', ''),
      (c) => ` ${c} `,
    ]) {
      await pool.query('DELETE FROM mcp_pending_authorizations');
      const { userCode } = await startLogin();
      const res = await enterCode(transform(userCode));
      expect(res.status).toBe(200);
    }
  });

  test('double submission of the same code → second gets generic failure (one-shot)', async () => {
    const { userCode } = await startLogin();
    const first = await enterCode(userCode);
    expect(first.status).toBe(200);
    const second = await enterCode(userCode);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('invalid_or_expired');
  });

  test('wrong vs expired vs used code responses are byte-identical (FR-015)', async () => {
    // wrong
    const wrong = await enterCode('BCDF-GHJK');
    // used
    const { userCode } = await startLogin();
    await enterCode(userCode);
    const used = await enterCode(userCode);
    // expired
    const { userCode: code2 } = await startLogin();
    await pool.query("UPDATE mcp_pending_authorizations SET expires_at = NOW() - interval '1 second'");
    const expired = await enterCode(code2);

    for (const r of [wrong, used, expired]) {
      expect(r.status).toBe(400);
      expect(r.body).toEqual(wrong.body);
    }
  });

  test('decision by a different user than the code-enterer → uniform failure', async () => {
    const other = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('login-flow-other', 'login-flow-other@example.com', 'Other', NULL)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, email, name, picture, is_admin`
    );
    const otherToken = generateAccessToken(other.rows[0]);

    const { userCode } = await startLogin();
    const codeRes = await enterCode(userCode); // entered by the main session user
    const decideRes = await decide(codeRes.body.authorizationId, true, otherToken); // decided by other
    expect(decideRes.status).toBe(400);
    expect(decideRes.body.error).toBe('invalid_or_expired');

    await pool.query('DELETE FROM users WHERE id = $1', [other.rows[0].id]);
  });

  test('revoking the delegation kills a claimed token (cascade, FR-023)', async () => {
    const { handle, authorizationId } = await approveFlow('Revoke Me');
    const token = (await claim(handle)).text.trim();

    // The token authenticates before revocation.
    const before = await rpc('tools/list', {}, token);
    expect(before.body.result.tools).toHaveLength(18);

    // Revoke the delegation directly (Settings → DELETE cascade path).
    const del = await pool.query('SELECT id FROM agent_delegations WHERE agent_id = $1', [
      `mcp-login:${authorizationId}`,
    ]);
    const delegation = require('../../auth/delegation');
    await delegation.revokeDelegation(del.rows[0].id);

    // The minted token no longer authenticates. A revoked (broken) credential is
    // NOT "no credential" — it keeps today's invalid-token 401, not the anonymous
    // surface (D1: anonymous means absent, not broken).
    const after = await rpc('tools/list', {}, token);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('INVALID_TOKEN');
  });

  test('unclaimed approval lapse leaves no active delegation (FR-021)', async () => {
    const { handle, authorizationId } = await approveFlow('Lapse Me');
    // Force the claim window to lapse.
    await pool.query(
      "UPDATE mcp_pending_authorizations SET claim_expires_at = NOW() - interval '1 second' WHERE id = $1",
      [authorizationId]
    );
    // Any observation (a poll) triggers the lazy sweep + delegation revoke.
    const poll = await pollStatus(handle);
    expect(poll.status).toBe('expired');

    const active = await pool.query(
      'SELECT * FROM agent_delegations WHERE agent_id = $1 AND revoked_at IS NULL',
      [`mcp-login:${authorizationId}`]
    );
    expect(active.rows).toHaveLength(0);
  });
});
