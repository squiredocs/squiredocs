/**
 * Tests for GET /api/tokens/claim — the one-shot claim delivery for
 * create_access_token (server/api/token-claim.js + mcp/auth/pending-mints.js).
 *
 * End-to-end: the mint is created by driving the real tool through the
 * registry (default, claim-delivery mode), the claim secret is lifted from
 * the returned claimCommand exactly as an agent's shell would use it, and the
 * endpoint is exercised via supertest. Covers the byte contract (text/plain
 * token straight to disk), one-shot semantics, the no-oracle 401 class,
 * reasoned 409 refusals (revoked minter, user token cap), and no-store.
 */
const request = require('supertest');
const express = require('express');
const apiTokens = require('../mcp/auth/api-tokens');
const delegation = require('../mcp/auth/delegation');
const toolRegistry = require('../mcp/tools');
const { createTokenClaimRouter } = require('../api/token-claim');
const { closeRedis } = require('../redis');
const { createPool, createTestUser, cleanupTestUser } = require('./helpers/db');

const pool = createPool();

describe('GET /api/tokens/claim', () => {
  let app;
  let testUserId;
  let testDelegation;

  const mint = (args = {}) =>
    toolRegistry.executeTool('create_access_token', args, {
      delegationId: testDelegation.id,
      userId: testUserId,
      agentId: 'claim-test-agent',
      agentName: 'Claim Test Agent',
      scopes: ['documents:read', 'documents:write'],
      isAgent: true,
      baseUrl: 'https://test.example.com',
    });

  const secretFrom = (result) => {
    const match = result.claimCommand.match(/Bearer (one_time_use_[A-Za-z0-9_-]+)/);
    expect(match).not.toBeNull();
    return match[1];
  };

  const claim = (secret) =>
    request(app)
      .get('/api/tokens/claim')
      .set('Authorization', `Bearer ${secret}`);

  beforeAll(async () => {
    apiTokens.init(pool);
    delegation.init(pool);
    testUserId = await createTestUser(pool, 'token-claim-test@example.com');
    app = express();
    app.use(createTokenClaimRouter());
  });

  afterAll(async () => {
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [testUserId]);
    await cleanupTestUser(pool, testUserId);
    await pool.end();
    await closeRedis();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [testUserId]);
    testDelegation = await delegation.createDelegation(testUserId, 'claim-test-agent', 'Claim Test Agent');
  });

  test('claim returns the raw token bytes, minted at claim time', async () => {
    const result = await mint({ ttlSeconds: 600 });
    const before = Date.now();
    const res = await claim(secretFrom(result));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['cache-control']).toBe('no-store');
    // The body IS the credential — exactly what curl -o writes to disk.
    expect(res.text).toMatch(/^sk_sqd_[A-Za-z0-9_-]+$/);

    const record = await apiTokens.verifyToken(res.text);
    expect(record).not.toBeNull();
    expect(record.user_id).toBe(testUserId);
    expect(record.scopes).toEqual(['documents:read']);
    expect(record.name).toBe('Minted by Claim Test Agent via MCP');

    const row = await apiTokens.getTokenById(record.id);
    expect(row.minted_by_delegation_id).toBe(testDelegation.id);
    // TTL counts from the claim, not the mint request.
    const expiresAt = new Date(record.expires_at).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  test('the claim is one-shot: a second redemption 401s and mints nothing new', async () => {
    const secret = secretFrom(await mint());
    expect((await claim(secret)).status).toBe(200);

    const second = await claim(secret);
    expect(second.status).toBe(401);
    expect(second.body).toEqual({ error: 'Invalid or expired claim' });
    expect(await apiTokens.listUserTokens(testUserId)).toHaveLength(1);
  });

  test('unknown, malformed, and missing credentials share one 401 (no oracle)', async () => {
    const forged = await claim('one_time_use_' + 'A'.repeat(43));
    expect(forged.status).toBe(401);
    expect(forged.body).toEqual({ error: 'Invalid or expired claim' });

    const garbage = await claim('x');
    expect(garbage.status).toBe(401);
    expect(garbage.body).toEqual({ error: 'Invalid or expired claim' });

    const missing = await request(app).get('/api/tokens/claim');
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ error: 'Invalid or expired claim' });
  });

  test('a delegation revoked between mint and claim is refused with a reasoned 409', async () => {
    const secret = secretFrom(await mint());
    await delegation.revokeDelegation(testDelegation.id);

    const res = await claim(secret);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Cannot mint token/);
    expect(await apiTokens.listUserTokens(testUserId)).toHaveLength(0);

    // The one-shot was still spent — retrying is a plain 401 now.
    expect((await claim(secret)).status).toBe(401);
  });

  test('the per-user token cap refuses the claim with a 409', async () => {
    const secret = secretFrom(await mint());
    for (let i = 0; i < apiTokens.MAX_TOKENS_PER_USER; i++) {
      await apiTokens.createToken(testUserId, `Filler ${i}`);
    }
    const res = await claim(secret);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Maximum of \d+ active tokens/);
  });

  test('nothing secret is console-logged across mint and claim', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await mint();
      const secret = secretFrom(result);
      const res = await claim(secret);
      expect(res.status).toBe(200);

      const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ');
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain(res.text);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
