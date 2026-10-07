/**
 * Feature 058 (T045, FR-026/027/028/030): hosted-only server behavior is off by
 * default and on with SQUIRE_HOSTED=true. Real routers and modules throughout;
 * the flag is flipped per case (every gate reads the config at request time).
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { randomUUID } = require('crypto');

jest.mock('../auth/google', () => ({
  generateAuthUrl: jest.fn(), exchangeCodeForTokens: jest.fn(),
  verifyIdToken: jest.fn(), fetchUserInfo: jest.fn(async () => ({})),
}));
jest.mock('../onboarding', () => ({
  resolveOnboarding: jest.fn(async () => ({ welcomeDocId: null, onboarded: true })),
}));

const { _resetInstanceConfigForTests } = require('../instance-config');
const admin = require('../api/admin');
const authRouter = require('../auth/routes');
const users = require('../auth/users');
const jwt = require('../auth/jwt');
const aiUsage = require('../ai-usage');
const { openRouterHeaders } = require('../api/ai-providers');
const { createPool, createTestUser, cleanupTestUser } = require('./helpers/db');

const SAVED = {};
const NAMES = ['SQUIRE_HOSTED', 'APP_URL', 'ADMIN_EMAIL', 'SMTP_HOST', 'SMTP_FROM'];

function setHosted(on) {
  if (on) process.env.SQUIRE_HOSTED = 'true';
  else delete process.env.SQUIRE_HOSTED;
  _resetInstanceConfigForTests();
}

let pool;
let adminApp;
let authApp;
let adminUser;
let adminToken;
let quotaUserId;

beforeAll(async () => {
  for (const n of NAMES) SAVED[n] = process.env[n];
  pool = createPool();
  admin.init(pool);
  users.init(pool);
  aiUsage.init(pool);

  const tag = randomUUID().slice(0, 8);
  const a = await pool.query(
    'INSERT INTO users (google_id, email, name, is_admin) VALUES ($1, $2, $3, true) RETURNING *',
    [`gating-admin-${tag}`, `gating-admin-${tag}@example.com`, 'Gating Admin']
  );
  adminUser = a.rows[0];
  adminToken = jwt.generateAccessToken(adminUser);
  quotaUserId = await createTestUser(pool, `gating-quota-${tag}@example.com`);

  adminApp = express();
  adminApp.use(express.json());
  adminApp.use('/api/admin', admin.router);

  authApp = express();
  authApp.use(cookieParser());
  authApp.use(express.json());
  authApp.use('/auth', authRouter);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM ai_usage_log WHERE user_id = $1', [quotaUserId]);
    await cleanupTestUser(pool, quotaUserId);
    await cleanupTestUser(pool, adminUser.id);
  } finally {
    await pool.end();
    for (const n of NAMES) {
      if (SAVED[n] === undefined) delete process.env[n];
      else process.env[n] = SAVED[n];
    }
    _resetInstanceConfigForTests();
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  setHosted(false);
});

describe('(a) POST /api/admin/users/:id/welcome-email', () => {
  test('not hosted: indistinguishable from an unknown admin path', async () => {
    setHosted(false);
    const res = await request(adminApp).post(`/api/admin/users/${adminUser.id}/welcome-email`);
    const unknown = await request(adminApp).post(`/api/admin/users/${adminUser.id}/no-such-action`);
    expect(res.status).toBe(404);
    expect(res.status).toBe(unknown.status);
    expect(res.text.replace('welcome-email', 'X')).toBe(unknown.text.replace('no-such-action', 'X'));
  });

  test('hosted: the route runs (503 naming SMTP_FROM when email is off)', async () => {
    setHosted(true);
    delete process.env.SMTP_FROM;
    _resetInstanceConfigForTests();
    const res = await request(adminApp).post(`/api/admin/users/${adminUser.id}/welcome-email`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Email is not configured (SMTP_FROM unset)' });
  });
});

describe('(b) POST /auth/prod-reset-selftest-account', () => {
  test('not hosted: indistinguishable from an unknown auth path', async () => {
    setHosted(false);
    const res = await request(authApp).post('/auth/prod-reset-selftest-account').set('Authorization', `Bearer ${adminToken}`);
    const unknown = await request(authApp).post('/auth/no-such-route').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.status).toBe(unknown.status);
    expect(res.text.replace('prod-reset-selftest-account', 'X')).toBe(unknown.text.replace('no-such-route', 'X'));
  });

  test('hosted: the route runs (admin-gated: no credentials is 401)', async () => {
    setHosted(true);
    const res = await request(authApp).post('/auth/prod-reset-selftest-account');
    expect(res.status).toBe(401);
  });
});

describe('(c) checkQuota', () => {
  beforeAll(async () => {
    await pool.query('UPDATE users SET ai_credit_cents = 100 WHERE id = $1', [quotaUserId]);
    await pool.query(
      `INSERT INTO ai_usage_log (user_id, model_key, input_tokens, output_tokens, cost_cents, is_byok)
       VALUES ($1, 'claude-haiku', 1, 1, 250, false)`,
      [quotaUserId]
    );
  });

  test('not hosted: allowed, notApplicable, usage intact', async () => {
    setHosted(false);
    const q = await aiUsage.checkQuota(quotaUserId);
    expect(q).toMatchObject({ allowed: true, notApplicable: true, usedCents: 250, creditCents: 100 });
  });

  test('hosted: over the allowance is not allowed', async () => {
    setHosted(true);
    const q = await aiUsage.checkQuota(quotaUserId);
    expect(q.allowed).toBe(false);
    expect(q.notApplicable).toBeUndefined();
    expect(q.usedCents).toBe(250);
  });
});

describe('(d) admin sign-up and login emails', () => {
  beforeEach(() => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.SMTP_HOST = 'mail.example.com';
    process.env.SMTP_FROM = 'noreply@example.com';
  });

  // ADMIN_EMAIL is read when email.js loads, so load a fresh copy (with its own
  // nodemailer) after setting it, and spy on that copy's transport factory.
  function loadEmail() {
    let mod;
    let sendMail;
    let spy;
    jest.isolateModules(() => {
      const nm = require('nodemailer');
      sendMail = jest.fn(async () => ({ messageId: 'm1' }));
      spy = jest.spyOn(nm, 'createTransport').mockReturnValue({ sendMail });
      mod = require('../email');
    });
    return { mod, sendMail, spy };
  }

  test('not hosted: the transport is never used', async () => {
    setHosted(false);
    const { mod, sendMail, spy } = loadEmail();
    mod.notifyNewUser({ email: 'n@example.com', name: 'N' });
    mod.notifyLogin({ email: 'n@example.com', name: 'N' });
    await new Promise((r) => setImmediate(r));
    expect(spy).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('hosted: both send through the transport', async () => {
    setHosted(true);
    const { mod, sendMail } = loadEmail();
    mod.notifyNewUser({ email: 'n@example.com', name: 'N' });
    mod.notifyLogin({ email: 'n@example.com', name: 'N' });
    await new Promise((r) => setImmediate(r));
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail.mock.calls[0][0].subject).toMatch(/^New user registered/);
    expect(sendMail.mock.calls[1][0].subject).toMatch(/^User logged in/);
  });
});

describe('(e) OpenRouter referer', () => {
  test('HTTP-Referer is APP_URL', () => {
    process.env.APP_URL = 'http://localhost:3910';
    _resetInstanceConfigForTests();
    expect(openRouterHeaders()).toEqual({ 'HTTP-Referer': 'http://localhost:3910', 'X-Title': 'Squire Docs' });
    process.env.APP_URL = 'https://squiredocs.com';
    _resetInstanceConfigForTests();
    expect(openRouterHeaders()['HTTP-Referer']).toBe('https://squiredocs.com');
  });
});
