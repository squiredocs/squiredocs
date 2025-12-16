/**
 * Auth routes integration tests
 * Tests the actual HTTP endpoints
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const crypto = require('crypto');

// Set test secrets before requiring auth modules
process.env.ACCESS_TOKEN_SECRET = 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';

const authRouter = require('../routes');
const users = require('../users');
const { generateAccessToken, generateRefreshToken } = require('../jwt');

describe('Auth routes', () => {
  let app;
  let pool;
  let testUser;

  // Test database config
  const testDbConfig = process.env.TEST_DATABASE_URL || {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.TEST_DB_NAME || 'collab_db',
    user: process.env.DB_USER || process.env.USER || 'postgres',
    password: process.env.DB_PASSWORD || ''
  };

  beforeAll(async () => {
    pool = new Pool(testDbConfig);
    users.init(pool);

    // Set up Express app for testing
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/auth', authRouter);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Create a test user for each test
    const profile = {
      googleId: `test-google-${crypto.randomUUID()}`,
      email: `test-${crypto.randomUUID()}@example.com`,
      name: 'Test User',
      picture: 'https://example.com/pic.jpg',
    };
    testUser = await users.findOrCreateUser(profile);
  });

  afterEach(async () => {
    // Clean up test users
    await pool.query("DELETE FROM users WHERE email LIKE 'test-%@example.com'");
  });

  describe('GET /auth/google', () => {
    test('redirects to Google OAuth', async () => {
      const response = await request(app)
        .get('/auth/google')
        .expect(302);

      expect(response.headers.location).toContain('accounts.google.com');
      expect(response.headers.location).toContain('client_id=test-client-id');
    });

    test('sets oauth_redirect cookie from origin header', async () => {
      const response = await request(app)
        .get('/auth/google')
        .set('Origin', 'http://localhost:5173')
        .expect(302);

      const cookies = response.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies.some(c => c.includes('oauth_redirect='))).toBe(true);
    });
  });

  describe('POST /auth/refresh', () => {
    test('returns new access token with valid refresh token', async () => {
      const refreshToken = generateRefreshToken(testUser);

      const response = await request(app)
        .post('/auth/refresh')
        .set('Cookie', `refreshToken=${refreshToken}`)
        .expect(200);

      expect(response.body.accessToken).toBeDefined();
      expect(typeof response.body.accessToken).toBe('string');
    });

    test('returns 401 when no refresh token cookie', async () => {
      const response = await request(app)
        .post('/auth/refresh')
        .expect(401);

      expect(response.body.error).toBe('No refresh token');
    });

    test('returns 401 for invalid refresh token', async () => {
      const response = await request(app)
        .post('/auth/refresh')
        .set('Cookie', 'refreshToken=invalid-token')
        .expect(401);

      expect(response.body.error).toBe('Invalid refresh token');
    });

    test('returns 401 when token version mismatch (token revoked)', async () => {
      const refreshToken = generateRefreshToken(testUser);
      
      // Increment token version to "revoke" the token
      await users.incrementTokenVersion(testUser.id);

      const response = await request(app)
        .post('/auth/refresh')
        .set('Cookie', `refreshToken=${refreshToken}`)
        .expect(401);

      expect(response.body.error).toBe('Token revoked');
    });

    test('returns 401 for non-existent user', async () => {
      // Create token for a user, then delete the user
      const refreshToken = generateRefreshToken(testUser);
      await pool.query('DELETE FROM users WHERE id = $1', [testUser.id]);

      const response = await request(app)
        .post('/auth/refresh')
        .set('Cookie', `refreshToken=${refreshToken}`)
        .expect(401);

      expect(response.body.error).toBe('User not found');
    });

    test('rotates refresh token (sets new cookie)', async () => {
      const refreshToken = generateRefreshToken(testUser);

      const response = await request(app)
        .post('/auth/refresh')
        .set('Cookie', `refreshToken=${refreshToken}`)
        .expect(200);

      const cookies = response.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies.some(c => c.includes('refreshToken='))).toBe(true);
    });
  });

  describe('GET /auth/me', () => {
    test('returns user profile with valid access token', async () => {
      const accessToken = generateAccessToken(testUser);

      const response = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.id).toBe(testUser.id);
      expect(response.body.email).toBe(testUser.email);
      expect(response.body.name).toBe(testUser.name);
      expect(response.body.picture).toBe(testUser.picture);
      // Sensitive fields should not be included
      expect(response.body.token_version).toBeUndefined();
      expect(response.body.google_id).toBeUndefined();
    });

    test('returns 401 without authorization header', async () => {
      const response = await request(app)
        .get('/auth/me')
        .expect(401);

      expect(response.body.error).toBe('No authorization header');
    });

    test('returns 401 for invalid token', async () => {
      const response = await request(app)
        .get('/auth/me')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body.error).toBe('Invalid token');
    });

    test('returns 404 for deleted user', async () => {
      const accessToken = generateAccessToken(testUser);
      await pool.query('DELETE FROM users WHERE id = $1', [testUser.id]);

      const response = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      expect(response.body.error).toBe('User not found');
    });
  });

  describe('POST /auth/logout', () => {
    test('invalidates refresh tokens and clears cookie', async () => {
      const accessToken = generateAccessToken(testUser);
      const initialVersion = testUser.token_version;

      const response = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);

      // Check token version was incremented
      const updatedVersion = await users.getTokenVersion(testUser.id);
      expect(updatedVersion).toBe(initialVersion + 1);

      // Check cookie is cleared
      const cookies = response.headers['set-cookie'];
      expect(cookies).toBeDefined();
      // Cookie should be cleared (empty value or expired)
      expect(cookies.some(c => c.includes('refreshToken='))).toBe(true);
    });

    test('returns 401 without authorization', async () => {
      const response = await request(app)
        .post('/auth/logout')
        .expect(401);

      expect(response.body.error).toBe('No authorization header');
    });

    test('clears cookie even if user deleted', async () => {
      const accessToken = generateAccessToken(testUser);
      await pool.query('DELETE FROM users WHERE id = $1', [testUser.id]);

      const response = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(500);

      // Cookie should still be cleared
      const cookies = response.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies.some(c => c.includes('refreshToken='))).toBe(true);
    });
  });

  describe('POST /auth/dev-login', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    test('creates test user and returns tokens in development mode', async () => {
      process.env.NODE_ENV = 'development';

      const response = await request(app)
        .post('/auth/dev-login')
        .expect(200);

      expect(response.body.accessToken).toBeDefined();
      expect(typeof response.body.accessToken).toBe('string');
      expect(response.body.user).toBeDefined();
      expect(response.body.user.email).toBe('dev@test.local');
      expect(response.body.user.name).toBe('Dev Test User');

      // Check refresh token cookie is set
      const cookies = response.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies.some(c => c.includes('refreshToken='))).toBe(true);
    });

    test('returns same user on subsequent calls', async () => {
      process.env.NODE_ENV = 'development';

      const response1 = await request(app)
        .post('/auth/dev-login')
        .expect(200);

      const response2 = await request(app)
        .post('/auth/dev-login')
        .expect(200);

      expect(response1.body.user.id).toBe(response2.body.user.id);
      expect(response1.body.user.email).toBe('dev@test.local');
      expect(response2.body.user.email).toBe('dev@test.local');
    });

    test('returns 403 in production mode', async () => {
      process.env.NODE_ENV = 'production';

      const response = await request(app)
        .post('/auth/dev-login')
        .expect(403);

      expect(response.body.error).toBe('Dev login only available in development mode');
    });

    test('returns 403 when NODE_ENV is not set', async () => {
      delete process.env.NODE_ENV;

      const response = await request(app)
        .post('/auth/dev-login')
        .expect(403);

      expect(response.body.error).toBe('Dev login only available in development mode');
    });
  });
});


