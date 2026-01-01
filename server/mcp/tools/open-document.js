/**
 * open_document MCP Tool
 *
 * Initialize agent session on a document with cursor at start or end.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition, getCursorContext, createCursorPosition } = require('../yjs/cursor-operations');

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
const name = 'open_document';

const description = `Open a document and establish cursor presence.

═══════════════════════════════════════════════════════════════════════════
CURSOR-BASED EDITING SESSION
═══════════════════════════════════════════════════════════════════════════

This tool initializes a cursor-based editing session. The cursor tracks your
position in the document and automatically adjusts when others edit concurrently.

WHEN TO USE THIS:
- Start editing a document
- Required before using any cursor-based editing tools
- Cursor starts at document beginning or end

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- position: Initial cursor position (optional)
  - "start": Beginning of document (default)
  - "end": End of document

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if session established
- sessionId: Session identifier
- documentInfo:
  - title: Document title
  - blockCount: Number of blocks
  - characterCount: Total characters
- cursor:
  - block: Current block index
  - blockType: Type of block (e.g., "paragraph", "heading")
  - context: Text around cursor (50 chars before/after)

═══════════════════════════════════════════════════════════════════════════
EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Open document at the beginning
await open_document({
  docGuid: "abc-123"
});

// Open document at the end
await open_document({
  docGuid: "abc-123",
  position: "end"
});

After opening, you can use cursor-based tools like goto, move, find, insert, etc.`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    position: {
      type: 'string',
      enum: ['start', 'end'],
      description: 'Initial cursor position (default: "start")',
    },
  },
  required: ['docGuid'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} [args.position="start"] - Initial position ("start" or "end")
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Session and cursor info
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('open_document tool not initialized');

  const { docGuid, position = 'start' } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has access to the document
  const accessResult = await pool.query(
    `SELECT d.id, d.title, ds.role
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  const { title } = accessResult.rows[0];

  // Get or create session (this initializes cursor at document start automatically)
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 300);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Count blocks and characters
  const blocks = xmlFragment.toArray();
  const blockCount = blocks.length;

  let characterCount = 0;
  function countChars(node) {
    if (node instanceof Y.XmlText) {
      characterCount += node.length;
    } else if (node instanceof Y.XmlElement) {
      const children = node.toArray();
      for (const child of children) {
        countChars(child);
      }
    }
  }

  for (const block of blocks) {
    countChars(block);
  }

  // Set cursor position based on parameter
  let cursorPos = session.cursor;

  if (position === 'end' || !cursorPos) {
    // Move to end or initialize if null
    if (blocks.length > 0) {
      const lastBlockIndex = blocks.length - 1;
      try {
        // Create position at end of last block
        const endPos = createCursorPosition(xmlFragment, lastBlockIndex, Infinity);
        cursorPos = { anchor: endPos, head: endPos };

        // Update session
        agentPresence.updateSessionCursor(session.sessionId, endPos, endPos);
      } catch (error) {
        console.error('[open_document] Error creating end position:', error);
        // Keep default start position
      }
    }
  }

  // Get cursor context
  let cursorInfo = {
    block: 0,
    blockType: blocks.length > 0 ? blocks[0].nodeName : 'unknown',
    context: '',
  };

  if (cursorPos && cursorPos.head) {
    const resolved = resolveCursorPosition(xmlFragment, cursorPos.head);
    if (resolved) {
      const context = getCursorContext(xmlFragment, cursorPos.head, 50, 50);
      cursorInfo = {
        block: resolved.blockIndex,
        blockType: resolved.blockType,
        context: context ? `${context.before}|${context.after}` : '',
      };
    }
  }

  return {
    success: true,
    sessionId: session.sessionId,
    documentInfo: {
      title,
      blockCount,
      characterCount,
    },
    cursor: cursorInfo,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
