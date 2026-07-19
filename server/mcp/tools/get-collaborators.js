/**
 * get_collaborators MCP Tool
 *
 * See who else is in the document and their cursor positions.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition, getTextInSelection } = require('../yjs/cursor-operations');

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
const name = 'get_collaborators';

const description = `Get information about other users currently in the document: who else is
editing, where their cursors are, and what they're working on. Useful for
coordinating with other users/agents and avoiding edits to the same area
simultaneously.

RETURNS:
- collaborators: array of users, each with clientId, name, color, isAgent
  (true for AI agents), and cursor when visible — { block, offset, blockType,
  hasSelection, selectionPreview (first 50 chars of any selection) }
- totalCount: number of collaborators`;

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
 * @returns {Promise<object>} Collaborators information
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('get_collaborators tool not initialized');

  const { docGuid } = args;

  // Get or create session (verifies access internally)
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 60);
  const awareness = session.provider.awareness;
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Get all awareness states
  const states = awareness.getStates();
  const collaborators = [];

  for (const [clientId, state] of states.entries()) {
    // Skip if no user info
    if (!state.user) continue;

    const user = state.user;
    const cursor = state.cursor;

    const collaborator = {
      clientId: clientId.toString(),
      name: user.name || 'Anonymous',
      color: user.color || '#000000',
      isAgent: user.isAgent || false,
    };

    // Parse cursor if exists
    if (cursor && cursor.head) {
      try {
        const resolved = resolveCursorPosition(xmlFragment, cursor.head);
        if (resolved) {
          const hasSelection = cursor.anchor && JSON.stringify(cursor.anchor) !== JSON.stringify(cursor.head);

          collaborator.cursor = {
            block: resolved.blockIndex,
            offset: resolved.offset,
            blockType: resolved.blockType,
            hasSelection,
          };

          // Get selection preview if has selection
          if (hasSelection && cursor.anchor) {
            const selectionText = getTextInSelection(xmlFragment, cursor.anchor, cursor.head);
            collaborator.cursor.selectionPreview = selectionText.substring(0, 50) +
              (selectionText.length > 50 ? '...' : '');
          }
        }
      } catch (error) {
        // Couldn't resolve cursor position
        collaborator.cursor = null;
      }
    } else {
      collaborator.cursor = null;
    }

    collaborators.push(collaborator);
  }

  return {
    collaborators,
    totalCount: collaborators.length,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
