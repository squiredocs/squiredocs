/**
 * Registered Agents Management
 *
 * Manages the allowlist of AI agents that can request authorization.
 */

let pool = null;

function init(dbPool) {
  pool = dbPool;
}

/**
 * Get a registered agent by client ID
 */
async function getRegisteredAgent(clientId) {
  const result = await pool.query(
    `SELECT * FROM registered_agents
     WHERE id = $1 AND is_enabled = true`,
    [clientId]
  );
  return result.rows[0] || null;
}

/**
 * Validate requested scopes against agent's allowed scopes
 */
function validateScopes(agent, requestedScopes) {
  const requested = Array.isArray(requestedScopes)
    ? requestedScopes
    : requestedScopes.split(' ').filter(Boolean);

  const invalid = requested.filter(s => !agent.allowed_scopes.includes(s));

  if (invalid.length > 0) {
    return {
      valid: false,
      error: `Invalid scopes: ${invalid.join(', ')}`,
      allowedScopes: agent.allowed_scopes,
    };
  }

  return { valid: true, scopes: requested };
}

/**
 * Validate redirect URI against agent's allowed patterns
 */
function validateRedirectUri(agent, redirectUri) {
  const patterns = agent.allowed_redirect_uris;

  for (const pattern of patterns) {
    if (matchUriPattern(pattern, redirectUri)) {
      return { valid: true };
    }
  }

  return {
    valid: false,
    error: 'redirect_uri not allowed for this agent',
  };
}

/**
 * Match URI against pattern (supports * wildcards)
 */
function matchUriPattern(pattern, uri) {
  // Convert pattern to regex
  // http://localhost:* -> http://localhost:\d+
  // vscode://anthropic.claude-code/* -> vscode://anthropic\.claude-code/.*
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape special chars
    .replace(/\*/g, '.*');                    // * -> .*

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(uri);
}

/**
 * Get all enabled registered agents (for admin UI)
 */
async function listRegisteredAgents() {
  const result = await pool.query(
    `SELECT id, name, description, icon_url, allowed_scopes, default_scopes, is_public_client
     FROM registered_agents
     WHERE is_enabled = true
     ORDER BY name`
  );
  return result.rows;
}

module.exports = {
  init,
  getRegisteredAgent,
  validateScopes,
  validateRedirectUri,
  listRegisteredAgents,
};
