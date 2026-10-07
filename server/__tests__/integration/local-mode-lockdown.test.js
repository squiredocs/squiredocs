/**
 * Feature 059 (T055, SC-007, FR-022, FR-045, US5-6, US5-8): in local mode no
 * request from the network can create an account or a session without a link
 * minted inside the container. Then the same instance moves to team mode with
 * Google, and the owner and their documents carry over.
 */
const crypto = require('crypto');
const request = require('supertest');

jest.mock('../../auth/google', () => ({
  GOOGLE_ISSUER: 'https://accounts.google.com',
  generateAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?state=s'),
  exchangeCodeForTokens: jest.fn(async () => ({ id_token: 'fixture', access_token: 'fixture' })),
  verifyIdToken: jest.fn(),
  fetchUserInfo: jest.fn(async () => ({})),
}));

const google = require('../../auth/google');
const { _resetInstanceConfigForTests } = require('../../instance-config');
const { startLocalInstance, sessionCookies } = require('../helpers/local-instance');
const links = require('../../auth/signin-links');

const APP = 'http://localhost:3910';

describe('local-mode lockdown (SC-007)', () => {
  let inst;
  let owner;
  let docId;
  const KEYS = ['SQUIRE_MODE', 'APP_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ENABLE_DEV_ENDPOINTS'];
  const saved = {};

  const setMode = (mode) => {
    process.env.SQUIRE_MODE = mode;
    _resetInstanceConfigForTests();
  };
  const userCount = async () => (await inst.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.APP_URL = APP;
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csecret';
    setMode('local');
    inst = await startLocalInstance();

    const { token } = await links.mintLink(inst.pool, { kind: 'claim', source: 'cli' });
    ({ user: owner } = await links.redeemLink(inst.pool, token, { name: 'Owner', email: 'owner@example.com' }));
    docId = crypto.randomUUID();
    await inst.pool.query("INSERT INTO documents (id, title, creator_id) VALUES ($1, 'Owner doc', $2)", [docId, owner.id]);
    await inst.pool.query("INSERT INTO document_shares (doc_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $2)", [docId, owner.id]);
  });

  afterAll(async () => {
    await inst.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetInstanceConfigForTests();
  });

  describe('local mode with an owner', () => {
    beforeEach(() => setMode('local'));

    test('GET /auth/google creates nothing and sets no cookie', async () => {
      const res = await request(inst.app).get('/auth/google').set('Origin', APP);
      expect(res.headers.location).toBe(`${APP}/login?error=provider_disabled`);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(await userCount()).toBe(1);
    });

    test('the callback with a valid-looking new identity creates nothing', async () => {
      google.verifyIdToken.mockResolvedValue({
        issuer: 'https://accounts.google.com', subject: 'attacker-1', email: 'attacker@example.com', name: 'A', picture: null,
      });
      const res = await request(inst.app)
        .get('/auth/google/callback?code=x&state=s')
        .set('Origin', APP)
        .set('Cookie', ['oauth_state=s']);
      expect(res.headers.location).toBe(`${APP}/login?error=provider_disabled`);
      expect(sessionCookies(res)).toHaveLength(0);
      expect(google.verifyIdToken).not.toHaveBeenCalled();
      expect(await userCount()).toBe(1);
    });

    test('POST /auth/dev-login with ENABLE_DEV_ENDPOINTS unset is a 404 and creates nothing', async () => {
      delete process.env.ENABLE_DEV_ENDPOINTS;
      try {
        for (const body of [{}, { fresh: true }, { fresh: true, browser: true, returnTo: '/docs' }]) {
          const res = await request(inst.app).post('/auth/dev-login').send(body);
          expect(res.status).toBe(404);
          expect(sessionCookies(res)).toHaveLength(0);
        }
      } finally {
        if (saved.ENABLE_DEV_ENDPOINTS === undefined) delete process.env.ENABLE_DEV_ENDPOINTS;
        else process.env.ENABLE_DEV_ENDPOINTS = saved.ENABLE_DEV_ENDPOINTS;
      }
      expect(await userCount()).toBe(1);
    });

    test('20 guessed tokens with a claim body: no account, no session', async () => {
      for (let i = 0; i < 20; i++) {
        const token = crypto.randomBytes(32).toString('base64url');
        const res = await request(inst.app)
          .post('/auth/signin-link')
          .set('Origin', APP)
          .type('form')
          .send({ token, name: 'Intruder', email: `intruder${i}@example.com` });
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(`${APP}/login?error=link_invalid`);
        expect(sessionCookies(res)).toHaveLength(0);
      }
      expect(await userCount()).toBe(1);
    });

    test('a genuine, unused claim link minted before the claim cannot create a second owner', async () => {
      // A claim link minted now (e.g. by a restart's startup block) is refused
      // because the instance has a user, inside the redemption transaction.
      const { token } = await links.mintLink(inst.pool, { kind: 'claim', source: 'startup' });
      const res = await request(inst.app)
        .post('/auth/signin-link')
        .set('Origin', APP)
        .set('Accept', 'application/json')
        .send({ token, name: 'Second', email: 'second@example.com' });
      expect(res.status).toBe(409);
      expect(sessionCookies(res)).toHaveLength(0);
      expect(await userCount()).toBe(1);
    });
  });

  describe('then the operator switches to team mode with Google (US5-8)', () => {
    beforeAll(() => setMode('team'));

    test('the owner still signs in by link and their document is intact', async () => {
      const { token } = await links.mintLink(inst.pool, { kind: 'signin', userId: owner.id, source: 'cli' });
      const res = await request(inst.app)
        .post('/auth/signin-link')
        .set('Origin', APP)
        .set('Accept', 'application/json')
        .send({ token });
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ id: owner.id, isAdmin: true });
      const doc = await inst.pool.query(
        "SELECT d.title FROM documents d JOIN document_shares s ON s.doc_id = d.id WHERE d.id = $1 AND s.user_id = $2 AND s.role = 'owner'",
        [docId, owner.id]
      );
      expect(doc.rows).toEqual([{ title: 'Owner doc' }]);
    });

    test('GET /auth/providers lists Google', async () => {
      const res = await request(inst.app).get('/auth/providers');
      expect(res.body).toMatchObject({ mode: 'team', hasOwner: true, signupOpen: true });
      expect(res.body.providers.map((p) => p.id)).toEqual(['google']);
    });

    test("a Google sign-in using the owner's email gets account_exists, not a link to the owner", async () => {
      google.verifyIdToken.mockResolvedValueOnce({
        issuer: 'https://accounts.google.com', subject: 'google-sub-owner', email: 'owner@example.com', name: 'Owner', picture: null,
      });
      const res = await request(inst.app)
        .get('/auth/google/callback?code=x&state=s')
        .set('Cookie', ['oauth_state=s', `oauth_redirect=${APP}`]);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${APP}/login?error=account_exists`);
      expect(sessionCookies(res)).toHaveLength(0);
      expect(await userCount()).toBe(1);
      const ids = await inst.pool.query('SELECT count(*)::int AS n FROM user_identities');
      expect(ids.rows[0].n).toBe(0);
    });
  });
});
