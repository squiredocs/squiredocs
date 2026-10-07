/**
 * The shared post-sign-in path (feature 059, FR-008 to FR-012, research R3,
 * contracts/identity-and-post-auth.md).
 *
 * Every sign-in method resolves its user first (Google and the faucet through
 * resolveIdentityUser, sign-in links through redeemLink) and then comes here.
 * This module is the ONE place that converts pending invites, notifies, writes
 * the auth-event row (through updateLastLogin), issues session cookies, runs
 * the feature 031 auto-issue gate, handles the return path, and decides the
 * welcome document.
 *
 * isValidReturnTo, tryParseAuthorizeReturnTo and completePostAuth moved here
 * from server/auth/routes.js unchanged in logic; routes.js re-exports the two
 * helpers for existing importers.
 *
 * STRUCTURAL INVARIANT (feature 031 U2/INV-3, kept by 034 and 059): neither
 * establishSession nor completePostAuth receives `req`. The auto-issue
 * parameters can only come from the cookie-bound returnTo string a caller
 * passes in, and `ctx` is the inert { ip, userAgent } capture pair the caller
 * already extracted. No decision in this file reads ctx.
 */
const {
  generateAccessToken,
  generateRefreshToken,
  getCookieOptions,
  getAccessTokenCookieOptions,
} = require('./jwt');
const users = require('./users');
const { notifyNewUser, notifyLogin } = require('../email');
const onboarding = require('../onboarding');
const mcpOauthFlow = require('../mcp/auth/oauth-flow');
// PKCE format re-check on the inline auto-issue path (feature 031, FR-005/FR-006).
// approveAuthorization checks code_challenge PRESENCE but not FORMAT, so the
// auto-issue gate re-runs the same validator handleAuthorize uses (INV-6).
const { validateCodeChallenge } = require('../mcp/auth/pkce');
// Auto-issue path is restricted to localhost redirect URIs (feature 031
// adversarial-review fix, ratified by Sam 2026-07-22 — see the gate below).
const { isLocalhostUri } = require('../mcp/auth/registered-agents');

/**
 * Validate a returnTo value as a same-origin relative path (open-redirect
 * defense). Implements the R2 predicate from feature 005-agent-onboarding.
 *
 * A value is accepted iff ALL of:
 *   1. typeof value === 'string'
 *   2. value.length > 0 && value.length <= 512
 *   3. value.startsWith('/')
 *   4. !value.startsWith('//') (protocol-relative)
 *   5. !value.includes('\\') (backslash open-redirect variants)
 *   6. new URL(value, 'http://placeholder').host === 'placeholder'
 *
 * @param {*} value - Candidate returnTo value
 * @returns {boolean} True if the value is a same-origin relative path
 */
function isValidReturnTo(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 512) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.includes('\\')) return false;
  try {
    const parsed = new URL(value, 'http://placeholder');
    if (parsed.host !== 'placeholder') return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Feature 031 (T003, FR-005) — parse + revalidate a cookie-bound returnTo as an
 * inline-auto-issue-eligible /authorize request. This is the trust boundary of
 * the consent collapse: it accepts ONLY the single string it is passed (in
 * production the server-bound httpOnly `oauth_return_to` cookie value), and
 * NEVER reads req.query / req.body / headers — completePostAuth does not even
 * receive `req`, so the auto-issue parameters cannot originate from any
 * client-modifiable post-auth channel (INV-3 / structural invariant U2).
 *
 * Feature 034 preserves this exactly: completePostAuth gained a `ctx` parameter
 * carrying ONLY the pre-extracted { ip, userAgent } capture pair, computed by
 * each caller in its own scope. It is still handed no `req`, and `ctx` is inert
 * storage data that no decision in this file reads — so U2 holds unchanged.
 *
 * Returns the parsed OAuth parameter set only when the value is a valid
 * same-origin returnTo, its pathname is exactly `/authorize`, the required
 * parameters are all present, and the PKCE challenge passes the SAME format
 * validator handleAuthorize uses. Returns null otherwise — every miss FAILS
 * CLOSED to the existing consent redirect. Agent resolution, redirect_uri
 * (checkRedirectUri) and scope validation are left to approveAuthorization,
 * which runs the byte-for-byte same validators as the explicit path (INV-6, D5).
 *
 * @param {*} rawReturnTo - the cookie-derived returnTo string (only accepted input)
 * @returns {null | {agent_client_id, agent_instance_id, redirect_uri,
 *   code_challenge, code_challenge_method, state, scope}}
 */
function tryParseAuthorizeReturnTo(rawReturnTo) {
  if (!isValidReturnTo(rawReturnTo)) return null;

  let parsed;
  try {
    parsed = new URL(rawReturnTo, 'http://placeholder');
  } catch {
    return null;
  }
  if (parsed.pathname !== '/authorize') return null;

  const q = parsed.searchParams;
  const agent_client_id = q.get('agent_client_id') || q.get('client_id');
  const redirect_uri = q.get('redirect_uri');
  const code_challenge = q.get('code_challenge');
  const code_challenge_method = q.get('code_challenge_method') || 'S256';
  const state = q.get('state');
  const scope = q.get('scope');
  const agent_instance_id = q.get('agent_instance_id') || undefined;

  // Required parameter presence (matches handleAuthorize's required set).
  if (!agent_client_id || !redirect_uri || !code_challenge || !state) return null;

  // PKCE challenge format re-check (approveAuthorization checks presence, not
  // format) — the exact validator the standard authorize entry point runs.
  if (!validateCodeChallenge(code_challenge).valid) return null;

  return {
    agent_client_id,
    agent_instance_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    state,
    scope,
  };
}

/**
 * Provenance for an account created in this sign-in (feature 029 FR-012):
 * agent_oauth iff a valid same-origin returnTo is present, else browser.
 * Callers compute it BEFORE resolving the user so it is stamped on INSERT.
 * @param {*} rawReturnTo
 * @returns {'agent_oauth'|'browser'}
 */
function signupSourceFor(rawReturnTo) {
  return isValidReturnTo(rawReturnTo) ? 'agent_oauth' : 'browser';
}

/**
 * The side effects of a completed sign-in, in today's order:
 *   1. convert pending document and space invites (one transaction, never
 *      throws, FR-012) — formerly inside findOrCreateUser;
 *   2. notify (new-user, then login) when `notify` and the email is not in
 *      the synthetic namespace — repeated rehearsals must not spam the admin
 *      inbox (029 review);
 *   3. updateLastLogin: the last-login capture and the ONE auth_events row
 *      for this sign-in (FR-009);
 *   4. the access and refresh cookies.
 *
 * @param {import('express').Response} res
 * @param {object} user - resolved user row with `isNew`
 * @param {{ signupSource: string, ctx?: {ip: string|null, userAgent: string|null}, notify: boolean }} opts
 */
async function establishSession(res, user, { signupSource, ctx = { ip: null, userAgent: null }, notify }) {
  await users.convertPendingInvites(user);

  if (notify && !users.isSyntheticEmail(user.email)) {
    if (user.isNew) {
      notifyNewUser({ email: user.email, name: user.name });
    }
    notifyLogin({ email: user.email, name: user.name });
  }

  await users.updateLastLogin(user.id, { ...ctx, signupSource, isNew: user.isNew });

  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  res.cookie('accessToken', accessToken, getAccessTokenCookieOptions());
  res.cookie('refreshToken', refreshToken, getCookieOptions());
  return { accessToken, refreshToken };
}

/**
 * Shared post-authentication logic for every browser sign-in: the Google
 * callback, the feature-029 faucet browser mode, and a sign-in link redeemed
 * from the claim page. Given an ALREADY-RESOLVED user (with `isNew`), it:
 *   - establishes the session (invites, notifications, the auth-event row,
 *     cookies);
 *   - on a valid returnTo, redirects there and DELIBERATELY skips welcome-doc
 *     seeding (FR-013, load-bearing — agent-first accounts get no browser
 *     welcome doc; the early return is the mechanism);
 *   - otherwise resolves onboarding and redirects to the welcome doc or doc list.
 *
 * A sign-in link always passes rawReturnTo null, so the feature 031 auto-issue
 * below can never fire for it (FR-011, D2).
 *
 * @param {import('express').Response} res
 * @param {object} args
 * @param {object} args.user          - resolved user row with `isNew`
 * @param {string} args.signupSource  - channel of THIS sign-in
 * @param {string} args.clientUrl     - validated client origin for redirects
 * @param {*} args.rawReturnTo        - candidate returnTo (validated here)
 * @param {{ip: string|null, userAgent: string|null}} [args.ctx] - feature 034
 *   capture pair, already extracted from the request by the caller. Storage-only:
 *   nothing in this function interprets it, and NO `req` is accepted (U2/INV-3).
 */
async function completePostAuth(res, { user, signupSource, clientUrl, rawReturnTo, ctx = { ip: null, userAgent: null } }) {
  const hasReturnTo = isValidReturnTo(rawReturnTo);

  await establishSession(res, user, { signupSource, ctx, notify: true });

  // Feature 005 consent round-trip / feature 029 agent-first: honor a validated
  // same-origin returnTo and return BEFORE welcome-doc seeding. This early return
  // is the deliberate, load-bearing welcome-doc skip for consent-born accounts
  // (FR-013) — do not "fix" it by falling through to onboarding.
  if (hasReturnTo) {
    // Feature 031 — First-run consent collapse (FR-003/004/005/006/010).
    //
    // AUTO-ISSUE GATE. Fires ONLY when the account was created in THIS very
    // round-trip (`user.isNew` === the xmax=0 INSERT outcome — never account
    // age, emptiness, or a pre-authenticated session, FR-004/FR-007) AND the
    // cookie-bound returnTo is a fully-valid /authorize request. A just-created
    // account holds zero documents, so the consent card would protect nothing;
    // every existing account (isNew === false) skips this branch and gets the
    // explicit ConsentCard. Any miss FAILS CLOSED to the consent redirect below
    // (never an error, never a fail-open mint — FR-010/INV-4).
    //
    // The OAuth parameters come EXCLUSIVELY from tryParseAuthorizeReturnTo(rawReturnTo)
    // — the server-bound cookie value — never from req.query/req.body (INV-3).
    // Minting reuses the shared approveAuthorization core (the same path the
    // browser Approve click and dev-consent-approve drive) — no parallel mint
    // path (FR-006/INV-2).
    if (user.isNew === true) {
      const authorizeParams = tryParseAuthorizeReturnTo(rawReturnTo);
      // SECURITY (feature 031 adversarial-review fix, ratified by Sam 2026-07-22).
      // The auto-issue path mints WITHOUT a human eyeball on the redirect_uri.
      // checkRedirectUri would otherwise accept any localhost OR HTTPS redirect
      // for an auto-registered client — which turns first-run auto-issue into a
      // remote login-CSRF token-theft vector: an attacker links a victim to an
      // /authorize URL for the attacker's client with an attacker-controlled
      // HTTPS redirect, the victim's first sign-in creates the account (isNew),
      // and the code is delivered server-side to the attacker. Restricting the
      // auto-issue path to LOCALHOST redirects lands the code on the victim's own
      // machine (unreadable to a remote attacker) and collapses the remote blast
      // radius to near-zero. A non-localhost redirect FAILS CLOSED to the explicit
      // consent card (a human then eyeballs the HTTPS URL) — no legitimate
      // first-run client is broken (Claude Code and every terminal agent use a
      // localhost loopback callback). The explicit-consent path is UNCHANGED (D5).
      if (authorizeParams && isLocalhostUri(authorizeParams.redirect_uri)) {
        try {
          const result = await mcpOauthFlow.approveAuthorization({
            userId: user.id,
            agent_client_id: authorizeParams.agent_client_id,
            agent_instance_id: authorizeParams.agent_instance_id,
            scopes: authorizeParams.scope,
            redirect_uri: authorizeParams.redirect_uri,
            state: authorizeParams.state,
            code_challenge: authorizeParams.code_challenge,
            code_challenge_method: authorizeParams.code_challenge_method,
          });
          if (result.ok) {
            // AUTO-ISSUE: straight to the agent callback carrying code + state.
            // No consent card, no "Authorized" interstitial (D1).
            return res.redirect(result.redirectUrl);
          }
          // !result.ok → fall through to the consent redirect (FAIL CLOSED).
        } catch (e) {
          // Never dead-end the user on an auto-issue error — fall through to the
          // existing consent redirect (FR-010/INV-4).
          console.error('Auto-issue (first-run consent collapse) failed; falling back to consent:', e);
        }
      }
      // authorizeParams null OR non-localhost redirect OR !result.ok OR threw
      // → fall through to the explicit consent redirect below (FAIL CLOSED).
    }

    return res.redirect(`${clientUrl}${rawReturnTo}`);
  }

  // Onboarding: not-yet-engaged users land on their seeded welcome doc with the
  // assistant primed to greet them; everyone else goes to their doc list.
  let redirectPath = '/docs?signup=1';
  try {
    const { welcomeDocId, onboarded } = await onboarding.resolveOnboarding(user, { seed: true });
    if (!onboarded && welcomeDocId) {
      redirectPath = `/d/${welcomeDocId}?welcome=1`;
    }
  } catch (e) {
    console.error('Onboarding resolve failed:', e);
  }

  return res.redirect(`${clientUrl}${redirectPath}`);
}

module.exports = {
  isValidReturnTo,
  tryParseAuthorizeReturnTo,
  signupSourceFor,
  establishSession,
  completePostAuth,
};
