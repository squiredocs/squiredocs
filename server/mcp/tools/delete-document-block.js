/**
 * delete_document_block MCP Tool
 *
 * Deletes a block at a specified index with a brief highlight before removal.
 */
const Y = require('yjs');
const { getTextContent } = require('../yjs/block-structure');
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
const name = 'delete_document_block';

const description = `Delete a block from the document at a specific index.

═══════════════════════════════════════════════════════════════════════════
HOW IT WORKS
═══════════════════════════════════════════════════════════════════════════

- Deletes the block at elementIndex
- Shows a brief highlight before removing
- Returns the deleted content as plain text
- Blocks after the deleted index shift up

Example:
  Before: [0] heading, [1] paragraph, [2] paragraph
  Delete index 1
  After:  [0] heading, [1] paragraph (old [2] is now [1])

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID
- elementIndex: Which block to delete (from get_document_structure)
- durationSeconds: How long to highlight before deletion (default: 15)

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- success: true if deleted successfully
- deletedContent: Plain text of what was removed
- deletedType: Block type that was removed
- totalElements: New total count of blocks

═══════════════════════════════════════════════════════════════════════════
WORKFLOW EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Step 1: See current structure
const { structure } = await get_document_structure({
  docGuid: "abc-123"
});
// Shows: [0] heading, [1] paragraph, [2] paragraph (3 total)

// Step 2: Read the block to confirm
const block = await read_document_block({
  docGuid: "abc-123",
  elementIndex: 1
});
// Returns: "This paragraph should be removed"

// Step 3: Delete it
const result = await delete_document_block({
  docGuid: "abc-123",
  elementIndex: 1,
  durationSeconds: 20
});

// Returns:
{
  success: true,
  deletedContent: "This paragraph should be removed",
  deletedType: "paragraph",
  totalElements: 2
}

// Now: [0] heading, [1] paragraph (old [2] is now [1])

═══════════════════════════════════════════════════════════════════════════
NOTES
═══════════════════════════════════════════════════════════════════════════

- Deletion is permanent and immediate
- Changes sync to all users in real-time
- Automatically saved to database
- Requires "editor" or "owner" role
- Element indices shift after deletion
- Brief highlight for visual feedback
- Returns deleted content for logging/undo`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    elementIndex: {
      type: 'integer',
      minimum: 0,
      description: 'The index of the block element to delete',
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to briefly highlight before deletion (1-300 seconds, default: 15)',
    },
  },
  required: ['docGuid', 'elementIndex'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.elementIndex - Element index to delete
 * @param {number} [args.durationSeconds=15] - Brief duration to show before deletion
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Delete result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('delete_document_block tool not initialized');

  const { docGuid, elementIndex, durationSeconds = 15 } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has editor access to the document
  const accessResult = await pool.query(
    `SELECT d.id, ds.role
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  const { role } = accessResult.rows[0];
  if (role === 'viewer') {
    throw new Error('Viewer role cannot delete document blocks');
  }

  // Connect to the shared WebSocket-managed document
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Validate element index
  if (elementIndex >= xmlFragment.length) {
    throw new Error(
      `Element index ${elementIndex} out of bounds (document has ${xmlFragment.length} elements)`
    );
  }

  // Get the element to be deleted (for return info)
  const elementToDelete = xmlFragment.get(elementIndex);
  const deletedType = elementToDelete.nodeName;
  const deletedContent = getTextContent(elementToDelete);

  // Highlight the block briefly before deleting
  let highlighted = false;
  try {
    const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, elementIndex);
    const headIndex = elementIndex + 1;
    const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, headIndex);

    const anchor = Y.relativePositionToJSON(anchorPos);
    const head = Y.relativePositionToJSON(headPos);

    session.awareness.setLocalStateField('cursor', { anchor, head });
    highlighted = true;

    // Brief delay to show the highlight before deletion
    // This helps users see what's being removed
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (error) {
    console.error('[delete-document-block] Failed to set highlight:', error);
    // Continue with deletion even if highlight fails
  }

  // Perform the deletion in a transaction
  ydoc.transact(() => {
    xmlFragment.delete(elementIndex, 1);
  });

  // Clear the cursor highlight after deletion
  try {
    session.awareness.setLocalStateField('cursor', null);
  } catch (error) {
    console.error('[delete-document-block] Failed to clear cursor:', error);
  }

  return {
    success: true,
    deletedContent,
    deletedType,
    totalElements: xmlFragment.length,
    highlighted,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
