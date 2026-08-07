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
      expect('lastActivityAt' in admin).toBe(true);
    });

    test('lastActivityAt is the newest of login, doc edit, chat and AI usage', async () => {
      const docGuid = crypto.randomUUID();
      // Three activity signals with distinct fixed timestamps; the yjs doc
      // edit is deliberately the newest so the GREATEST must pick it over
      // the chat, the AI call and the (null) last login.
      await pool.query(
        `INSERT INTO chats (id, user_id, title, created_at, updated_at)
         VALUES ($1, $2, 'activity test', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z')`,
        [`chat-${crypto.randomUUID()}`, regularUser.id]
      );
      await pool.query(
        `INSERT INTO ai_usage_log (user_id, model_key, input_tokens, output_tokens, cost_cents, is_byok, created_at)
         VALUES ($1, 'test-model', 1, 1, 1, false, '2026-04-01T00:00:00Z')`,
        [regularUser.id]
      );
      await pool.query(
        `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, created_at)
         VALUES ($1, 1, $2, $3, '2026-05-01T00:00:00Z')`,
        [docGuid, Buffer.from([0]), regularUser.id]
      );

      const token = generateAccessToken(adminUser);
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const user = response.body.users.find(u => u.id === regularUser.id);
      expect(Date.parse(user.lastActivityAt)).toBe(Date.parse('2026-05-01T00:00:00Z'));

      // Cleanup (user deletion cascades chats but SET-NULLs yjs rows, which
      // would otherwise accumulate as orphans across runs)
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
      await pool.query('DELETE FROM chats WHERE user_id = $1', [regularUser.id]);
      await pool.query('DELETE FROM ai_usage_log WHERE user_id = $1', [regularUser.id]);
    });

    test('lastActivityAt falls back to last login when there is no other activity', async () => {
      await pool.query(
        "UPDATE users SET last_login_at = '2026-06-15T12:00:00Z' WHERE id = $1",
        [regularUser.id]
      );

      const token = generateAccessToken(adminUser);
      const response = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const user = response.body.users.find(u => u.id === regularUser.id);
      expect(Date.parse(user.lastActivityAt)).toBe(Date.parse('2026-06-15T12:00:00Z'));
    });

    test('returns correct doc count', async () => {
      // Create a document owned by the regular user
      const docId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO documents (id) VALUES ($1) ON CONFLICT DO NOTHING",
        [docId]
      );
      await pool.query(
        "INSERT INTO document_shares (doc_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $2)",
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
          "INSERT INTO document_shares (doc_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $2)",
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
        "INSERT INTO document_shares (doc_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $2)",
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
        "INSERT INTO document_shares (doc_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $2)",
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

      // Pricing rides along so the picker can show cost per model (cents per 1M
      // tokens, straight from the registry).
      const opus = response.body.models.find((m) => m.key === 'claude-opus');
      expect(opus.label).toBe('Claude Opus 4.8');
      expect(opus.pricing).toEqual({ input: 500, output: 2500 });
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

  // Feature 026: OpenRouter as a shared gateway. Eligibility is derived from
  // OPENROUTER_API_KEY presence, so these toggle it per-case. Anthropic stays set
  // (from the outer beforeEach) so the picker always has a load-bearing provider.
  describe('shared assistant default model — OpenRouter gateway (026)', () => {
    const CURATED = ['or-kimi-k3', 'or-qwen3.7-max', 'or-qwen3.7-plus', 'or-minimax-m3'];
    const OR_GLM = ['or-glm-4.6', 'or-glm-4.7', 'or-glm-5', 'or-glm-5.2'];
    let savedAnthropicKey;
    let savedOpenRouterKey;
    let savedAiChatModel;

    beforeEach(() => {
      savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
      savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
      // Neutralize ambient AI_CHAT_MODEL so fallback assertions are deterministic
      // regardless of the developer's .env (an ineligible ambient value would
      // degrade to DEFAULT_MODEL_KEY and diverge from the env-based expectation).
      savedAiChatModel = process.env.AI_CHAT_MODEL;
      delete process.env.AI_CHAT_MODEL;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    });
    afterEach(async () => {
      if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
      if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
      if (savedAiChatModel === undefined) delete process.env.AI_CHAT_MODEL;
      else process.env.AI_CHAT_MODEL = savedAiChatModel;
      await pool.query('DELETE FROM app_settings');
      await appSettings.refresh();
    });

    test('T004: with OPENROUTER_API_KEY set, GET lists curated + or-glm-* entries and openrouter provider', async () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-test';
      const token = generateAccessToken(adminUser);
      const res = await request(app)
        .get('/api/admin/settings/shared-model')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const keys = res.body.models.map((m) => m.key);
      for (const k of [...CURATED, ...OR_GLM]) expect(keys).toContain(k);

      const providerIds = res.body.providers.map((p) => p.id);
      expect(providerIds).toContain('openrouter');
      expect(res.body.providers).toContainEqual({ id: 'openrouter', label: 'OpenRouter' });

      // Every model's provider is represented in providers (grouping is total).
      for (const m of res.body.models) expect(providerIds).toContain(m.provider);
    });

    test('T004/SC-007: with OPENROUTER_API_KEY unset, no openrouter models or provider', async () => {
      delete process.env.OPENROUTER_API_KEY;
      const token = generateAccessToken(adminUser);
      const res = await request(app)
        .get('/api/admin/settings/shared-model')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const providers = res.body.models.map((m) => m.provider);
      expect(providers).not.toContain('openrouter');
      expect(res.body.providers.map((p) => p.id)).not.toContain('openrouter');
    });

    test('T005/US1-2: PUT a gateway modelKey with the key set → 200, stored + effective echo it', async () => {
      process.env.OPENROUTER_API_KEY = 'sk-or-test';
      const token = generateAccessToken(adminUser);
      const res = await request(app)
        .put('/api/admin/settings/shared-model')
        .set('Authorization', `Bearer ${token}`)
        .send({ modelKey: 'or-kimi-k3' })
        .expect(200);
      expect(res.body.modelKey).toBe('or-kimi-k3');
      expect(res.body.effectiveModelKey).toBe('or-kimi-k3');
      expect(appSettings.getSharedDefaultModel()).toBe('or-kimi-k3');
    });

    test('T005/US1-4: PUT a gateway modelKey without the key set → 400 no shared server key', async () => {
      delete process.env.OPENROUTER_API_KEY;
      const token = generateAccessToken(adminUser);
      const res = await request(app)
        .put('/api/admin/settings/shared-model')
        .set('Authorization', `Bearer ${token}`)
        .send({ modelKey: 'or-kimi-k3' })
        .expect(400);
      expect(res.body.error).toMatch(/no shared server key/i);
    });

    test('T014/FR-005: stored gateway key but OPENROUTER_API_KEY absent → GET effectiveModelKey is the fallback, not the stored key', async () => {
      // Persist a gateway default directly (bypassing PUT validation), then remove
      // the key — the rollback path.
      await appSettings.setSharedDefaultModel('or-kimi-k3');
      delete process.env.OPENROUTER_API_KEY;

      const token = generateAccessToken(adminUser);
      const res = await request(app)
        .get('/api/admin/settings/shared-model')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.modelKey).toBe('or-kimi-k3'); // stored value is unchanged
      expect(res.body.effectiveModelKey).not.toBe('or-kimi-k3'); // but degraded
      // AI_CHAT_MODEL is neutralized in beforeEach, so the fallback is the
      // DEFAULT_MODEL_KEY constant.
      expect(res.body.effectiveModelKey).toBe('claude-opus');
      // The unrunnable gateway entry is also gone from the picker.
      expect(res.body.models.map((m) => m.provider)).not.toContain('openrouter');
    });
  });
});
