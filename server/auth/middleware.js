/**
 * Authentication middleware
 *
 * Uses permissions.extractUser() for unified token extraction — supports
 * user JWTs, agent JWTs, and API tokens consistently across REST and WebSocket.
 */
const { extractUser } = require('../permissions');

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Scope required for an HTTP method: reads need documents:read,
 * anything mutating needs documents:write.
 */
function requiredScopeForMethod(method) {
  return READ_METHODS.includes(method) ? 'documents:read' : 'documents:write';
}

/**
 * Enforce token scopes for scoped principals (API tokens and agent JWTs
 * carry a scopes array; browser session JWTs do not and get full access).
 * Returns null when allowed, or a 403 payload matching the MCP
 * requireScope error shape when the required scope is missing.
 */
function checkScopes(user, method) {
  if (!Array.isArray(user.scopes)) {
    return null;
  }
  const required = requiredScopeForMethod(method);
  if (user.scopes.includes(required)) {
    return null;
  }
  return {
    error: 'Insufficient scope',
    code: 'INSUFFICIENT_SCOPE',
    required,
    granted: user.scopes,
    // Tokens minted via the MCP create_access_token tool default to
    // documents:read, so a write-scoped 403 is a likely first failure for an
    // agent following the import recipe — name the remedy, not just the gap.
    hint: `This token lacks ${required}. Mint a new token with that scope — e.g. the MCP tool create_access_token({ scopes: ["documents:read", "documents:write"] }) — or use a personal token from Settings → API Tokens.`,
  };
}

/**
 * Middleware to require authentication
 * Verifies token from Authorization header (user JWT, agent JWT, or API token)
 * Adds decoded user to req.user on success. Scoped tokens (API tokens, agent
 * JWTs) additionally need documents:read for reads / documents:write for
 * mutations.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }

  const user = await extractUser({ authHeader });
  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const scopeError = checkScopes(user, req.method);
  if (scopeError) {
    return res.status(403).json(scopeError);
  }

  req.user = user;
  next();
}

/**
 * Optional authentication middleware
 * Works with or without auth - adds req.user if valid token present
 * Does not return error if no token or invalid token
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return next();
  }

  const user = await extractUser({ authHeader });
  if (user) {
    req.user = user;
  }

  next();
}

/**
 * Middleware to require admin access
 * Composes with requireAuth, then verifies admin status against the database
 */
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (res.headersSent) return;

    // Fast reject from JWT claim
    if (!req.user || !req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Defense in depth: verify against DB
    const { findById } = require('./users');
    findById(req.user.userId)
      .then((dbUser) => {
        if (!dbUser || !dbUser.is_admin) {
          return res.status(403).json({ error: 'Admin access required' });
        }
        next();
      })
      .catch((error) => {
        console.error('Admin middleware DB check error:', error);
        res.status(500).json({ error: 'Internal server error' });
      });
  });
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireAdmin,
  requiredScopeForMethod,
  checkScopes,
};
