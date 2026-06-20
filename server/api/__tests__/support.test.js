/**
 * Support API tests
 */
const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const { createPool } = require('../../__tests__/helpers/db');

// Set test secrets before requiring auth modules
process.env.ACCESS_TOKEN_SECRET = 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';

// Mock the email module so no real mail is sent; assert it was invoked.
jest.mock('../../email', () => ({
  notifySupportRequest: jest.fn(),
}));

const support = require('../support');
const { notifySupportRequest } = require('../../email');
const users = require('../../auth/users');
const { generateAccessToken } = require('../../auth/jwt');

describe('Support API', () => {
  let app;
  let pool;
  let user;

  beforeAll(async () => {
    pool = createPool();
    users.init(pool);
    support.init(pool);

    app = express();
    app.use(express.json());
    app.use('/api/support', support.router);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    notifySupportRequest.mockClear();
    user = await users.findOrCreateUser({
      googleId: `support-google-${crypto.randomUUID()}`,
      email: `support-${crypto.randomUUID()}@example.com`,
      name: 'Support User',
      picture: null,
    });
  });

  afterEach(async () => {
    await pool.query("DELETE FROM support_requests WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com')");
    await pool.query("DELETE FROM users WHERE email LIKE '%@example.com'");
  });

  test('returns 401 without authorization', async () => {
    await request(app)
      .post('/api/support')
      .send({ message: 'Help me' })
      .expect(401);
  });

  test('saves the request and notifies the admin', async () => {
    const token = generateAccessToken(user);

    const res = await request(app)
      .post('/api/support')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '  My editor is stuck  ' })
      .expect(200);

    expect(res.body).toEqual({ success: true });

    // Persisted (trimmed)
    const { rows } = await pool.query(
      'SELECT user_id, message FROM support_requests WHERE user_id = $1',
      [user.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('My editor is stuck');

    // Admin notified with identity + message
    expect(notifySupportRequest).toHaveBeenCalledTimes(1);
    expect(notifySupportRequest).toHaveBeenCalledWith({
      email: user.email,
      name: 'Support User',
      message: 'My editor is stuck',
    });
  });

  test('returns 400 for an empty message', async () => {
    const token = generateAccessToken(user);

    await request(app)
      .post('/api/support')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '   ' })
      .expect(400);

    expect(notifySupportRequest).not.toHaveBeenCalled();
  });

  test('returns 400 for a missing message', async () => {
    const token = generateAccessToken(user);

    await request(app)
      .post('/api/support')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400);
  });

  test('returns 400 for an over-long message', async () => {
    const token = generateAccessToken(user);

    await request(app)
      .post('/api/support')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'x'.repeat(5001) })
      .expect(400);

    expect(notifySupportRequest).not.toHaveBeenCalled();
  });

  describe('GET /api/support', () => {
    test('returns 401 without authorization', async () => {
      await request(app).get('/api/support').expect(401);
    });

    test('lists only the user\'s own requests, newest first', async () => {
      const token = generateAccessToken(user);

      // Another user's request should not leak in
      const other = await users.findOrCreateUser({
        googleId: `support-other-${crypto.randomUUID()}`,
        email: `support-other-${crypto.randomUUID()}@example.com`,
        name: 'Other User',
        picture: null,
      });
      await pool.query('INSERT INTO support_requests (user_id, message) VALUES ($1, $2)', [other.id, 'not mine']);

      await request(app).post('/api/support').set('Authorization', `Bearer ${token}`).send({ message: 'first' }).expect(200);
      await request(app).post('/api/support').set('Authorization', `Bearer ${token}`).send({ message: 'second' }).expect(200);

      const res = await request(app)
        .get('/api/support')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.requests).toHaveLength(2);
      expect(res.body.requests[0].message).toBe('second');
      expect(res.body.requests[1].message).toBe('first');
      expect(res.body.requests[0]).toHaveProperty('id');
      expect(res.body.requests[0]).toHaveProperty('createdAt');
    });

    test('returns an empty list when the user has no requests', async () => {
      const token = generateAccessToken(user);
      const res = await request(app)
        .get('/api/support')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.requests).toEqual([]);
    });
  });
});
