/**
 * GET /api/mcp/login/claim endpoint tests (feature 008, T018).
 *
 * One-shot atomic claim under concurrency, the uniform 404 oracle, the window
 * lapse + auto-revoke, the query-param fallback, and the FR-022 mint-time
 * token-cap carve-out with claim rollback (row stays approved, retriable).
 */
process.env.LOGIN_RATE_LIMIT_FORCE_MEMORY = '1';

const express = require('express');
const request = require('supertest');
const { createPool, createPersistence } = require('./helpers/db');
const { createLoginClaimRouter } = require('../api/mcp-login-claim');
const loginService = require('../mcp/auth/login-service');
const delegation = require('../mcp/auth/delegation');
const apiTokens = require('../mcp/auth/api-tokens');
const rateLimit = require('../mcp/auth/rate-limit');

const pool = createPool();
const persistence = createPersistence();

const UNIFORM_404 = { error: 'invalid_or_expired' };

describe('GET /api/mcp/login/claim', () => {
  let app;
  let userId;

  beforeAll(async () => {
    loginService.init(pool);
    delegation.init(pool);
    apiTokens.init(pool);
    const u = await pool.query(
      `INSERT INTO users (google_id, email, name, picture)
       VALUES ('claim-test', 'claim-test@example.com', 'Claim User', NULL)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`
    );
    userId = u.rows[0].id;

    app = express();
    app.set('trust proxy', true);
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

  // Build an approved, claimable authorization; return its handle + id.
  async function approvedHandle(agentName = 'Claim Agent') {
    const p = await loginService.createPendingAuthorization({
      agentName,
      ip: '203.0.113.55',
      baseUrl: 'https://squiredocs.com',
    });
    const entered = await loginService.enterCode(p.userCode, userId);
    const approved = await loginService.approveAuthorization(entered.authorizationId, userId);
    expect(approved.status).toBe('approved');
    return { handle: p.handle, authorizationId: entered.authorizationId };
  }

  const claim = (handle) =>
    request(app).get('/api/mcp/login/claim').set('Authorization', `Bearer ${handle}`);
  const claimCanonical = (handle) =>
    request(app).get('/api/login/claim').set('Authorization', `Bearer ${handle}`);

  test('first claim: 200 text/plain, trailing newline, no-store, sk_sqd_ token', async () => {
    const { handle } = await approvedHandle();
    const res = await claim(handle);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain; charset=utf-8/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.endsWith('\n')).toBe(true);
    expect(res.text.trim()).toMatch(/^sk_sqd_/);
  });

  test('N=8 concurrent claims: exactly one 200, the rest byte-identical 404', async () => {
    const { handle } = await approvedHandle();
    const results = await Promise.all(Array.from({ length: 8 }, () => claim(handle)));
    const ok = results.filter((r) => r.status === 200);
    const notFound = results.filter((r) => r.status === 404);
    expect(ok).toHaveLength(1);
    expect(notFound).toHaveLength(7);
    for (const r of notFound) expect(r.body).toEqual(UNIFORM_404);
  });

  test('claim after the 5-minute window: 404 and the delegation is revoked (FR-021)', async () => {
    const { handle, authorizationId } = await approvedHandle();
    await pool.query(
      "UPDATE mcp_pending_authorizations SET claim_expires_at = NOW() - interval '1 second' WHERE id = $1",
      [authorizationId]
    );
    const res = await claim(handle);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(UNIFORM_404);

    const del = await pool.query('SELECT revoked_at FROM agent_delegations WHERE agent_id = $1', [
      `mcp-login:${authorizationId}`,
    ]);
    expect(del.rows[0].revoked_at).not.toBeNull();
  });

  test('fabricated / malformed / missing handle all give the same 404 body', async () => {
    const fabricated = await claim('sqlh_totally-made-up');
    const missing = await request(app).get('/api/mcp/login/claim');
    const malformed = await request(app).get('/api/mcp/login/claim').set('Authorization', 'Bearer ');
    for (const r of [fabricated, missing, malformed]) {
      expect(r.status).toBe(404);
      expect(r.body).toEqual(UNIFORM_404);
    }
  });

  test('query-param handle is REJECTED with the uniform 404 and does not consume the approval (008 review)', async () => {
    // The handle is a bearer credential; a credential in a URL lands in
    // upstream proxy/ingress access logs. Header-only since the 008 review.
    const { handle } = await approvedHandle();
    const viaQuery = await request(app).get('/api/mcp/login/claim').query({ handle });
    expect(viaQuery.status).toBe(404);
    expect(viaQuery.body).toEqual(UNIFORM_404);

    // The approval is untouched — the proper header claim still succeeds.
    const viaHeader = await claim(handle);
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.text.trim()).toMatch(/^sk_sqd_/);
  });

  test('mint-time token-cap: 409 token_limit, row stays approved, retriable after freeing a token', async () => {
    const { handle, authorizationId } = await approvedHandle();

    // Fill the user to the active-token cap (25) so the mint fails.
    const tokenIds = [];
    for (let i = 0; i < apiTokens.MAX_TOKENS_PER_USER; i += 1) {
      const { record } = await apiTokens.createToken(userId, `filler-${i}`, {
        expiresAt: new Date(Date.now() + 3600_000),
      });
      tokenIds.push(record.id);
    }

    const capped = await claim(handle);
    expect(capped.status).toBe(409);
    expect(capped.body.error).toBe('token_limit');

    // The claim rolled back — the authorization is still approved & claimable.
    const row = await pool.query('SELECT state FROM mcp_pending_authorizations WHERE id = $1', [
      authorizationId,
    ]);
    expect(row.rows[0].state).toBe('approved');

    // Free a token, retry within the window → 200.
    await apiTokens.revokeToken(tokenIds[0], userId);
    const ok = await claim(handle);
    expect(ok.status).toBe(200);
    expect(ok.text.trim()).toMatch(/^sk_sqd_/);
  });

  test('rate limit: the 11th claim in a minute from one IP is 429 keyed before handle inspection', async () => {
    // 10 claims against a fabricated handle (all 404 on the handle, but they
    // consume the per-IP claim budget), then the 11th is 429 before any lookup.
    for (let i = 0; i < 10; i += 1) {
      const r = await claim('sqlh_made-up');
      expect(r.status).toBe(404);
    }
    const limited = await claim('sqlh_made-up');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
  });

  // ── Feature 009: canonical /api/login/claim ≡ alias /api/mcp/login/claim ────
  // Same handler mounted twice: byte-identical responses, one shared claim:ip
  // budget, and a claim on one URL consumes the one-shot for the other (FR-007).

  test('canonical claim: first-claim 200 bytes byte-identical shape to the alias', async () => {
    const { handle } = await approvedHandle();
    const res = await claimCanonical(handle);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain; charset=utf-8/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.endsWith('\n')).toBe(true);
    expect(res.text.trim()).toMatch(/^sk_sqd_/);
  });

  test('canonical and alias share the one-shot: a claim on one URL 404s the other', async () => {
    const a = await approvedHandle();
    const okAlias = await claim(a.handle);
    expect(okAlias.status).toBe(200);
    const thenCanonical = await claimCanonical(a.handle);
    expect(thenCanonical.status).toBe(404);
    expect(thenCanonical.body).toEqual(UNIFORM_404);

    const b = await approvedHandle();
    const okCanonical = await claimCanonical(b.handle);
    expect(okCanonical.status).toBe(200);
    const thenAlias = await claim(b.handle);
    expect(thenAlias.status).toBe(404);
    expect(thenAlias.body).toEqual(UNIFORM_404);
  });

  test('canonical claim: fabricated handle → the same uniform 404 body as the alias', async () => {
    const viaCanonical = await claimCanonical('sqlh_made-up');
    const viaAlias = await claim('sqlh_made-up');
    expect(viaCanonical.status).toBe(404);
    expect(viaCanonical.body).toEqual(UNIFORM_404);
    expect(viaCanonical.body).toEqual(viaAlias.body);
  });

  test('canonical + alias draw the SAME claim:ip budget: 10 across both URLs, 11th → 429', async () => {
    // Alternate the two URLs; the shared per-IP budget is 10, so the 11th (on
    // either URL) is 429 — the alias does NOT grant a second fresh 10.
    for (let i = 0; i < 10; i += 1) {
      const r = i % 2 === 0 ? await claim('sqlh_made-up') : await claimCanonical('sqlh_made-up');
      expect(r.status).toBe(404);
    }
    const limited = await claimCanonical('sqlh_made-up');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
  });

  test('canonical claim: mint-time token-cap → 409 token_limit (same carve-out as the alias)', async () => {
    const { handle } = await approvedHandle();
    const tokenIds = [];
    for (let i = 0; i < apiTokens.MAX_TOKENS_PER_USER; i += 1) {
      const { record } = await apiTokens.createToken(userId, `filler-canon-${i}`, {
        expiresAt: new Date(Date.now() + 3600_000),
      });
      tokenIds.push(record.id);
    }
    const capped = await claimCanonical(handle);
    expect(capped.status).toBe(409);
    expect(capped.body.error).toBe('token_limit');
  });
});
