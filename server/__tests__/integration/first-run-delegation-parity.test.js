/**
 * Feature 031 (T018, FR-012, SC-004) — an AUTO-ISSUED delegation is
 * indistinguishable from an explicitly-approved one: it appears in
 * handleListDelegations and is revocable via handleDeleteDelegation identically.
 * Serial.
 *
 * Drives the collapsed path end to end with a REAL PKCE pair: faucet browser
 * mode auto-issues the code inline (no consent POST), token exchange creates the
 * durable delegation, then the delegation is listed and revoked through the same
 * handlers the explicit-approve path uses.
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

jest.mock('../../auth/google', () => ({
  generateAuthUrl: jest.fn(),
  exchangeCodeForTokens: jest.fn(),
  verifyIdToken: jest.fn(),
  fetchUserInfo: jest.fn(async () => ({})),
}));
jest.mock('../../email', () => ({
  notifyNewUser: jest.fn(),
  notifyLogin: jest.fn(),
  sendShareInvite: jest.fn(),
  sendShareNotification: jest.fn(),
}));
jest.mock('../../onboarding', () => ({
  resolveOnboarding: jest.fn(async () => ({ welcomeDocId: null, onboarded: true })),
}));

const authRouter = require('../../auth/routes');
const users = require('../../auth/users');
const oauthFlow = require('../../mcp/auth/oauth-flow');
const registeredAgents = require('../../mcp/auth/registered-agents');
const delegation = require('../../mcp/auth/delegation');
const apiTokens = require('../../mcp/auth/api-tokens');
const { createPool } = require('../helpers/db');

// Minimal Express res stub capturing json/status/redirect for direct handler calls.
function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    location: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    redirect(u) { this.statusCode = 302; this.location = u; return this; },
  };
}

describe('Feature 031 — auto-issued delegation revocation parity', () => {
  let app;
  let pool;

  beforeAll(async () => {
    pool = createPool();
    users.init(pool);
    oauthFlow.init(pool);
    registeredAgents.init(pool);
    delegation.init(pool);
    apiTokens.init(pool);

    app = express();
    app.use(cookieParser());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use('/auth', authRouter);
  });

  afterAll(async () => {
    await users.deleteAllSyntheticUsers();
    await pool.end();
  });

  test('SC-004 — auto-issued delegation lists + revokes identically to an approved one', async () => {
    const rnd = crypto.randomBytes(6).toString('hex');
    const nonce = `dp${rnd}`;
    const clientId = `client_${rnd}`;
    const state = `state_${rnd}`;
    const redirectUri = 'http://localhost:8765/callback';

    // Real PKCE pair so the token exchange succeeds.
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const returnTo = '/authorize?' + new URLSearchParams({
      agent_client_id: clientId,
      agent_instance_id: '',
      scope: 'documents:read documents:write',
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      existing_delegation: 'false',
    }).toString();

    // 1. Faucet browser mode → auto-issue the code inline (no consent POST).
    const signin = await request(app).post('/auth/dev-login').send({ fresh: true, browser: true, nonce, returnTo });
    expect(signin.status).toBe(302);
    const cbUrl = new URL(signin.headers.location);
    expect(cbUrl.origin + cbUrl.pathname).toBe(redirectUri); // auto-issued to the agent callback
    const code = cbUrl.searchParams.get('code');
    expect(code).toBeTruthy();

    const userRow = await pool.query('SELECT id FROM users WHERE email = $1', [`test+${nonce}@test.local`]);
    const userId = userRow.rows[0].id;

    // 2. Token exchange → creates the durable delegation.
    const tokRes = mockRes();
    await oauthFlow.handleToken(
      { headers: { 'content-type': 'application/json' }, body: { grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri } },
      tokRes,
    );
    expect(tokRes.statusCode).toBe(200);
    expect(tokRes.body.access_token).toBeTruthy();

    // 3. The auto-issue-born delegation appears in the listing (same shape).
    const listRes = mockRes();
    await oauthFlow.handleListDelegations({ user: { userId } }, listRes);
    const mine = listRes.body.delegations.filter((d) => d.agentId === clientId || d.agentId?.startsWith(clientId));
    expect(mine.length).toBe(1);
    const del = mine[0];
    expect(del.scopes).toEqual(expect.arrayContaining(['documents:read', 'documents:write']));
    expect(del.id).toBeTruthy();

    // 4. Revoke it via the same handler an explicitly-approved delegation uses.
    const delRes = mockRes();
    await oauthFlow.handleDeleteDelegation({ user: { userId }, params: { id: del.id } }, delRes);
    expect(delRes.body).toEqual({ success: true });

    // 5. Gone from the listing.
    const list2 = mockRes();
    await oauthFlow.handleListDelegations({ user: { userId } }, list2);
    const still = list2.body.delegations.filter((d) => d.id === del.id);
    expect(still.length).toBe(0);
  });
});
