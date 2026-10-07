/**
 * JWT utilities for access and refresh tokens
 */
const jwt = require('jsonwebtoken');
const { getInstanceConfig } = require('../instance-config');

// Secrets from environment variables (with fallbacks for development only)
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev-access-secret-change-in-production';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'dev-refresh-secret-change-in-production';

if (process.env.NODE_ENV === 'production') {
  if (!process.env.ACCESS_TOKEN_SECRET || process.env.ACCESS_TOKEN_SECRET === 'dev-access-secret-change-in-production') {
    throw new Error('FATAL: ACCESS_TOKEN_SECRET must be set to a strong secret in production');
  }
  if (!process.env.REFRESH_TOKEN_SECRET || process.env.REFRESH_TOKEN_SECRET === 'dev-refresh-secret-change-in-production') {
    throw new Error('FATAL: REFRESH_TOKEN_SECRET must be set to a strong secret in production');
  }
}

// Test mode for rapid token expiry (useful for testing stale tab scenarios)
// Usage: AUTH_TEST_MODE=true npm run server
const AUTH_TEST_MODE = process.env.AUTH_TEST_MODE === 'true';

// Token expiration times
const ACCESS_TOKEN_EXPIRY = AUTH_TEST_MODE ? '30s' : '15m';   // 30 seconds in test mode, 15 minutes normally
const REFRESH_TOKEN_EXPIRY = AUTH_TEST_MODE ? '2m' : '7d';   // 2 minutes in test mode, 7 days normally

if (AUTH_TEST_MODE) {
  console.log('[JWT] AUTH_TEST_MODE enabled - using short token expiry (access: 30s, refresh: 2m)');
}

// Cookie configuration.
// Feature 058 (FR-011): `Secure` follows APP_URL's scheme, not NODE_ENV, so a
// plain-http local instance in production mode can still sign in and an https
// deployment always gets Secure cookies. SameSite keeps its NODE_ENV rule
// (strict in production for CSRF protection). Both are read at call time.
function cookieBase() {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: getInstanceConfig().cookieSecure,
    sameSite: isProduction ? 'strict' : 'lax',
    path: '/',
  };
}

// Refresh token cookie lifetime (long-lived)
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// Access token cookie lifetime (short-lived, matches token expiry)
const ACCESS_COOKIE_MAX_AGE = AUTH_TEST_MODE ? 30 * 1000 : 15 * 60 * 1000;

/**
 * Generate access token with user claims
 * @param {object} user - User object from database
 * @returns {string} JWT access token
 */
function generateAccessToken(user) {
  const payload = {
    userId: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    isAdmin: !!user.is_admin,
  };
  
  return jwt.sign(payload, ACCESS_TOKEN_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
    issuer: 'collab-app',
    audience: 'collab-app',
  });
}

/**
 * Generate refresh token with user ID and token version
 * @param {object} user - User object from database
 * @returns {string} JWT refresh token
 */
function generateRefreshToken(user) {
  const payload = {
    userId: user.id,
    tokenVersion: user.token_version,
  };

  return jwt.sign(payload, REFRESH_TOKEN_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
    issuer: 'collab-app',
    audience: 'collab-app',
  });
}

/**
 * Verify and decode access token
 * @param {string} token - JWT access token
 * @returns {object} Decoded token payload
 * @throws {Error} If token is invalid or expired
 */
function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_TOKEN_SECRET, {
    issuer: 'collab-app',
    audience: 'collab-app',
    algorithms: ['HS256'],
  });
}

/**
 * Verify and decode refresh token
 * @param {string} token - JWT refresh token
 * @returns {object} Decoded token payload
 * @throws {Error} If token is invalid or expired
 */
function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_TOKEN_SECRET, {
    issuer: 'collab-app',
    audience: 'collab-app',
    algorithms: ['HS256'],
  });
}

/**
 * Get cookie options for setting refresh token
 * @returns {object} Cookie configuration options
 */
function getCookieOptions() {
  return { ...cookieBase(), maxAge: REFRESH_COOKIE_MAX_AGE };
}

/**
 * Get cookie options for setting access token
 * @returns {object} Cookie configuration options
 */
function getAccessTokenCookieOptions() {
  return { ...cookieBase(), maxAge: ACCESS_COOKIE_MAX_AGE };
}

/**
 * Get options for clearing refresh token cookie
 * @returns {object} Cookie configuration for clearing
 */
function getClearCookieOptions() {
  return cookieBase();
}

/**
 * Clear all auth cookies from response
 * @param {object} res - Express response object
 */
function clearAuthCookies(res) {
  res.clearCookie('accessToken', getClearCookieOptions());
  res.clearCookie('refreshToken', getClearCookieOptions());
}

/**
 * Extract Bearer token from Authorization header
 * @param {string} authHeader - Authorization header value
 * @returns {string|null} Token string or null if invalid format
 */
function extractBearerToken(authHeader) {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0] === 'Bearer') {
    return parts[1];
  }
  return null;
}

/**
 * Parse cookies from a cookie header string
 * Useful for WebSocket upgrade requests where cookie-parser middleware doesn't run
 * @param {string} cookieHeader - Cookie header value
 * @returns {object} Parsed cookies as key-value pairs
 */
function parseCookies(cookieHeader) {
  const cookies = {};
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.trim().split('=');
      cookies[name] = rest.join('=');
    });
  }
  return cookies;
}

/**
 * Get JWT error response details
 * @param {Error} error - JWT verification error
 * @returns {{status: number, body: object}} Status code and response body
 */
function getJwtErrorResponse(error) {
  if (error.name === 'TokenExpiredError') {
    return { status: 401, body: { error: 'Token expired', code: 'TOKEN_EXPIRED' } };
  }
  if (error.name === 'JsonWebTokenError') {
    return { status: 401, body: { error: 'Invalid token' } };
  }
  return { status: 401, body: { error: 'Authentication failed' } };
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  getCookieOptions,
  getAccessTokenCookieOptions,
  getClearCookieOptions,
  clearAuthCookies,
  extractBearerToken,
  parseCookies,
  getJwtErrorResponse,
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY,
};




