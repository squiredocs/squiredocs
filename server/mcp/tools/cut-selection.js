/**
 * cut_selection MCP Tool
 *
 * Copy selection to clipboard and delete it from the document.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition } = require('../yjs/cursor-operations');
const copySelection = require('./copy-selection');
const deleteOp = require('./delete');

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
const name = 'cut_selection';

const description = `Cut selection to clipboard (copy + delete).

═══════════════════════════════════════════════════════════════════════════
CUT SELECTION
═══════════════════════════════════════════════════════════════════════════

Copies the currently selected content to clipboard and deletes it from the
document. Equivalent to copy_selection followed by delete.

WHEN TO USE THIS:
- Move content to a different location
- Remove content while keeping it available for pasting
- Reorganize document structure

WORKFLOW:
1. Create selection (using select, find, or move with extend)
2. Cut selection (copies and deletes)
3. Navigate to destination
4. Paste content

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if operation completed
- hasSelection: true if selection exists and was cut
- cutBlocks: Number of top-level blocks cut
- cutLength: Character count
- contentPreview: First 100 characters of cut content
- clipboardId: Unique identifier for this clipboard entry
- cursor: New cursor position after cut

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Cut and move a section
await select({ docGuid: "abc-123", mode: "block" });
await move({ docGuid: "abc-123", direction: "forward", unit: "block", count: 2, extend: true });
await cut_selection({ docGuid: "abc-123" });
await goto({ docGuid: "abc-123", target: { type: "document_end" } });
await paste({ docGuid: "abc-123", mode: "after" });

// Cut a word to replace it elsewhere
await select({ docGuid: "abc-123", mode: "word" });
await cut_selection({ docGuid: "abc-123" });`;

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
 * @returns {Promise<object>} Cut result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('cut_selection tool not initialized');

  const { docGuid } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has access to the document
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

  if (accessResult.rows[0].role === 'viewer') {
    throw new Error('Permission denied: viewers cannot edit documents');
  }

  // Get or create session (reuses existing WebSocket if available)
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 3600);

  if (!session || !session.cursor) {
    throw new Error('Failed to get session');
  }

  const anchorPos = session.cursor.anchor;
  const headPos = session.cursor.head;
  const hasSelection = JSON.stringify(anchorPos) !== JSON.stringify(headPos);

  if (!hasSelection) {
    // No selection - return success but indicate nothing was cut
    return {
      success: true,
      hasSelection: false,
      cutBlocks: 0,
      cutLength: 0,
      contentPreview: '',
    };
  }

  // CRITICAL: Cut must be atomic - either both copy AND delete succeed, or neither happens
  // We cannot rollback Yjs transactions easily, so we must ensure copy succeeds before deleting

  let copyResult;
  let deleteResult;

  try {
    // First, copy the selection
    // If this fails, we return error and document is unchanged
    copyResult = await copySelection.handler(args, agentToken);

    if (!copyResult.success || !copyResult.hasSelection) {
      return {
        success: true,
        hasSelection: false,
        cutBlocks: 0,
        cutLength: 0,
        contentPreview: '',
      };
    }
  } catch (copyError) {
    // Copy failed - document is unchanged, no data loss
    throw new Error(`Cut failed during copy: ${copyError.message}`);
  }

  try {
    // Then, delete the selection
    // If this fails, content is in clipboard but not deleted from document
    deleteResult = await deleteOp.handler(args, agentToken);
  } catch (deleteError) {
    // Delete failed but copy succeeded - content is in clipboard
    // This is safer than the reverse (delete without copy)
    throw new Error(`Cut failed during delete (content saved to clipboard): ${deleteError.message}`);
  }

  // Both operations succeeded - return success
  // Wrap in try-catch to ensure we return success even if building response fails
  try {
    return {
      success: true,
      hasSelection: true,
      cutBlocks: copyResult.copiedBlocks,
      cutLength: copyResult.copiedLength,
      contentPreview: copyResult.contentPreview,
      clipboardId: copyResult.clipboardId,
      cursor: deleteResult.cursor,
    };
  } catch (responseError) {
    // Operations succeeded but response building failed
    // Return minimal success response to prevent user thinking operation failed
    return {
      success: true,
      hasSelection: true,
      cutBlocks: copyResult.copiedBlocks || 0,
      cutLength: copyResult.copiedLength || 0,
      contentPreview: copyResult.contentPreview || '',
      clipboardId: copyResult.clipboardId || '',
      cursor: { block: 0, offset: 0, blockType: 'paragraph' },
    };
  }
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
