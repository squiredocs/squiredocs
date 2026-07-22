/**
 * Authentication routes
 */
const crypto = require('crypto');
const express = require('express');
const { generateAuthUrl, exchangeCodeForTokens, verifyIdToken, fetchUserInfo } = require('./google');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  getCookieOptions,
  getAccessTokenCookieOptions,
  clearAuthCookies,
  getJwtErrorResponse,
} = require('./jwt');
const {
  findOrCreateUser,
  findById,
  incrementTokenVersion,
  updateName,
  updateLastLogin,
  isSyntheticEmail,
  deleteUserByEmail,
  deleteAllSyntheticUsers,
} = require('./users');
const { requireAuth, requireAdmin, requireDevEndpoints } = require('./middleware');
const { notifyNewUser, notifyLogin } = require('../email');
const onboarding = require('../onboarding');
const mcpOauthFlow = require('../mcp/auth/oauth-flow');

const router = express.Router();

// Fallback client URL for redirects (configurable via env)
const DEFAULT_CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

/**
 * Get the client URL from request origin or referer, falling back to env config.
 * In production, always returns DEFAULT_CLIENT_URL to prevent open redirect.
 */
function getClientUrl(req) {
  if (process.env.NODE_ENV === 'production') {
    return DEFAULT_CLIENT_URL;
  }
  // In development, use origin/referer for flexibility
  if (req.headers.origin) {
    return req.headers.origin;
  }
  if (req.headers.referer) {
    try {
      const url = new URL(req.headers.referer);
      return `${url.protocol}//${url.host}`;
    } catch (e) {
      // Invalid referer, fall through
    }
  }
  return DEFAULT_CLIENT_URL;
}

/**
 * Validate that a client URL matches the allowed origin.
 * Returns DEFAULT_CLIENT_URL if validation fails.
 */
function validateClientUrl(clientUrl) {
  try {
    const parsed = new URL(clientUrl);
    const allowed = new URL(DEFAULT_CLIENT_URL);
    if (parsed.origin === allowed.origin) {
      return clientUrl;
    }
  } catch {
    // Invalid URL
  }
  return DEFAULT_CLIENT_URL;
}

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
 * GET /auth/google
 * Initiates Google OAuth flow by redirecting to Google's consent screen
 */
router.get('/google', (req, res) => {
  try {
    const isProduction = process.env.NODE_ENV === 'production';
    const clientUrl = getClientUrl(req);

    // Store the client URL in a cookie so we can redirect back after OAuth
    res.cookie('oauth_redirect', clientUrl, {
      httpOnly: true,
      maxAge: 5 * 60 * 1000,
      sameSite: 'lax',
      secure: isProduction,
    });

    // Feature 005-agent-onboarding: honor a same-origin returnTo path through
    // the Google round-trip via a short-lived httpOnly cookie. Invalid values
    // are dropped silently (open-redirect defense, D4/R2 fail-closed).
    const returnTo = req.query.returnTo;
    if (isValidReturnTo(returnTo)) {
      res.cookie('oauth_return_to', returnTo, {
        httpOnly: true,
        maxAge: 10 * 60 * 1000, // 10 minutes (R1)
        sameSite: 'lax',
        secure: isProduction,
      });
    }

    // Generate CSRF state parameter and store in httpOnly cookie
    const state = crypto.randomBytes(32).toString('hex');
    res.cookie('oauth_state', state, {
      httpOnly: true,
      maxAge: 5 * 60 * 1000,
      sameSite: 'lax',
      secure: isProduction,
    });

    const authUrl = generateAuthUrl(state);
    res.redirect(authUrl);
  } catch (error) {
    console.error('Error generating auth URL:', error);
    const clientUrl = getClientUrl(req);
    res.redirect(`${clientUrl}/login?error=config_error`);
  }
});

/**
 * GET /auth/google/callback
 * Handles the OAuth callback from Google
 * Creates/updates user, generates JWT tokens, redirects to client
 */
router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;

  // Get the client URL from the cookie we set, validate it, then clear
  const rawClientUrl = req.cookies?.oauth_redirect || DEFAULT_CLIENT_URL;
  const clientUrl = process.env.NODE_ENV === 'production'
    ? validateClientUrl(rawClientUrl)
    : rawClientUrl;
  res.clearCookie('oauth_redirect');

  // Verify OAuth state parameter to prevent CSRF
  const storedState = req.cookies?.oauth_state;
  res.clearCookie('oauth_state');

  // Feature 005-agent-onboarding: capture and clear the returnTo continuation
  // on EVERY callback exit (success, error, denial) — a clear only on success
  // leaves a stale cookie that hijacks the landing destination of the next
  // login within its TTL (review LOW-1).
  const rawReturnTo = req.cookies?.oauth_return_to;
  res.clearCookie('oauth_return_to');
  if (!storedState || storedState !== state) {
    return res.redirect(`${clientUrl}/login?error=invalid_state`);
  }

  if (error) {
    console.error('Google OAuth error:', error);
    return res.redirect(`${clientUrl}/login?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect(`${clientUrl}/login?error=no_code`);
  }
  
  try {
    // Exchange authorization code for tokens
    const tokens = await exchangeCodeForTokens(code);
    
    if (!tokens.id_token) {
      throw new Error('No ID token received from Google');
    }
    
    // Verify ID token and extract user profile
    const profile = await verifyIdToken(tokens.id_token);

    // Google's ID token omits the `picture` claim for some accounts, so backfill
    // the avatar from the userinfo endpoint when it's missing.
    if (!profile.picture) {
      const info = await fetchUserInfo(tokens.access_token);
      if (info.picture) profile.picture = info.picture;
    }

    // Shared post-auth logic (account creation, provenance stamping, welcome-doc
    // decision, returnTo handling). The faucet's browser mode routes through the
    // exact same helper, substituting only the identity leg (RBD-10).
    return completePostAuth(res, { profile, clientUrl, rawReturnTo });
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect(`${clientUrl}/login?error=auth_failed`);
  }
});

/**
 * Shared post-authentication logic for both the real Google callback and the
 * feature-029 faucet browser mode. Given a verified identity profile, it:
 *   - stamps signup provenance (agent_oauth iff a valid same-origin returnTo is
 *     present at account creation, else browser — FR-012, written once on INSERT);
 *   - creates/updates the user and notifies;
 *   - issues session cookies;
 *   - on a valid returnTo, redirects there and DELIBERATELY skips welcome-doc
 *     seeding (FR-013, load-bearing — agent-first accounts get no browser
 *     welcome doc; the early return is the mechanism);
 *   - otherwise resolves onboarding and redirects to the welcome doc or doc list.
 *
 * This is the ONE place provenance + the welcome-doc skip live, so the tier-1
 * tests exercise production behavior, not the faucet (RBD-10).
 *
 * @param {import('express').Response} res
 * @param {object} args
 * @param {object} args.profile   - {googleId, email, name, picture}
 * @param {string} args.clientUrl - validated client origin for redirects
 * @param {*} args.rawReturnTo    - candidate returnTo (validated here)
 */
async function completePostAuth(res, { profile, clientUrl, rawReturnTo }) {
  const hasReturnTo = isValidReturnTo(rawReturnTo);
  const signupSource = hasReturnTo ? 'agent_oauth' : 'browser';

  const user = await findOrCreateUser(profile, { signupSource });

  if (user.isNew) {
    notifyNewUser({ email: user.email, name: user.name });
  }
  notifyLogin({ email: user.email, name: user.name });

  await updateLastLogin(user.id);

  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  res.cookie('accessToken', accessToken, getAccessTokenCookieOptions());
  res.cookie('refreshToken', refreshToken, getCookieOptions());

  // Feature 005 consent round-trip / feature 029 agent-first: honor a validated
  // same-origin returnTo and return BEFORE welcome-doc seeding. This early return
  // is the deliberate, load-bearing welcome-doc skip for consent-born accounts
  // (FR-013) — do not "fix" it by falling through to onboarding.
  if (hasReturnTo) {
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

/**
 * POST /auth/refresh
 * Refreshes access token using refresh token from cookie
 * Implements token rotation (issues new refresh token each time)
 */
router.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  
  if (!refreshToken) {
    return res.status(401).json({ error: 'No refresh token' });
  }
  
  try {
    // Verify refresh token
    const decoded = verifyRefreshToken(refreshToken);
    
    // Get current user to check token version
    const user = await findById(decoded.userId);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    // Check token version for revocation
    if (user.token_version !== decoded.tokenVersion) {
      // Token has been revoked (user logged out or password changed)
      clearAuthCookies(res);
      return res.status(401).json({ error: 'Token revoked' });
    }

    // Generate new tokens (cookie rotation without version increment).
    // Version increment only happens on logout — incrementing here would
    // invalidate refresh tokens held by other tabs, causing a race where
    // the second tab to refresh gets "Token revoked" and logs out all tabs.
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    // Set new token cookies
    res.cookie('accessToken', newAccessToken, getAccessTokenCookieOptions());
    res.cookie('refreshToken', newRefreshToken, getCookieOptions());

    // Return new access token (for REST API Authorization header)
    res.json({ accessToken: newAccessToken });
  } catch (error) {
    clearAuthCookies(res);
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Refresh token expired', code: 'TOKEN_EXPIRED' });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    console.error('Refresh token error:', error);
    return res.status(500).json({ error: 'Token refresh failed' });
  }
});

/**
 * GET /auth/me
 * Returns current user profile
 * Requires authentication
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await findById(req.user.userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Onboarding state (read-only probe — recomputes engagement so a refresh
    // stops redirecting once the user has created a real doc; never seeds here).
    let welcomeDocId = user.welcome_doc_id || null;
    let onboarded = !!user.onboarded_at;
    try {
      ({ welcomeDocId, onboarded } = await onboarding.resolveOnboarding(user, { seed: false }));
    } catch (e) {
      console.error('Onboarding probe failed:', e);
    }

    // Return user profile (exclude sensitive fields)
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      isAdmin: !!user.is_admin,
      emailEnabled: !!user.email_enabled,
      welcomeDocId,
      onboarded,
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

/**
 * PATCH /auth/me
 * Updates current user's profile (name)
 * Requires authentication
 */
router.patch('/me', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;

    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const trimmed = name.trim();
    if (trimmed.length > 255) {
      return res.status(400).json({ error: 'Name must be 255 characters or fewer' });
    }

    const user = await updateName(req.user.userId, trimmed);

    // Issue a fresh access token so JWT claims reflect the new name
    const newAccessToken = generateAccessToken(user);
    res.cookie('accessToken', newAccessToken, getAccessTokenCookieOptions());

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
      },
      accessToken: newAccessToken,
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * POST /auth/logout
 * Logs out user by incrementing token version and clearing cookie
 * Requires authentication
 */
router.post('/logout', requireAuth, async (req, res) => {
  try {
    // Increment token version to invalidate all existing tokens
    await incrementTokenVersion(req.user.userId);

    clearAuthCookies(res);
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    // Still clear cookies even if DB update fails
    clearAuthCookies(res);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ---------------------------------------------------------------------------
// Feature 029 — First-run test mechanism (dev-support endpoints).
//
// Every synthetic endpoint below is fail-closed behind `requireDevEndpoints`
// (positive ENABLE_DEV_ENDPOINTS opt-in + NODE_ENV belt, RBD-5) — 404 and
// indistinguishable from a missing route when the gate is closed. These forge
// sessions / mass-delete, so the namespace (`isSyntheticEmail`) is the security
// perimeter for the wipe and the auto-approve. The prod single-account reset at
// the very bottom is the ONE deliberate exception: admin-gated, prod-reachable,
// hardcoded single-target (FR-002).
// ---------------------------------------------------------------------------

// The production self-test account (D6, RBD-4). Hardcoded compile-time constant —
// the ENTIRE target surface of the prod reset. No parameter is ever consulted.
const PROD_RESET_ACCOUNT = 'selftest@example.com';

// Nonce grammar for the faucet (RBD-3), matching the SYNTHETIC namespace bound.
const NONCE_RE = /^[a-z0-9-]{1,32}$/;

/**
 * POST /auth/dev-login  (EXTENDED — FR-003, FR-004)
 *
 * Dev-only auth bypass with three modes (backward compatible):
 *   - Fixed JSON     `{}`                              → the fixed dev@test.local
 *     user, JSON `{ accessToken, user }` (unchanged legacy behavior).
 *   - Fresh JSON     `{fresh:true[, nonce]}`           → mints test+<nonce>@test.local,
 *     JSON `{ accessToken, user, email, nonce }`.
 *   - Fresh browser  `{fresh:true, browser:true, returnTo}` → sets accessToken/
 *     refreshToken cookies and 302s to a validated same-origin returnTo,
 *     standing in for Google on the consent page's sign-in leg. Routes through
 *     the SAME shared post-auth path (provenance stamping + welcome-doc skip) as
 *     the Google callback, substituting only the identity leg (RBD-10).
 */
router.post('/dev-login', requireDevEndpoints, async (req, res) => {
  try {
    const { fresh, nonce: rawNonce, browser, returnTo } = req.body || {};

    // Legacy fixed-user mode — empty/`fresh`-absent body (backward compatible).
    if (!fresh) {
      const user = await findOrCreateUser({
        googleId: 'dev-test-user',
        email: 'dev@test.local',
        name: 'Dev Test User',
        picture: null,
      });
      await updateLastLogin(user.id);

      const accessToken = generateAccessToken(user);
      const refreshToken = generateRefreshToken(user);
      res.cookie('accessToken', accessToken, getAccessTokenCookieOptions());
      res.cookie('refreshToken', refreshToken, getCookieOptions());

      let welcomeDocId = null;
      let onboarded = true;
      try {
        ({ welcomeDocId, onboarded } = await onboarding.resolveOnboarding(user, { seed: true }));
      } catch (e) {
        console.error('Onboarding resolve failed (dev-login):', e);
      }

      return res.json({
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          picture: user.picture,
          isAdmin: !!user.is_admin,
          emailEnabled: !!user.email_enabled,
          welcomeDocId,
          onboarded,
        },
      });
    }

    // Fresh mode: resolve the nonce (server-random hex, or a validated caller
    // nonce for a stable identity — find-or-create makes reuse a re-login).
    let nonce;
    if (rawNonce === undefined || rawNonce === null || rawNonce === '') {
      nonce = crypto.randomBytes(5).toString('hex'); // 10 lowercase hex chars
    } else if (typeof rawNonce === 'string' && NONCE_RE.test(rawNonce)) {
      nonce = rawNonce;
    } else {
      return res.status(400).json({ error: 'invalid nonce (must match /^[a-z0-9-]{1,32}$/)' });
    }

    const profile = {
      googleId: `dev-test-${nonce}`,
      email: `test+${nonce}@test.local`,
      name: `Test User ${nonce}`,
      picture: null,
    };

    // Fresh browser mode — session cookies + 302, through the shared path so
    // provenance/welcome-doc/returnTo behavior is production-identical (RBD-10).
    if (browser) {
      const clientUrl = getClientUrl(req);
      return completePostAuth(res, { profile, clientUrl, rawReturnTo: returnTo });
    }

    // Fresh JSON mode — no returnTo, so browser provenance. Cookies + JSON echo.
    const user = await findOrCreateUser(profile, { signupSource: 'browser' });
    await updateLastLogin(user.id);

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);
    res.cookie('accessToken', accessToken, getAccessTokenCookieOptions());
    res.cookie('refreshToken', refreshToken, getCookieOptions());

    return res.json({
      accessToken,
      email: user.email,
      nonce,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        isAdmin: !!user.is_admin,
        emailEnabled: !!user.email_enabled,
      },
    });
  } catch (error) {
    console.error('Dev login error:', error);
    res.status(500).json({ error: 'Dev login failed' });
  }
});

/**
 * POST /auth/dev-onboarding-reset
 * Development-only: reset the current user's onboarding state and reseed a fresh
 * welcome doc, so the welcome flow can be re-triggered on demand. Unchanged from
 * before feature 029 (kept — it serves the browser-first welcome flow, which is
 * NOT the same as first-run testing since it never removes the account row).
 */
router.post('/dev-onboarding-reset', requireDevEndpoints, requireAuth, async (req, res) => {
  try {
    const welcomeDocId = await onboarding.resetForDev(req.user.userId);
    res.json({ welcomeDocId, url: `/d/${welcomeDocId}?welcome=1` });
  } catch (error) {
    console.error('Dev onboarding reset error:', error);
    res.status(500).json({ error: 'Dev onboarding reset failed' });
  }
});

/**
 * POST /auth/dev-wipe-user  (NEW — FR-008, FR-009, RBD-2)
 *
 * Hard-delete a SYNTHETIC test user and everything hanging off the row so the
 * identity's next sign-in is a genuine first run. The namespace is the only
 * targeting grammar — no numeric ids, no wildcards outside it.
 *   - `{email}` matching isSyntheticEmail ⇒ deleteUserByEmail (idempotent no-op
 *     if absent).
 *   - `{all:true}` ⇒ delete ALL synthetic-namespace rows (harness cleanup).
 *   - any non-synthetic address ⇒ 400 refuse (never touches a real account).
 */
router.post('/dev-wipe-user', requireDevEndpoints, async (req, res) => {
  try {
    const { email, all } = req.body || {};

    if (all === true) {
      const count = await deleteAllSyntheticUsers();
      return res.json({ ok: true, wiped: count });
    }

    if (!isSyntheticEmail(email)) {
      return res.status(400).json({
        error: 'refused: target must be a synthetic test+<nonce>@test.local address',
      });
    }

    const { deleted, docCount } = await deleteUserByEmail(email);
    return res.json({ ok: true, deleted, docCount });
  } catch (error) {
    console.error('Dev wipe-user error:', error);
    res.status(500).json({ error: 'Dev wipe-user failed' });
  }
});

/**
 * POST /auth/dev-consent-approve  (NEW — FR-006, FR-007, RBD-1)
 *
 * Completes the /authorize Approve step for a SYNTHETIC session and mints the
 * agent's authorization code with no browser click. Synthetic-session-only: the
 * authenticated user's email MUST match the namespace, else 403. Reuses the real
 * approve core (oauth-flow.approveAuthorization) — no parallel mock.
 */
router.post('/dev-consent-approve', requireDevEndpoints, requireAuth, async (req, res) => {
  try {
    if (!isSyntheticEmail(req.user.email)) {
      return res.status(403).json({ error: 'auto-approve is synthetic-session-only' });
    }

    const {
      agent_client_id,
      agent_instance_id,
      scopes,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
    } = req.body || {};

    const result = await mcpOauthFlow.approveAuthorization({
      userId: req.user.userId,
      agent_client_id,
      agent_instance_id,
      scopes,
      redirect_uri,
      state,
      code_challenge,
      code_challenge_method,
    });

    if (!result.ok) {
      return res.status(result.status).json(result.body);
    }

    return res.json({ redirectUrl: result.redirectUrl, code: result.code });
  } catch (error) {
    console.error('Dev consent-approve error:', error);
    res.status(500).json({ error: 'Dev consent-approve failed' });
  }
});

/**
 * POST /auth/prod-reset-selftest-account  (NEW — FR-002, FR-010, RBD-4, D6)
 *
 * The ONE feature-029 endpoint reachable in production. Admin-gated (reuses the
 * existing requireAdmin, no new auth machinery — 008/009 lesson) and DELIBERATELY
 * not behind ENABLE_DEV_ENDPOINTS. Its entire target surface is the compile-time
 * constant PROD_RESET_ACCOUNT — NO request body is consulted for targeting, so a
 * parameter-handling bug cannot widen the blast radius (SC-005). Idempotent no-op
 * when the account is already reset.
 */
router.post('/prod-reset-selftest-account', requireAdmin, async (req, res) => {
  try {
    const { deleted, docCount } = await deleteUserByEmail(PROD_RESET_ACCOUNT);
    return res.json({ ok: true, account: PROD_RESET_ACCOUNT, deleted, docCount });
  } catch (error) {
    console.error('Prod reset self-test account error:', error);
    res.status(500).json({ error: 'Prod reset failed' });
  }
});

module.exports = router;
module.exports.isValidReturnTo = isValidReturnTo;
module.exports.PROD_RESET_ACCOUNT = PROD_RESET_ACCOUNT;





