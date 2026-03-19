/**
 * Authentication middleware
 */
const { verifyAccessToken, extractBearerToken, getJwtErrorResponse } = require('./jwt');

/**
 * Middleware to require authentication
 * Verifies Bearer token from Authorization header
 * Adds decoded user to req.user on success
 */
function requireAuth(req, res, next) {
  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    return res.status(401).json({ error: 'No authorization header or invalid format' });
  }

  try {
    const decoded = verifyAccessToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    const { status, body } = getJwtErrorResponse(error);
    if (error.name !== 'TokenExpiredError' && error.name !== 'JsonWebTokenError') {
      console.error('Auth middleware error:', error);
    }
    return res.status(status).json(body);
  }
}

/**
 * Optional authentication middleware
 * Works with or without auth - adds req.user if valid token present
 * Does not return error if no token or invalid token
 */
function optionalAuth(req, res, next) {
  const token = extractBearerToken(req.headers.authorization);

  if (!token) {
    return next();
  }

  try {
    const decoded = verifyAccessToken(token);
    req.user = decoded;
  } catch (error) {
    // Silently ignore auth errors for optional routes
  }

  next();
}

/**
 * Middleware to require admin access
 * Composes with requireAuth, then verifies admin status against the database
 */
function requireAdmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (res.headersSent) return; // requireAuth already sent a response

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




