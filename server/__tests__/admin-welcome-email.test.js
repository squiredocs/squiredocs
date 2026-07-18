/**
 * Tests for the admin-triggered welcome-email endpoint (server/api/admin.js).
 * The email module is mocked so no SMTP call is made; we assert the route wiring,
 * the derived first name, the BCC/recipient contract, and the sent-at bookkeeping.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../email', () => ({
  sendWelcomeEmail: jest.fn(),
}));

const { sendWelcomeEmail } = require('../email');
const admin = require('../api/admin');
const { createPool } = require('./helpers/db');

describe('Admin: welcome email', () => {
  let app;
  let pool;
  let userId;

  beforeAll(async () => {
    pool = createPool();
    admin.init(pool);

    const u = await pool.query(
      `INSERT INTO users (google_id, email, name)
       VALUES ('test-welcome-user', 'test-welcome-user@example.com', 'Ada Lovelace')
       RETURNING id`
    );
    userId = u.rows[0].id;

    app = express();
    app.use(express.json());
    app.use('/api/admin', admin.router);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM users WHERE email = 'test-welcome-user@example.com'");
    await pool.end();
  });

  beforeEach(() => {
    sendWelcomeEmail.mockReset();
  });

  test('sends the email to the user with their first name and records the send', async () => {
    sendWelcomeEmail.mockResolvedValue({ ok: true, messageId: 'test-id' });

    const res = await request(app).post(`/api/admin/users/${userId}/welcome-email`);
    expect(res.status).toBe(200);
    expect(res.body.welcomeEmailSentAt).toBeTruthy();

    expect(sendWelcomeEmail).toHaveBeenCalledWith({
      to: 'test-welcome-user@example.com',
      firstName: 'Ada',
    });

    const check = await pool.query('SELECT welcome_email_sent_at FROM users WHERE id = $1', [userId]);
    expect(check.rows[0].welcome_email_sent_at).toBeTruthy();
  });

  test('does not record a send time when the email fails', async () => {
    await pool.query('UPDATE users SET welcome_email_sent_at = NULL WHERE id = $1', [userId]);
    sendWelcomeEmail.mockResolvedValue({ ok: false, error: 'SMTP down' });

    const res = await request(app).post(`/api/admin/users/${userId}/welcome-email`);
    expect(res.status).toBe(502);

    const check = await pool.query('SELECT welcome_email_sent_at FROM users WHERE id = $1', [userId]);
    expect(check.rows[0].welcome_email_sent_at).toBeNull();
  });

  test('returns 503 when email is not configured', async () => {
    sendWelcomeEmail.mockResolvedValue({ ok: false, skipped: true });

    const res = await request(app).post(`/api/admin/users/${userId}/welcome-email`);
    expect(res.status).toBe(503);
  });

  test('returns 404 for an unknown user', async () => {
    sendWelcomeEmail.mockResolvedValue({ ok: true, messageId: 'x' });

    const res = await request(app).post(`/api/admin/users/${require('crypto').randomUUID()}/welcome-email`);
    expect(res.status).toBe(404);
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });
});
