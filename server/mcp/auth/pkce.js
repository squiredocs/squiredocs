/**
 * PKCE (Proof Key for Code Exchange) utilities
 *
 * Implements RFC 7636 for public clients.
 */
const crypto = require('crypto');

/**
 * Validate PKCE code verifier against stored challenge
 */
function validateCodeVerifier(codeVerifier, codeChallenge, method = 'S256') {
  if (method !== 'S256') {
    return { valid: false, error: 'Only S256 method is supported' };
  }

  // code_verifier must be 43-128 characters
  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) {
    return { valid: false, error: 'Invalid code_verifier length' };
  }

  // Calculate expected challenge
  const expectedChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  if (expectedChallenge !== codeChallenge) {
    return { valid: false, error: 'code_verifier does not match code_challenge' };
  }

  return { valid: true };
}

/**
 * Validate code challenge format
 */
function validateCodeChallenge(codeChallenge) {
  // Base64url encoded SHA-256 hash is 43 characters
  if (!codeChallenge || codeChallenge.length !== 43) {
    return { valid: false, error: 'Invalid code_challenge format' };
  }

  // Must be valid base64url
  if (!/^[A-Za-z0-9_-]+$/.test(codeChallenge)) {
    return { valid: false, error: 'code_challenge must be base64url encoded' };
  }

  return { valid: true };
}

/**
 * Generate a secure random state parameter
 */
function generateState() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate authorization code
 */
function generateAuthCode() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Hash authorization code for storage
 */
function hashAuthCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

module.exports = {
  validateCodeVerifier,
  validateCodeChallenge,
  generateState,
  generateAuthCode,
  hashAuthCode,
};
