/**
 * Feature 058 (T019, US2): with the production overlay's values
 * (SQUIRE_HOSTED=true, APP_URL=https://squiredocs.com), every hosted surface
 * behaves as it did before the feature.
 */
const fs = require('fs');
const request = require('supertest');
const express = require('express');
const { _resetInstanceConfigForTests, resolveInstanceConfig } = require('../instance-config');
const { mountWebRoutes, buildCspDirectives } = require('../web-routes');
const { createClientBuildFixture, REAL_AGENTS } = require('./helpers/web-fixture');

const SAVED = {};
const NAMES = ['SQUIRE_HOSTED', 'APP_URL', 'NODE_ENV', 'ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET'];
let fixture;
let app;

beforeAll(() => {
  for (const n of NAMES) SAVED[n] = process.env[n];
  process.env.SQUIRE_HOSTED = 'true';
  process.env.APP_URL = 'https://squiredocs.com';
  _resetInstanceConfigForTests();
  fixture = createClientBuildFixture();
  app = express();
  mountWebRoutes(app, { clientBuildPath: fixture.dir });
});

afterAll(() => {
  fixture.cleanup();
  for (const n of NAMES) {
    if (SAVED[n] === undefined) delete process.env[n];
    else process.env[n] = SAVED[n];
  }
  _resetInstanceConfigForTests();
});

describe('pages', () => {
  test.each([
    ['/', 'LANDING PAGE'],
    ['/pricing', 'PRICING PAGE'],
    ['/about', 'ABOUT PAGE'],
    ['/security', 'SECURITY PAGE'],
    ['/landing.html', 'LANDING PAGE'],
    ['/blog', 'BLOG INDEX'],
  ])('%s serves its file', async (p, marker) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(200);
    expect(res.text).toContain(marker);
  });

  test.each(['/privacy', '/terms', '/docs', '/index.html'])('%s serves the hosted shell with the analytics tag', async (p) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<script>window.__SQUIRE_INSTANCE__={"hosted":true}</script>');
    expect(res.text).toContain('https://www.googletagmanager.com/gtag/js?id=G-9HGTDJRJWH');
    expect(res.text).toContain("gtag('config', 'AW-18023084061');");
  });

  test('/agents.md is served verbatim', async () => {
    const res = await request(app).get('/agents.md').set('Host', 'localhost:3910');
    expect(res.status).toBe(200);
    expect(res.text).toBe(fs.readFileSync(REAL_AGENTS, 'utf8'));
    expect(res.text).toContain('https://squiredocs.com');
  });

  test('root blog assets keep their edge-cache header', async () => {
    const res = await request(app).get('/blog.css');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=3600, s-maxage=31536000');
  });
});

describe('CSP', () => {
  // The pre-058 literal policy from server/index.js, with a configured bucket.
  const BUCKET_ORIGIN = 'https://squire-images.s3.us-east-1.amazonaws.com';
  const storage = { cspImageSources: () => [BUCKET_ORIGIN] };

  test('hosted directives are byte-identical to the pre-058 policy', () => {
    expect(buildCspDirectives({ hosted: true, storage })).toEqual({
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://www.googletagmanager.com', 'https://googleads.g.doubleclick.net', 'https://www.googleadservices.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com', 'https://www.googletagmanager.com', 'https://googleads.g.doubleclick.net', 'https://www.google.com', 'https://*.gstatic.com', BUCKET_ORIGIN],
      connectSrc: ["'self'", 'ws:', 'wss:', 'https://www.google-analytics.com', 'https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://www.google.com', 'https://googleads.g.doubleclick.net'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    });
  });
});

describe('cookies', () => {
  test('production + https APP_URL: Secure and SameSite=Strict', () => {
    process.env.NODE_ENV = 'production';
    process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'hosted-parity-access-secret-0123456789';
    process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'hosted-parity-refresh-secret-0123456789';
    _resetInstanceConfigForTests();
    let jwt;
    jest.isolateModules(() => { jwt = require('../auth/jwt'); });
    for (const o of [jwt.getCookieOptions(), jwt.getAccessTokenCookieOptions(), jwt.getClearCookieOptions()]) {
      expect(o).toMatchObject({ httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
    }
    process.env.NODE_ENV = SAVED.NODE_ENV;
  });
});

describe('email', () => {
  test('the production SES_* names yield the pre-058 transport', () => {
    const { smtp } = resolveInstanceConfig({
      SES_SMTP_USER: 'AKIA', SES_SMTP_PASS: 'pw', SES_FROM_EMAIL: 'noreply@squiredocs.com',
    });
    expect(smtp).toMatchObject({ host: 'email-smtp.us-west-2.amazonaws.com', port: 465, secure: true, from: 'noreply@squiredocs.com' });
  });
});

describe('derived URLs', () => {
  test('the overlay values keep every derived value', () => {
    const c = resolveInstanceConfig({
      NODE_ENV: 'production', SQUIRE_HOSTED: 'true', MIGRATE_ON_BOOT: 'false',
      APP_URL: 'https://squiredocs.com', STORAGE_DRIVER: 's3', S3_IMAGE_BUCKET: 'b',
      CLIENT_URL: 'https://squiredocs.com', GOOGLE_REDIRECT_URI: 'https://squiredocs.com/auth/google/callback',
    });
    expect(c).toMatchObject({
      hosted: true, migrateOnBoot: false, storageDriver: 's3', cookieSecure: true, insecureRemoteHttp: false,
      clientUrl: 'https://squiredocs.com', googleRedirectUri: 'https://squiredocs.com/auth/google/callback',
      publicOrigin: 'https://squiredocs.com',
    });
  });
});
