/**
 * Feature 059 (T035): POST /auth/signin-link and /auth/signin-link/peek
 * through the real /auth router (mounted with the per-IP limiter, as
 * server/index.js does), the real post-sign-in path, and the real onboarding,
 * on a fresh zero-user database, in local mode.
 *
 * Covers FR-011 (no auto-issue through a link), FR-027 (no token in a
 * Location), FR-029/FR-034 (both response modes), FR-033 (no route mints),
 * FR-047 (peek keys), and the contract's refusal table.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');

jest.mock('../../auth/google', () => ({
  GOOGLE_ISSUER: 'https://accounts.google.com',
  generateAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth'),
  exchangeCodeForTokens: jest.fn(),
  verifyIdToken: jest.fn(),
  fetchUserInfo: jest.fn(async () => ({})),
}));

const { _resetInstanceConfigForTests } = require('../../instance-config');
const { startLocalInstance, sessionCookies } = require('../helpers/local-instance');
const links = require('../../auth/signin-links');

const APP = 'http://localhost:3910';

describe('sign-in link endpoints (local mode)', () => {
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

  beforeEach(async () => {
    await inst.reset();
  });

  const events = async (userId) =>
    (await inst.pool.query('SELECT event, signup_source FROM auth_events WHERE user_id = $1 ORDER BY id', [userId])).rows;
  const userCount = async () => (await inst.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  const addUser = async (email = `u-${crypto.randomUUID()}@example.com`) =>
    (await inst.pool.query("INSERT INTO users (email, name) VALUES ($1, 'Existing') RETURNING *", [email])).rows[0];
  const claimLink = (over = {}) => links.mintLink(inst.pool, { kind: 'claim', source: 'cli', ...over });
  const formPost = (body, cookies = []) =>
    request(inst.app).post('/auth/signin-link').set('Origin', APP).type('form').set('Accept', 'text/html').set('Cookie', cookies).send(body);
  const jsonPost = (body) =>
    request(inst.app).post('/auth/signin-link').set('Origin', APP).set('Accept', 'application/json').send(body);

  test('the dev faucet refuses to create the first user of an unclaimed local instance (059 review M2)', async () => {
    const savedFlag = process.env.ENABLE_DEV_ENDPOINTS;
    process.env.ENABLE_DEV_ENDPOINTS = '1';
    try {
      const refused = await request(inst.app).post('/auth/dev-login').send({});
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('instance_unclaimed');
      expect(await userCount()).toBe(0);

      const { token } = await claimLink();
      await jsonPost({ token, name: 'Owner', email: 'owner@example.com' });
      const allowed = await request(inst.app).post('/auth/dev-login').send({});
      expect(allowed.status).toBe(200);
    } finally {
      if (savedFlag === undefined) delete process.env.ENABLE_DEV_ENDPOINTS;
      else process.env.ENABLE_DEV_ENDPOINTS = savedFlag;
    }
  });

  test('form mode: a claim sets both session cookies, lands on the seeded welcome doc, one signup event', async () => {
    const { token } = await claimLink();
    const res = await formPost({ token, name: 'Sam', email: 'sam@example.com' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(new RegExp(`^${APP}/d/[0-9a-f-]{36}\\?welcome=1$`));
    expect(res.headers.location).not.toContain(token);
    expect(sessionCookies(res)).toHaveLength(2);

    const { rows } = await inst.pool.query('SELECT * FROM users');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'sam@example.com', is_admin: true, signup_source: 'signin_link' });
    expect(rows[0].welcome_doc_id).toBeTruthy();
    expect(res.headers.location).toContain(rows[0].welcome_doc_id);
    expect(await events(rows[0].id)).toEqual([{ event: 'signup', signup_source: 'signin_link' }]);
  });

  test('JSON mode: a sign-in link returns { ok, user } with the same cookies and one login event', async () => {
    const u = await addUser('owner@example.com');
    const { token } = await links.mintLink(inst.pool, { kind: 'signin', userId: u.id, source: 'cli' });
    const res = await jsonPost({ token });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Object.keys(res.body.user).sort()).toEqual(['email', 'id', 'isAdmin', 'name', 'onboarded', 'welcomeDocId']);
    expect(res.body.user).toMatchObject({ id: u.id, email: 'owner@example.com', isAdmin: false });
    expect(sessionCookies(res)).toHaveLength(2);
    expect(await events(u.id)).toEqual([{ event: 'login', signup_source: 'signin_link' }]);
  });

  describe('refusals set no cookie', () => {
    test('link_invalid (unknown, used, malformed): form 302 to /login, JSON 400', async () => {
      const unknown = crypto.randomBytes(32).toString('base64url');
      let res = await formPost({ token: unknown });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${APP}/login?error=link_invalid`);
      expect(sessionCookies(res)).toHaveLength(0);
      res = await jsonPost({ token: unknown });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'link_invalid' });
      res = await jsonPost({ token: 'x' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'link_invalid' });
      expect(sessionCookies(res)).toHaveLength(0);

      const u = await addUser();
      const { token } = await links.mintLink(inst.pool, { kind: 'signin', userId: u.id, source: 'cli' });
      expect((await jsonPost({ token })).status).toBe(200);
      res = await jsonPost({ token });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('link_invalid');
      expect(sessionCookies(res)).toHaveLength(0);
    });

    test('instance_claimed: form 302 to /login, JSON 409', async () => {
      const a = await claimLink();
      const b = await claimLink();
      await addUser();
      let res = await formPost({ token: a.token, name: 'X', email: 'x@example.com' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${APP}/login?error=instance_claimed`);
      expect(sessionCookies(res)).toHaveLength(0);
      res = await jsonPost({ token: b.token, name: 'X', email: 'x@example.com' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ ok: false, error: 'instance_claimed' });
      expect(await userCount()).toBe(1);
    });

    test('claim_invalid: form 303 to /claim (no fragment), JSON 400 with field; the link stays unspent', async () => {
      const { token } = await claimLink();
      let res = await formPost({ token, name: 'Sam', email: '' });
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe(`${APP}/claim?error=claim_invalid`);
      expect(sessionCookies(res)).toHaveLength(0);
      res = await jsonPost({ token, name: '', email: 'sam@example.com' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: 'claim_invalid', field: 'name' });
      expect((await links.peekLink(inst.pool, token)).valid).toBe(true);
      expect(await userCount()).toBe(0);
    });
  });

  test('FR-011: a valid oauth_return_to cookie never yields an authorization code through a link', async () => {
    const p = new URLSearchParams({
      agent_client_id: `client_${crypto.randomBytes(4).toString('hex')}`,
      scope: 'documents:read documents:write',
      redirect_uri: 'http://localhost:8765/callback',
      state: 'st',
      code_challenge: crypto.randomBytes(32).toString('base64url'),
      code_challenge_method: 'S256',
    });
    const returnTo = `/authorize?${p.toString()}`;
    const { token } = await claimLink();
    const res = await formPost(
      { token, name: 'Sam', email: 'sam@example.com' },
      [`oauth_return_to=${encodeURIComponent(returnTo)}`]
    );
    expect(res.status).toBe(302);
    expect(res.headers.location.startsWith('http://localhost:8765')).toBe(false);
    expect(res.headers.location).toMatch(/\/d\/[0-9a-f-]{36}\?welcome=1$/);
    expect((await inst.pool.query('SELECT count(*)::int AS n FROM mcp_auth_codes')).rows[0].n).toBe(0);
  });

  describe('peek (FR-047)', () => {
    const peek = (token) => request(inst.app).post('/auth/signin-link/peek').send({ token });

    test('valid claim, valid signin, and invalid bodies carry only the contract keys', async () => {
      const c = await claimLink({ prefillName: 'Sam', prefillEmail: 'sam@example.com' });
      let res = await peek(c.token);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'kind', 'prefill', 'valid']);
      expect(res.body).toMatchObject({ valid: true, kind: 'claim', prefill: { name: 'Sam', email: 'sam@example.com' } });

      const u = await addUser('who@example.com');
      const s = await links.mintLink(inst.pool, { kind: 'signin', userId: u.id, source: 'cli' });
      res = await peek(s.token);
      expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'kind', 'prefill', 'valid']);
      expect(res.body.prefill).toEqual({ name: 'Existing', email: 'who@example.com' });

      res = await peek(crypto.randomBytes(32).toString('base64url'));
      expect(res.body).toEqual({ valid: false });
      // The claim link is invalid now that a user exists.
      res = await peek(c.token);
      expect(res.body).toEqual({ valid: false });
      expect(sessionCookies(res)).toHaveLength(0);
    });

    test('a body without a plausible token is 400 token_required', async () => {
      const res = await request(inst.app).post('/auth/signin-link/peek').send({});
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'token_required' });
    });
  });

  test('FR-033: mintLink( is called only from server/cli/ and maybeLogStartupClaimLink', () => {
    const serverRoot = path.join(__dirname, '..', '..');
    const callers = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
          walk(full);
        } else if (ent.name.endsWith('.js')) {
          const src = fs.readFileSync(full, 'latin1');
          if (/\bmintLink\(/.test(src)) callers.push({ rel: path.relative(serverRoot, full), src });
        }
      }
    };
    walk(serverRoot);
    for (const { rel, src } of callers) {
      if (rel.startsWith(`cli${path.sep}`)) continue;
      expect(rel).toBe(path.join('auth', 'signin-links.js'));
      // Inside signin-links.js: the definition plus the one call in the startup block.
      const calls = src.match(/[^\w]mintLink\(/g) || [];
      expect(calls).toHaveLength(2);
      const startup = src.slice(src.indexOf('async function maybeLogStartupClaimLink'));
      expect(startup).toMatch(/mintLink\(/);
    }
    // No route file mints.
    const routes = ['routes.js', 'signin-link-routes.js'].map((f) =>
      fs.readFileSync(path.join(serverRoot, 'auth', f), 'utf8')
    );
    for (const src of routes) expect(src).not.toMatch(/mintLink/);
  });

  test('FR-035: the link endpoints live on the /auth router that index.js puts behind the per-IP limiter', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
    expect(index).toMatch(/app\.use\('\/auth', rateLimit\.authRouteLimiter\(\), authRouter\)/);
    const routes = fs.readFileSync(path.join(__dirname, '..', '..', 'auth', 'routes.js'), 'utf8');
    expect(routes).toMatch(/router\.use\(require\('\.\/signin-link-routes'\)\.createSigninLinkRouter/);
  });
});
