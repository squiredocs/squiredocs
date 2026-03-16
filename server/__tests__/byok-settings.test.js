/**
 * BYOK settings API tests
 * Tests the GET/PUT /api/settings/byok endpoints.
 */
const express = require('express');
const request = require('supertest');
const { createPool, createTestUser, cleanupTestUser } = require('./helpers/db');

// Set encryption key before requiring byok-settings (which requires crypto)
process.env.API_KEY_ENCRYPTION_KEY = 'b'.repeat(64);

// Mock requireAuth to inject test user
let mockUserId = null;
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => {
    if (!mockUserId) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { userId: mockUserId };
    next();
  },
}));

const byokSettings = require('../api/byok-settings');
const crypto = require('../crypto');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/settings/byok', byokSettings.router);
  return app;
}

describe('BYOK Settings API', () => {
  let pool, app, testUserId;

  beforeAll(async () => {
    pool = createPool();
    byokSettings.init(pool);
    app = createApp();

    testUserId = await createTestUser(pool, `byok-api-${Date.now()}@test.com`);
    mockUserId = testUserId;
  });

  afterAll(async () => {
    await cleanupTestUser(pool, testUserId);
    await pool.end();
  });

  afterEach(async () => {
    // Reset BYOK columns
    await pool.query(
      `UPDATE users SET byok_enabled = false, byok_anthropic_key = NULL, byok_google_key = NULL, byok_model_key = NULL WHERE id = $1`,
      [testUserId]
    );
    mockUserId = testUserId;
  });

  describe('GET /api/settings/byok', () => {
    test('returns default state with no keys', async () => {
      const res = await request(app).get('/api/settings/byok');

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.anthropic.hasKey).toBe(false);
      expect(res.body.google.hasKey).toBe(false);
      expect(res.body.modelKey).toBeNull();
      expect(Array.isArray(res.body.models)).toBe(true);
    });

    test('returns hasKey true when key is stored', async () => {
      const encrypted = crypto.encrypt('sk-ant-test-key');
      await pool.query(
        `UPDATE users SET byok_anthropic_key = $1 WHERE id = $2`,
        [encrypted, testUserId]
      );

      const res = await request(app).get('/api/settings/byok');

      expect(res.body.anthropic.hasKey).toBe(true);
      expect(res.body.google.hasKey).toBe(false);
      // Key value should never be returned
      expect(res.body.anthropic.key).toBeUndefined();
    });

    test('returns models with labels', async () => {
      const res = await request(app).get('/api/settings/byok');

      const models = res.body.models;
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(m).toHaveProperty('key');
        expect(m).toHaveProperty('label');
        expect(m).toHaveProperty('provider');
      }
    });

    test('requires auth', async () => {
      mockUserId = null;
      const res = await request(app).get('/api/settings/byok');
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/settings/byok', () => {
    test('saves enabled toggle', async () => {
      // Must have a key to enable BYOK
      const encrypted = crypto.encrypt('test-google-key');
      await pool.query(
        `UPDATE users SET byok_google_key = $1 WHERE id = $2`,
        [encrypted, testUserId]
      );

      const res = await request(app)
        .put('/api/settings/byok')
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);

      // Verify in DB
      const row = await pool.query('SELECT byok_enabled FROM users WHERE id = $1', [testUserId]);
      expect(row.rows[0].byok_enabled).toBe(true);
    });

    test('saves model key', async () => {
      const res = await request(app)
        .put('/api/settings/byok')
        .send({ modelKey: 'claude-haiku' });

      expect(res.status).toBe(200);
      expect(res.body.modelKey).toBe('claude-haiku');
    });

    test('rejects unknown model key', async () => {
      const res = await request(app)
        .put('/api/settings/byok')
        .send({ modelKey: 'nonexistent-model' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Unknown model/);
    });

    test('clears model key with null', async () => {
      // Set a model first
      await request(app).put('/api/settings/byok').send({ modelKey: 'claude-haiku' });

      // Clear it
      const res = await request(app)
        .put('/api/settings/byok')
        .send({ modelKey: null });

      expect(res.status).toBe(200);
      expect(res.body.modelKey).toBeNull();
    });

    test('clears API key with null', async () => {
      // Set a key directly in DB
      const encrypted = crypto.encrypt('sk-ant-test-key');
      await pool.query('UPDATE users SET byok_anthropic_key = $1 WHERE id = $2', [encrypted, testUserId]);

      // Clear via API
      const res = await request(app)
        .put('/api/settings/byok')
        .send({ anthropicKey: null });

      expect(res.status).toBe(200);
      expect(res.body.anthropic.hasKey).toBe(false);

      // Verify in DB
      const row = await pool.query('SELECT byok_anthropic_key FROM users WHERE id = $1', [testUserId]);
      expect(row.rows[0].byok_anthropic_key).toBeNull();
    });

    test('toggle persists independently of model key', async () => {
      // Set up: key + model + enable
      const encrypted = crypto.encrypt('sk-ant-test-key');
      await pool.query(
        `UPDATE users SET byok_anthropic_key = $1, byok_model_key = 'claude-haiku', byok_enabled = true WHERE id = $2`,
        [encrypted, testUserId]
      );

      // Toggle off — model key should remain
      const res = await request(app)
        .put('/api/settings/byok')
        .send({ enabled: false });

      expect(res.body.enabled).toBe(false);
      expect(res.body.modelKey).toBe('claude-haiku');
    });

    test('partial updates do not overwrite other fields', async () => {
      // Set up: key + model + enable
      const encrypted = crypto.encrypt('test-google-key');
      await pool.query(
        `UPDATE users SET byok_google_key = $1, byok_model_key = 'gemini-2.5-flash', byok_enabled = true WHERE id = $2`,
        [encrypted, testUserId]
      );

      // Update only enabled
      const res = await request(app)
        .put('/api/settings/byok')
        .send({ enabled: false });

      expect(res.body.enabled).toBe(false);
      expect(res.body.modelKey).toBe('gemini-2.5-flash');
    });

    test('enabling without any API key returns error', async () => {
      const res = await request(app)
        .put('/api/settings/byok')
        .send({ enabled: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('API key');
    });

    test('enabling without a key works when a key exists', async () => {
      const encrypted = crypto.encrypt('test-google-key');
      await pool.query(
        `UPDATE users SET byok_google_key = $1 WHERE id = $2`,
        [encrypted, testUserId]
      );

      const res = await request(app)
        .put('/api/settings/byok')
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
    });

    test('clearing the provider key disables BYOK', async () => {
      // Set up: Anthropic key + Anthropic model + enabled
      const encrypted = crypto.encrypt('sk-ant-test-key');
      await pool.query(
        `UPDATE users SET byok_enabled = true, byok_anthropic_key = $1, byok_model_key = 'claude-haiku' WHERE id = $2`,
        [encrypted, testUserId]
      );

      // Clear the Anthropic key
      const res = await request(app)
        .put('/api/settings/byok')
        .send({ anthropicKey: null });

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.anthropic.hasKey).toBe(false);
      // Model selection should persist
      expect(res.body.modelKey).toBe('claude-haiku');
    });

    test('clearing an unrelated provider key does not disable BYOK', async () => {
      // Set up: Anthropic key + Anthropic model + enabled
      const encrypted = crypto.encrypt('sk-ant-test-key');
      await pool.query(
        `UPDATE users SET byok_enabled = true, byok_anthropic_key = $1, byok_model_key = 'claude-haiku' WHERE id = $2`,
        [encrypted, testUserId]
      );

      // Clear the Google key (not used by the selected model)
      const res = await request(app)
        .put('/api/settings/byok')
        .send({ googleKey: null });

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
    });

    test('requires auth', async () => {
      mockUserId = null;
      const res = await request(app)
        .put('/api/settings/byok')
        .send({ enabled: true });
      expect(res.status).toBe(401);
    });
  });
});
