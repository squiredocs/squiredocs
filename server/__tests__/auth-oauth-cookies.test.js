/**
 * Feature 058 (T022, FR-010, FR-011): the three transient OAuth cookies follow
 * APP_URL's scheme, and the Google redirect and post-sign-in URL derive from
 * APP_URL when not set explicitly. Mounts the real server/auth/routes.js with
 * the real server/auth/google.js (stub credentials; no network: GET
 * /auth/google only builds the consent URL).
 */
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { _resetInstanceConfigForTests } = require('../instance-config');

jest.mock('../email', () => ({
  notifyNewUser: jest.fn(),
  notifyLogin: jest.fn(),
  sendShareInvite: jest.fn(),
  sendShareNotification: jest.fn(),
}));

const authRouter = require('../auth/routes');

const SAVED = {};
const NAMES = ['APP_URL', 'CLIENT_URL', 'GOOGLE_REDIRECT_URI', 'NODE_ENV'];
beforeAll(() => { for (const n of NAMES) SAVED[n] = process.env[n]; });
afterEach(() => {
  for (const n of NAMES) {
    if (SAVED[n] === undefined) delete process.env[n];
    else process.env[n] = SAVED[n];
  }
  _resetInstanceConfigForTests();
});

function configure(vars) {
  for (const n of NAMES) if (n !== 'NODE_ENV') delete process.env[n];
  Object.assign(process.env, vars);
  _resetInstanceConfigForTests();
}

function app() {
  const a = express();
  a.use(cookieParser());
  a.use('/auth', authRouter);
  return a;
}

function cookieMap(res) {
  const out = {};
  for (const line of res.headers['set-cookie'] || []) {
    const name = line.split('=')[0];
    out[name] = line;
  }
  return out;
}

const TRANSIENT = ['oauth_redirect', 'oauth_return_to', 'oauth_state'];

test('http APP_URL: transient cookies are not Secure, SameSite=Lax', async () => {
  configure({ APP_URL: 'http://localhost:3910' });
  const res = await request(app()).get('/auth/google?returnTo=/docs');
  expect(res.status).toBe(302);
  const cookies = cookieMap(res);
  for (const name of TRANSIENT) {
    expect(cookies[name]).toBeDefined();
    expect(cookies[name]).not.toMatch(/;\s*Secure/i);
    expect(cookies[name]).toMatch(/SameSite=Lax/);
  }
});

test('https APP_URL: transient cookies are Secure, SameSite=Lax', async () => {
  configure({ APP_URL: 'https://docs.example.com' });
  const res = await request(app()).get('/auth/google?returnTo=/docs');
  const cookies = cookieMap(res);
  for (const name of TRANSIENT) {
    expect(cookies[name]).toMatch(/;\s*Secure/i);
    expect(cookies[name]).toMatch(/SameSite=Lax/);
  }
});

test('redirect_uri defaults to ${APP_URL}/auth/google/callback', async () => {
  configure({ APP_URL: 'http://localhost:3910' });
  const res = await request(app()).get('/auth/google');
  const url = new URL(res.headers.location);
  expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3910/auth/google/callback');
});

test('an explicit GOOGLE_REDIRECT_URI wins', async () => {
  configure({ APP_URL: 'http://localhost:3910', GOOGLE_REDIRECT_URI: 'https://login.example.com/cb' });
  const res = await request(app()).get('/auth/google');
  const url = new URL(res.headers.location);
  expect(url.searchParams.get('redirect_uri')).toBe('https://login.example.com/cb');
});

test('production with CLIENT_URL unset: oauth_redirect is APP_URL', async () => {
  configure({ APP_URL: 'https://docs.example.com', NODE_ENV: 'production' });
  const res = await request(app()).get('/auth/google').set('Origin', 'https://evil.example.com');
  const cookies = cookieMap(res);
  const value = decodeURIComponent(cookies.oauth_redirect.split(';')[0].split('=').slice(1).join('='));
  expect(value).toBe('https://docs.example.com');
});
