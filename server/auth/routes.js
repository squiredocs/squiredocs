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
const { findOrCreateUser, findById, incrementTokenVersion, updateName, updateLastLogin } = require('./users');
const { requireAuth } = require('./middleware');
const { notifyNewUser, notifyLogin } = require('../email');
const onboarding = require('../onboarding');

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

    // Create or update user in database
    const user = await findOrCreateUser(profile);

    if (user.isNew) {
      notifyNewUser({ email: user.email, name: user.name });
    }
    notifyLogin({ email: user.email, name: user.name });

    // Record last login timestamp
    await updateLastLogin(user.id);

    // Generate application tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);
    
    // Set tokens as httpOnly cookies
    res.cookie('accessToken', accessToken, getAccessTokenCookieOptions());
    res.cookie('refreshToken', refreshToken, getCookieOptions());

    // Feature 005-agent-onboarding: consent login round-trip. If the outbound
    // /auth/google leg captured a same-origin returnTo, honor it here and take
    // precedence over the onboarding destination (FR-011). Captured and
    // cleared above; re-validated before use.
    if (isValidReturnTo(rawReturnTo)) {
      return res.redirect(`${clientUrl}${rawReturnTo}`);
    }

    // Onboarding: not-yet-engaged users land on their seeded welcome doc with
    // the assistant primed to greet them; everyone else goes to their doc list.
    let redirectPath = '/docs?signup=1';
    try {
      const { welcomeDocId, onboarded } = await onboarding.resolveOnboarding(user, { seed: true });
      if (!onboarded && welcomeDocId) {
        redirectPath = `/d/${welcomeDocId}?welcome=1`;
      }
    } catch (e) {
      console.error('Onboarding resolve failed:', e);
    }

    // Redirect to client (token is in cookie, not URL)
    res.redirect(`${clientUrl}${redirectPath}`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.redirect(`${clientUrl}/login?error=auth_failed`);
  }
});

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

/**
 * POST /auth/dev-login
 * Development-only endpoint that bypasses OAuth and creates/logs in a test user
 * Only works when NODE_ENV=development
 */
if (process.env.NODE_ENV !== 'production') {
  router.post('/dev-login', async (req, res) => {
    try {
      const testUserProfile = {
        googleId: 'dev-test-user',
        email: 'dev@test.local',
        name: 'Dev Test User',
        picture: null,
      };

      const user = await findOrCreateUser(testUserProfile);
      await updateLastLogin(user.id);

      const accessToken = generateAccessToken(user);
      const refreshToken = generateRefreshToken(user);

      res.cookie('accessToken', accessToken, getAccessTokenCookieOptions());
      res.cookie('refreshToken', refreshToken, getCookieOptions());

      // Mirror the OAuth onboarding resolution so dev-bypass exercises the flow.
      let welcomeDocId = null;
      let onboarded = true;
      try {
        ({ welcomeDocId, onboarded } = await onboarding.resolveOnboarding(user, { seed: true }));
      } catch (e) {
        console.error('Onboarding resolve failed (dev-login):', e);
      }

      res.json({
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
        }
      });
    } catch (error) {
      console.error('Dev login error:', error);
      res.status(500).json({ error: 'Dev login failed' });
    }
  });

  /**
   * POST /auth/dev-onboarding-reset
   * Development-only: reset the current user's onboarding state and reseed a
   * fresh welcome doc, so the welcome flow can be re-triggered on demand (even
   * for an already-engaged user). Returns the welcome doc URL to open.
   */
  router.post('/dev-onboarding-reset', requireAuth, async (req, res) => {
    try {
      const welcomeDocId = await onboarding.resetForDev(req.user.userId);
      res.json({ welcomeDocId, url: `/d/${welcomeDocId}?welcome=1` });
    } catch (error) {
      console.error('Dev onboarding reset error:', error);
      res.status(500).json({ error: 'Dev onboarding reset failed' });
    }
  });
}

module.exports = router;
module.exports.isValidReturnTo = isValidReturnTo;





