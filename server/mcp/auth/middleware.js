/**
 * MCP Authentication Middleware
 *
 * Middleware for authenticating and authorizing AI agents.
 */
const { verifyAgentToken, extractAgentToken } = require('./jwt');

/**
 * Middleware to require agent authentication
 * Extracts and verifies agent JWT from Authorization header or query parameter.
 * Sets req.agentToken with decoded token payload on success.
 */
function requireAgentAuth(req, res, next) {
  const token = extractAgentToken({
    authHeader: req.headers.authorization,
    queryToken: req.query?.token,
  });

  if (!token) {
    return res.status(401).json({
      error: 'No agent token provided',
      code: 'MISSING_TOKEN',
    });
  }

  try {
    const decoded = verifyAgentToken(token);
    // Include the raw token string for use in WebSocket connections
    req.agentToken = { ...decoded, rawToken: token };
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Agent token expired',
        code: 'TOKEN_EXPIRED',
      });
    }

    return res.status(401).json({
      error: 'Invalid agent token',
      code: 'INVALID_TOKEN',
    });
  }
}

/**
 * Middleware factory to require a specific scope
 * @param {string|string[]} requiredScopes - Required scope(s). If array, agent needs at least one.
 * @returns {Function} Express middleware
 */
function requireScope(requiredScopes) {
  const scopes = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];

  return (req, res, next) => {
    // Check if agent is authenticated
    if (!req.agentToken) {
      return res.status(401).json({
        error: 'Agent authentication required',
        code: 'NOT_AUTHENTICATED',
      });
    }

    const agentScopes = req.agentToken.scopes || [];

    // Check if agent has any of the required scopes
    const hasScope = scopes.some((scope) => agentScopes.includes(scope));

    if (!hasScope) {
      return res.status(403).json({
        error: 'Insufficient scope',
        code: 'INSUFFICIENT_SCOPE',
        required: scopes.length === 1 ? scopes[0] : scopes,
        granted: agentScopes,
      });
    }

    next();
  };
}

/**
 * Optional agent authentication middleware
 * Sets req.agentToken if valid token provided, otherwise continues without error.
 */
function optionalAgentAuth(req, res, next) {
  const token = extractAgentToken({
    authHeader: req.headers.authorization,
    queryToken: req.query?.token,
  });

  if (token) {
    const decoded = verifyAgentToken(token, { throwOnError: false });
    if (decoded) {
      // Include the raw token string for use in WebSocket connections
      req.agentToken = { ...decoded, rawToken: token };
    }
  }

  next();
}

module.exports = {
  requireAgentAuth,
  requireScope,
  optionalAgentAuth,
};
