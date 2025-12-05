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
  getClearCookieOptions,
} = require('./jwt');
const { findOrCreateUser, findById, incrementTokenVersion, getTokenVersion } = require('./users');
const { requireAuth } = require('./middleware');

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
    
    // Generate application tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);
    
    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', refreshToken, getCookieOptions());
    
    // Redirect to client with access token in URL
    // Access token in URL is safe because:
    // 1. It's short-lived (15 minutes)
    // 2. Client immediately clears it from URL history
    // 3. HTTPS encrypts the URL in transit
    res.redirect(`${clientUrl}?accessToken=${encodeURIComponent(accessToken)}`);
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
      res.clearCookie('refreshToken', getClearCookieOptions());
      return res.status(401).json({ error: 'Token revoked' });
    }
    
    // Generate new tokens (token rotation)
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);
    
    // Set new refresh token cookie
    res.cookie('refreshToken', newRefreshToken, getCookieOptions());
    
    // Return new access token
    res.json({ accessToken: newAccessToken });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      res.clearCookie('refreshToken', getClearCookieOptions());
      return res.status(401).json({ error: 'Refresh token expired' });
    }
    if (error.name === 'JsonWebTokenError') {
      res.clearCookie('refreshToken', getClearCookieOptions());
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
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user profile' });
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
    
    // Clear refresh token cookie
    res.clearCookie('refreshToken', getClearCookieOptions());
    
    res.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    // Still clear the cookie even if DB update fails
    res.clearCookie('refreshToken', getClearCookieOptions());
    res.status(500).json({ error: 'Logout failed' });
  }
});

module.exports = router;

