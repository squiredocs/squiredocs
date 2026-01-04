/**
 * Waitlist API integration tests
 */
const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

const waitlist = require('../waitlist');
const { createPool } = require('./helpers/db');

describe('Waitlist API', () => {
  let app;
  let pool;

  beforeAll(async () => {
    // Use shared test database configuration
    pool = createPool();
    waitlist.init(pool);

    // Set up Express app for testing
    app = express();
    app.use(express.json());
    app.use('/api/waitlist', waitlist.router);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    // Clean up test entries
    await pool.query("DELETE FROM waitlist WHERE email LIKE 'test-%@example.com'");
  });

  describe('POST /api/waitlist', () => {
    test('successfully adds email to waitlist', async () => {
      const email = `test-${crypto.randomUUID()}@example.com`;

      const response = await request(app)
        .post('/api/waitlist')
        .send({ email })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toContain("You're on the list");
      expect(response.body.id).toBeDefined();

      // Verify in database
      const result = await pool.query('SELECT * FROM waitlist WHERE email = $1', [email]);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].email).toBe(email);
    });

    test('accepts email with optional role', async () => {
      const email = `test-${crypto.randomUUID()}@example.com`;

      const response = await request(app)
        .post('/api/waitlist')
        .send({ email, role: 'consultant' })
        .expect(201);

      expect(response.body.success).toBe(true);

      // Verify role in database
      const result = await pool.query('SELECT * FROM waitlist WHERE email = $1', [email]);
      expect(result.rows[0].role).toBe('consultant');
    });

    test('accepts email with optional org_size', async () => {
      const email = `test-${crypto.randomUUID()}@example.com`;

      const response = await request(app)
        .post('/api/waitlist')
        .send({ email, org_size: '11-50' })
        .expect(201);

      expect(response.body.success).toBe(true);

      // Verify org_size in database
      const result = await pool.query('SELECT * FROM waitlist WHERE email = $1', [email]);
      expect(result.rows[0].org_size).toBe('11-50');
    });

    test('accepts all optional fields together', async () => {
      const email = `test-${crypto.randomUUID()}@example.com`;

      const response = await request(app)
        .post('/api/waitlist')
        .send({ email, role: 'legal', org_size: '201-1000' })
        .expect(201);

      expect(response.body.success).toBe(true);

      // Verify all fields in database
      const result = await pool.query('SELECT * FROM waitlist WHERE email = $1', [email]);
      expect(result.rows[0].role).toBe('legal');
      expect(result.rows[0].org_size).toBe('201-1000');
    });

    test('normalizes email to lowercase', async () => {
      const uuid = crypto.randomUUID();
      const email = `Test-${uuid}@Example.COM`;

      const response = await request(app)
        .post('/api/waitlist')
        .send({ email })
        .expect(201);

      expect(response.body.success).toBe(true);

      // Verify email is lowercase in database
      const result = await pool.query('SELECT * FROM waitlist WHERE email = $1', [email.toLowerCase()]);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].email).toBe(email.toLowerCase());
    });

    test('handles duplicate email gracefully (updates optional fields)', async () => {
      const email = `test-${crypto.randomUUID()}@example.com`;

      // First signup without optional fields
      await request(app)
        .post('/api/waitlist')
        .send({ email })
        .expect(201);

      // Second signup with optional fields should update
      const response = await request(app)
        .post('/api/waitlist')
        .send({ email, role: 'grant_writer', org_size: '1-10' })
        .expect(201);

      expect(response.body.success).toBe(true);

      // Verify only one entry exists with updated fields
      const result = await pool.query('SELECT * FROM waitlist WHERE email = $1', [email]);
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].role).toBe('grant_writer');
      expect(result.rows[0].org_size).toBe('1-10');
    });

    test('returns 400 when email is missing', async () => {
      const response = await request(app)
        .post('/api/waitlist')
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Email is required');
    });

    test('returns 400 for invalid email format', async () => {
      const response = await request(app)
        .post('/api/waitlist')
        .send({ email: 'not-an-email' })
        .expect(400);

      expect(response.body.error).toBe('Invalid email format');
    });

    test('returns 400 for email without domain', async () => {
      const response = await request(app)
        .post('/api/waitlist')
        .send({ email: 'test@' })
        .expect(400);

      expect(response.body.error).toBe('Invalid email format');
    });

    test('returns 400 for invalid role', async () => {
      const email = `test-${crypto.randomUUID()}@example.com`;

      const response = await request(app)
        .post('/api/waitlist')
        .send({ email, role: 'invalid_role' })
        .expect(400);

      expect(response.body.error).toBe('Invalid role');
    });

    test('returns 400 for invalid org_size', async () => {
      const email = `test-${crypto.randomUUID()}@example.com`;

      const response = await request(app)
        .post('/api/waitlist')
        .send({ email, org_size: 'huge' })
        .expect(400);

      expect(response.body.error).toBe('Invalid organization size');
    });

    test('accepts all valid roles', async () => {
      const validRoles = ['consultant', 'legal', 'grant_writer', 'rfp_manager', 'other'];

      for (const role of validRoles) {
        const email = `test-${crypto.randomUUID()}@example.com`;
        const response = await request(app)
          .post('/api/waitlist')
          .send({ email, role })
          .expect(201);

        expect(response.body.success).toBe(true);
      }
    });

    test('accepts all valid org sizes', async () => {
      const validOrgSizes = ['1-10', '11-50', '51-200', '201-1000', '1000+'];

      for (const org_size of validOrgSizes) {
        const email = `test-${crypto.randomUUID()}@example.com`;
        const response = await request(app)
          .post('/api/waitlist')
          .send({ email, org_size })
          .expect(201);

        expect(response.body.success).toBe(true);
      }
    });
  });
});
