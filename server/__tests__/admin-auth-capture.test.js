/**
 * Feature 034 (T011) — the exposure boundary of the capture data.
 *
 * IP + user-agent is personal data and an abuse-detection signal: the admin
 * area is its ENTIRE exposure surface (FR-011/FR-012, SC-005). Two halves:
 *
 *   (a) an admin GET /api/admin/users carries all four values, and renders
 *       pre-feature accounts as null rather than fabricating anything;
 *   (b) nobody else can reach them — the non-admin assertion mounts the router
 *       behind the REAL requireAdmin middleware, exactly as server/index.js does
 *       (`app.use('/api/admin', requireAdmin, admin.router)`). Mounting
 *       admin.router bare (as admin-sharing.test.js does) would bypass the gate
 *       and make the 403 assertion vacuous.
 *
 * The third assertion pins the GET /auth/me payload to its documented
 * whitelist, which is what structurally prevents the new users columns from
 * leaking through the one endpoint every signed-in user calls.
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { createPool } = require('./helpers/db');

// Set test secrets before requiring auth modules.
process.env.ACCESS_TOKEN_SECRET = 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

const admin = require('../api/admin');
const appSettings = require('../api/app-settings');
const aiUsage = require('../ai-usage');
const users = require('../auth/users');
const authRouter = require('../auth/routes');
const { generateAccessToken } = require('../auth/jwt');
const { requireAdmin } = require('../auth/middleware');

const EMAIL_SUFFIX = '@auth-capture.test.example.com';

describe('Feature 034: capture exposure boundary', () => {
  let app;
  let pool;
  let adminUser;
  let adminToken;
  let capturedUser;
  let preFeatureUser;
  let regularUser;
  let regularToken;

  beforeAll(async () => {
    pool = createPool();
    users.init(pool);
    admin.init(pool);
    aiUsage.init(pool);
    await appSettings.init(pool);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    // The production mounting, gate included (server/index.js).
    app.use('/api/admin', requireAdmin, admin.router);
    app.use('/auth', authRouter);

    // An account that signed in WITH capture.
    capturedUser = await users.findOrCreateUser(
      {
        googleId: `capture-${crypto.randomUUID()}`,
        email: `captured-${crypto.randomUUID()}${EMAIL_SUFFIX}`,
        name: 'Captured User',
        picture: null,
      },
      { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (Captured)' }
    );
    await users.updateLastLogin(capturedUser.id, {
      ip: '198.51.100.9',
      userAgent: 'Mozilla/5.0 (Latest)',
      isNew: true,
    });

    // An account that predates the feature — no capture context at all.
    preFeatureUser = await users.findOrCreateUser({
      googleId: `prefeature-${crypto.randomUUID()}`,
      email: `prefeature-${crypto.randomUUID()}${EMAIL_SUFFIX}`,
      name: 'Pre-feature User',
      picture: null,
    });

    adminUser = await users.findOrCreateUser({
      googleId: `admin-${crypto.randomUUID()}`,
      email: `admin-${crypto.randomUUID()}${EMAIL_SUFFIX}`,
      name: 'Admin User',
      picture: null,
    });
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [adminUser.id]);
    adminUser = await users.findById(adminUser.id);
    adminToken = generateAccessToken(adminUser);

    regularUser = await users.findOrCreateUser({
      googleId: `regular-${crypto.randomUUID()}`,
      email: `regular-${crypto.randomUUID()}${EMAIL_SUFFIX}`,
      name: 'Regular User',
      picture: null,
    });
    regularToken = generateAccessToken(regularUser);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE email LIKE '%${EMAIL_SUFFIX}'`);
    await pool.end();
  });

  describe('GET /api/admin/users (admin)', () => {
    let body;

    beforeAll(async () => {
      const res = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      body = res.body;
    });

    test('returns the four capture fields with their stored values (FR-011)', () => {
      const row = body.users.find((u) => u.id === capturedUser.id);
      expect(row).toBeDefined();
      expect(row.signupIp).toBe('203.0.113.7');
      expect(row.signupUserAgent).toBe('Mozilla/5.0 (Captured)');
      expect(row.lastLoginIp).toBe('198.51.100.9');
      expect(row.lastLoginUserAgent).toBe('Mozilla/5.0 (Latest)');
    });

    test('renders a pre-feature account as null, not a fabricated value (US1 acceptance 4)', () => {
      const row = body.users.find((u) => u.id === preFeatureUser.id);
      expect(row).toBeDefined();
      expect(row.signupIp).toBeNull();
      expect(row.signupUserAgent).toBeNull();
      expect(row.lastLoginIp).toBeNull();
      expect(row.lastLoginUserAgent).toBeNull();
    });

    test('leaves the existing payload shape intact', () => {
      const row = body.users.find((u) => u.id === capturedUser.id);
      expect(row).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          email: expect.any(String),
          docCount: expect.any(Number),
          aiRemainingCents: expect.any(Number),
        })
      );
    });
  });

  describe('non-admin exposure (FR-012)', () => {
    test('a signed-in non-admin gets 403 and no capture data', async () => {
      const res = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${regularToken}`);

      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('203.0.113.7');
      expect(JSON.stringify(res.body)).not.toContain('signupIp');
      expect(res.body.users).toBeUndefined();
    });

    test('an unauthenticated caller gets 401 and no capture data', async () => {
      const res = await request(app).get('/api/admin/users');
      expect(res.status).toBe(401);
      expect(res.body.users).toBeUndefined();
    });
  });

  describe('GET /auth/me (SC-005)', () => {
    test('payload keys are exactly the documented whitelist — no capture fields', async () => {
      const token = generateAccessToken(capturedUser);
      const res = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual([
        'email',
        'emailEnabled',
        'id',
        'isAdmin',
        'name',
        'onboarded',
        'picture',
        'welcomeDocId',
      ]);
      expect(JSON.stringify(res.body)).not.toContain('203.0.113.7');
      expect(JSON.stringify(res.body)).not.toContain('Mozilla');
    });
  });
});
