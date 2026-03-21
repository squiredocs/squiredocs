/**
 * Authentication middleware
 *
 * Uses permissions.extractUser() for unified token extraction — supports
 * user JWTs, agent JWTs, and API tokens consistently across REST and WebSocket.
 */
const { extractUser } = require('../permissions');

/**
 * Middleware to require authentication
 * Verifies token from Authorization header (user JWT, agent JWT, or API token)
 * Adds decoded user to req.user on success
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
};
