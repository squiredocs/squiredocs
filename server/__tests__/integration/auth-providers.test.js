/**
 * Feature 059 (T047, FR-016, FR-019, FR-047): GET /auth/providers and the
 * local-mode refusal of the Google start and callback paths.
 */
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
const { startLocalInstance } = require('../helpers/local-instance');
const links = require('../../auth/signin-links');

const APP = 'http://localhost:3910';
const SECRET = 'google-secret-value-for-test';
const CLIENT_ID = 'google-client-id-for-test.apps.googleusercontent.com';

describe('GET /auth/providers and provider start paths', () => {
  let inst;
  const KEYS = ['SQUIRE_MODE', 'APP_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
  const saved = {};

  const setMode = (mode) => {
    process.env.SQUIRE_MODE = mode;
    _resetInstanceConfigForTests();
  };

  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.APP_URL = APP;
    process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = SECRET;
    setMode('local');
    inst = await startLocalInstance();
  });

  afterAll(async () => {
    await inst.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetInstanceConfigForTests();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await inst.reset();
    setMode('local');
  });

  test('local: exact keys, no providers, sign-up closed, hasOwner false then true after a claim', async () => {
    let res = await request(inst.app).get('/auth/providers');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.body).toEqual({ mode: 'local', hasOwner: false, signupOpen: false, providers: [] });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_ID);

    const { token } = await links.mintLink(inst.pool, { kind: 'claim', source: 'cli' });
    await links.redeemLink(inst.pool, token, { name: 'Owner', email: 'owner@example.com' });
    res = await request(inst.app).get('/auth/providers');
    expect(res.body.hasOwner).toBe(true);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('team with Google: exact keys and the Google entry only; no secret anywhere in the body', async () => {
    setMode('team');
    const res = await request(inst.app).get('/auth/providers');
    expect(res.body).toEqual({
      mode: 'team',
      hasOwner: false,
      signupOpen: true,
      providers: [{ id: 'google', label: 'Google', startPath: '/auth/google' }],
    });
    const text = JSON.stringify(res.body);
    for (const v of [SECRET, CLIENT_ID, 'redirect', '@']) expect(text).not.toContain(v);
  });

  test('local: GET /auth/google redirects to provider_disabled with no Set-Cookie and no adapter call', async () => {
    const res = await request(inst.app).get('/auth/google?returnTo=/docs').set('Origin', APP);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP}/login?error=provider_disabled`);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(google.generateAuthUrl).not.toHaveBeenCalled();
  });

  test('local: the callback redirects to provider_disabled, sets and clears no cookie, never calls the adapter', async () => {
    const res = await request(inst.app)
      .get('/auth/google/callback?code=x&state=y')
      .set('Origin', APP)
      .set('Cookie', ['oauth_state=y', 'oauth_redirect=http://evil.example']);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${APP}/login?error=provider_disabled`);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(google.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(google.verifyIdToken).not.toHaveBeenCalled();
  });

  test('team: both routes behave as before (start redirects to Google with cookies)', async () => {
    setMode('team');
    const res = await request(inst.app).get('/auth/google').set('Origin', APP);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(res.headers['set-cookie'].some((c) => c.startsWith('oauth_state='))).toBe(true);
    expect(google.generateAuthUrl).toHaveBeenCalledTimes(1);
  });
});
