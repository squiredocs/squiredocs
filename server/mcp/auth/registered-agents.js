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
 * Check if a URI is a localhost/loopback address
 */
function isLocalhostUri(uri) {
  try {
    const parsed = new URL(uri);
    const hostname = parsed.hostname;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
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

/**
 * Create or update a registered agent
 * Allows dynamic registration of new agents
 */
async function createOrUpdateAgent({
  id,
  name,
  description = null,
  icon_url = null,
  allowed_scopes = ['documents:read', 'documents:write'],
  default_scopes = ['documents:read'],
  allowed_redirect_uris = [],
  is_public_client = true,
}) {
  const result = await pool.query(
    `INSERT INTO registered_agents
     (id, name, description, icon_url, allowed_scopes, default_scopes, allowed_redirect_uris, is_public_client, is_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
     ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         description = COALESCE(EXCLUDED.description, registered_agents.description),
         icon_url = COALESCE(EXCLUDED.icon_url, registered_agents.icon_url),
         allowed_scopes = EXCLUDED.allowed_scopes,
         default_scopes = EXCLUDED.default_scopes,
         allowed_redirect_uris = EXCLUDED.allowed_redirect_uris,
         updated_at = NOW()
     RETURNING *`,
    [id, name, description, icon_url, allowed_scopes, default_scopes, allowed_redirect_uris, is_public_client]
  );
  return result.rows[0];
}

module.exports = {
  init,
  getRegisteredAgent,
  validateScopes,
  validateRedirectUri,
  isLocalhostUri,
  listRegisteredAgents,
  createOrUpdateAgent,
};
