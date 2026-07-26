/**
 * Feature 035 — the admin management surface for the per-user model override.
 *
 * The router is mounted the way server/index.js mounts it —
 * `app.use('/api/admin', requireAdmin, admin.router)` — because that middleware
 * IS the authorization (the handler carries no check of its own). Mounting
 * admin.router bare would make the 403/401 assertions vacuous (034 precedent,
 * admin-auth-capture.test.js).
 *
 * Covered: set / clear / validation (unknown, ineligible, wrong type) / 404 /
 * 403 / 401, the `chatModelOverride` field on GET /users, the dormant-override
 * case (FR-015), the clear round-trip against a CHANGED shared default (SC-003),
 * and an anti-drift property test asserting the endpoint's accept/reject
 * decision equals isSharedEligible(key) for every registry entry (FR-005).
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
const { generateAccessToken } = require('../auth/jwt');
const { requireAdmin } = require('../auth/middleware');
const { MODEL_DEFS, isSharedEligible } = require('../api/chat-models');

const EMAIL_SUFFIX = '@chat-model-override.test.example.com';

describe('Feature 035: PATCH /api/admin/users/:userId/chat-model', () => {
  let app;
  let pool;
  let adminToken;
  let targetUser;
  let regularUser;
  let regularToken;
  let savedAnthropic;
  let savedOR;
  let savedEnvOverride;
  let savedSharedDefault;

  beforeAll(async () => {
    // Eligibility is env-driven: anthropic funded, openrouter NOT — so gateway
    // entries are the reliably-ineligible case without hardcoding assumptions
    // about which key a deployment happens to hold.
    savedAnthropic = process.env.ANTHROPIC_API_KEY;
    savedOR = process.env.OPENROUTER_API_KEY;
    savedEnvOverride = process.env.AI_CHAT_MODEL;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AI_CHAT_MODEL;

    pool = createPool();
    users.init(pool);
    admin.init(pool);
    aiUsage.init(pool);
    await appSettings.init(pool);
    // app_settings is a GLOBAL row on the shared serial test DB — capture the
    // real shared default and restore it in afterAll so the next suite in the
    // run doesn't inherit whatever this one leaves behind.
    savedSharedDefault = appSettings.getSharedDefaultModel();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin', requireAdmin, admin.router); // the production mounting

    const adminUser = await users.findOrCreateUser({
      googleId: `admin-${crypto.randomUUID()}`,
      email: `admin-${crypto.randomUUID()}${EMAIL_SUFFIX}`,
      name: 'Admin User',
      picture: null,
    });
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [adminUser.id]);
    adminToken = generateAccessToken(await users.findById(adminUser.id));

    targetUser = await users.findOrCreateUser({
      googleId: `target-${crypto.randomUUID()}`,
      email: `target-${crypto.randomUUID()}${EMAIL_SUFFIX}`,
      name: 'Target User',
      picture: null,
    });

    regularUser = await users.findOrCreateUser({
      googleId: `regular-${crypto.randomUUID()}`,
      email: `regular-${crypto.randomUUID()}${EMAIL_SUFFIX}`,
      name: 'Regular User',
      picture: null,
    });
    regularToken = generateAccessToken(regularUser);
  });

  afterAll(async () => {
    await appSettings.setSharedDefaultModel(savedSharedDefault ?? null);
    await pool.query(`DELETE FROM users WHERE email LIKE '%${EMAIL_SUFFIX}'`);
    await pool.end();
    const restore = (k, v) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('ANTHROPIC_API_KEY', savedAnthropic);
    restore('OPENROUTER_API_KEY', savedOR);
    restore('AI_CHAT_MODEL', savedEnvOverride);
  });

  afterEach(async () => {
    await pool.query('UPDATE users SET chat_model_override = NULL WHERE email LIKE $1', [`%${EMAIL_SUFFIX}`]);
  });

  const patchModel = (userId, body, token = adminToken) =>
    request(app)
      .patch(`/api/admin/users/${userId}/chat-model`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const storedFor = async (userId) => {
    const { rows } = await pool.query('SELECT chat_model_override FROM users WHERE id = $1', [userId]);
    return rows[0].chat_model_override;
  };

  describe('set and clear (FR-007)', () => {
    test('setting an eligible model stores it and reports the effective key', async () => {
      const res = await patchModel(targetUser.id, { modelKey: 'claude-haiku' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ chatModelOverride: 'claude-haiku', effectiveModelKey: 'claude-haiku' });
      expect(await storedFor(targetUser.id)).toBe('claude-haiku');
    });

    test('clearing with null returns the user to the dynamic shared default', async () => {
      await patchModel(targetUser.id, { modelKey: 'claude-haiku' });
      await appSettings.setSharedDefaultModel('claude-sonnet');

      const res = await patchModel(targetUser.id, { modelKey: null });

      expect(res.status).toBe(200);
      expect(res.body.chatModelOverride).toBeNull();
      expect(res.body.effectiveModelKey).toBe('claude-sonnet');
      expect(await storedFor(targetUser.id)).toBeNull();
    });

    test('SC-003: after a clear the effective key is the CURRENT shared default, not the one in force when pinned', async () => {
      await appSettings.setSharedDefaultModel('claude-sonnet');
      const pinned = await patchModel(targetUser.id, { modelKey: 'claude-haiku' });
      expect(pinned.body.effectiveModelKey).toBe('claude-haiku');

      // The admin changes the shared default while the pin is in force …
      await appSettings.setSharedDefaultModel('claude-opus-5');

      // … then clears the pin.
      const cleared = await patchModel(targetUser.id, { modelKey: null });
      expect(cleared.body.effectiveModelKey).toBe('claude-opus-5');
      expect(cleared.body.effectiveModelKey).not.toBe('claude-sonnet');
    });

    test('re-pinning overwrites the previous value (last write wins)', async () => {
      await patchModel(targetUser.id, { modelKey: 'claude-haiku' });
      const res = await patchModel(targetUser.id, { modelKey: 'claude-sonnet-5' });
      expect(res.body.chatModelOverride).toBe('claude-sonnet-5');
      expect(await storedFor(targetUser.id)).toBe('claude-sonnet-5');
    });

    test('FR-015: setting an override for a BYOK-active user succeeds (dormant)', async () => {
      await pool.query(
        `UPDATE users SET byok_enabled = true, byok_model_key = 'claude-sonnet', byok_anthropic_key = 'ciphertext'
         WHERE id = $1`,
        [targetUser.id]
      );
      try {
        const res = await patchModel(targetUser.id, { modelKey: 'claude-haiku' });
        expect(res.status).toBe(200);
        expect(res.body.chatModelOverride).toBe('claude-haiku');
      } finally {
        await pool.query(
          `UPDATE users SET byok_enabled = false, byok_model_key = NULL, byok_anthropic_key = NULL WHERE id = $1`,
          [targetUser.id]
        );
      }
    });
  });

  describe('validation (FR-007, US1 acceptance 4)', () => {
    test('an unknown model key is rejected and nothing is stored', async () => {
      const res = await patchModel(targetUser.id, { modelKey: 'ghost-model' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Unknown model/);
      expect(await storedFor(targetUser.id)).toBeNull();
    });

    test('a known-but-ineligible key (provider has no shared server key) is rejected', async () => {
      const res = await patchModel(targetUser.id, { modelKey: 'or-glm-4.7' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no shared server key/);
      expect(await storedFor(targetUser.id)).toBeNull();
    });

    test('a BYOK-only provider entry is rejected too', async () => {
      const res = await patchModel(targetUser.id, { modelKey: 'gpt-5.6-sol' });
      expect(res.status).toBe(400);
      expect(await storedFor(targetUser.id)).toBeNull();
    });

    test('a non-string, non-null modelKey is rejected', async () => {
      for (const body of [{ modelKey: 42 }, { modelKey: {} }, { modelKey: ['claude-haiku'] }, {}]) {
        const res = await patchModel(targetUser.id, body);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/model key string or null/);
      }
      expect(await storedFor(targetUser.id)).toBeNull();
    });

    test('a valid pin is not clobbered by a subsequent rejected write', async () => {
      await patchModel(targetUser.id, { modelKey: 'claude-haiku' });
      await patchModel(targetUser.id, { modelKey: 'ghost-model' });
      expect(await storedFor(targetUser.id)).toBe('claude-haiku');
    });

    test('an unknown user id returns 404', async () => {
      const res = await patchModel(crypto.randomUUID(), { modelKey: 'claude-haiku' });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    test('FR-005 anti-drift: accept/reject agrees with isSharedEligible for EVERY registry entry', async () => {
      for (const def of MODEL_DEFS) {
        const res = await patchModel(targetUser.id, { modelKey: def.key });
        const accepted = res.status === 200;
        expect({ key: def.key, accepted }).toEqual({ key: def.key, accepted: isSharedEligible(def.key) });
      }
    });
  });

  describe('authorization (FR-008, US1 acceptance 5)', () => {
    test('a signed-in non-admin gets 403 and no override data', async () => {
      const res = await patchModel(targetUser.id, { modelKey: 'claude-haiku' }, regularToken);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('chatModelOverride');
      expect(JSON.stringify(res.body)).not.toContain('claude-haiku');
      expect(await storedFor(targetUser.id)).toBeNull();
    });

    test('an unauthenticated caller gets 401 and nothing is written', async () => {
      const res = await request(app)
        .patch(`/api/admin/users/${targetUser.id}/chat-model`)
        .send({ modelKey: 'claude-haiku' });
      expect(res.status).toBe(401);
      expect(res.body.chatModelOverride).toBeUndefined();
      expect(await storedFor(targetUser.id)).toBeNull();
    });

    test('a non-admin cannot read the value through GET /users either', async () => {
      const res = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${regularToken}`);
      expect(res.status).toBe(403);
      expect(res.body.users).toBeUndefined();
    });
  });

  describe('GET /api/admin/users carries chatModelOverride (A2)', () => {
    test('null for an untouched account, the stored key for a pinned one', async () => {
      await patchModel(targetUser.id, { modelKey: 'claude-haiku' });

      const res = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const pinned = res.body.users.find((u) => u.id === targetUser.id);
      const untouched = res.body.users.find((u) => u.id === regularUser.id);
      expect(pinned.chatModelOverride).toBe('claude-haiku');
      expect(untouched.chatModelOverride).toBeNull();
    });
  });
});
