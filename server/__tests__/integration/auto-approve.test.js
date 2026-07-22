/**
 * Feature 029 US2 — consent auto-approve (FR-006/FR-007, RBD-1, Acc 2.2/2.3,
 * SC-004). Serial. The auto-approve endpoint mints a real authorization code
 * through the factored approve core for a SYNTHETIC session only.
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
const jwt = require('../../auth/jwt');
const oauthFlow = require('../../mcp/auth/oauth-flow');
const registeredAgents = require('../../mcp/auth/registered-agents');
const { createPool } = require('../helpers/db');

describe('Feature 029 US2 — consent auto-approve', () => {
  let app;
  let pool;
  let realUserId;

  beforeAll(async () => {
    pool = createPool();
    users.init(pool);
    oauthFlow.init(pool);
    registeredAgents.init(pool);

    app = express();
    app.use(cookieParser());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use('/auth', authRouter);
  });

  afterAll(async () => {
    await users.deleteAllSyntheticUsers();
    if (realUserId) await pool.query('DELETE FROM users WHERE id = $1', [realUserId]);
    await pool.query("DELETE FROM users WHERE email = 'realapprove-029@gmail.com'");
    await pool.end();
  });

  function approveBody() {
    return {
      agent_client_id: `client_${crypto.randomBytes(8).toString('hex')}`,
      agent_instance_id: '',
      scopes: ['documents:read', 'documents:write'],
      redirect_uri: 'http://localhost:45678/callback',
      state: crypto.randomBytes(16).toString('hex'),
      code_challenge: crypto.randomBytes(32).toString('base64url'),
      code_challenge_method: 'S256',
    };
  }

  test('Acc 2.2 — a synthetic session completes Approve and mints an auth code', async () => {
    const mint = await request(app).post('/auth/dev-login').send({ fresh: true, nonce: 'approve1' });
    expect(mint.status).toBe(200);
    const token = mint.body.accessToken;

    const body = approveBody();
    const res = await request(app)
      .post('/auth/dev-consent-approve')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.code).toBeTruthy();
    expect(res.body.redirectUrl).toContain('code=');
    expect(res.body.redirectUrl).toContain(`state=${body.state}`);

    // The code was persisted for the synthetic user (real path, not a mock).
    const userRow = await pool.query("SELECT id FROM users WHERE email = 'test+approve1@test.local'");
    const codeRow = await pool.query(
      'SELECT 1 FROM mcp_auth_codes WHERE user_id = $1 AND agent_client_id = $2',
      [userRow.rows[0].id, body.agent_client_id]
    );
    expect(codeRow.rows.length).toBe(1);
  });

  test('Acc 2.3 — a real (non-synthetic) session is refused 403', async () => {
    const ins = await pool.query(
      "INSERT INTO users (google_id, email, name) VALUES ('real-029-approve', 'realapprove-029@gmail.com', 'Real Approve') RETURNING *"
    );
    realUserId = ins.rows[0].id;
    const token = jwt.generateAccessToken(ins.rows[0]);

    const res = await request(app)
      .post('/auth/dev-consent-approve')
      .set('Authorization', `Bearer ${token}`)
      .send(approveBody());

    expect(res.status).toBe(403);
    // And no code was minted for the real user.
    const codeRow = await pool.query('SELECT 1 FROM mcp_auth_codes WHERE user_id = $1', [realUserId]);
    expect(codeRow.rows.length).toBe(0);
  });

  test('SC-004 — unreachable with ENABLE_DEV_ENDPOINTS unset (before auth is even checked)', async () => {
    const mint = await request(app).post('/auth/dev-login').send({ fresh: true, nonce: 'approve2' });
    const token = mint.body.accessToken;
    const prev = process.env.ENABLE_DEV_ENDPOINTS;
    delete process.env.ENABLE_DEV_ENDPOINTS;
    try {
      const res = await request(app)
        .post('/auth/dev-consent-approve')
        .set('Authorization', `Bearer ${token}`)
        .send(approveBody());
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_DEV_ENDPOINTS = prev;
    }
  });
});
