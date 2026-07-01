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
const appSettings = require('../app-settings');
const aiUsage = require('../../ai-usage');
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
    aiUsage.init(pool);
    await appSettings.init(pool);

    app = express();
    app.use(express.json());
    app.use('/api/admin', requireAdmin, admin.router);
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
    await pool.query("DELETE FROM ai_extra_credits WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@example.com')");
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

    test('includes aiExtraCreditCents in user list', async () => {
      await aiUsage.grantExtraCredits(regularUser.id, 300, { memo: 'test' });

      const token = generateAccessToken(adminUser);
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const user = response.body.users.find(u => u.id === regularUser.id);
      expect(user.aiExtraCreditCents).toBe(300);
      expect(user.aiRemainingCents).toBe(regularUser.ai_credit_cents + 300);
    });

    test('excludes expired extra credits from stats', async () => {
      await pool.query(
        `INSERT INTO ai_extra_credits (user_id, amount_cents, expires_at)
         VALUES ($1, 500, now() - interval '1 day')`,
        [regularUser.id]
      );

      const token = generateAccessToken(adminUser);
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const user = response.body.users.find(u => u.id === regularUser.id);
      expect(user.aiExtraCreditCents).toBe(0);
    });
  });

  describe('POST /api/admin/users/extra-credits', () => {
    test('grants extra credits to a user', async () => {
      const token = generateAccessToken(adminUser);

      const response = await request(app)
        .post('/api/admin/users/extra-credits')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: regularUser.id, amountCents: 500, memo: 'Beta bonus' })
        .expect(200);

      expect(response.body.grant).toBeDefined();
      expect(response.body.grant.amountCents).toBe(500);
      expect(response.body.grant.memo).toBe('Beta bonus');
      expect(response.body.grant.grantedBy).toBe(adminUser.id);
    });

    test('grants extra credits with expiration', async () => {
      const token = generateAccessToken(adminUser);
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const response = await request(app)
        .post('/api/admin/users/extra-credits')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: regularUser.id, amountCents: 200, expiresAt: future })
        .expect(200);

      expect(response.body.grant.expiresAt).toBeDefined();
    });

    test('returns 400 for missing amountCents', async () => {
      const token = generateAccessToken(adminUser);

      await request(app)
        .post('/api/admin/users/extra-credits')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: regularUser.id })
        .expect(400);
    });

    test('returns 400 for negative amountCents', async () => {
      const token = generateAccessToken(adminUser);

      await request(app)
        .post('/api/admin/users/extra-credits')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: regularUser.id, amountCents: -100 })
        .expect(400);
    });

    test('returns 400 for past expiresAt', async () => {
      const token = generateAccessToken(adminUser);
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      await request(app)
        .post('/api/admin/users/extra-credits')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: regularUser.id, amountCents: 100, expiresAt: past })
        .expect(400);
    });

    test('returns 403 for non-admin user', async () => {
      const token = generateAccessToken(regularUser);

      await request(app)
        .post('/api/admin/users/extra-credits')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: regularUser.id, amountCents: 500 })
        .expect(403);
    });

    test('returns 401 without authorization', async () => {
      await request(app)
        .post('/api/admin/users/extra-credits')
        .send({ userId: regularUser.id, amountCents: 500 })
        .expect(401);
    });
  });

  describe('PATCH /api/admin/users/:userId/credit', () => {
    test('updates monthly credit allowance', async () => {
      const token = generateAccessToken(adminUser);

      const response = await request(app)
        .patch(`/api/admin/users/${regularUser.id}/credit`)
        .set('Authorization', `Bearer ${token}`)
        .send({ aiCreditCents: 1000 })
        .expect(200);

      expect(response.body.aiCreditCents).toBe(1000);

      // Verify in DB
      const { rows } = await pool.query('SELECT ai_credit_cents FROM users WHERE id = $1', [regularUser.id]);
      expect(rows[0].ai_credit_cents).toBe(1000);
    });

    test('allows setting credit to zero', async () => {
      const token = generateAccessToken(adminUser);

      const response = await request(app)
        .patch(`/api/admin/users/${regularUser.id}/credit`)
        .set('Authorization', `Bearer ${token}`)
        .send({ aiCreditCents: 0 })
        .expect(200);

      expect(response.body.aiCreditCents).toBe(0);
    });

    test('returns 400 for negative credit', async () => {
      const token = generateAccessToken(adminUser);

      await request(app)
        .patch(`/api/admin/users/${regularUser.id}/credit`)
        .set('Authorization', `Bearer ${token}`)
        .send({ aiCreditCents: -100 })
        .expect(400);
    });

    test('returns 400 for non-numeric credit', async () => {
      const token = generateAccessToken(adminUser);

      await request(app)
        .patch(`/api/admin/users/${regularUser.id}/credit`)
        .set('Authorization', `Bearer ${token}`)
        .send({ aiCreditCents: 'abc' })
        .expect(400);
    });

    test('returns 404 for non-existent user', async () => {
      const token = generateAccessToken(adminUser);

      await request(app)
        .patch('/api/admin/users/00000000-0000-0000-0000-000000000000/credit')
        .set('Authorization', `Bearer ${token}`)
        .send({ aiCreditCents: 500 })
        .expect(404);
    });

    test('returns 403 for non-admin', async () => {
      const token = generateAccessToken(regularUser);

      await request(app)
        .patch(`/api/admin/users/${regularUser.id}/credit`)
        .set('Authorization', `Bearer ${token}`)
        .send({ aiCreditCents: 1000 })
        .expect(403);
    });
  });

  describe('GET /api/admin/users/:userId/extra-credits', () => {
    test('lists extra credit records for a user', async () => {
      const token = generateAccessToken(adminUser);

      // Grant two credits
      await aiUsage.grantExtraCredits(regularUser.id, 300, { memo: 'First' });
      await aiUsage.grantExtraCredits(regularUser.id, 200, { memo: 'Second' });

      const response = await request(app)
        .get(`/api/admin/users/${regularUser.id}/extra-credits`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.credits).toHaveLength(2);
      // Ordered by id DESC (newest first)
      expect(response.body.credits[0].memo).toBe('Second');
      expect(response.body.credits[1].memo).toBe('First');
    });

    test('includes correct fields', async () => {
      const token = generateAccessToken(adminUser);
      await aiUsage.grantExtraCredits(regularUser.id, 500, {
        memo: 'Test', grantedBy: adminUser.id,
      });

      const response = await request(app)
        .get(`/api/admin/users/${regularUser.id}/extra-credits`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const credit = response.body.credits[0];
      expect(credit.amountCents).toBe(500);
      expect(credit.usedCents).toBe(0);
      expect(credit.remainingCents).toBe(500);
      expect(credit.memo).toBe('Test');
      expect(credit.grantedByName).toBe('Admin User');
      expect(credit.createdAt).toBeDefined();
      expect(credit.isExpired).toBe(false);
      expect(credit.isDepleted).toBe(false);
    });

    test('marks expired credits', async () => {
      const token = generateAccessToken(adminUser);
      await pool.query(
        `INSERT INTO ai_extra_credits (user_id, amount_cents, expires_at)
         VALUES ($1, 100, now() - interval '1 day')`,
        [regularUser.id]
      );

      const response = await request(app)
        .get(`/api/admin/users/${regularUser.id}/extra-credits`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.credits[0].isExpired).toBe(true);
    });

    test('returns empty array for user with no credits', async () => {
      const token = generateAccessToken(adminUser);

      const response = await request(app)
        .get(`/api/admin/users/${regularUser.id}/extra-credits`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.credits).toHaveLength(0);
    });

    test('returns 403 for non-admin', async () => {
      const token = generateAccessToken(regularUser);

      await request(app)
        .get(`/api/admin/users/${regularUser.id}/extra-credits`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  describe('DELETE /api/admin/users/extra-credits/:creditId', () => {
    test('deletes an extra credit record', async () => {
      const token = generateAccessToken(adminUser);
      const grant = await aiUsage.grantExtraCredits(regularUser.id, 500);

      await request(app)
        .delete(`/api/admin/users/extra-credits/${grant.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Verify deleted
      const { rows } = await pool.query('SELECT * FROM ai_extra_credits WHERE id = $1', [grant.id]);
      expect(rows).toHaveLength(0);
    });

    test('returns 404 for non-existent credit', async () => {
      const token = generateAccessToken(adminUser);

      await request(app)
        .delete('/api/admin/users/extra-credits/999999')
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    test('returns 403 for non-admin', async () => {
      const token = generateAccessToken(regularUser);
      const grant = await aiUsage.grantExtraCredits(regularUser.id, 500);

      await request(app)
        .delete(`/api/admin/users/extra-credits/${grant.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });
  });

  describe('shared assistant default model', () => {
    // Eligibility filters on a configured shared server key, so ensure the
    // Anthropic key is present for the duration of these tests.
    let savedAnthropicKey;
    beforeEach(() => {
      savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    });
    afterEach(async () => {
      if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
      await pool.query('DELETE FROM app_settings');
      await appSettings.refresh();
    });

    test('GET returns effective model and eligible models (admin)', async () => {
      const token = generateAccessToken(adminUser);
      const response = await request(app)
        .get('/api/admin/settings/shared-model')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.modelKey).toBeNull();
      expect(typeof response.body.effectiveModelKey).toBe('string');
      // Anthropic models are eligible (server key set); OpenAI never is.
      const providers = response.body.models.map((m) => m.provider);
      expect(providers).toContain('anthropic');
      expect(providers).not.toContain('openai');
    });

    test('PUT sets and clears the shared default', async () => {
      const token = generateAccessToken(adminUser);

      const set = await request(app)
        .put('/api/admin/settings/shared-model')
        .set('Authorization', `Bearer ${token}`)
        .send({ modelKey: 'claude-sonnet' })
        .expect(200);
      expect(set.body.modelKey).toBe('claude-sonnet');
      expect(set.body.effectiveModelKey).toBe('claude-sonnet');
      expect(appSettings.getSharedDefaultModel()).toBe('claude-sonnet');

      const cleared = await request(app)
        .put('/api/admin/settings/shared-model')
        .set('Authorization', `Bearer ${token}`)
        .send({ modelKey: null })
        .expect(200);
      expect(cleared.body.modelKey).toBeNull();
      expect(appSettings.getSharedDefaultModel()).toBeNull();
    });

    test('PUT rejects an unknown model', async () => {
      const token = generateAccessToken(adminUser);
      await request(app)
        .put('/api/admin/settings/shared-model')
        .set('Authorization', `Bearer ${token}`)
        .send({ modelKey: 'bogus-model' })
        .expect(400);
    });

    test('PUT rejects a BYOK-only model as the shared default', async () => {
      const token = generateAccessToken(adminUser);
      await request(app)
        .put('/api/admin/settings/shared-model')
        .set('Authorization', `Bearer ${token}`)
        .send({ modelKey: 'gpt-5.4' })
        .expect(400);
    });

    test('returns 403 for non-admin', async () => {
      const token = generateAccessToken(regularUser);
      await request(app)
        .get('/api/admin/settings/shared-model')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(app)
        .put('/api/admin/settings/shared-model')
        .set('Authorization', `Bearer ${token}`)
        .send({ modelKey: 'claude-sonnet' })
        .expect(403);
    });
  });
});
