/**
 * move MCP Tool
 *
 * Move cursor relative to current position.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { moveCursor, resolveCursorPosition, getCursorContext, getTextInSelection } = require('../yjs/cursor-operations');

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
const name = 'move';

const description = `Move cursor forward or backward by units.

═══════════════════════════════════════════════════════════════════════════
RELATIVE NAVIGATION
═══════════════════════════════════════════════════════════════════════════

Move cursor relative to current position by characters, words, or blocks.
Can optionally extend selection instead of moving.

WHEN TO USE THIS:
- Navigate forward/backward by characters
- Jump by word boundaries
- Move to next/previous block
- Create selections by extending while moving

UNITS:
- char: Character-by-character movement
- word: Word boundary navigation (uses \\b regex)
- block: Jump to next/previous block

EXTEND MODE:
- extend=false: Move both anchor and head (collapsed cursor)
- extend=true: Move only head, keep anchor fixed (creates/extends selection)

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- direction: "forward" or "backward" (required)
- unit: "char", "word", or "block" (required)
- count: Number of units to move (optional, default: 1)
- extend: Extend selection instead of moving (optional, default: false)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if cursor moved
- moved: Actual units moved (may be less if hit boundary)
- cursor:
  - block: Current block index
  - offset: Current offset
  - blockType: Type of block
  - context: Text around cursor
- selection: (if selection exists)
  - text: Selected text
  - length: Character count

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Move forward 5 characters
await move({
  docGuid: "abc-123",
  direction: "forward",
  unit: "char",
  count: 5
});

// Move backward one word
await move({
  docGuid: "abc-123",
  direction: "backward",
  unit: "word"
});

// Select next 3 words (extend while moving)
await move({
  docGuid: "abc-123",
  direction: "forward",
  unit: "word",
  count: 3,
  extend: true
});`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    direction: {
      type: 'string',
      enum: ['forward', 'backward'],
      description: 'Movement direction',
    },
    unit: {
      type: 'string',
      enum: ['char', 'word', 'block'],
      description: 'Movement unit',
    },
    count: {
      type: 'integer',
      minimum: 1,
      description: 'Number of units to move (default: 1)',
    },
    extend: {
      type: 'boolean',
      description: 'Extend selection instead of moving (default: false)',
    },
  },
  required: ['docGuid', 'direction', 'unit'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.direction - Direction
 * @param {string} args.unit - Unit
 * @param {number} [args.count=1] - Count
 * @param {boolean} [args.extend=false] - Extend selection
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Move result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('move tool not initialized');

  const { docGuid, direction, unit, count = 1, extend = false } = args;
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

  // Move cursor
  const currentHead = session.cursor.head;
  const moveResult = moveCursor(xmlFragment, currentHead, direction, unit, count);

  if (!moveResult) {
    throw new Error('Could not move cursor');
  }

  const { newPos, movedCount } = moveResult;

  // Update cursor based on extend mode
  let newAnchor, newHead;

  if (extend) {
    // Extend selection: keep anchor, move head
    newAnchor = session.cursor.anchor;
    newHead = newPos;
  } else {
    // Normal move: both anchor and head move (collapsed cursor)
    newAnchor = newPos;
    newHead = newPos;
  }

  // Update session
  agentPresence.updateSessionCursor(session.sessionId, newAnchor, newHead);

  // Resolve new position
  const resolved = resolveCursorPosition(xmlFragment, newHead);
  const context = getCursorContext(xmlFragment, newHead, 50, 50);

  const result = {
    success: true,
    moved: movedCount,
    cursor: {
      block: resolved.blockIndex,
      offset: resolved.offset,
      blockType: resolved.blockType,
      context: context ? `${context.before}|${context.after}` : '',
    },
  };

  // Check if selection exists
  const hasSelection = JSON.stringify(newAnchor) !== JSON.stringify(newHead);
  if (hasSelection) {
    const selectionText = getTextInSelection(xmlFragment, newAnchor, newHead);
    result.selection = {
      text: selectionText,
      length: selectionText.length,
    };
  } else {
    result.selection = null;
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
