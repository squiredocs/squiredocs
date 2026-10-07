/**
 * Tests for the consent-login returnTo round-trip (feature 005-agent-onboarding,
 * US2). Mocks server/auth/google so no external network is touched:
 * exchangeCodeForTokens returns a fixture; verifyIdToken returns a canned
 * profile the users module can upsert against the real DB.
 *
 * Cases (serial):
 *   (a) GET /auth/google?returnTo=/authorize?foo=bar → 302 to Google; the
 *       oauth_return_to cookie is set httpOnly + SameSite=Lax + 10 min TTL.
 *   (b) Hostile returnTo values (from contracts/returnto-continuation.md) →
 *       no oauth_return_to cookie is set.
 *   (c) Callback with valid oauth_return_to cookie → 302 to
 *       ${clientUrl}${returnTo}; cookie cleared.
 *   (d) Callback with planted hostile cookie value → cookie cleared, 302
 *       falls through to onboarding default destination (still on-origin).
 *   (e) Callback with no cookie → 302 to onboarding destination (SC-006
 *       regression guard).
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

// Mock the Google OAuth adapter BEFORE requiring the router.
jest.mock('../auth/google', () => ({
  generateAuthUrl: jest.fn((state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
  exchangeCodeForTokens: jest.fn(async () => ({
    id_token: 'fixture-id-token',
    access_token: 'fixture-access-token',
    refresh_token: 'fixture-refresh-token',
  })),
  // Feature 059: the adapter returns the identity shape.
  verifyIdToken: jest.fn(async () => ({
    issuer: 'https://accounts.google.com',
    subject: 'test-google-id-005-returnto',
    email: 'returnto-test-005@example.com',
    name: 'ReturnTo Test 005',
    picture: 'https://example.com/pic.png',
  })),
  fetchUserInfo: jest.fn(async () => ({})),
}));

// Mock the email notification module so tests don't try to send anything.
jest.mock('../email', () => ({
  notifyNewUser: jest.fn(),
  notifyLogin: jest.fn(),
  sendShareInvite: jest.fn(),
  sendShareNotification: jest.fn(),
}));

// Silence the onboarding.resolveOnboarding branch by returning a predictable
// onboarded=true so the default redirect is /docs?signup=1 (no welcome doc).
jest.mock('../onboarding', () => ({
  resolveOnboarding: jest.fn(async () => ({ welcomeDocId: null, onboarded: true })),
}));

const authRouter = require('../auth/routes');
const { isValidReturnTo } = require('../auth/routes');
const users = require('../auth/users');
const { createPool } = require('./helpers/db');

describe('Auth returnTo round-trip', () => {
  let app;
  let pool;
  let testUserId;

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
    if (testUserId) {
      await pool.query('DELETE FROM document_shares WHERE user_id = $1', [testUserId]);
      await pool.query('DELETE FROM documents WHERE creator_id = $1', [testUserId]);
      await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    }
    // Extra cleanup on the fixture google_id in case a prior run left it.
    await pool.query('DELETE FROM users WHERE id IN (SELECT user_id FROM user_identities WHERE subject = $1)', ['test-google-id-005-returnto']);
    await pool.end();
  });

  // Helper: extract Set-Cookie header entries as an array of name=value strings.
  function getSetCookies(res) {
    const raw = res.headers['set-cookie'];
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  }
  function findCookie(res, name) {
    return getSetCookies(res).find((c) => c.startsWith(`${name}=`));
  }

  describe('isValidReturnTo (unit-level, exported for tests)', () => {
    test('exported from the routes module', () => {
      expect(typeof isValidReturnTo).toBe('function');
    });

    // Accept cases (contracts/returnto-continuation.md)
    test.each([
      ['/docs'],
      ['/authorize?client_id=abc&code_challenge=x&state=y'],
      ['/d/abc-123?welcome=1'],
      ['/'],
      ['/%2F%2Fevil.com'], // encoded % is on-origin path literal (per contract)
      ['/@evil.com/x'], // authority-tricky but on-origin path (per contract)
    ])('accepts %s', (value) => {
      expect(isValidReturnTo(value)).toBe(true);
    });

    // Reject cases
    test.each([
      ['http://squiredocs.com/docs'],
      ['https://evil.com/x'],
      ['javascript:alert(1)'],
      ['data:text/html,foo'],
      ['//evil.com/'],
      ['//evil.com/x'],
      ['/\\evil.com'],
      ['\\\\evil.com'],
      [''],
      [null],
      [undefined],
      [[]],
      [{}],
      ['x'.repeat(513).replace(/^./, '/')], // 513 chars starting with '/'
    ])('rejects %p', (value) => {
      expect(isValidReturnTo(value)).toBe(false);
    });
  });

  describe('(a) GET /auth/google — valid returnTo sets cookie', () => {
    test('sets oauth_return_to httpOnly + SameSite=Lax', async () => {
      const res = await request(app)
        .get('/auth/google?returnTo=%2Fauthorize%3Ffoo%3Dbar');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('accounts.google.com');
      const cookie = findCookie(res, 'oauth_return_to');
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      // 10-min TTL (R1) — Max-Age should be within 590-610s (600 minus rounding).
      expect(cookie).toMatch(/Max-Age=6\d\d/);
      // Value should decode to /authorize?foo=bar
      const value = decodeURIComponent(cookie.split('=', 2)[1].split(';')[0]);
      expect(value).toBe('/authorize?foo=bar');
    });
  });

  describe('(b) GET /auth/google — hostile returnTo dropped silently', () => {
    // Per contract (analyze C3), Express single-decodes the query parameter
    // once — so a raw %2F%2Fevil.com in the URL arrives at the handler as the
    // string //evil.com, which R2 rejects (starts with //). The cookie is not
    // set and the request otherwise redirects to Google normally.
    test.each([
      ['%2F%2Fevil.com%2F'],   // decodes to //evil.com/
      ['http%3A%2F%2Fevil.com'],
      ['https%3A%2F%2Fevil.com%2Fx'],
      ['javascript%3Aalert(1)'],
      ['%2F%5Cevil.com'],  // /\evil.com
      ['not-a-slash'],
    ])('drops hostile returnTo %s (no cookie)', async (encoded) => {
      const res = await request(app).get(`/auth/google?returnTo=${encoded}`);
      expect(res.status).toBe(302);
      const cookie = findCookie(res, 'oauth_return_to');
      expect(cookie).toBeUndefined();
    });

    test('drops absent returnTo (no cookie)', async () => {
      const res = await request(app).get('/auth/google');
      expect(res.status).toBe(302);
      expect(findCookie(res, 'oauth_return_to')).toBeUndefined();
    });
  });

  describe('(c) callback with valid oauth_return_to → honored, cookie cleared', () => {
    test('redirects to ${clientUrl}${returnTo} and clears the cookie', async () => {
      const state = 'valid-state-c';
      const res = await request(app)
        .get(`/auth/google/callback?code=fake-code&state=${state}`)
        .set('Cookie', [
          `oauth_state=${state}`,
          `oauth_redirect=http://localhost:5173`,
          `oauth_return_to=/authorize?client_id=abc&state=xyz`,
        ]);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        'http://localhost:5173/authorize?client_id=abc&state=xyz'
      );
      // Cookie was cleared (Max-Age=0 or expires in the past)
      const cleared = findCookie(res, 'oauth_return_to');
      expect(cleared).toBeDefined();
      expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
      // Capture the user id for cleanup.
      const idQ = await pool.query('SELECT id FROM users WHERE id IN (SELECT user_id FROM user_identities WHERE subject = $1)', ['test-google-id-005-returnto']);
      testUserId = idQ.rows[0]?.id;
    });
  });

  describe('(d) callback with planted hostile cookie → falls through to default', () => {
    test('clears the cookie and lands on the onboarding default destination', async () => {
      const state = 'valid-state-d';
      const res = await request(app)
        .get(`/auth/google/callback?code=fake-code&state=${state}`)
        .set('Cookie', [
          `oauth_state=${state}`,
          `oauth_redirect=http://localhost:5173`,
          // Hostile: absolute URL. Server MUST re-validate before honoring.
          `oauth_return_to=${encodeURIComponent('http://evil.com/pwn')}`,
        ]);
      expect(res.status).toBe(302);
      // Should NOT redirect off-origin.
      expect(res.headers.location).not.toContain('evil.com');
      expect(res.headers.location.startsWith('http://localhost:5173/')).toBe(true);
      // Cookie cleared regardless.
      const cleared = findCookie(res, 'oauth_return_to');
      expect(cleared).toBeDefined();
      expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    });
  });

  describe('(f) abandoned attempt: error/denial callback exits clear the cookie (review LOW-1)', () => {
    test('user-denied callback (error=access_denied) clears oauth_return_to', async () => {
      const state = 'valid-state-f1';
      const res = await request(app)
        .get(`/auth/google/callback?error=access_denied&state=${state}`)
        .set('Cookie', [
          `oauth_state=${state}`,
          `oauth_redirect=http://localhost:5173`,
          `oauth_return_to=${encodeURIComponent('/authorize?client_id=abc')}`,
        ]);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/login?error=access_denied');
      const cleared = findCookie(res, 'oauth_return_to');
      expect(cleared).toBeDefined();
      expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    });

    test('invalid-state callback clears oauth_return_to', async () => {
      const res = await request(app)
        .get('/auth/google/callback?code=fake-code&state=mismatched')
        .set('Cookie', [
          'oauth_state=something-else',
          `oauth_redirect=http://localhost:5173`,
          `oauth_return_to=${encodeURIComponent('/authorize?client_id=abc')}`,
        ]);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/login?error=invalid_state');
      const cleared = findCookie(res, 'oauth_return_to');
      expect(cleared).toBeDefined();
      expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    });
  });

  describe('(e) callback with no cookie → onboarding default (SC-006 regression)', () => {
    test('lands on the onboarding default destination when no returnTo', async () => {
      const state = 'valid-state-e';
      const res = await request(app)
        .get(`/auth/google/callback?code=fake-code&state=${state}`)
        .set('Cookie', [
          `oauth_state=${state}`,
          `oauth_redirect=http://localhost:5173`,
        ]);
      expect(res.status).toBe(302);
      // Default destination — with our onboarding mock returning onboarded=true,
      // the fallback is /docs?signup=1.
      expect(res.headers.location).toBe('http://localhost:5173/docs?signup=1');
    });
  });
});
