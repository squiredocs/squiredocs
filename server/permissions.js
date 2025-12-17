/**
 * Centralized permission enforcement
 * All permission checks should go through this module
 */

const documents = require('./documents');
const { verifyAccessToken } = require('./auth/jwt');
const { verifyAgentToken } = require('./mcp/auth/jwt');

/**
 * Permission levels required for different actions
 */
const REQUIRED_ROLES = {
  view: 'viewer',
  edit: 'editor',
  share: 'viewer',  // Anyone with access can share
  manage: 'editor', // Change roles, remove access (editors and owners)
  delete: 'owner',  // Only owner can delete
};

/**
 * Extract and verify JWT from various sources
 * @param {object} options - Token sources
 * @param {string} options.authHeader - Authorization header
 * @param {string} options.token - Direct token
 * @param {string} options.queryToken - Token from query string
 * @returns {object|null} Decoded user or null
 */
function extractUser({ authHeader, token, queryToken }) {
  /**
   * Helper to try verifying a token as both user and agent token
   * @param {string} tokenString - JWT token string
   * @returns {object|null} Decoded token or null
   */
  const tryVerifyToken = (tokenString) => {
    // Try as regular user token first
    try {
      return verifyAccessToken(tokenString);
    } catch (e) {
      // Not a valid user token, try as agent token
      try {
        return verifyAgentToken(tokenString);
      } catch (e2) {
        // Not a valid agent token either
        return null;
      }
    }
  };

  // Try Authorization header first
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      const result = tryVerifyToken(parts[1]);
      if (result) return result;
    }
  }

  // Try direct token
  if (token) {
    const result = tryVerifyToken(token);
    if (result) return result;
  }

  // Try query string token
  if (queryToken) {
    const result = tryVerifyToken(queryToken);
    if (result) return result;
  }

  return null;
}

/**
 * Check if a user can perform an action on a document
 * @param {string} userId - User UUID
 * @param {string} docId - Document UUID
 * @param {string} action - Action to perform (view, edit, share, manage)
 * @returns {Promise<{allowed: boolean, role: string|null, reason?: string}>}
 */
async function checkPermission(userId, docId, action) {
  if (!userId) {
    return { allowed: false, role: null, reason: 'Not authenticated' };
  }

  const requiredRole = REQUIRED_ROLES[action];
  if (!requiredRole) {
    return { allowed: false, role: null, reason: `Unknown action: ${action}` };
  }

  const role = await documents.getRole(docId, userId);
  if (!role) {
    return { allowed: false, role: null, reason: 'No access to document' };
  }

  const hasPermission = documents.ROLES[role] >= documents.ROLES[requiredRole];
  
  return {
    allowed: hasPermission,
    role,
    reason: hasPermission ? undefined : `Requires ${requiredRole} role, you have ${role}`,
  };
}

/**
 * Quick check methods
 */
const can = {
  view: (userId, docId) => checkPermission(userId, docId, 'view'),
  edit: (userId, docId) => checkPermission(userId, docId, 'edit'),
  share: (userId, docId) => checkPermission(userId, docId, 'share'),
  manage: (userId, docId) => checkPermission(userId, docId, 'manage'),
  delete: (userId, docId) => checkPermission(userId, docId, 'delete'),
};

module.exports = {
  REQUIRED_ROLES,
  extractUser,
  checkPermission,
  can,
};
