/**
 * Authentication routes
 */
const express = require('express');
const { generateAuthUrl, exchangeCodeForTokens, verifyIdToken } = require('./google');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  getCookieOptions,
  getAccessTokenCookieOptions,
  clearAuthCookies,
  getJwtErrorResponse,
} = require('./jwt');
const { findOrCreateUser, findById, incrementTokenVersion, getTokenVersion, updateName, updateLastLogin } = require('./users');
const { requireAuth } = require('./middleware');
const { notifyNewUser, notifyLogin } = require('../email');

const router = express.Router();

// Fallback client URL for redirects (configurable via env)
const DEFAULT_CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

/**
 * Get the client URL from request origin or referer, falling back to env config
 */
function getClientUrl(req) {
  // Use origin header if available
  if (req.headers.origin) {
    return req.headers.origin;
  }
  // Try referer header
  if (req.headers.referer) {
    try {
      const url = new URL(req.headers.referer);
      return `${url.protocol}//${url.host}`;
    } catch (e) {
      // Invalid referer, fall through
    }
  }
  // Fall back to env config
  return DEFAULT_CLIENT_URL;
}

/**
 * GET /auth/google
 * Initiates Google OAuth flow by redirecting to Google's consent screen
 */
router.get('/google', (req, res) => {
  try {
    // Store the client URL in a cookie so we can redirect back after OAuth
    const clientUrl = getClientUrl(req);
    res.cookie('oauth_redirect', clientUrl, { 
      httpOnly: true, 
      maxAge: 5 * 60 * 1000, // 5 minutes
      sameSite: 'lax'
    });
    
    const authUrl = generateAuthUrl();
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
  const { code, error } = req.query;
  
  // Get the client URL from the cookie we set, or fall back to default
  const clientUrl = req.cookies?.oauth_redirect || DEFAULT_CLIENT_URL;
  // Clear the oauth redirect cookie
  res.clearCookie('oauth_redirect');
  
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

    // Redirect to client (token is in cookie, not URL)
    res.redirect(`${clientUrl}/docs?signup=1`);
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
    
    // Generate new tokens (token rotation)
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
    
    // Return user profile (exclude sensitive fields)
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      isAdmin: !!user.is_admin,
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
router.post('/dev-login', async (req, res) => {
  // Only allow in development mode
  if (process.env.NODE_ENV !== 'development') {
    return res.status(403).json({ error: 'Dev login only available in development mode' });
  }

  try {
    // Create or find test user
    const testUserProfile = {
      googleId: 'dev-test-user',
      email: 'dev@test.local',
      name: 'Dev Test User',
      picture: null,
    };

    const user = await findOrCreateUser(testUserProfile);

    // Record last login timestamp
    await updateLastLogin(user.id);

    // Generate application tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // Set tokens as httpOnly cookies
    res.cookie('accessToken', accessToken, getAccessTokenCookieOptions());
    res.cookie('refreshToken', refreshToken, getCookieOptions());

    // Return access token (for REST API Authorization header)
    res.json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
      }
    });
  } catch (error) {
    console.error('Dev login error:', error);
    res.status(500).json({ error: 'Dev login failed' });
  }
});

module.exports = router;





