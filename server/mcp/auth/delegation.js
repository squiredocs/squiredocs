/**
 * Agent Delegation Module
 *
 * Manages OAuth-style delegations allowing AI agents to act on behalf of users.
 * Agents inherit the user's permissions but actions are tracked separately.
 */

// Database pool - set by init function
let pool = null;

/**
 * Initialize the delegation module with a database pool
 * @param {Pool} dbPool - PostgreSQL connection pool
 */
function init(dbPool) {
  pool = dbPool;
}

/**
 * Create or update an agent delegation
 * @param {string} userId - UUID of the delegating user
 * @param {string} agentId - Unique agent identifier (e.g., "claude-code:abc123")
 * @param {string} agentName - Human-readable agent name
 * @param {object} options - Optional settings
 * @param {string[]} options.scopes - Permission scopes (default: ['documents:read', 'documents:write'])
 * @param {Date} options.expiresAt - Expiration time (default: null, no expiration)
 * @param {object} options.metadata - Additional agent metadata
 * @param {object} options.client - Optional pg client to run on (for a caller-managed
 *   transaction — e.g. the MCP login approval, which must create the delegation and
 *   flip the pending authorization to approved atomically). Defaults to the module pool.
 * @returns {Promise<object>} The created or updated delegation record
 */
async function createDelegation(userId, agentId, agentName, options = {}) {
  if (!pool) throw new Error('Delegation module not initialized');

  const {
    scopes = ['documents:read', 'documents:write'],
    expiresAt = null,
    metadata = {},
    client = null,
  } = options;

  const executor = client || pool;
  const result = await executor.query(
    `INSERT INTO agent_delegations (user_id, agent_id, agent_name, scopes, expires_at, agent_metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, agent_id) DO UPDATE SET
       agent_name = EXCLUDED.agent_name,
       scopes = EXCLUDED.scopes,
       expires_at = EXCLUDED.expires_at,
       agent_metadata = EXCLUDED.agent_metadata,
       revoked_at = NULL
     RETURNING *`,
    [userId, agentId, agentName, scopes, expiresAt, metadata]
  );

  return result.rows[0];
}

/**
 * Get a delegation by ID
 * @param {string} delegationId - UUID of the delegation
 * @returns {Promise<object|null>} Delegation record or null
 */
async function getDelegation(delegationId) {
  if (!pool) throw new Error('Delegation module not initialized');

  const result = await pool.query(
    'SELECT * FROM agent_delegations WHERE id = $1',
    [delegationId]
  );

  return result.rows[0] || null;
}

/**
 * Get active delegation for a user-agent pair
 * @param {string} userId - User UUID
 * @param {string} agentId - Agent identifier
 * @returns {Promise<object|null>} Active delegation or null
 */
async function getActiveDelegation(userId, agentId) {
  if (!pool) throw new Error('Delegation module not initialized');

  const result = await pool.query(
    `SELECT * FROM agent_delegations
     WHERE user_id = $1 AND agent_id = $2
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [userId, agentId]
  );

  return result.rows[0] || null;
}

/**
 * Check if a delegation is valid for a given scope
 * @param {string} delegationId - UUID of the delegation
 * @param {string} requiredScope - The scope to check (e.g., 'documents:read')
 * @returns {Promise<object>} { isValid: boolean, delegation?: object, reason?: string }
 */
async function checkDelegation(delegationId, requiredScope) {
  if (!pool) throw new Error('Delegation module not initialized');

  const delegation = await getDelegation(delegationId);

  if (!delegation) {
    return { isValid: false, reason: 'Delegation not found' };
  }

  if (delegation.revoked_at) {
    return { isValid: false, reason: 'Delegation has been revoked' };
  }

  if (delegation.expires_at && new Date(delegation.expires_at) < new Date()) {
    return { isValid: false, reason: 'Delegation has expired' };
  }

  if (requiredScope && !delegation.scopes.includes(requiredScope)) {
    return {
      isValid: false,
      reason: `Required scope '${requiredScope}' not granted. Available scopes: ${delegation.scopes.join(', ')}`,
    };
  }

  return { isValid: true, delegation };
}

/**
 * Revoke a delegation
 * @param {string} delegationId - UUID of the delegation to revoke
 * @returns {Promise<boolean>} True if revoked, false if not found
 */
async function revokeDelegation(delegationId) {
  if (!pool) throw new Error('Delegation module not initialized');

  const result = await pool.query(
    `UPDATE agent_delegations
     SET revoked_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [delegationId]
  );

  if (result.rowCount > 0) {
    // Cascade: tokens minted via create_access_token die with their
    // delegation. Required at every revocation site because revocation is
    // done with raw SQL in three places (here and both oauth-flow handlers).
    const apiTokens = require('./api-tokens'); // lazy: avoids import cycle at module load
    await apiTokens.revokeMintedTokens({ delegationId })
      .catch((err) => console.error('[delegation] minted-token cascade failed:', err));
  }

  return result.rowCount > 0;
}

/**
 * List delegations for a user
 * @param {string} userId - User UUID
 * @param {object} options - Query options
 * @param {boolean} options.includeRevoked - Include revoked delegations (default: false)
 * @returns {Promise<Array<object>>} Array of delegation records
 */
async function listUserDelegations(userId, options = {}) {
  if (!pool) throw new Error('Delegation module not initialized');

  const { includeRevoked = false } = options;

  let query = 'SELECT * FROM agent_delegations WHERE user_id = $1';
  if (!includeRevoked) {
    query += ' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())';
  }
  query += ' ORDER BY created_at DESC';

  const result = await pool.query(query, [userId]);

  return result.rows;
}

/**
 * Update the last_used_at timestamp for a delegation
 * @param {string} delegationId - UUID of the delegation
 * @returns {Promise<void>}
 */
async function updateLastUsed(delegationId) {
  if (!pool) throw new Error('Delegation module not initialized');

  await pool.query(
    'UPDATE agent_delegations SET last_used_at = NOW() WHERE id = $1',
    [delegationId]
  );
}

/**
 * Log an agent action for audit purposes
 * @param {string} delegationId - UUID of the delegation
 * @param {string} action - Action type (e.g., 'document:read', 'document:update')
 * @param {object} options - Action details
 * @param {string} options.docGuid - Document UUID (if applicable)
 * @param {object} options.metadata - Additional action metadata
 * @returns {Promise<void>}
 */
async function logAgentAction(delegationId, action, options = {}) {
  if (!pool) throw new Error('Delegation module not initialized');

  const { docGuid = null, metadata = {} } = options;

  // Get the delegation to get agent_id and user_id
  const delegation = await getDelegation(delegationId);
  if (!delegation) {
    throw new Error('Delegation not found');
  }

  await pool.query(
    `INSERT INTO agent_activity_log (delegation_id, agent_id, user_id, action, doc_guid, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [delegationId, delegation.agent_id, delegation.user_id, action, docGuid, metadata]
  );

  // Also update last_used_at
  await updateLastUsed(delegationId);
}

module.exports = {
  init,
  createDelegation,
  getDelegation,
  getActiveDelegation,
  checkDelegation,
  revokeDelegation,
  listUserDelegations,
  updateLastUsed,
  logAgentAction,
};
