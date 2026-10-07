/**
 * Feature 059 (T043, FR-041): `squire login-link --email E`.
 */
const request = require('supertest');

jest.mock('../../auth/google', () => ({
  GOOGLE_ISSUER: 'https://accounts.google.com',
  generateAuthUrl: jest.fn(),
  exchangeCodeForTokens: jest.fn(),
  verifyIdToken: jest.fn(),
  fetchUserInfo: jest.fn(async () => ({})),
}));

const { _resetInstanceConfigForTests } = require('../../instance-config');
const { startLocalInstance } = require('../../__tests__/helpers/local-instance');
const { runCli } = require('./helpers');

const APP = 'http://localhost:3910';

describe('squire login-link', () => {
  let inst;
  const saved = {};

  beforeAll(async () => {
    for (const k of ['SQUIRE_MODE', 'APP_URL']) saved[k] = process.env[k];
    process.env.SQUIRE_MODE = 'team';
    process.env.APP_URL = APP;
    _resetInstanceConfigForTests();
    inst = await startLocalInstance();
  });

  afterAll(async () => {
    await inst.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetInstanceConfigForTests();
  });

  beforeEach(async () => {
    await inst.reset();
  });

  const run = (argv) => runCli(argv, { url: inst.url });

  test('mixed-case email finds the user; redemption writes exactly one login event with signin_link (team mode)', async () => {
    const { rows } = await inst.pool.query("INSERT INTO users (email, name) VALUES ('Mixed.Case@Example.com', 'Mixed') RETURNING id");
    const r = await run(['login-link', '--email', 'mixed.case@example.COM']);
    expect(r.code).toBe(0);
    const token = new URL(r.out.trim()).hash.slice(1);
    const res = await request(inst.app)
      .post('/auth/signin-link')
      .set('Origin', APP)
      .set('Accept', 'application/json')
      .send({ token });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(rows[0].id);
    const ev = await inst.pool.query('SELECT event, signup_source FROM auth_events WHERE user_id = $1', [rows[0].id]);
    expect(ev.rows).toEqual([{ event: 'login', signup_source: 'signin_link' }]);
  });

  test('unknown email on an instance with users exits 1 naming the email and login-link', async () => {
    await inst.pool.query("INSERT INTO users (email, name) VALUES ('someone@example.com', 'Someone')");
    const r = await run(['login-link', '--email', 'nobody@example.com']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/No account has the email nobody@example\.com/);
    expect(r.err).toMatch(/squire login-link --email/);
  });

  test('unknown email on an empty instance points at claim-link', async () => {
    const r = await run(['login-link', '--email', 'nobody@example.com']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no owner yet\. Run: squire claim-link/);
  });

  test('missing --email is a usage error', async () => {
    const r = await run(['login-link']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--email/);
  });
});
