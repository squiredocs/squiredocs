/**
 * Feature 021 (DR-2) — kill-switch storage + delivery.
 *
 * Covers the app_settings accessors, the admin GET/PUT flip round-trip
 * (real admin router), and the authenticated /api/client-config delivery:
 * default-ON with no stored row, false only when the stored value is exactly
 * 'false', flip back re-clears the row (default-ON stays literal in the
 * store), and auth is required (real requireAuth middleware).
 *
 * The /api/client-config mount mirrors server/index.js exactly (same
 * middleware, same one-line handler reading the cached accessor) — the repo's
 * established pattern for index.js-mounted routes (cf. chat-body-limit.test.js).
 */
const request = require('supertest');
const express = require('express');

const appSettings = require('../api/app-settings');
const admin = require('../api/admin');
const { requireAuth } = require('../auth');
const { generateAccessToken } = require('../auth/jwt');
const { createPool } = require('./helpers/db');

describe('021 kill-switch: app-settings + admin flip + /api/client-config', () => {
  let app;
  let pool;
  let authToken;

  beforeAll(async () => {
    pool = createPool();
    await pool.query("DELETE FROM app_settings WHERE key = 'collab_binding_hardening'");
    await appSettings.init(pool);
    admin.init(pool);

    authToken = generateAccessToken({
      id: '00000000-0000-4000-8000-000000000021',
      email: 'client-config-test@example.com',
      name: 'Client Config Test',
    });

    app = express();
    app.use(express.json());
    // Admin auth (requireAdmin) is index.js mount-level and covered by the
    // existing admin-route suites; here the router is mounted directly.
    app.use('/api/admin', admin.router);
    // Mirror server/index.js exactly:
    app.get('/api/client-config', requireAuth, (req, res) => {
      res.json({ collabBindingHardening: appSettings.getCollabBindingHardening() });
    });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM app_settings WHERE key = 'collab_binding_hardening'");
    await pool.end();
  });

  test('default is ON: no stored row => collabBindingHardening true', async () => {
    const res = await request(app)
      .get('/api/client-config')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ collabBindingHardening: true });

    const admGet = await request(app).get('/api/admin/settings/collab-binding-hardening');
    expect(admGet.status).toBe(200);
    expect(admGet.body).toEqual({ enabled: true });
  });

  test('flip round-trip: PUT false engages the switch, PUT true clears the row', async () => {
    const off = await request(app)
      .put('/api/admin/settings/collab-binding-hardening')
      .send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ enabled: false });

    // Stored literally as 'false' (contract: runtime-config-and-skip-report.md)
    const rowOff = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'collab_binding_hardening'"
    );
    expect(rowOff.rows).toHaveLength(1);
    expect(rowOff.rows[0].value).toBe('false');

    const cfgOff = await request(app)
      .get('/api/client-config')
      .set('Authorization', `Bearer ${authToken}`);
    expect(cfgOff.body).toEqual({ collabBindingHardening: false });

    const on = await request(app)
      .put('/api/admin/settings/collab-binding-hardening')
      .send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ enabled: true });

    // Re-enabled = row DELETED (unset keeps the default-ON invariant literal)
    const rowOn = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'collab_binding_hardening'"
    );
    expect(rowOn.rows).toHaveLength(0);

    const cfgOn = await request(app)
      .get('/api/client-config')
      .set('Authorization', `Bearer ${authToken}`);
    expect(cfgOn.body).toEqual({ collabBindingHardening: true });
  });

  test('PUT rejects a non-boolean enabled', async () => {
    const res = await request(app)
      .put('/api/admin/settings/collab-binding-hardening')
      .send({ enabled: 'nope' });
    expect(res.status).toBe(400);
    // and the setting is unchanged (still default ON)
    expect(appSettings.getCollabBindingHardening()).toBe(true);
  });

  test('/api/client-config requires authentication', async () => {
    const noAuth = await request(app).get('/api/client-config');
    expect(noAuth.status).toBe(401);

    const badAuth = await request(app)
      .get('/api/client-config')
      .set('Authorization', 'Bearer not-a-token');
    expect(badAuth.status).toBe(401);
  });
});
