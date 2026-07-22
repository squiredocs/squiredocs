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

/**
 * Feature 029: shared fail-closed gate for dev-only support endpoints.
 *
 * Two independent conditions, BOTH required (the 2b9d6be pattern, RBD-5):
 *   1. ENABLE_DEV_ENDPOINTS === '1' — the EXPLICIT positive opt-in that is the
 *      primary, required, fail-closed gate. Absent ⇒ off, independent of
 *      NODE_ENV. Set only in the minikube dev overlay and the test setup.
 *   2. NODE_ENV !== 'production' — belt-and-suspenders: even if the flag is ever
 *      set by accident in a prod-like env, production still blocks it.
 *
 * The invariant forbids the NODE_ENV negative as the SOLE gate (the 2026-07-21
 * incident: NODE_ENV was unset in prod, so negatively-gated routes were live);
 * it is kept here only as an ADDITIONAL guard on top of the positive flag.
 *
 * Evaluated per-request (not at module load) so the reachability tests can
 * toggle the environment between requests on a single app instance.
 *
 * @returns {boolean} true iff the synthetic dev endpoints may be reached.
 */
function devEndpointsEnabled() {
  return process.env.ENABLE_DEV_ENDPOINTS === '1' && process.env.NODE_ENV !== 'production';
}

/**
 * Express middleware guarding every synthetic dev-support endpoint (faucet
 * fresh/browser modes, synthetic wipe, consent auto-approve). Responds 404 when
 * the gate is closed so the endpoint is indistinguishable from a non-existent
 * route (no information leak that a dev surface exists). The prod single-account
 * reset does NOT use this — it is admin-gated and deliberately prod-reachable.
 */
function requireDevEndpoints(req, res, next) {
  if (!devEndpointsEnabled()) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireAdmin,
  requiredScopeForMethod,
  checkScopes,
  devEndpointsEnabled,
  requireDevEndpoints,
};
