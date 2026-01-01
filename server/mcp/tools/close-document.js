/**
 * close_document MCP Tool
 *
 * End agent session and remove presence from document.
 */

const agentPresence = require('../agent-presence');

// Persistence provider - set by init function
let persistenceProvider = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
}

/**
 * Tool definition for MCP discovery
 */
const name = 'close_document';

const description = `Close the document session.

═══════════════════════════════════════════════════════════════════════════
END EDITING SESSION
═══════════════════════════════════════════════════════════════════════════

Closes your cursor session and removes your presence from the document.
Your cursor will disappear for other users.

WHEN TO USE THIS:
- When done editing a document
- To explicitly end your session (otherwise it times out after 5 minutes)

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if session was closed
- message: Confirmation message

═══════════════════════════════════════════════════════════════════════════
EXAMPLE
═══════════════════════════════════════════════════════════════════════════

await close_document({
  docGuid: "abc-123"
});`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
  },
  required: ['docGuid'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Close result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('close_document tool not initialized');

  const { docGuid } = args;
  const userId = agentToken.userId;

  // Find and clear all sessions for this user/document combination
  const sessionKey = `${userId}-${docGuid}`;
  const activeSessions = agentPresence.getActiveSessions();

  let cleared = 0;
  for (const [sessionId, session] of activeSessions.entries()) {
    if (session.key === sessionKey) {
      agentPresence.clearSession(sessionId);
      cleared++;
    }
  }

  return {
    success: true,
    message: cleared > 0
      ? `Closed ${cleared} session(s) for document ${docGuid}`
      : `No active sessions found for document ${docGuid}`,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
