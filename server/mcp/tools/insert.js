/**
 * insert MCP Tool
 *
 * Insert text at cursor position.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const {
  resolveCursorPosition,
  getTextInSelection,
  createCursorPosition,
} = require('../yjs/cursor-operations');
const { insertText, deleteText } = require('../yjs/text-operations');
const { streamingInsert } = require('../yjs/streaming-insert');

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
const name = 'insert';

const description = `Insert text at cursor position.

═══════════════════════════════════════════════════════════════════════════
TEXT INSERTION
═══════════════════════════════════════════════════════════════════════════

Insert text at current cursor position. If selection exists, replaces selection.
Cursor moves to end of inserted text.

Supports streaming mode for character-by-character insertion visible to other users.

WHEN TO USE THIS:
- Add text at cursor
- Replace selected text
- Type new content
- Insert with formatting marks

BEHAVIOR:
- If selection exists: Deletes selection first, inserts at anchor position
- If no selection: Inserts at cursor (head) position
- Cursor always moves to end of inserted text

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- text: Text to insert (required)
- marks: Formatting marks (optional)
  - Array of: "bold", "italic", "underline", "strike"
  - Or objects: [{ type: "link", href: "url" }]
- streaming: Insert with typing animation (optional, default: false)
  - true: Character-by-character insertion (visible to others)
  - false: Instant insertion

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if text inserted
- insertedLength: Number of characters inserted
- replacedSelection: true if selection was replaced
- cursor: New cursor position

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Insert plain text
await insert({
  docGuid: "abc-123",
  text: "Hello world"
});

// Insert with bold formatting
await insert({
  docGuid: "abc-123",
  text: "Important!",
  marks: ["bold"]
});

// Insert with streaming animation
await insert({
  docGuid: "abc-123",
  text: "Typing this slowly...",
  streaming: true
});`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    text: {
      type: 'string',
      description: 'Text to insert',
    },
    marks: {
      type: 'array',
      description: 'Formatting marks',
      items: {
        oneOf: [
          { type: 'string', enum: ['bold', 'italic', 'underline', 'strike'] },
          { type: 'object', properties: { type: { const: 'link' }, href: { type: 'string' } } },
        ],
      },
    },
    streaming: {
      type: 'boolean',
      description: 'Insert with typing animation (default: false)',
    },
  },
  required: ['docGuid', 'text'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.text - Text to insert
 * @param {Array} [args.marks=[]] - Formatting marks
 * @param {boolean} [args.streaming=false] - Streaming mode
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Insert result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('insert tool not initialized');

  const { docGuid, text, marks = [], streaming = false } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has access to the document and can edit
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

  const role = accessResult.rows[0].role;
  if (role === 'viewer') {
    throw new Error('Permission denied: viewers cannot edit documents');
  }

  // Get session
  const sessionKey = `${userId}-${docGuid}`;
  const activeSessions = agentPresence.getActiveSessions();

  let session = null;
  for (const [sid, sess] of activeSessions.entries()) {
    if (sess.key === sessionKey) {
      session = sess;
      break;
    }
  }

  if (!session || !session.cursor) {
    throw new Error('No active session found. Use open_document first.');
  }

  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);
  const undoManager = session.undoManager;

  const anchorPos = session.cursor.anchor;
  const headPos = session.cursor.head;

  // Check if selection exists
  const hasSelection = JSON.stringify(anchorPos) !== JSON.stringify(headPos);
  let insertPos = headPos;
  let replacedSelection = false;

  if (hasSelection) {
    // Delete selection first
    const anchorResolved = resolveCursorPosition(xmlFragment, anchorPos);
    const headResolved = resolveCursorPosition(xmlFragment, headPos);

    if (!anchorResolved || !headResolved) {
      throw new Error('Could not resolve selection positions');
    }

    // Delete the selection
    ydoc.transact(() => {
      // Determine which position is earlier
      const isForward = anchorResolved.blockIndex < headResolved.blockIndex ||
        (anchorResolved.blockIndex === headResolved.blockIndex && anchorResolved.offset < headResolved.offset);

      const startResolved = isForward ? anchorResolved : headResolved;
      const endResolved = isForward ? headResolved : anchorResolved;

      // Delete text in selection
      deleteText(xmlFragment, startResolved.blockIndex, startResolved.offset,
        endResolved.blockIndex, endResolved.offset);
    }, undoManager);

    // Use anchor position for insertion
    insertPos = anchorPos;
    replacedSelection = true;
  }

  // Resolve insert position
  const insertResolved = resolveCursorPosition(xmlFragment, insertPos);
  if (!insertResolved) {
    throw new Error('Could not resolve insert position');
  }

  // Perform insertion
  if (streaming) {
    // Streaming insert (character-by-character)
    const blocks = xmlFragment.toArray();
    const block = blocks[insertResolved.blockIndex];

    // Find text node at position
    function findTextNodeAtOffset(element, targetOffset) {
      let currentOffset = 0;
      function traverse(node) {
        if (node instanceof Y.XmlText) {
          if (currentOffset + node.length >= targetOffset) {
            return { textNode: node, offset: targetOffset - currentOffset };
          }
          currentOffset += node.length;
        } else if (node instanceof Y.XmlElement) {
          for (const child of node.toArray()) {
            const result = traverse(child);
            if (result) return result;
          }
        }
        return null;
      }
      return traverse(element);
    }

    const nodeInfo = findTextNodeAtOffset(block, insertResolved.offset);
    if (!nodeInfo) {
      throw new Error('Could not find text node at insert position');
    }

    // Use streaming insert
    await streamingInsert(
      ydoc,
      nodeInfo.textNode,
      nodeInfo.offset,
      text,
      marks,
      session.provider.awareness,
      insertPos,
      40  // 40ms delay between chars
    );
  } else {
    // Regular insert (instant)
    ydoc.transact(() => {
      insertText(xmlFragment, insertResolved.blockIndex, insertResolved.offset, text, marks);
    }, undoManager);
  }

  // Move cursor to end of inserted text
  const newOffset = insertResolved.offset + text.length;
  const newPos = createCursorPosition(xmlFragment, insertResolved.blockIndex, newOffset);

  // Update session cursor (collapsed)
  agentPresence.updateSessionCursor(session.sessionId, newPos, newPos);

  // Resolve new position for response
  const newResolved = resolveCursorPosition(xmlFragment, newPos);

  return {
    success: true,
    insertedLength: text.length,
    replacedSelection,
    cursor: {
      block: newResolved.blockIndex,
      offset: newResolved.offset,
      blockType: newResolved.blockType,
    },
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
