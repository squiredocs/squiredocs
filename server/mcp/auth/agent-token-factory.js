/**
 * Agent Token Factory
 *
 * Creates both a signed JWT and a synthetic agent token object
 * from a single configuration. Used by the chat endpoint (and any
 * future agent entry-point) to avoid duplicating token setup.
 */
const { generateAgentToken } = require('./jwt');

/**
 * Create an agent JWT and matching synthetic token in one call.
 *
 * @param {Object} opts
 * @param {string} opts.userId   - The human user the agent acts on behalf of
 * @param {string} opts.agentId  - Stable agent identifier (e.g. 'in-app-chat')
 * @param {string} opts.agentName - Display name (e.g. 'Squire Docs Assistant')
 * @param {string[]} opts.scopes - Permission scopes (e.g. ['read', 'write'])
 * @param {string} opts.baseUrl  - Server base URL for tool callbacks
 * @returns {{ jwt: string, token: Object }} The raw JWT string and the synthetic token object
 */
function createAgentTokenPair({ userId, agentId, agentName, scopes, baseUrl }) {
  const jwt = generateAgentToken({
    id: `${agentId}-${userId}`,
    user_id: userId,
    agent_id: agentId,
    agent_name: agentName,
    scopes,
  });

  const token = {
    userId,
    agentId,
    agentName,
    scopes,
    isAgent: true,
    rawToken: jwt,
    baseUrl,
  };

  return { jwt, token };
}

module.exports = { createAgentTokenPair };
