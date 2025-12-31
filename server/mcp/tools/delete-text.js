/**
 * delete_text MCP Tool
 *
 * Deletes a specific range of text within a block.
 */
const Y = require('yjs');
const { deleteText: doDeleteText } = require('../yjs/text-operations');
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
const name = 'delete_text';

const description = `Delete a specific range of text within a block.

✅ INDEX SAFETY: This tool does NOT change element indices
⚠️  CHARACTER POSITION WARNING: Changes positions WITHIN the block
═══════════════════════════════════════════════════════════════════════════

Block indices remain unchanged, but character positions AFTER the deleted
range will shift left.

BEFORE delete positions 4-9:  "The very quick fox"
                                   ^^^^^ delete this
AFTER  delete positions 4-9:  "The quick fox"
                                   ↑ "quick" was at 9, now at 4

If you need to perform multiple operations in the same block:
- Read the block again with read_document_block to see updated positions
- Or calculate new positions: new_pos = old_pos - deleted_length

═══════════════════════════════════════════════════════════════════════════
REMOVE TEXT WITHOUT REPLACING
═══════════════════════════════════════════════════════════════════════════

Delete specific text within a block without removing the entire block.
Perfect for removing words, sentences, or phrases while keeping the rest.

Use cases:
- Remove unwanted words or phrases
- Delete text ranges while preserving surrounding content
- Clean up specific portions of text

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID
- elementIndex: Which block to edit
- startPosition: Start of range to delete (0-based, inclusive)
- endPosition: End of range to delete (0-based, exclusive)
- durationSeconds: How long to highlight before deletion (default: 15)

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- success: true if deleted successfully
- deletedText: The text that was removed
- newBlockLength: New character count of the block
- highlighted: Whether the change was highlighted

═══════════════════════════════════════════════════════════════════════════
WORKFLOW EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Step 1: Read the block
const block = await read_document_block({
  docGuid: "abc-123",
  elementIndex: 0
});
// Returns: "The very quick brown fox jumps"

// Step 2: Delete "very " (positions 4-9)
const result = await delete_text({
  docGuid: "abc-123",
  elementIndex: 0,
  startPosition: 4,
  endPosition: 9,
  durationSeconds: 20
});

// Result: "The quick brown fox jumps"
// Returns: { success: true, deletedText: "very ", newBlockLength: 25 }

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

1. DELETE FROM BEGINNING:
delete_text({
  docGuid: "abc-123",
  elementIndex: 1,
  startPosition: 0,
  endPosition: 8
})

2. DELETE FROM END:
// If block has "Hello world!!!"
delete_text({
  docGuid: "abc-123",
  elementIndex: 1,
  startPosition: 11,    // Position of "!"
  endPosition: 14       // End of text
})
// Result: "Hello world"

3. DELETE MIDDLE PORTION:
// "The quick brown fox" → "The fox"
delete_text({
  docGuid: "abc-123",
  elementIndex: 2,
  startPosition: 4,     // After "The "
  endPosition: 16       // Before "fox"
})

4. DELETE SINGLE CHARACTER:
delete_text({
  docGuid: "abc-123",
  elementIndex: 3,
  startPosition: 10,
  endPosition: 11       // Delete character at position 10
})

═══════════════════════════════════════════════════════════════════════════
POSITION TIPS
═══════════════════════════════════════════════════════════════════════════

- Positions are 0-based (first character is position 0)
- startPosition is inclusive (this character is deleted)
- endPosition is exclusive (this character is NOT deleted)
- To delete one character: endPosition = startPosition + 1
- Use read_document_block to see current content and plan positions

═══════════════════════════════════════════════════════════════════════════
NOTES
═══════════════════════════════════════════════════════════════════════════

- Changes sync to all users in real-time
- Automatically saved to database
- Requires "editor" or "owner" role
- Brief highlight before deletion for visual feedback
- Returns deleted text for logging/undo
- Use replace_text if you need to both delete and insert`;

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
      description: 'The index of the block element to edit',
    },
    startPosition: {
      type: 'integer',
      minimum: 0,
      description: 'Start character position (inclusive, 0-based)',
    },
    endPosition: {
      type: 'integer',
      minimum: 0,
      description: 'End character position (exclusive, 0-based)',
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to highlight before deletion (1-300 seconds, default: 15)',
    },
  },
  required: ['docGuid', 'elementIndex', 'startPosition', 'endPosition'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.elementIndex - Element index
 * @param {number} args.startPosition - Start position
 * @param {number} args.endPosition - End position
 * @param {number} [args.durationSeconds=15] - Duration to highlight
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Delete result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('delete_text tool not initialized');

  const { docGuid, elementIndex, startPosition, endPosition, durationSeconds = 15 } = args;
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
    throw new Error('Viewer role cannot delete text');
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

  // Get the block element
  const element = xmlFragment.get(elementIndex);

  // Highlight before deleting
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (error) {
    console.error('[delete-text] Failed to set highlight:', error);
  }

  // Perform the deletion in a transaction
  let deletedText;
  let newBlockLength;

  ydoc.transact(() => {
    const result = doDeleteText(element, startPosition, endPosition);
    deletedText = result.deletedText;
    newBlockLength = result.newLength;
  });

  return {
    success: true,
    deletedText,
    newBlockLength,
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
