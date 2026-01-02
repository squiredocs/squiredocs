/**
 * get_selection MCP Tool
 *
 * Get information about current cursor and selection.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition, getCursorContext, getTextInSelection } = require('../yjs/cursor-operations');

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
const name = 'get_selection';

const description = `Get information about current cursor and selection.

═══════════════════════════════════════════════════════════════════════════
QUERY CURSOR STATE
═══════════════════════════════════════════════════════════════════════════

Check your current cursor position and any active selection.

WHEN TO USE THIS:
- Check where cursor is located
- Verify what text is selected
- Get context around current position

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- includeContext: Include surrounding text (optional, default: true)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- hasSelection: true if text is selected
- selection: (if text is selected)
  - text: Selected text
  - length: Character count
  - startBlock: Start block index
  - startOffset: Start offset within block
  - endBlock: End block index
  - endOffset: End offset within block
- cursor:
  - block: Current block index
  - offset: Current offset
  - blockType: Type of block
- context: (if includeContext true)
  - before: 100 chars before cursor/selection
  - after: 100 chars after cursor/selection

═══════════════════════════════════════════════════════════════════════════
EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Get current selection with context
await get_selection({
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
    includeContext: {
      type: 'boolean',
      description: 'Include surrounding text (default: true)',
    },
  },
  required: ['docGuid'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {boolean} [args.includeContext=true] - Include context
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Selection information
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('get_selection tool not initialized');

  const { docGuid, includeContext = true } = args;
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

  // Get or create session (reuses existing WebSocket if available)
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 3600);

  if (!session || !session.cursor) {
    throw new Error('Failed to get session');
  }

  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  const anchorPos = session.cursor.anchor;
  const headPos = session.cursor.head;

  // Check if selection exists (anchor != head)
  const hasSelection = JSON.stringify(anchorPos) !== JSON.stringify(headPos);

  const result = {
    hasSelection,
  };

  // Resolve cursor position
  const cursorResolved = resolveCursorPosition(xmlFragment, headPos);
  if (!cursorResolved) {
    throw new Error('Could not resolve cursor position');
  }

  result.cursor = {
    block: cursorResolved.blockIndex,
    offset: cursorResolved.offset,
    blockType: cursorResolved.blockType,
  };

  // If selection exists, get selection details
  if (hasSelection) {
    const selectionText = getTextInSelection(xmlFragment, anchorPos, headPos);
    const anchorResolved = resolveCursorPosition(xmlFragment, anchorPos);

    if (anchorResolved) {
      result.selection = {
        text: selectionText,
        length: selectionText.length,
        startBlock: Math.min(anchorResolved.blockIndex, cursorResolved.blockIndex),
        startOffset: anchorResolved.blockIndex < cursorResolved.blockIndex
          ? anchorResolved.offset
          : cursorResolved.offset,
        endBlock: Math.max(anchorResolved.blockIndex, cursorResolved.blockIndex),
        endOffset: anchorResolved.blockIndex > cursorResolved.blockIndex
          ? anchorResolved.offset
          : cursorResolved.offset,
      };
    }
  } else {
    result.selection = null;
  }

  // Include context if requested
  if (includeContext) {
    const context = getCursorContext(xmlFragment, headPos, 100, 100);
    if (context) {
      result.context = {
        before: context.before,
        after: context.after,
      };
    }
  }

  return result;
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
