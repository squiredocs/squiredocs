/**
 * Feature 029 US5 — production single-account reset (FR-002/FR-010/FR-011,
 * RBD-4, D6, Acc 5.1-5.4, SC-005). Serial.
 *
 * The ONE prod-reachable endpoint: admin-gated, NOT behind ENABLE_DEV_ENDPOINTS,
 * target is PROD_RESET_ACCOUNT (from SELFTEST_RESET_ACCOUNT) and NOTHING a request
 * body can name; unset, the endpoint is a 404.
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

// The reset is a hosted-only route (feature 058, FR-028): it exists only with
// SQUIRE_HOSTED=true, which the production overlay sets. The self-hosted 404
// is covered by hosted-gating.test.js.
process.env.SQUIRE_HOSTED = 'true';
process.env.SELFTEST_RESET_ACCOUNT = 'selftest@example.com';
require('../../instance-config')._resetInstanceConfigForTests();

jest.mock('../../auth/google', () => ({
  generateAuthUrl: jest.fn(), exchangeCodeForTokens: jest.fn(),
  verifyIdToken: jest.fn(), fetchUserInfo: jest.fn(async () => ({})),
}));
jest.mock('../../email', () => ({
  notifyNewUser: jest.fn(), notifyLogin: jest.fn(),
  sendShareInvite: jest.fn(), sendShareNotification: jest.fn(),
}));
jest.mock('../../onboarding', () => ({
  resolveOnboarding: jest.fn(async () => ({ welcomeDocId: null, onboarded: true })),
}));

const authRouter = require('../../auth/routes');
const users = require('../../auth/users');
const jwt = require('../../auth/jwt');
const { createPool } = require('../helpers/db');
const { PROD_RESET_ACCOUNT } = require('../../auth/routes');

describe('Feature 029 US5 — production single-account reset', () => {
  let app;
  let pool;
  let adminToken;
  let adminId;
  let nonAdminToken;
  let nonAdminId;

  beforeAll(async () => {
    pool = createPool();
    users.init(pool);
    app = express();
    app.use(cookieParser());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use('/auth', authRouter);

    const admin = await pool.query(
      "INSERT INTO users (google_id, email, name, is_admin) VALUES ('prodreset-admin', 'prodreset-admin@example.com', 'Admin', true) RETURNING *"
    );
    adminId = admin.rows[0].id;
    adminToken = jwt.generateAccessToken(admin.rows[0]);

    const nonAdmin = await pool.query(
      "INSERT INTO users (google_id, email, name, is_admin) VALUES ('prodreset-nonadmin', 'prodreset-nonadmin@example.com', 'Reg', false) RETURNING *"
    );
    nonAdminId = nonAdmin.rows[0].id;
    nonAdminToken = jwt.generateAccessToken(nonAdmin.rows[0]);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[adminId, nonAdminId]]);
    await pool.query('DELETE FROM users WHERE email = $1', [PROD_RESET_ACCOUNT]);
    await pool.query("DELETE FROM users WHERE email LIKE 'prodreset-bystander%@example.com'");
    await pool.end();
  });

  /** Seed the hardcoded self-test account with owned content. */
  async function seedSelfTestAccount() {
    const u = await pool.query(
      "INSERT INTO users (google_id, email, name) VALUES ('prodreset-selftest', $1, 'Self Test') RETURNING id",
      [PROD_RESET_ACCOUNT]
    );
    const userId = u.rows[0].id;
    const d = await pool.query(
      "INSERT INTO documents (id, creator_id, title) VALUES (gen_random_uuid(), $1, 'selftest doc') RETURNING id",
      [userId]
    );
    const docId = d.rows[0].id;
    await pool.query("INSERT INTO document_shares (doc_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $2)", [docId, userId]);
    await pool.query('INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id) VALUES ($1, 0, $2, $3)', [docId, Buffer.from([9]), userId]);
    return { userId, docId };
  }

  test('Acc 5.1 — an admin resets ONLY the hardcoded account, full cascade, bystander untouched', async () => {
    const { userId, docId } = await seedSelfTestAccount();
    const bystander = await pool.query(
      "INSERT INTO users (google_id, email, name) VALUES ('prodreset-bystander-a', 'prodreset-bystander-a@example.com', 'Bystander A') RETURNING id"
    );

    const res = await request(app)
      .post('/auth/prod-reset-selftest-account')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.account).toBe(PROD_RESET_ACCOUNT);
    expect(res.body.deleted).toBe(true);

    expect((await pool.query('SELECT 1 FROM users WHERE id = $1', [userId])).rows.length).toBe(0);
    expect((await pool.query('SELECT 1 FROM documents WHERE id = $1', [docId])).rows.length).toBe(0);
    expect((await pool.query('SELECT 1 FROM yjs_updates WHERE doc_guid = $1', [docId])).rows.length).toBe(0);
    // The bystander account is entirely untouched.
    expect((await pool.query('SELECT 1 FROM users WHERE id = $1', [bystander.rows[0].id])).rows.length).toBe(1);
  });

  test('Acc 5.4 — already-reset account is an idempotent no-op success', async () => {
    const res = await request(app)
      .post('/auth/prod-reset-selftest-account')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBe(false); // nothing there to delete
  });

  test('Acc 5.3 — a non-admin caller is rejected 403', async () => {
    const res = await request(app)
      .post('/auth/prod-reset-selftest-account')
      .set('Authorization', `Bearer ${nonAdminToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  test('Acc 5.3 — an unauthenticated caller is rejected 401', async () => {
    const res = await request(app).post('/auth/prod-reset-selftest-account').send({});
    expect(res.status).toBe(401);
  });

  test('Acc 5.2 / SC-005 — no request body can widen the target', async () => {
    // Seed the real self-test account AND a differently-named account; try to
    // steer the reset at the other account via every plausible body field.
    const { userId } = await seedSelfTestAccount();
    const other = await pool.query(
      "INSERT INTO users (google_id, email, name) VALUES ('prodreset-bystander-b', 'prodreset-bystander-b@example.com', 'Bystander B') RETURNING id"
    );
    try {
      const res = await request(app)
        .post('/auth/prod-reset-selftest-account')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          email: 'prodreset-bystander-b@example.com',
          userId: other.rows[0].id,
          target: 'prodreset-bystander-b@example.com',
          all: true,
          wildcard: '*',
        });
      expect(res.status).toBe(200);
      expect(res.body.account).toBe(PROD_RESET_ACCOUNT);
      // The named "other" account is NOT deleted — only the hardcoded target was.
      expect((await pool.query('SELECT 1 FROM users WHERE id = $1', [other.rows[0].id])).rows.length).toBe(1);
      expect((await pool.query('SELECT 1 FROM users WHERE id = $1', [userId])).rows.length).toBe(0);
    } finally {
      await pool.query('DELETE FROM users WHERE id = $1', [other.rows[0].id]);
    }
  });

  test('FR-002 — reachable WITHOUT ENABLE_DEV_ENDPOINTS, but still admin-gated', async () => {
    const prev = process.env.ENABLE_DEV_ENDPOINTS;
    delete process.env.ENABLE_DEV_ENDPOINTS;
    try {
      const admin = await request(app)
        .post('/auth/prod-reset-selftest-account')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(admin.status).toBe(200); // NOT gated by the dev flag

      const nonAdmin = await request(app)
        .post('/auth/prod-reset-selftest-account')
        .set('Authorization', `Bearer ${nonAdminToken}`)
        .send({});
      expect(nonAdmin.status).toBe(403); // still admin-only
    } finally {
      process.env.ENABLE_DEV_ENDPOINTS = prev;
    }
  });
});

describe('SELFTEST_RESET_ACCOUNT unset — the reset is off', () => {
  test('an admin gets 404 and nothing is deleted', async () => {
    const prev = process.env.SELFTEST_RESET_ACCOUNT;
    delete process.env.SELFTEST_RESET_ACCOUNT;
    const pool = createPool();
    try {
      let router;
      jest.isolateModules(() => { router = require('../../auth/routes'); });
      expect(router.PROD_RESET_ACCOUNT).toBeNull();
      require('../../auth/users').init(pool);
      const app = express();
      app.use(cookieParser());
      app.use(express.json());
      app.use('/auth', router);
      const admin = await pool.query(
        "INSERT INTO users (google_id, email, name, is_admin) VALUES ('prodreset-unset-admin', 'prodreset-unset-admin@example.com', 'Admin', true) RETURNING *"
      );
      try {
        const res = await request(app)
          .post('/auth/prod-reset-selftest-account')
          .set('Authorization', `Bearer ${jwt.generateAccessToken(admin.rows[0])}`)
          .send({});
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('selftest_reset_not_configured');
      } finally {
        await pool.query('DELETE FROM users WHERE id = $1', [admin.rows[0].id]);
      }
    } finally {
      process.env.SELFTEST_RESET_ACCOUNT = prev;
      await pool.end();
    }
  });
});
