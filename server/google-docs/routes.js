/**
 * Google Drive OAuth routes
 *
 * Handles the incremental OAuth flow for connecting a user's Google Drive.
 * Uses a dedicated callback URI separate from the login OAuth flow to prevent
 * confused-flow attacks.
 *
 * Security:
 * - CSRF state cookie (drive_oauth_state) separate from login state
 * - Identity verification: id_token sub must match logged-in user's googleId
 * - requireCookieAuth: user must be logged in (via cookie, since these are browser redirects)
 */
const crypto = require('crypto');
const express = require('express');
const { verifyAccessToken } = require('../auth/jwt');
const { findById } = require('../auth/users');
const {
  generateDriveAuthUrl,
  exchangeDriveCode,
  verifyDriveIdToken,
  storeTokens,
} = require('./google-auth');

const router = express.Router();

let pool = null;

function init(dbPool) {
  pool = dbPool;
}

/**
 * Middleware: require authentication via cookie.
 * Browser-initiated OAuth redirects carry auth in cookies, not Authorization headers.
 */
function requireCookieAuth(req, res, next) {
  const token = req.cookies?.accessToken;
  if (!token) {
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    return res.redirect(`${clientUrl}/login?error=not_authenticated`);
  }

  try {
    const user = verifyAccessToken(token);
    req.user = user;
    next();
  } catch (e) {
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    return res.redirect(`${clientUrl}/login?error=session_expired`);
  }
}

/**
 * GET /auth/google/drive
 * Initiates Google Drive OAuth flow.
 * User must be logged in (cookie auth).
 */
router.get('/drive', requireCookieAuth, (req, res) => {
  try {
    const isProduction = process.env.NODE_ENV === 'production';

    // CSRF state in a dedicated cookie (separate from login flow)
    const state = crypto.randomBytes(32).toString('hex');
    res.cookie('drive_oauth_state', state, {
      httpOnly: true,
      maxAge: 5 * 60 * 1000,
      sameSite: 'lax',
      secure: isProduction,
    });

    const authUrl = generateDriveAuthUrl(state, req.user.email);
    res.redirect(authUrl);
  } catch (error) {
    console.error('[google-drive] Error generating auth URL:', error);
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    res.redirect(`${clientUrl}/settings?drive=error&reason=config`);
  }
});

/**
 * GET /auth/google/drive-callback
 * Handles the OAuth callback from Google for Drive scope.
 * Verifies identity, stores encrypted tokens, redirects to settings.
 */
router.get('/drive-callback', requireCookieAuth, async (req, res) => {
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const { code, error, state } = req.query;

  // Verify CSRF state
  const storedState = req.cookies?.drive_oauth_state;
  res.clearCookie('drive_oauth_state');

  if (!storedState || storedState !== state) {
    return res.redirect(`${clientUrl}/settings?drive=error&reason=invalid_state`);
  }

  if (error) {
    console.error('[google-drive] OAuth error:', error);
    return res.redirect(
      `${clientUrl}/settings?drive=error&reason=${encodeURIComponent(error)}`
    );
  }

  if (!code) {
    return res.redirect(`${clientUrl}/settings?drive=error&reason=no_code`);
  }

  try {
    // Exchange code for tokens
    const tokens = await exchangeDriveCode(code);

    if (!tokens.refresh_token) {
      throw new Error('No refresh token received. User may need to revoke and reconnect.');
    }

    if (!tokens.id_token) {
      throw new Error('No ID token received from Google');
    }

    // Identity check: verify the Google account matches the logged-in user.
    // The JWT doesn't include googleId, so look up from DB.
    const { sub, email } = await verifyDriveIdToken(tokens.id_token);
    const dbUser = await findById(req.user.userId);
    if (!dbUser || sub !== dbUser.google_id) {
      console.error(
        `[google-drive] Identity mismatch: logged in as ${dbUser?.google_id}, ` +
          `but authorized Google account ${sub} (${email})`
      );
      return res.redirect(
        `${clientUrl}/settings?drive=error&reason=account_mismatch`
      );
    }

    // Store encrypted tokens
    await storeTokens(pool, req.user.userId, tokens.refresh_token, email);

    res.redirect(`${clientUrl}/settings?drive=connected`);
  } catch (error) {
    console.error('[google-drive] Callback error:', error);
    res.redirect(`${clientUrl}/settings?drive=error&reason=auth_failed`);
  }
});

module.exports = { router, init };
