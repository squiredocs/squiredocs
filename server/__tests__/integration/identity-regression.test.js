/**
 * Feature 059 (T023): the hosted service's sign-in behavior, pinned through
 * the REAL router, the real post-sign-in path (server/auth/post-auth.js), and
 * the real database. Only the Google adapter, email, and onboarding are
 * mocked, as the existing first-run suites do.
 *
 * Regression pins (User Story 2):
 *   1. new Google user, browser: one user, signup_source browser, capture pair,
 *      google_id NULL, one Google identity with email_verified, exactly one
 *      auth_events row, pending document AND space invites converted, welcome
 *      document redirect;
 *   2. the same subject returns with a changed email: same user, profile
 *      refreshed, signup_* untouched, last_login_* refreshed, one login row;
 *   3. a legacy row (numeric google_id + backfilled identity) signs in as itself;
 *   4. unknown subject with an existing email: account_exists, no session
 *      cookie, zero new rows of any kind;
 *   5. feature 031: a new user inside a valid /authorize returnTo with a
 *      localhost redirect is stamped agent_oauth and gets an inline code;
 *   6. an existing user with the same returnTo gets the consent page, no code;
 *   7. the feature 029 faucet's three modes use `dev` identities and keep their
 *      response shapes; a pre-059 faucet row is found again, not refused;
 *   8. no production file calls findOrCreateUser.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');

jest.mock('../../auth/google', () => ({
  GOOGLE_ISSUER: 'https://accounts.google.com',
  generateAuthUrl: jest.fn((state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
  exchangeCodeForTokens: jest.fn(async () => ({ id_token: 'fixture', access_token: 'fixture' })),
  verifyIdToken: jest.fn(),
  fetchUserInfo: jest.fn(async () => ({})),
}));
jest.mock('../../email', () => ({
  notifyNewUser: jest.fn(),
  notifyLogin: jest.fn(),
  sendShareInvite: jest.fn(),
  sendShareNotification: jest.fn(),
}));
jest.mock('../../onboarding', () => ({
  resolveOnboarding: jest.fn(async () => ({ welcomeDocId: '00000000-0000-4000-8000-00000000c0de', onboarded: false })),
}));

const authRouter = require('../../auth/routes');
const users = require('../../auth/users');
const documents = require('../../documents');
const spaces = require('../../spaces');
const oauthFlow = require('../../mcp/auth/oauth-flow');
const registeredAgents = require('../../mcp/auth/registered-agents');
const google = require('../../auth/google');
const email = require('../../email');
const onboarding = require('../../onboarding');
const { createPool } = require('../helpers/db');

const G = 'https://accounts.google.com';
const SUFFIX = '@identity-regression.test.example.com';
const AGENT_CALLBACK = 'http://localhost:8765/callback';

const rnd = () => crypto.randomBytes(6).toString('hex');

describe('feature 059 identity regression (hosted behavior pinned)', () => {
  let app;
  let pool;
  const userIds = new Set();

  beforeAll(() => {
    pool = createPool();
    users.init(pool);
    documents.init(pool);
    spaces.init(pool);
    oauthFlow.init(pool);
    registeredAgents.init(pool);
    app = express();
    app.use(cookieParser());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use('/auth', authRouter);
  });

  afterAll(async () => {
    const ids = [...userIds];
    if (ids.length) {
      await pool.query('DELETE FROM space_members WHERE user_id = ANY($1::uuid[]) OR granted_by = ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM spaces WHERE created_by = ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM document_shares WHERE user_id = ANY($1::uuid[]) OR granted_by = ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM documents WHERE creator_id = ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [ids]);
    }
    await pool.query(`DELETE FROM users WHERE email LIKE '%${SUFFIX}'`);
    await users.deleteAllSyntheticUsers();
    await pool.end();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const identity = (over = {}) => ({
    issuer: G,
    subject: `${Date.now()}${Math.floor(Math.random() * 1e9)}`,
    email: `u-${rnd()}${SUFFIX}`,
    name: 'Regression User',
    picture: 'https://example.com/p.png',
    emailVerified: true,
    ...over,
  });

  async function googleCallback(id, { returnTo, ua = 'RegressionUA/1' } = {}) {
    google.verifyIdToken.mockResolvedValueOnce({ ...id });
    const state = `state-${rnd()}`;
    const cookies = [`oauth_state=${state}`, 'oauth_redirect=http://localhost:5173'];
    if (returnTo) cookies.push(`oauth_return_to=${encodeURIComponent(returnTo)}`);
    return request(app)
      .get(`/auth/google/callback?code=fake&state=${state}`)
      .set('Cookie', cookies)
      .set('User-Agent', ua);
  }

  const sessionCookies = (res) =>
    (res.headers['set-cookie'] || []).filter((c) => /^(accessToken|refreshToken)=[^;]+/.test(c));
  const userBySubject = async (issuer, subject) =>
    (await pool.query(
      'SELECT u.* FROM users u JOIN user_identities i ON i.user_id = u.id WHERE i.issuer = $1 AND i.subject = $2',
      [issuer, subject]
    )).rows[0];
  const events = async (userId) =>
    (await pool.query('SELECT event, signup_source FROM auth_events WHERE user_id = $1 ORDER BY id', [userId])).rows;
  const count = async (sql, params = []) => (await pool.query(sql, params)).rows[0].n;

  function authorizeReturnTo(clientId) {
    const p = new URLSearchParams({
      agent_client_id: clientId,
      scope: 'documents:read documents:write',
      redirect_uri: AGENT_CALLBACK,
      state: `st_${rnd()}`,
      code_challenge: crypto.randomBytes(32).toString('base64url'),
      code_challenge_method: 'S256',
    });
    return `/authorize?${p.toString()}`;
  }

  test('1. new Google user (browser): identity, capture, one event, invites converted, welcome doc', async () => {
    const id = identity();
    // An inviter with a document and a space, both with pending invites for this email.
    const inviter = await users.resolveIdentityUser(identity());
    userIds.add(inviter.id);
    const doc = (await pool.query(
      "INSERT INTO documents (id, title, creator_id) VALUES (uuid_generate_v4(), 'Invite doc', $1) RETURNING *",
      [inviter.id]
    )).rows[0];
    await pool.query(
      "INSERT INTO document_shares (doc_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $2)",
      [doc.id, inviter.id]
    );
    await pool.query(
      "INSERT INTO document_share_invites (doc_id, email, role, invited_by_user_id) VALUES ($1, $2, 'editor', $3)",
      [doc.id, id.email, inviter.id]
    );
    const space = await spaces.createSpace('Regression Space', inviter.id);
    await spaces.inviteMember(space.id, id.email, 'viewer', inviter.id);

    const res = await googleCallback(id);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/d/00000000-0000-4000-8000-00000000c0de?welcome=1');
    expect(sessionCookies(res)).toHaveLength(2);
    expect(onboarding.resolveOnboarding).toHaveBeenCalledTimes(1);

    const user = await userBySubject(G, id.subject);
    userIds.add(user.id);
    expect(user).toMatchObject({ signup_source: 'browser', google_id: null, email: id.email });
    expect(user.signup_user_agent).toBe('RegressionUA/1');
    // supertest connects from loopback, which authContext stores as NULL (034 guard).
    expect(user.signup_ip).toBe(user.last_login_ip);
    const ident = (await pool.query('SELECT * FROM user_identities WHERE user_id = $1', [user.id])).rows;
    expect(ident).toHaveLength(1);
    expect(ident[0]).toMatchObject({ issuer: G, subject: id.subject, email_verified: true });
    expect(await events(user.id)).toEqual([{ event: 'signup', signup_source: 'browser' }]);
    expect(email.notifyNewUser).toHaveBeenCalledTimes(1);
    expect(email.notifyLogin).toHaveBeenCalledTimes(1);

    const share = await pool.query('SELECT role FROM document_shares WHERE doc_id = $1 AND user_id = $2', [doc.id, user.id]);
    expect(share.rows[0].role).toBe('editor');
    expect(await spaces.getMemberRole(space.id, user.id)).toBe('viewer');
    expect(await count('SELECT count(*)::int AS n FROM document_share_invites WHERE lower(email) = lower($1)', [id.email])).toBe(0);
  });

  test('2. a returning subject with a changed email claim is the same user', async () => {
    const id = identity();
    await googleCallback(id, { ua: 'First/1' });
    const first = await userBySubject(G, id.subject);
    userIds.add(first.id);

    const changed = { ...id, email: `changed-${rnd()}${SUFFIX}`, name: 'Changed Name', picture: 'https://example.com/q.png' };
    const res = await googleCallback(changed, { ua: 'Second/2' });
    expect(res.status).toBe(302);
    expect(sessionCookies(res)).toHaveLength(2);

    const second = await userBySubject(G, id.subject);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ email: changed.email, name: 'Changed Name', picture: changed.picture });
    expect(second.signup_source).toBe(first.signup_source);
    expect(second.signup_user_agent).toBe('First/1');
    expect(second.last_login_user_agent).toBe('Second/2');
    expect(second.last_login_at.getTime()).toBeGreaterThanOrEqual(first.last_login_at.getTime());
    expect(await events(first.id)).toEqual([
      { event: 'signup', signup_source: 'browser' },
      { event: 'login', signup_source: 'browser' },
    ]);
    expect(email.notifyNewUser).toHaveBeenCalledTimes(1);
  });

  test('3. a legacy pre-059 row (numeric google_id + backfilled identity) signs in as itself', async () => {
    const legacyId = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const legacyEmail = `legacy-${rnd()}${SUFFIX}`;
    const { rows } = await pool.query(
      "INSERT INTO users (google_id, email, name, signup_source) VALUES ($1, $2, 'Legacy', 'browser') RETURNING *",
      [legacyId, legacyEmail]
    );
    userIds.add(rows[0].id);
    // Make it look exactly like a backfilled row: drop the trigger's identity
    // and recreate it the way the migration's backfill does.
    await pool.query('DELETE FROM user_identities WHERE user_id = $1', [rows[0].id]);
    await pool.query(
      "INSERT INTO user_identities (user_id, issuer, subject, created_at) SELECT id, 'https://accounts.google.com', google_id, created_at FROM users WHERE id = $1",
      [rows[0].id]
    );

    const res = await googleCallback(identity({ subject: legacyId, email: legacyEmail, name: 'Legacy' }));
    expect(res.status).toBe(302);
    expect(sessionCookies(res)).toHaveLength(2);
    expect(await count('SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)', [legacyEmail])).toBe(1);
    expect(await events(rows[0].id)).toEqual([{ event: 'login', signup_source: 'browser' }]);
  });

  test('4. unknown subject whose email exists: account_exists, no session, nothing created', async () => {
    const existing = identity();
    await googleCallback(existing);
    const owner = await userBySubject(G, existing.subject);
    userIds.add(owner.id);

    const before = {
      users: await count('SELECT count(*)::int AS n FROM users'),
      identities: await count('SELECT count(*)::int AS n FROM user_identities'),
      events: await count('SELECT count(*)::int AS n FROM auth_events'),
    };
    const res = await googleCallback(identity({ email: existing.email.toUpperCase() }));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/login?error=account_exists');
    expect(sessionCookies(res)).toHaveLength(0);
    expect({
      users: await count('SELECT count(*)::int AS n FROM users'),
      identities: await count('SELECT count(*)::int AS n FROM user_identities'),
      events: await count('SELECT count(*)::int AS n FROM auth_events'),
    }).toEqual(before);
  });

  test('5. feature 031: new user inside a valid /authorize returnTo (localhost) gets agent_oauth and an inline code', async () => {
    const id = identity();
    const returnTo = authorizeReturnTo(`client_${rnd()}`);
    const res = await googleCallback(id, { returnTo });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(`${loc.origin}${loc.pathname}`).toBe(AGENT_CALLBACK);
    expect(loc.searchParams.get('code')).toBeTruthy();

    const user = await userBySubject(G, id.subject);
    userIds.add(user.id);
    expect(user.signup_source).toBe('agent_oauth');
    expect(await count('SELECT count(*)::int AS n FROM mcp_auth_codes WHERE user_id = $1', [user.id])).toBe(1);
    expect(await events(user.id)).toEqual([{ event: 'signup', signup_source: 'agent_oauth' }]);
    expect(onboarding.resolveOnboarding).not.toHaveBeenCalled();
  });

  test('6. an existing user with the same returnTo sees the consent page and nothing is minted', async () => {
    const id = identity();
    await googleCallback(id);
    const user = await userBySubject(G, id.subject);
    userIds.add(user.id);

    const returnTo = authorizeReturnTo(`client_${rnd()}`);
    const res = await googleCallback(id, { returnTo });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`http://localhost:5173${returnTo}`);
    expect(await count('SELECT count(*)::int AS n FROM mcp_auth_codes WHERE user_id = $1', [user.id])).toBe(0);
  });

  describe('7. the feature 029 faucet keys synthetic users by dev identities', () => {
    test('fixed JSON mode keeps its response shape and uses the dev-test-user identity', async () => {
      const res = await request(app).post('/auth/dev-login').send({});
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'user']);
      expect(Object.keys(res.body.user).sort()).toEqual(
        ['email', 'emailEnabled', 'id', 'isAdmin', 'name', 'onboarded', 'picture', 'welcomeDocId'].sort()
      );
      expect(sessionCookies(res)).toHaveLength(2);
      const u = await userBySubject('dev', 'dev-test-user');
      expect(u.email).toBe('dev@test.local');
      expect(email.notifyLogin).not.toHaveBeenCalled();
      // One event per call.
      const n0 = (await events(u.id)).length;
      await request(app).post('/auth/dev-login').send({});
      expect((await events(u.id)).length).toBe(n0 + 1);
    });

    test('fresh JSON mode keeps its response shape and creates a dev identity', async () => {
      const nonce = `idr${rnd()}`;
      const res = await request(app).post('/auth/dev-login').send({ fresh: true, nonce });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['accessToken', 'email', 'nonce', 'user']);
      expect(res.body.email).toBe(`test+${nonce}@test.local`);
      const u = await userBySubject('dev', `dev-test-${nonce}`);
      expect(u.id).toBe(res.body.user.id);
      expect(u.google_id).toBeNull();
      expect(await events(u.id)).toEqual([{ event: 'signup', signup_source: 'browser' }]);
      expect(email.notifyNewUser).not.toHaveBeenCalled();
    });

    test('fresh browser mode goes through completePostAuth with a dev identity', async () => {
      const nonce = `idrb${rnd()}`;
      const res = await request(app)
        .post('/auth/dev-login')
        .send({ fresh: true, browser: true, nonce, returnTo: '/docs' });
      expect(res.status).toBe(302);
      expect(res.headers.location.endsWith('/docs')).toBe(true);
      expect(sessionCookies(res)).toHaveLength(2);
      const u = await userBySubject('dev', `dev-test-${nonce}`);
      expect(u.signup_source).toBe('agent_oauth');
    });

    test('a pre-059 faucet row (google_id dev-test-<nonce>) is found again, not refused', async () => {
      const nonce = `pre${rnd()}`;
      const { rows } = await pool.query(
        "INSERT INTO users (google_id, email, name) VALUES ($1, $2, 'Pre Faucet') RETURNING id",
        [`dev-test-${nonce}`, `test+${nonce}@test.local`]
      );
      const res = await request(app).post('/auth/dev-login').send({ fresh: true, nonce });
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(rows[0].id);
      expect(await events(rows[0].id)).toEqual([{ event: 'login', signup_source: 'browser' }]);
    });
  });

  test('8. no production file under server/ calls findOrCreateUser', () => {
    const root = path.join(__dirname, '..', '..');
    const offenders = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
          walk(full);
        } else if (ent.name.endsWith('.js')) {
          const src = fs.readFileSync(full, 'latin1');
          if (!src.includes('findOrCreateUser(')) continue;
          const rel = path.relative(root, full);
          if (rel === path.join('auth', 'users.js')) {
            // Only its own definition.
            const calls = src.match(/findOrCreateUser\(/g) || [];
            if (calls.length !== 1 || !/async function findOrCreateUser\(/.test(src)) offenders.push(rel);
          } else {
            offenders.push(rel);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
