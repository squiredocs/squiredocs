/**
 * Feature 059 (T036, SC-001): the whole claim path, end to end, on an empty
 * local instance: the real CLI entry point prints a link, the page's peek
 * reads its prefill, the page's form post claims the instance, and the
 * returned cookies are a working admin session on /auth/me.
 */
const { Pool } = require('pg');
const request = require('supertest');

jest.mock('../../auth/google', () => ({
  GOOGLE_ISSUER: 'https://accounts.google.com',
  generateAuthUrl: jest.fn(),
  exchangeCodeForTokens: jest.fn(),
  verifyIdToken: jest.fn(),
  fetchUserInfo: jest.fn(async () => ({})),
}));

const { _resetInstanceConfigForTests } = require('../../instance-config');
const { startLocalInstance } = require('../helpers/local-instance');
const { main } = require('../../cli');

const APP = 'http://localhost:3910';

function capture() {
  let text = '';
  return { write: (s) => { text += s; return true; }, get text() { return text; } };
}

describe('SC-001: claim a fresh local instance from the terminal', () => {
  let inst;
  const saved = {};

  beforeAll(async () => {
    for (const k of ['SQUIRE_MODE', 'APP_URL']) saved[k] = process.env[k];
    process.env.SQUIRE_MODE = 'local';
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

  test('CLI link -> peek -> form post -> welcome doc -> admin session', async () => {
    const out = capture();
    const err = capture();
    const code = await main(['claim-link', '--name', 'Sam', '--email', 'sam@example.com'], {
      out,
      err,
      createPool: () => new Pool({ connectionString: inst.url }),
    });
    expect(code).toBe(0);
    const lines = out.text.trim().split('\n');
    expect(lines).toHaveLength(1);
    const url = new URL(lines[0]);
    expect(`${url.origin}${url.pathname}`).toBe(`${APP}/claim`);
    const token = url.hash.slice(1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(err.text).toMatch(/within 15 minutes/);

    const peek = await request(inst.app).post('/auth/signin-link/peek').send({ token });
    expect(peek.body).toMatchObject({ valid: true, kind: 'claim', prefill: { name: 'Sam', email: 'sam@example.com' } });

    const res = await request(inst.app)
      .post('/auth/signin-link')
      .set('Origin', APP)
      .type('form')
      .send({ token, name: peek.body.prefill.name, email: peek.body.prefill.email });
    expect(res.status).toBe(302);
    const landing = new URL(res.headers.location);
    expect(landing.pathname).toMatch(/^\/d\/[0-9a-f-]{36}$/);
    expect(landing.searchParams.get('welcome')).toBe('1');

    const cookies = res.headers['set-cookie'].map((c) => c.split(';')[0]);
    // The SPA sends the access token as a Bearer header (it reads it after
    // the refresh-cookie exchange); /auth/me accepts only the header.
    const access = cookies.find((c) => c.startsWith('accessToken=')).slice('accessToken='.length);
    const me = await request(inst.app).get('/auth/me').set('Authorization', `Bearer ${access}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ name: 'Sam', email: 'sam@example.com', isAdmin: true });
    expect(me.body.welcomeDocId).toBe(landing.pathname.split('/')[2]);

    const link = await inst.pool.query('SELECT used_at FROM signin_links');
    expect(link.rows).toHaveLength(1);
    expect(link.rows[0].used_at).not.toBeNull();
  });
});
