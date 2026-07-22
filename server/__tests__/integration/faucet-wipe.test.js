/**
 * Feature 029 US1 — fresh-user faucet + synthetic wipe (FR-003/004/008/009/011,
 * RBD-2/3, SC-004). Serial (constitution II — shared DB).
 *
 * Mocks google/email/onboarding exactly like auth-return-to.test.js so no
 * network is touched and the shared post-auth path resolves predictably.
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

jest.mock('../../auth/google', () => ({
  generateAuthUrl: jest.fn((state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
  exchangeCodeForTokens: jest.fn(async () => ({ id_token: 'x', access_token: 'y' })),
  verifyIdToken: jest.fn(async () => ({})),
  fetchUserInfo: jest.fn(async () => ({})),
}));
jest.mock('../../email', () => ({
  notifyNewUser: jest.fn(),
  notifyLogin: jest.fn(),
  sendShareInvite: jest.fn(),
  sendShareNotification: jest.fn(),
}));
jest.mock('../../onboarding', () => ({
  resolveOnboarding: jest.fn(async () => ({ welcomeDocId: null, onboarded: true })),
}));

const authRouter = require('../../auth/routes');
const users = require('../../auth/users');
const oauthFlow = require('../../mcp/auth/oauth-flow');
const { createPool } = require('../helpers/db');

function getSetCookies(res) {
  const raw = res.headers['set-cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}
function findCookie(res, name) {
  return getSetCookies(res).find((c) => c.startsWith(`${name}=`));
}

describe('Feature 029 US1 — faucet + synthetic wipe', () => {
  let app;
  let pool;

  beforeAll(async () => {
    pool = createPool();
    users.init(pool);
    oauthFlow.init(pool);

    app = express();
    app.use(cookieParser());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use('/auth', authRouter);
  });

  afterAll(async () => {
    await users.deleteAllSyntheticUsers();
    await pool.query("DELETE FROM users WHERE email = 'dev@test.local'");
    await pool.end();
  });

  afterEach(async () => {
    // Keep the namespace clean between cases (each mints its own users).
    await users.deleteAllSyntheticUsers();
  });

  describe('Acc 1.1 — fresh JSON mints distinct synthetic users', () => {
    test('repeated fresh calls with no nonce produce distinct test+<nonce>@test.local', async () => {
      const r1 = await request(app).post('/auth/dev-login').send({ fresh: true });
      const r2 = await request(app).post('/auth/dev-login').send({ fresh: true });
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r1.body.email).toMatch(/^test\+[a-z0-9-]{1,32}@test\.local$/);
      expect(r2.body.email).toMatch(/^test\+[a-z0-9-]{1,32}@test\.local$/);
      expect(r1.body.email).not.toBe(r2.body.email);
      expect(r1.body.accessToken).toBeTruthy();
      expect(r1.body.user.id).not.toBe(r2.body.user.id);
    });

    test('reused explicit nonce is a re-login of the same identity (not an error)', async () => {
      const a = await request(app).post('/auth/dev-login').send({ fresh: true, nonce: 'stable1' });
      const b = await request(app).post('/auth/dev-login').send({ fresh: true, nonce: 'stable1' });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.email).toBe('test+stable1@test.local');
      expect(b.body.email).toBe('test+stable1@test.local');
      expect(a.body.user.id).toBe(b.body.user.id); // same row
    });

    test('invalid nonce is rejected 400', async () => {
      const res = await request(app).post('/auth/dev-login').send({ fresh: true, nonce: 'BAD NONCE!' });
      expect(res.status).toBe(400);
    });

    test('fresh account is stamped signup_source=browser in JSON mode (no returnTo)', async () => {
      const r = await request(app).post('/auth/dev-login').send({ fresh: true, nonce: 'srcjson' });
      const row = await pool.query('SELECT signup_source FROM users WHERE id = $1', [r.body.user.id]);
      expect(row.rows[0].signup_source).toBe('browser');
    });
  });

  describe('Acc 1.2 — browser mode: cookies + 302 to validated returnTo', () => {
    test('sets accessToken/refreshToken cookies and 302s to the returnTo', async () => {
      const returnTo = '/authorize?client_id=abc&state=xyz&code_challenge=cc';
      const res = await request(app)
        .post('/auth/dev-login')
        .send({ fresh: true, browser: true, nonce: 'browser1', returnTo });
      expect(res.status).toBe(302);
      // Host-agnostic: the redirect is <client-origin> + the validated path.
      expect(res.headers.location.endsWith(returnTo)).toBe(true);
      expect(res.headers.location).toMatch(/^https?:\/\/[^/]+\/authorize\?/);
      expect(findCookie(res, 'accessToken')).toBeDefined();
      expect(findCookie(res, 'refreshToken')).toBeDefined();
    });

    test('browser mode WITH valid returnTo stamps agent_oauth (RBD-10, same path as Google)', async () => {
      const res = await request(app)
        .post('/auth/dev-login')
        .send({ fresh: true, browser: true, nonce: 'agentprov', returnTo: '/authorize?x=1' });
      expect(res.status).toBe(302);
      const row = await pool.query("SELECT signup_source FROM users WHERE email = 'test+agentprov@test.local'");
      expect(row.rows[0].signup_source).toBe('agent_oauth');
    });

    test('invalid/oversized returnTo is dropped safely — no open redirect', async () => {
      const hostile = await request(app)
        .post('/auth/dev-login')
        .send({ fresh: true, browser: true, nonce: 'hostile1', returnTo: 'http://evil.com/pwn' });
      expect(hostile.status).toBe(302);
      // Falls through to the same-origin onboarding default, never off-origin.
      expect(hostile.headers.location).not.toContain('evil.com');
      expect(hostile.headers.location.endsWith('/docs?signup=1')).toBe(true);

      const oversized = '/' + 'a'.repeat(600);
      const big = await request(app)
        .post('/auth/dev-login')
        .send({ fresh: true, browser: true, nonce: 'hostile2', returnTo: oversized });
      expect(big.status).toBe(302);
      expect(big.headers.location).not.toContain('aaaaaa'.repeat(10));
      expect(big.headers.location.endsWith('/docs?signup=1')).toBe(true);
    });
  });

  describe('Acc 1.4 — synthetic wipe deletes user + cascade, idempotent', () => {
    test('wipe removes the user row, owned documents, and their non-cascading content', async () => {
      const r = await request(app).post('/auth/dev-login').send({ fresh: true, nonce: 'wipe1' });
      const userId = r.body.user.id;

      // Build owned content: a document (creator + owner share), CRDT content
      // (yjs_updates, keyed by doc_guid — no FK to documents), and a version row.
      const docRes = await pool.query(
        "INSERT INTO documents (id, creator_id, title) VALUES (gen_random_uuid(), $1, 'wipe doc') RETURNING id",
        [userId]
      );
      const docId = docRes.rows[0].id;
      await pool.query(
        "INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, 'owner')",
        [docId, userId]
      );
      await pool.query(
        'INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id) VALUES ($1, 0, $2, $3)',
        [docId, Buffer.from([1, 2, 3]), userId]
      );
      await pool.query(
        'INSERT INTO document_versions (doc_id, name, clock_start, clock_end, created_by) VALUES ($1, $2, 0, 1, $3)',
        [docId, 'v1', userId]
      );

      const wipe = await request(app).post('/auth/dev-wipe-user').send({ email: 'test+wipe1@test.local' });
      expect(wipe.status).toBe(200);
      expect(wipe.body.deleted).toBe(true);

      // No residue anywhere.
      const u = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
      const d = await pool.query('SELECT 1 FROM documents WHERE id = $1', [docId]);
      const y = await pool.query('SELECT 1 FROM yjs_updates WHERE doc_guid = $1', [docId]);
      const v = await pool.query('SELECT 1 FROM document_versions WHERE doc_id = $1', [docId]);
      expect(u.rows.length).toBe(0);
      expect(d.rows.length).toBe(0);
      expect(y.rows.length).toBe(0);
      expect(v.rows.length).toBe(0);
    });

    test('wiping a non-existent synthetic account is an idempotent no-op success', async () => {
      const res = await request(app).post('/auth/dev-wipe-user').send({ email: 'test+ghost@test.local' });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.deleted).toBe(false);
    });
  });

  describe('Acc 1.5 — wipe refuses non-synthetic addresses', () => {
    test.each([
      ['someone@gmail.com'],
      ['selftest@example.com'],
      ['test+abc@example.com'],
      ['test+@test.local'],
      ['admin+test@test.local'],
      ['test+UPPER@test.local'],
    ])('refuses %s', async (email) => {
      const res = await request(app).post('/auth/dev-wipe-user').send({ email });
      expect(res.status).toBe(400);
    });

    test('a real (non-synthetic) user is never touched by a refused wipe', async () => {
      const ins = await pool.query(
        "INSERT INTO users (google_id, email, name) VALUES ('real-029-guard', 'realguard-029@gmail.com', 'Real') RETURNING id",
      );
      const realId = ins.rows[0].id;
      try {
        const res = await request(app).post('/auth/dev-wipe-user').send({ email: 'realguard-029@gmail.com' });
        expect(res.status).toBe(400);
        const still = await pool.query('SELECT 1 FROM users WHERE id = $1', [realId]);
        expect(still.rows.length).toBe(1);
      } finally {
        await pool.query('DELETE FROM users WHERE id = $1', [realId]);
      }
    });
  });

  describe('Acc — all:true deletes only namespace rows', () => {
    test('wipes every synthetic user and leaves real users intact', async () => {
      await request(app).post('/auth/dev-login').send({ fresh: true, nonce: 'allx1' });
      await request(app).post('/auth/dev-login').send({ fresh: true, nonce: 'allx2' });
      const ins = await pool.query(
        "INSERT INTO users (google_id, email, name) VALUES ('real-029-all', 'realall-029@gmail.com', 'Real') RETURNING id",
      );
      const realId = ins.rows[0].id;
      try {
        const res = await request(app).post('/auth/dev-wipe-user').send({ all: true });
        expect(res.status).toBe(200);
        expect(res.body.wiped).toBeGreaterThanOrEqual(2);
        const syn = await pool.query("SELECT count(*)::int AS n FROM users WHERE email LIKE 'test+%@test.local'");
        expect(syn.rows[0].n).toBe(0);
        const real = await pool.query('SELECT 1 FROM users WHERE id = $1', [realId]);
        expect(real.rows.length).toBe(1);
      } finally {
        await pool.query('DELETE FROM users WHERE id = $1', [realId]);
      }
    });
  });

  describe('Acc 1.6 / SC-004 — unreachable with the flag unset or production-like', () => {
    const paths = [
      ['post', '/auth/dev-login', { fresh: true }],
      ['post', '/auth/dev-wipe-user', { all: true }],
      ['post', '/auth/dev-consent-approve', {}],
    ];

    test.each(paths)('%s %s is 404 with ENABLE_DEV_ENDPOINTS unset', async (method, path, body) => {
      const prev = process.env.ENABLE_DEV_ENDPOINTS;
      delete process.env.ENABLE_DEV_ENDPOINTS;
      try {
        const res = await request(app)[method](path).send(body);
        expect(res.status).toBe(404);
      } finally {
        process.env.ENABLE_DEV_ENDPOINTS = prev;
      }
    });

    test.each(paths)('%s %s is 404 in a production-like NODE_ENV even if the flag is set', async (method, path, body) => {
      const prevNode = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const res = await request(app)[method](path).send(body);
        expect(res.status).toBe(404);
      } finally {
        process.env.NODE_ENV = prevNode;
      }
    });
  });
});
