/**
 * JWT utilities for access and refresh tokens
 */
const jwt = require('jsonwebtoken');

// Secrets from environment variables (with fallbacks for development only)
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev-access-secret-change-in-production';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'dev-refresh-secret-change-in-production';

// Token expiration times
const ACCESS_TOKEN_EXPIRY = '15m';  // 15 minutes
const REFRESH_TOKEN_EXPIRY = '7d';  // 7 days

// Cookie configuration
const isProduction = process.env.NODE_ENV === 'production';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProduction,  // Only send over HTTPS in production
  sameSite: isProduction ? 'strict' : 'lax',  // Strict in production for CSRF protection
  maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days in milliseconds
  path: '/',
};

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
  };
  
  return jwt.sign(payload, ACCESS_TOKEN_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
    issuer: 'collab-app',
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
  });
}

/**
 * Get cookie options for setting refresh token
 * @returns {object} Cookie configuration options
 */
function getCookieOptions() {
  return { ...COOKIE_OPTIONS };
}

/**
 * Get options for clearing refresh token cookie
 * @returns {object} Cookie configuration for clearing
 */
function getClearCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
    path: '/',
  };
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  getCookieOptions,
  getClearCookieOptions,
  ACCESS_TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY,
};



