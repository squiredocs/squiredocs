/**
 * MCP Authentication Middleware
 *
 * Middleware for authenticating and authorizing AI agents.
 */
const { verifyAgentToken, extractAgentToken } = require('./jwt');
const apiTokens = require('./api-tokens');

/**
 * Try to authenticate via API token (sk_sqd_ prefix, or legacy sqd_)
 * @param {string} token - Raw token string
 * @returns {object|null} agentToken-shaped object or null
 */
async function tryApiToken(token) {
  if (!apiTokens.isApiToken(token)) return null;
  const record = await apiTokens.verifyToken(token);
  if (!record) return null;
  return {
    userId: record.user_id,
    agentId: `api-token:${record.id}`,
    agentName: record.name,
    scopes: record.scopes,
    isAgent: true,
    rawToken: token,
    apiTokenId: record.id,
  };
}

/**
 * Middleware to require agent authentication
 * Extracts and verifies agent JWT from Authorization header or query parameter.
 * Falls back to API token (sk_sqd_/legacy sqd_) verification if JWT fails.
 * Sets req.agentToken with decoded token payload on success.
 */
async function requireAgentAuth(req, res, next) {
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

  // Try JWT verification first
  try {
    const decoded = verifyAgentToken(token);
    // Include the raw token string for use in WebSocket connections
    req.agentToken = { ...decoded, rawToken: token };
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Agent token expired',
        code: 'TOKEN_EXPIRED',
      });
    }

    // JWT failed — try API token fallback
    try {
      const apiToken = await tryApiToken(token);
      if (apiToken) {
        req.agentToken = apiToken;
        return next();
      }
    } catch (apiErr) {
      // API token lookup failed, fall through to 401
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
async function optionalAgentAuth(req, res, next) {
  const token = extractAgentToken({
    authHeader: req.headers.authorization,
    queryToken: req.query?.token,
  });

  if (token) {
    const decoded = verifyAgentToken(token, { throwOnError: false });
    if (decoded) {
      // Include the raw token string for use in WebSocket connections
      req.agentToken = { ...decoded, rawToken: token };
    } else {
      // Try API token fallback
      try {
        const apiToken = await tryApiToken(token);
        if (apiToken) {
          req.agentToken = apiToken;
        }
      } catch (err) {
        // Ignore errors in optional auth
      }
    }
  }

  next();
}

module.exports = {
  requireAgentAuth,
  requireScope,
  optionalAgentAuth,
};
