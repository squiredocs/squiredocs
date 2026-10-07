/**
 * Feature 058 (T021, FR-011): the auth cookie `Secure` flag follows APP_URL's
 * scheme, independent of NODE_ENV; SameSite keeps its NODE_ENV rule. Drives
 * the real server/auth/jwt.js exports.
 */
const { _resetInstanceConfigForTests } = require('../../instance-config');

const savedNodeEnv = process.env.NODE_ENV;
const savedAppUrl = process.env.APP_URL;
const SECRETS = {
  ACCESS_TOKEN_SECRET: 'cookie-secure-test-access-secret-0123456789',
  REFRESH_TOKEN_SECRET: 'cookie-secure-test-refresh-secret-0123456789',
};

let jwt;
beforeAll(() => {
  // jwt.js checks these at require time when NODE_ENV=production; require it
  // once with strong values so the production cases can run.
  Object.assign(process.env, SECRETS);
  jwt = require('../jwt');
});

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv;
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
  _resetInstanceConfigForTests();
});

function configure(nodeEnv, appUrl) {
  process.env.NODE_ENV = nodeEnv;
  process.env.APP_URL = appUrl;
  _resetInstanceConfigForTests();
}

const allOptions = () => [
  jwt.getCookieOptions(),
  jwt.getAccessTokenCookieOptions(),
  jwt.getClearCookieOptions(),
];

test('production + http APP_URL: not Secure, SameSite strict', () => {
  configure('production', 'http://localhost:3910');
  for (const o of allOptions()) {
    expect(o.secure).toBe(false);
    expect(o.sameSite).toBe('strict');
    expect(o.httpOnly).toBe(true);
    expect(o.path).toBe('/');
  }
});

test('production + https APP_URL: Secure, SameSite strict', () => {
  configure('production', 'https://docs.example.com');
  for (const o of allOptions()) {
    expect(o.secure).toBe(true);
    expect(o.sameSite).toBe('strict');
  }
});

test('development + http APP_URL: not Secure, SameSite lax', () => {
  configure('development', 'http://localhost:3001');
  for (const o of allOptions()) {
    expect(o.secure).toBe(false);
    expect(o.sameSite).toBe('lax');
  }
});

test('maxAge values are unchanged', () => {
  configure('production', 'https://squiredocs.com');
  expect(jwt.getCookieOptions().maxAge).toBe(7 * 24 * 60 * 60 * 1000);
  expect(jwt.getAccessTokenCookieOptions().maxAge).toBe(15 * 60 * 1000);
  expect(jwt.getClearCookieOptions().maxAge).toBeUndefined();
});
