/**
 * select MCP Tool
 *
 * Create or modify text selection.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const {
  resolveCursorPosition,
  createCursorPosition,
  moveCursor,
  getTextInSelection,
} = require('../yjs/cursor-operations');

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
const name = 'select';

const description = `Create or modify selection.

═══════════════════════════════════════════════════════════════════════════
TEXT SELECTION
═══════════════════════════════════════════════════════════════════════════

Create selections using various modes. Selection has anchor (start) and
head (cursor position).

WHEN TO USE THIS:
- Select text for formatting
- Select content to delete/replace
- Expand or collapse selection
- Select entire blocks or document

MODES:
- "none": Collapse selection (deselect)
- "word": Select word at/around cursor
- "block": Select entire current block
- "all": Select entire document
- "to_block_start": From cursor to start of block
- "to_block_end": From cursor to end of block

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- mode: Selection mode (required)
  - "none" | "word" | "block" | "all" | "to_block_start" | "to_block_end"

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if selection created
- selection: (if mode != "none")
  - text: Selected text
  - length: Character count
  - startBlock: Start block index
  - endBlock: End block index
- cursor: Updated cursor state

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Select word at cursor
await select({
  docGuid: "abc-123",
  mode: "word"
});

// Select entire current block
await select({
  docGuid: "abc-123",
  mode: "block"
});

// Select from cursor to end of block
await select({
  docGuid: "abc-123",
  mode: "to_block_end"
});

// Deselect (collapse to cursor)
await select({
  docGuid: "abc-123",
  mode: "none"
});`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    mode: {
      type: 'string',
      enum: ['none', 'word', 'block', 'all', 'to_block_start', 'to_block_end'],
      description: 'Selection mode',
    },
  },
  required: ['docGuid', 'mode'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.mode - Selection mode
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Selection result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('select tool not initialized');

  const { docGuid, mode } = args;
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
  const blocks = xmlFragment.toArray();

  const currentHead = session.cursor.head;
  const currentResolved = resolveCursorPosition(xmlFragment, currentHead);

  if (!currentResolved) {
    throw new Error('Could not resolve cursor position');
  }

  let newAnchor, newHead;

  switch (mode) {
    case 'none': {
      // Collapse selection (both anchor and head at current position)
      newAnchor = currentHead;
      newHead = currentHead;
      break;
    }

    case 'word': {
      // Select word at/around cursor
      // Find word boundaries using regex
      function getBlockText(block) {
        let text = '';
        function traverse(node) {
          if (node instanceof Y.XmlText) {
            text += node.toString();
          } else if (node instanceof Y.XmlElement) {
            for (const child of node.toArray()) {
              traverse(child);
            }
          }
        }
        traverse(block);
        return text;
      }

      const blockText = getBlockText(blocks[currentResolved.blockIndex]);
      const offset = currentResolved.offset;

      // Find word boundaries
      let wordStart = offset;
      let wordEnd = offset;

      // Move back to word start
      while (wordStart > 0 && /\w/.test(blockText[wordStart - 1])) {
        wordStart--;
      }

      // Move forward to word end
      while (wordEnd < blockText.length && /\w/.test(blockText[wordEnd])) {
        wordEnd++;
      }

      newAnchor = createCursorPosition(xmlFragment, currentResolved.blockIndex, wordStart);
      newHead = createCursorPosition(xmlFragment, currentResolved.blockIndex, wordEnd);
      break;
    }

    case 'block': {
      // Select entire current block
      newAnchor = createCursorPosition(xmlFragment, currentResolved.blockIndex, 0);
      newHead = createCursorPosition(xmlFragment, currentResolved.blockIndex, Infinity);
      break;
    }

    case 'all': {
      // Select entire document
      newAnchor = createCursorPosition(xmlFragment, 0, 0);
      newHead = createCursorPosition(xmlFragment, blocks.length - 1, Infinity);
      break;
    }

    case 'to_block_start': {
      // From cursor to start of block
      newAnchor = createCursorPosition(xmlFragment, currentResolved.blockIndex, 0);
      newHead = currentHead;
      break;
    }

    case 'to_block_end': {
      // From cursor to end of block
      newAnchor = currentHead;
      newHead = createCursorPosition(xmlFragment, currentResolved.blockIndex, Infinity);
      break;
    }

    default:
      throw new Error(`Unknown selection mode: ${mode}`);
  }

  // Update session
  agentPresence.updateSessionCursor(session.sessionId, newAnchor, newHead);

  // Build result
  const result = {
    success: true,
  };

  // Check if selection exists
  const hasSelection = JSON.stringify(newAnchor) !== JSON.stringify(newHead);

  if (hasSelection) {
    const selectionText = getTextInSelection(xmlFragment, newAnchor, newHead);
    const anchorResolved = resolveCursorPosition(xmlFragment, newAnchor);
    const headResolved = resolveCursorPosition(xmlFragment, newHead);

    result.selection = {
      text: selectionText,
      length: selectionText.length,
      startBlock: Math.min(anchorResolved.blockIndex, headResolved.blockIndex),
      endBlock: Math.max(anchorResolved.blockIndex, headResolved.blockIndex),
    };
  } else {
    result.selection = null;
  }

  const headResolved = resolveCursorPosition(xmlFragment, newHead);
  result.cursor = {
    block: headResolved.blockIndex,
    offset: headResolved.offset,
    blockType: headResolved.blockType,
  };

  return result;
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
