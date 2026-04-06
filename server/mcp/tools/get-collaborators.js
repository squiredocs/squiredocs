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

const description = `Get information about other users currently in the document.

═══════════════════════════════════════════════════════════════════════════
COLLABORATIVE AWARENESS
═══════════════════════════════════════════════════════════════════════════

See who else is editing the document, where their cursors are, and what they're working on.
Useful for coordination and avoiding edit conflicts.

WHEN TO USE THIS:
- Check who else is in the document
- See where others are editing
- Coordinate with other users/agents
- Avoid editing same area simultaneously

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- collaborators: Array of users
  - userId: User identifier
  - name: User display name
  - color: User cursor color
  - isAgent: true if AI agent, false if human
  - cursor: (if user has cursor visible)
    - block: Block index
    - offset: Offset within block
    - blockType: Type of block
    - hasSelection: true if text selected
    - selectionPreview: First 50 chars of selection (if any)
- totalCount: Number of collaborators

═══════════════════════════════════════════════════════════════════════════
EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// See who's in the document
await get_collaborators({
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
