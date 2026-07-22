/**
 * Feature 029 US3 — tier-1 first-run integration suite (FR-015, SC-007). Serial.
 *
 * Drives the REAL Google-callback production path (google adapter mocked, DB
 * real) so the assertions exercise production behavior, not the faucet (RBD-10):
 *   (a) consent returnTo round-trip creates the account mid-flow;
 *   (b) signup-source stamping — browser (Acc 3.1), agent_oauth (Acc 3.2),
 *       default browser for pre-existing rows + stamp-once on re-login (Acc 3.3);
 *   (c) deliberate welcome-doc skip for consent-born accounts (Acc 3.2, FR-013);
 *   (d) null-welcome-doc client contract on /auth/me (Acc 3.4, FR-014);
 *   (e) flag-off / production-like unreachability of the synthetic endpoints.
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

jest.mock('../../auth/google', () => ({
  generateAuthUrl: jest.fn((state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
  exchangeCodeForTokens: jest.fn(async () => ({ id_token: 'fixture', access_token: 'fixture' })),
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
const google = require('../../auth/google');
const onboarding = require('../../onboarding');
const { createPool } = require('../helpers/db');

const GOOGLE_IDS = [];

describe('Feature 029 US3 — tier-1 first-run suite', () => {
  let app;
  let pool;

  beforeAll(async () => {
    pool = createPool();
    users.init(pool);
    app = express();
    app.use(cookieParser());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use('/auth', authRouter);
  });

  afterAll(async () => {
    if (GOOGLE_IDS.length) {
      await pool.query('DELETE FROM users WHERE google_id = ANY($1::text[])', [GOOGLE_IDS]);
    }
    await users.deleteAllSyntheticUsers();
    await pool.end();
  });

  beforeEach(() => {
    onboarding.resolveOnboarding.mockClear();
  });

  /** Drive a full Google callback for a given profile, optionally with a returnTo. */
  async function googleCallback(profile, returnTo) {
    GOOGLE_IDS.push(profile.googleId);
    google.verifyIdToken.mockResolvedValueOnce(profile);
    const state = `state-${profile.googleId}`;
    const cookies = [`oauth_state=${state}`, 'oauth_redirect=http://localhost:5173'];
    if (returnTo) cookies.push(`oauth_return_to=${encodeURIComponent(returnTo)}`);
    return request(app).get(`/auth/google/callback?code=fake&state=${state}`).set('Cookie', cookies);
  }

  describe('(a)(b)(c) signup provenance + welcome-doc skip through the real callback', () => {
    test('Acc 3.1 — plain browser sign-in stamps signup_source=browser and seeds onboarding', async () => {
      const profile = { googleId: 'fr-browser-1', email: 'fr-browser-1@example.com', name: 'Browser One', picture: null };
      const res = await googleCallback(profile); // no returnTo
      expect(res.status).toBe(302);
      const row = await pool.query('SELECT signup_source FROM users WHERE google_id = $1', [profile.googleId]);
      expect(row.rows[0].signup_source).toBe('browser');
      // Non-consent path resolves onboarding (seeds welcome doc).
      expect(onboarding.resolveOnboarding).toHaveBeenCalled();
    });

    test('Acc 3.2 — consent returnTo round-trip creates the account mid-flow, stamps agent_oauth, and SKIPS the welcome doc', async () => {
      const profile = { googleId: 'fr-agent-1', email: 'fr-agent-1@example.com', name: 'Agent One', picture: null };
      const before = await pool.query('SELECT 1 FROM users WHERE google_id = $1', [profile.googleId]);
      expect(before.rows.length).toBe(0); // account does not exist yet

      const res = await googleCallback(profile, '/authorize?client_id=abc&state=xyz&code_challenge=cc');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:5173/authorize?client_id=abc&state=xyz&code_challenge=cc');

      const row = await pool.query('SELECT signup_source, welcome_doc_id FROM users WHERE google_id = $1', [profile.googleId]);
      expect(row.rows[0].signup_source).toBe('agent_oauth'); // stamped mid-flow
      expect(row.rows[0].welcome_doc_id).toBeNull();          // deliberate skip (FR-013)
      // The load-bearing early return means onboarding seeding is NEVER reached.
      expect(onboarding.resolveOnboarding).not.toHaveBeenCalled();
    });

    test('Acc 3.3 — a pre-existing row reports the default browser, and provenance is stamp-once (never overwritten on later login)', async () => {
      // Pre-existing row created directly (pre-feature style) → migration default.
      const ins = await pool.query(
        "INSERT INTO users (google_id, email, name) VALUES ('fr-pre-1', 'fr-pre-1@example.com', 'Pre One') RETURNING id"
      );
      GOOGLE_IDS.push('fr-pre-1');
      const pre = await pool.query('SELECT signup_source FROM users WHERE id = $1', [ins.rows[0].id]);
      expect(pre.rows[0].signup_source).toBe('browser');

      // Stamp-once: an account born via consent (agent_oauth) keeps it even after
      // a later plain login with no returnTo.
      const profile = { googleId: 'fr-stamponce-1', email: 'fr-stamponce-1@example.com', name: 'Stamp Once', picture: null };
      await googleCallback(profile, '/authorize?x=1');        // born agent_oauth
      await googleCallback(profile);                          // later plain login
      const row = await pool.query('SELECT signup_source FROM users WHERE google_id = $1', [profile.googleId]);
      expect(row.rows[0].signup_source).toBe('agent_oauth');  // NOT downgraded to browser
    });
  });

  describe('(d) null-welcome-doc client contract — /auth/me (Acc 3.4, FR-014)', () => {
    test('an account with welcome_doc_id null returns cleanly with welcomeDocId=null, no error', async () => {
      const profile = { googleId: 'fr-nullwelcome-1', email: 'fr-nullwelcome-1@example.com', name: 'Null Welcome', picture: null };
      await googleCallback(profile, '/authorize?x=1'); // agent_oauth, welcome_doc_id null
      const row = await pool.query('SELECT * FROM users WHERE google_id = $1', [profile.googleId]);
      const token = jwt.generateAccessToken(row.rows[0]);

      const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.welcomeDocId).toBeNull();
      expect(res.body.email).toBe(profile.email);
      // onboarded comes through as a boolean, never throws on a null welcome doc.
      expect(typeof res.body.onboarded).toBe('boolean');
    });
  });

  describe('(e) SC-004 — synthetic endpoints unreachable flag-off / production-like', () => {
    test('faucet + wipe 404 with the flag unset', async () => {
      const prev = process.env.ENABLE_DEV_ENDPOINTS;
      delete process.env.ENABLE_DEV_ENDPOINTS;
      try {
        expect((await request(app).post('/auth/dev-login').send({ fresh: true })).status).toBe(404);
        expect((await request(app).post('/auth/dev-wipe-user').send({ all: true })).status).toBe(404);
      } finally {
        process.env.ENABLE_DEV_ENDPOINTS = prev;
      }
    });

    test('faucet + wipe 404 in a production-like NODE_ENV even with the flag set', async () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect((await request(app).post('/auth/dev-login').send({ fresh: true })).status).toBe(404);
        expect((await request(app).post('/auth/dev-wipe-user').send({ all: true })).status).toBe(404);
      } finally {
        process.env.NODE_ENV = prev;
      }
    });
  });
});
