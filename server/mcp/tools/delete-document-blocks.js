/**
 * delete_document_blocks MCP Tool
 *
 * Deletes a RANGE of blocks with a brief highlight before removal.
 * More efficient than multiple delete_document_block calls.
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
const name = 'delete_document_blocks';

const description = `Delete one or more blocks from the document.

⚠️  CRITICAL: INDEX INVALIDATION WARNING
═══════════════════════════════════════════════════════════════════════════

This tool CHANGES element indices! After deletion, blocks after the deleted
range will have NEW indices.

BEFORE delete range 2-4:  [0] h1, [1] p, [2] p, [3] p, [4] p, [5] p, [6] p
AFTER  delete range 2-4:  [0] h1, [1] p, [2] p, [3] p
                                        ↑ was [5] ↑ was [6]

REQUIRED NEXT STEP: After using this tool, you MUST call get_document_structure
to get updated indices before performing any other block operations.

Example workflow:
  1. delete_document_blocks({ fromIndex: 2, toIndex: 4 })
  2. get_document_structure({ docGuid })  ← REQUIRED to refresh indices
  3. Now safe to use other tools with updated indices

═══════════════════════════════════════════════════════════════════════════
HOW IT WORKS
═══════════════════════════════════════════════════════════════════════════

- Deletes blocks from fromIndex to toIndex (INCLUSIVE)
- If toIndex is omitted, deletes only the single block at fromIndex
- Shows a brief highlight before removing
- Returns array of deleted content
- All blocks after the deletion shift up

Examples:
  // Delete single block
  delete_document_blocks({ fromIndex: 5 })
  → Deletes 1 block: index 5

  // Delete range of blocks
  delete_document_blocks({ fromIndex: 5, toIndex: 10 })
  → Deletes 6 blocks: indices 5, 6, 7, 8, 9, 10

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID
- fromIndex: Starting index (required)
- toIndex: Ending index (optional, defaults to fromIndex for single block)
- durationSeconds: How long to highlight before deletion (default: 15)

IMPORTANT: Both fromIndex and toIndex are INCLUSIVE.
  Range 5-10 deletes: [5], [6], [7], [8], [9], [10] = 6 blocks total
  Single block: fromIndex: 5 (no toIndex) deletes only [5]

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- success: true if deleted successfully
- deletedBlocks: Array of { type, content } for each deleted block
- deletedCount: Number of blocks removed
- totalElements: New total count of blocks after deletion
- highlighted: Whether the range was highlighted before deletion

═══════════════════════════════════════════════════════════════════════════
WORKFLOW EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Step 1: See current structure
const { structure } = await get_document_structure({
  docGuid: "abc-123"
});
// Shows: [0] h1, [1] p, [2] p, [3] p, [4] p, [5] p, [6] p (7 total)

// Step 2: Delete a range (e.g., remove blocks 2-4)
const result = await delete_document_blocks({
  docGuid: "abc-123",
  fromIndex: 2,
  toIndex: 4,
  durationSeconds: 20
});

// Returns:
// {
//   success: true,
//   deletedBlocks: [
//     { type: "paragraph", content: "Block 2 text..." },
//     { type: "paragraph", content: "Block 3 text..." },
//     { type: "paragraph", content: "Block 4 text..." }
//   ],
//   deletedCount: 3,
//   totalElements: 4,  // Was 7, deleted 3, now 4
//   highlighted: true
// }

// Step 3: Get updated structure (REQUIRED!)
const { structure } = await get_document_structure({ docGuid: "abc-123" });
// Shows: [0] h1, [1] p, [2] p, [3] p (4 total)
//                      ↑ was [5] ↑ was [6]

═══════════════════════════════════════════════════════════════════════════
SAFE PATTERNS
═══════════════════════════════════════════════════════════════════════════

✅ GOOD: Single block deletion
  delete_document_blocks({ fromIndex: 5 })

✅ GOOD: Range deletion
  delete_document_blocks({ fromIndex: 5, toIndex: 10 })
  get_document_structure()  // refresh indices

✅ GOOD: Multiple separate ranges (delete from END to BEGINNING)
  delete_document_blocks({ fromIndex: 20, toIndex: 25 })
  delete_document_blocks({ fromIndex: 10, toIndex: 15 })
  delete_document_blocks({ fromIndex: 3, toIndex: 5 })
  get_document_structure()  // refresh once at end

❌ AVOID: Multiple ranges from beginning to end (indices invalidate!)
  delete_document_blocks({ fromIndex: 3, toIndex: 5 })
  delete_document_blocks({ fromIndex: 10, toIndex: 15 })  // WRONG indices!

═══════════════════════════════════════════════════════════════════════════`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    fromIndex: {
      type: 'integer',
      minimum: 0,
      description: 'Starting index (inclusive). For single block deletion, only provide this.',
    },
    toIndex: {
      type: 'integer',
      minimum: 0,
      description: 'Ending index (inclusive, optional). Omit for single block deletion. Provide for range deletion.',
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to briefly highlight before deletion (1-300 seconds, default: 15)',
    },
  },
  required: ['docGuid', 'fromIndex'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.fromIndex - Starting index (inclusive)
 * @param {number} [args.toIndex] - Ending index (inclusive, defaults to fromIndex)
 * @param {number} [args.durationSeconds=15] - Brief duration to show before deletion
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Delete result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('delete_document_blocks tool not initialized');

  const { docGuid, fromIndex, durationSeconds = 15 } = args;
  // Default toIndex to fromIndex for single block deletion
  const toIndex = args.toIndex !== undefined ? args.toIndex : fromIndex;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Validate range
  if (fromIndex > toIndex) {
    throw new Error(
      `Invalid range: fromIndex (${fromIndex}) must be <= toIndex (${toIndex})`
    );
  }

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

  // Validate indices
  if (fromIndex >= xmlFragment.length) {
    throw new Error(
      `fromIndex ${fromIndex} out of bounds (document has ${xmlFragment.length} elements)`
    );
  }

  if (toIndex >= xmlFragment.length) {
    throw new Error(
      `toIndex ${toIndex} out of bounds (document has ${xmlFragment.length} elements)`
    );
  }

  // Calculate how many blocks to delete
  const deleteCount = toIndex - fromIndex + 1;

  // Collect info about blocks being deleted (before deletion)
  const deletedBlocks = [];
  for (let i = fromIndex; i <= toIndex; i++) {
    const element = xmlFragment.get(i);
    deletedBlocks.push({
      type: element.nodeName,
      content: getTextContent(element),
    });
  }

  // Highlight the entire range before deleting
  let highlighted = false;
  try {
    const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, fromIndex);
    const headIndex = toIndex + 1; // Head is exclusive
    const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, headIndex);

    const anchor = Y.relativePositionToJSON(anchorPos);
    const head = Y.relativePositionToJSON(headPos);

    session.awareness.setLocalStateField('cursor', { anchor, head });
    highlighted = true;

    // Brief delay to show the highlight before deletion
    await new Promise((resolve) => setTimeout(resolve, 500));
  } catch (error) {
    console.error('[delete-document-blocks] Failed to set highlight:', error);
    // Continue with deletion even if highlight fails
  }

  // Perform the deletion in a transaction
  // Delete all blocks in the range at once
  ydoc.transact(() => {
    xmlFragment.delete(fromIndex, deleteCount);
  });

  // Clear the cursor highlight after deletion
  try {
    session.awareness.setLocalStateField('cursor', null);
  } catch (error) {
    console.error('[delete-document-blocks] Failed to clear cursor:', error);
  }

  return {
    success: true,
    deletedBlocks,
    deletedCount: deleteCount,
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
