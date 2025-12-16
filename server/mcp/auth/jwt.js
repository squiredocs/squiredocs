/**
 * Agent JWT utilities
 *
 * Generates and verifies JWT tokens for AI agents acting on behalf of users
 * via OAuth delegation.
 */
const jwt = require('jsonwebtoken');

// Secret for agent tokens (separate from user tokens)
const MCP_JWT_SECRET =
  process.env.MCP_JWT_SECRET || 'dev-mcp-secret-change-in-production';

// Agent token expiration (shorter than user tokens for security)
const AGENT_TOKEN_EXPIRY = '1h';

/**
 * Generate an agent access token from a delegation
 * @param {object} delegation - Delegation record from database
 * @returns {string} JWT agent token
 */
function generateAgentToken(delegation) {
  const payload = {
    delegationId: delegation.id,
    userId: delegation.user_id,
    agentId: delegation.agent_id,
    agentName: delegation.agent_name,
    scopes: delegation.scopes,
    isAgent: true,
  };

  return jwt.sign(payload, MCP_JWT_SECRET, {
    expiresIn: AGENT_TOKEN_EXPIRY,
    issuer: 'collab-app-mcp',
  });
}

/**
 * Verify and decode an agent token
 * @param {string} token - JWT agent token
 * @param {object} options - Verification options
 * @param {boolean} options.throwOnError - Whether to throw on error (default: true)
 * @returns {object|null} Decoded token payload, or null if invalid and throwOnError is false
 * @throws {Error} If token is invalid and throwOnError is true
 */
function verifyAgentToken(token, options = {}) {
  const { throwOnError = true } = options;

  try {
    return jwt.verify(token, MCP_JWT_SECRET, {
      issuer: 'collab-app-mcp',
    });
  } catch (error) {
    if (throwOnError) {
      throw error;
    }
    return null;
  }
}

/**
 * Extract agent token from various sources
 * @param {object} sources - Token sources
 * @param {string} sources.authHeader - Authorization header value
 * @param {string} sources.queryToken - Token from query parameter
 * @returns {string|null} Extracted token or null
 */
function extractAgentToken({ authHeader, queryToken }) {
  // Try Authorization header first
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      return parts[1];
    }
    // Invalid format
    return null;
  }

  // Fall back to query parameter
  if (queryToken) {
    return queryToken;
  }

  return null;
}

module.exports = {
  generateAgentToken,
  verifyAgentToken,
  extractAgentToken,
  AGENT_TOKEN_EXPIRY,
};
