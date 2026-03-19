/**
 * Admin API tests
 */
const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const { createPool } = require('../../__tests__/helpers/db');

// Set test secrets before requiring auth modules
process.env.ACCESS_TOKEN_SECRET = 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';

const admin = require('../admin');
const users = require('../../auth/users');
const { generateAccessToken } = require('../../auth/jwt');
const { requireAdmin } = require('../../auth/middleware');

describe('Admin API', () => {
  let app;
  let pool;
  let adminUser;
  let regularUser;

  beforeAll(async () => {
    pool = createPool();
    users.init(pool);
    admin.init(pool);

    app = express();
    app.use(express.json());
    app.use('/api/admin/users', requireAdmin, admin.router);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Create an admin user
    const adminProfile = {
      googleId: `admin-google-${crypto.randomUUID()}`,
      email: `admin-${crypto.randomUUID()}@example.com`,
      name: 'Admin User',
      picture: 'https://example.com/admin.jpg',
    };
    adminUser = await users.findOrCreateUser(adminProfile);
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [adminUser.id]);
    // Refresh to pick up is_admin
    adminUser = await users.findById(adminUser.id);

    // Create a regular user
    const regularProfile = {
      googleId: `regular-google-${crypto.randomUUID()}`,
      email: `regular-${crypto.randomUUID()}@example.com`,
      name: 'Regular User',
      picture: null,
    };
    regularUser = await users.findOrCreateUser(regularProfile);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM document_shares WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com')");
    await pool.query("DELETE FROM ai_usage_log WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com')");
    await pool.query("DELETE FROM users WHERE email LIKE '%@example.com'");
  });

  describe('GET /api/admin/users', () => {
    test('returns 401 without authorization', async () => {
      await request(app)
        .get('/api/admin/users')
        .expect(401);
    });

    test('returns 403 for non-admin user', async () => {
      const token = generateAccessToken(regularUser);

      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect(response.body.error).toBe('Admin access required');
    });

    test('returns user list for admin user', async () => {
      const token = generateAccessToken(adminUser);

      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.users).toBeDefined();
      expect(Array.isArray(response.body.users)).toBe(true);

      // Should include both test users
      const emails = response.body.users.map(u => u.email);
      expect(emails).toContain(adminUser.email);
      expect(emails).toContain(regularUser.email);
    });

    test('returns correct fields in camelCase', async () => {
      const token = generateAccessToken(adminUser);

      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const admin = response.body.users.find(u => u.id === adminUser.id);
      expect(admin).toBeDefined();
      expect(admin.name).toBe('Admin User');
      expect(admin.email).toBe(adminUser.email);
      expect(admin.isAdmin).toBe(true);
      expect(admin.createdAt).toBeDefined();
      expect(typeof admin.docCount).toBe('number');
      expect(typeof admin.aiUsedCents).toBe('number');
      expect(typeof admin.aiRemainingCents).toBe('number');
      expect(typeof admin.aiCreditCents).toBe('number');
      // lastLoginAt may be null
      expect('lastLoginAt' in admin).toBe(true);
    });

    test('returns correct doc count', async () => {
      // Create a document owned by the regular user
      const docId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO documents (id) VALUES ($1) ON CONFLICT DO NOTHING",
        [docId]
      );
      await pool.query(
        "INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')",
        [docId, regularUser.id]
      );

      const token = generateAccessToken(adminUser);
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const user = response.body.users.find(u => u.id === regularUser.id);
      expect(user.docCount).toBe(1);

      // Cleanup
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    });

    test('does not inflate AI usage when user has multiple docs (no fan-out)', async () => {
      // Create two docs owned by the regular user
      const docIds = [crypto.randomUUID(), crypto.randomUUID()];
      for (const docId of docIds) {
        await pool.query(
          "INSERT INTO documents (id) VALUES ($1) ON CONFLICT DO NOTHING",
          [docId]
        );
        await pool.query(
          "INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')",
          [docId, regularUser.id]
        );
      }

      // Create a single AI usage log entry worth 100 cents
      await pool.query(
        `INSERT INTO ai_usage_log (user_id, model_key, input_tokens, output_tokens, cost_cents, is_byok)
         VALUES ($1, 'test-model', 100, 50, 100, false)`,
        [regularUser.id]
      );

      const token = generateAccessToken(adminUser);
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const user = response.body.users.find(u => u.id === regularUser.id);
      expect(user.docCount).toBe(2);
      // Should be exactly 100, not 200 (which would indicate fan-out)
      expect(user.aiUsedCents).toBe(100);

      // Cleanup
      await pool.query('DELETE FROM ai_usage_log WHERE user_id = $1', [regularUser.id]);
      for (const docId of docIds) {
        await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
        await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
      }
    });

    test('excludes BYOK usage from AI used cents', async () => {
      const docId = crypto.randomUUID();
      await pool.query("INSERT INTO documents (id) VALUES ($1) ON CONFLICT DO NOTHING", [docId]);
      await pool.query(
        "INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')",
        [docId, regularUser.id]
      );

      // Non-BYOK usage
      await pool.query(
        `INSERT INTO ai_usage_log (user_id, model_key, input_tokens, output_tokens, cost_cents, is_byok)
         VALUES ($1, 'test-model', 100, 50, 50, false)`,
        [regularUser.id]
      );
      // BYOK usage (should be excluded)
      await pool.query(
        `INSERT INTO ai_usage_log (user_id, model_key, input_tokens, output_tokens, cost_cents, is_byok)
         VALUES ($1, 'test-model', 100, 50, 200, true)`,
        [regularUser.id]
      );

      const token = generateAccessToken(adminUser);
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const user = response.body.users.find(u => u.id === regularUser.id);
      expect(user.aiUsedCents).toBe(50); // Only non-BYOK

      // Cleanup
      await pool.query('DELETE FROM ai_usage_log WHERE user_id = $1', [regularUser.id]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    });

    test('aiRemainingCents is never negative', async () => {
      // Set credit to 0 and add some usage
      await pool.query('UPDATE users SET ai_credit_cents = 0 WHERE id = $1', [regularUser.id]);

      const docId = crypto.randomUUID();
      await pool.query("INSERT INTO documents (id) VALUES ($1) ON CONFLICT DO NOTHING", [docId]);
      await pool.query(
        "INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')",
        [docId, regularUser.id]
      );
      await pool.query(
        `INSERT INTO ai_usage_log (user_id, model_key, input_tokens, output_tokens, cost_cents, is_byok)
         VALUES ($1, 'test-model', 100, 50, 100, false)`,
        [regularUser.id]
      );

      const token = generateAccessToken(adminUser);
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const user = response.body.users.find(u => u.id === regularUser.id);
      expect(user.aiRemainingCents).toBe(0);
      expect(user.aiUsedCents).toBe(100);

      // Cleanup
      await pool.query('DELETE FROM ai_usage_log WHERE user_id = $1', [regularUser.id]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    });

    test('users are ordered by created_at descending', async () => {
      const token = generateAccessToken(adminUser);

      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const dates = response.body.users.map(u => new Date(u.createdAt).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
      }
    });
  });
});
