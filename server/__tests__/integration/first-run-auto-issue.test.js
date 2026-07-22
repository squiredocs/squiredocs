/**
 * Feature 031 — First-run consent collapse: tier-1 auto-issue gate suite. Serial.
 *
 * Exercises the production auto-issue gate in completePostAuth through the faucet
 * browser mode (RBD-10: the faucet routes through the SAME completePostAuth as the
 * real Google callback, substituting only the identity leg — so these assertions
 * cover production behavior, not a mock path).
 *
 *   US1 (T007): a brand-new account's /authorize round-trip mints the code inline
 *     and 302s straight to the agent callback with NO consent action (INV-1+,
 *     SC-005, FR-003); provenance stamped agent_oauth + welcome-doc skipped on the
 *     auto-issue branch (T017/INV-5/FR-011).
 *   US2 (T009): an EXISTING account (pre-minted via a non-auto-issuing faucet JSON
 *     call, U1) with the identical returnTo does NOT auto-issue — it falls through
 *     to the consent redirect, no code, no delegation (INV-1-, FR-004/FR-007).
 *   US2 (T010): FR-008 phishing — attacker client + attacker redirect, a
 *     PRE-EXISTING victim signing in mints nothing; a victimless fresh account
 *     under the same attacker params yields at most a token on that just-created
 *     zero-document account (blast-radius ceiling).
 *   US2 (T011): fail-closed matrix — non-/authorize path, malformed challenge,
 *     rejected redirect_uri, and divergent req.query all fail closed; a minted code
 *     reflects the COOKIE (returnTo) params only, never req.query (INV-3/INV-4).
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

jest.mock('../../auth/google', () => ({
  generateAuthUrl: jest.fn(),
  exchangeCodeForTokens: jest.fn(),
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
  resolveOnboarding: jest.fn(async () => ({ welcomeDocId: null, onboarded: true })),
}));

const authRouter = require('../../auth/routes');
const users = require('../../auth/users');
const oauthFlow = require('../../mcp/auth/oauth-flow');
const registeredAgents = require('../../mcp/auth/registered-agents');
const onboarding = require('../../onboarding');
const { createPool } = require('../helpers/db');

// The consent-fallback redirect is `${clientUrl}${returnTo}`, where clientUrl is
// resolved from the request (getClientUrl) — under supertest that is an ephemeral
// 127.0.0.1:<port> origin, not a fixed value. So fallback assertions check the
// returnTo SUFFIX + that the redirect is NOT the agent callback, origin-agnostic.
const AGENT_CALLBACK_ORIGIN = 'http://localhost:8765';
function expectConsentFallback(res, returnTo) {
  expect(res.status).toBe(302);
  const loc = res.headers.location;
  expect(loc.endsWith(returnTo)).toBe(true); // redirect to the consent/return path, unchanged
  expect(new URL(loc).origin).not.toBe(AGENT_CALLBACK_ORIGIN); // NOT the agent callback → no auto-issue
}

describe('Feature 031 — first-run auto-issue gate', () => {
  let app;
  let pool;

  beforeAll(async () => {
    pool = createPool();
    users.init(pool);
    oauthFlow.init(pool);
    registeredAgents.init(pool);

    app = express();
    app.use(cookieParser());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use('/auth', authRouter);
  });

  afterAll(async () => {
    await users.deleteAllSyntheticUsers();
    await pool.end();
  });

  beforeEach(() => {
    onboarding.resolveOnboarding.mockClear();
  });

  // A valid PKCE S256 challenge is exactly 43 base64url chars.
  const challenge = () => crypto.randomBytes(32).toString('base64url');
  const rnd = () => crypto.randomBytes(6).toString('hex');

  /** Build an /authorize returnTo path with a full, valid OAuth parameter set. */
  function authorizeReturnTo(overrides = {}) {
    const p = new URLSearchParams({
      agent_client_id: overrides.agent_client_id || `client_${rnd()}`,
      agent_instance_id: overrides.agent_instance_id ?? '',
      scope: overrides.scope || 'documents:read documents:write',
      redirect_uri: overrides.redirect_uri || 'http://localhost:8765/callback',
      state: overrides.state || `state_${rnd()}`,
      code_challenge: overrides.code_challenge || challenge(),
      code_challenge_method: overrides.code_challenge_method || 'S256',
      existing_delegation: 'false',
    });
    return `/authorize?${p.toString()}`;
  }

  /** Drive faucet BROWSER mode (session cookies + 302) through completePostAuth. */
  function faucetBrowser(nonce, returnTo, queryString = '') {
    return request(app)
      .post(`/auth/dev-login${queryString}`)
      .send({ fresh: true, browser: true, nonce, returnTo });
  }

  /** Non-auto-issuing account creation (JSON fresh mode — no browser/returnTo, U1). */
  function faucetCreate(nonce) {
    return request(app).post('/auth/dev-login').send({ fresh: true, nonce });
  }

  const userIdFor = async (nonce) => {
    const r = await pool.query('SELECT id FROM users WHERE email = $1', [`test+${nonce}@test.local`]);
    return r.rows[0]?.id;
  };
  const codeCountFor = async (userId) => {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM mcp_auth_codes WHERE user_id = $1', [userId]);
    return r.rows[0].n;
  };
  const delegationCountFor = async (userId) => {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM agent_delegations WHERE user_id = $1', [userId]);
    return r.rows[0].n;
  };

  describe('US1 (T007) — brand-new account auto-issues inline, no consent action', () => {
    test('302s straight to the agent callback with code+state; a code row exists; NO consent POST', async () => {
      const nonce = `new${rnd()}`;
      const clientId = `client_${rnd()}`;
      const state = `state_${rnd()}`;
      const returnTo = authorizeReturnTo({ agent_client_id: clientId, state });

      const res = await faucetBrowser(nonce, returnTo);

      // Straight to the agent callback (redirect_uri host), carrying code + state.
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.location);
      expect(loc.origin).toBe('http://localhost:8765'); // the agent redirect_uri, NOT the consent page
      expect(loc.pathname).toBe('/callback');
      expect(loc.searchParams.get('code')).toBeTruthy();
      expect(loc.searchParams.get('state')).toBe(state);

      // A code was persisted for the just-created user, for THIS client.
      const userId = await userIdFor(nonce);
      expect(userId).toBeTruthy();
      const codeRow = await pool.query(
        'SELECT 1 FROM mcp_auth_codes WHERE user_id = $1 AND agent_client_id = $2',
        [userId, clientId],
      );
      expect(codeRow.rows.length).toBe(1);

      // T017/INV-5/FR-011: agent_oauth provenance stamped, welcome doc skipped,
      // onboarding seeding never reached (auto-issue returns before it).
      const u = await pool.query('SELECT signup_source, welcome_doc_id FROM users WHERE id = $1', [userId]);
      expect(u.rows[0].signup_source).toBe('agent_oauth');
      expect(u.rows[0].welcome_doc_id).toBeNull();
      expect(onboarding.resolveOnboarding).not.toHaveBeenCalled();
    });
  });

  describe('US2 (T009) — existing account never auto-issues (counter-assertion)', () => {
    test('a pre-existing account with an identical returnTo falls through to consent, no code', async () => {
      const nonce = `exist${rnd()}`;
      // U1: create the account via the NON-auto-issuing JSON faucet (no returnTo),
      // so setup itself mints no code.
      const created = await faucetCreate(nonce);
      expect(created.status).toBe(200);
      const userId = await userIdFor(nonce);
      expect(await codeCountFor(userId)).toBe(0);

      // Second call: SAME nonce (find-or-create → isNew=false) + a valid /authorize returnTo.
      const returnTo = authorizeReturnTo();
      const res = await faucetBrowser(nonce, returnTo);

      // Fall through to the consent page (NOT the agent callback), no code, no delegation.
      expectConsentFallback(res, returnTo);
      expect(await codeCountFor(userId)).toBe(0);
      expect(await delegationCountFor(userId)).toBe(0);
    });
  });

  describe('US2 (T010) — FR-008 phishing blast radius', () => {
    const ATTACKER_CLIENT = `attacker_${rnd()}`;
    const ATTACKER_REDIRECT = 'https://evil.example.com/callback'; // HTTPS → passes checkRedirectUri for an auto-registered client

    test('a PRE-EXISTING victim signing in under attacker params mints nothing', async () => {
      const nonce = `victim${rnd()}`;
      await faucetCreate(nonce); // victim account already exists (U1 non-auto-issuing)
      const userId = await userIdFor(nonce);

      const returnTo = authorizeReturnTo({ agent_client_id: ATTACKER_CLIENT, redirect_uri: ATTACKER_REDIRECT });
      const res = await faucetBrowser(nonce, returnTo);

      expectConsentFallback(res, returnTo); // consent fallback, names attacker client
      expect(await codeCountFor(userId)).toBe(0);
      expect(await delegationCountFor(userId)).toBe(0);
    });

    test('even a fresh account never hands a code to a NON-LOCALHOST redirect (031 ratified tightening)', async () => {
      // Adversarial-review fix (ratified 2026-07-22): the auto-issue path is
      // localhost-only. An attacker-controlled HTTPS redirect — the remotely
      // exfiltratable channel — now FAILS CLOSED to the explicit consent card
      // even for a brand-new account, so no code is ever delivered off-box to a
      // remote attacker. This is strictly tighter than the old FR-008 ceiling.
      const nonce = `fresh${rnd()}`;
      const returnTo = authorizeReturnTo({ agent_client_id: ATTACKER_CLIENT, redirect_uri: ATTACKER_REDIRECT });
      const res = await faucetBrowser(nonce, returnTo);

      expectConsentFallback(res, returnTo); // consent card, NOT the attacker's https origin
      const userId = await userIdFor(nonce);
      expect(await codeCountFor(userId)).toBe(0);
      expect(await delegationCountFor(userId)).toBe(0);
    });

    test('a fresh account WITH a localhost redirect still auto-issues (the legitimate first-run path)', async () => {
      // The tightening must not break real first-run clients — Claude Code and
      // every terminal agent use a localhost loopback callback.
      const nonce = `freshlocal${rnd()}`;
      const returnTo = authorizeReturnTo({ agent_client_id: `good_${rnd()}`, redirect_uri: 'http://localhost:8765/callback' });
      const res = await faucetBrowser(nonce, returnTo);

      expect(res.status).toBe(302);
      expect(new URL(res.headers.location).origin).toBe('http://localhost:8765'); // straight to the agent callback
      expect(new URL(res.headers.location).searchParams.get('code')).toBeTruthy();
    });
  });

  describe('US2 (T011) — fail-closed matrix', () => {
    test('(a) a non-/authorize returnTo redirects normally, no code', async () => {
      const nonce = `patha${rnd()}`;
      const res = await faucetBrowser(nonce, '/docs?welcome=1');
      expectConsentFallback(res, '/docs?welcome=1');
      expect(await codeCountFor(await userIdFor(nonce))).toBe(0);
    });

    test('(b) an /authorize returnTo with a malformed code_challenge fails closed to consent', async () => {
      const nonce = `pathb${rnd()}`;
      const returnTo = authorizeReturnTo({ code_challenge: 'too-short-not-base64url' });
      const res = await faucetBrowser(nonce, returnTo);
      expectConsentFallback(res, returnTo);
      expect(await codeCountFor(await userIdFor(nonce))).toBe(0);
    });

    test('(c) an /authorize returnTo with a rejected redirect_uri (http non-localhost) fails closed', async () => {
      const nonce = `pathc${rnd()}`;
      const returnTo = authorizeReturnTo({ redirect_uri: 'http://evil.example.com/cb' });
      const res = await faucetBrowser(nonce, returnTo);
      expectConsentFallback(res, returnTo); // approveAuthorization !ok → consent fallback
      expect(await codeCountFor(await userIdFor(nonce))).toBe(0);
    });

    test('(d) divergent req.query is ignored — a minted code reflects the COOKIE (returnTo) params only (INV-3)', async () => {
      const nonce = `pathd${rnd()}`;
      const goodClient = `good_${rnd()}`;
      const returnTo = authorizeReturnTo({ agent_client_id: goodClient });
      // Tamper the POST query with a different client_id — completePostAuth never
      // reads req, so this MUST be ignored.
      const res = await faucetBrowser(nonce, returnTo, `?agent_client_id=EVIL_QUERY_CLIENT&code=INJECT`);
      expect(res.status).toBe(302);
      expect(new URL(res.headers.location).origin).toBe('http://localhost:8765');
      const userId = await userIdFor(nonce);
      // The persisted code is bound to the returnTo client, never the query client.
      const good = await pool.query('SELECT 1 FROM mcp_auth_codes WHERE user_id = $1 AND agent_client_id = $2', [userId, goodClient]);
      const evil = await pool.query('SELECT 1 FROM mcp_auth_codes WHERE user_id = $1 AND agent_client_id = $2', [userId, 'EVIL_QUERY_CLIENT']);
      expect(good.rows.length).toBe(1);
      expect(evil.rows.length).toBe(0);
    });
  });
});

