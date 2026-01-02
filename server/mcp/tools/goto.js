/**
 * goto MCP Tool
 *
 * Move cursor to an absolute location.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { createCursorPosition, resolveCursorPosition, getCursorContext, createCursorPositionFromPath } = require('../yjs/cursor-operations');

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
const name = 'goto';

const description = `Move cursor to a specific location.

═══════════════════════════════════════════════════════════════════════════
ABSOLUTE NAVIGATION
═══════════════════════════════════════════════════════════════════════════

Jump cursor to a specific location in the document.
Collapses any existing selection.

WHEN TO USE THIS:
- Jump to beginning or end of document
- Move to specific block
- Navigate to start/end of current block

TARGET TYPES:
- document_start: First position in document
- document_end: Last position in document
- block: Start of specific block (requires index parameter)
- block_start: Start of current block
- block_end: End of current block
- position: Specific block + offset (requires block and offset parameters)
- path: Navigate to nested element by path (requires path array, optional offset)

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- target: Target object (required), one of:
  - { type: "document_start" }
  - { type: "document_end" }
  - { type: "block", index: number }
  - { type: "block_start" }
  - { type: "block_end" }
  - { type: "position", block: number, offset: number }
  - { type: "path", path: [number, ...], offset?: number }
    - path: Array of indices to navigate nested structure
    - Example: [6, 0] = first child of block 6 (e.g., first listItem in bulletList)
    - Example: [6, 1, 0] = first child of second child of block 6
    - offset: Character position within the target element (default: 0)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if cursor moved
- cursor:
  - block: New block index
  - offset: New offset within block
  - blockType: Type of block
  - context: Text around new position (50 chars before/after)

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Jump to start of document
await goto({
  docGuid: "abc-123",
  target: { type: "document_start" }
});

// Jump to block 5
await goto({
  docGuid: "abc-123",
  target: { type: "block", index: 5 }
});

// Jump to specific position (block 3, offset 10)
await goto({
  docGuid: "abc-123",
  target: { type: "position", block: 3, offset: 10 }
});

// Navigate to nested list item (first item in bulletList at block 6)
await goto({
  docGuid: "abc-123",
  target: { type: "path", path: [6, 0], offset: 0 }
});

// Navigate deep into nested structure
await goto({
  docGuid: "abc-123",
  target: { type: "path", path: [6, 1, 0], offset: 5 }
});`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    target: {
      type: 'object',
      description: 'Target location',
      oneOf: [
        { type: 'object', properties: { type: { const: 'document_start' } }, required: ['type'] },
        { type: 'object', properties: { type: { const: 'document_end' } }, required: ['type'] },
        { type: 'object', properties: { type: { const: 'block_start' } }, required: ['type'] },
        { type: 'object', properties: { type: { const: 'block_end' } }, required: ['type'] },
        { type: 'object', properties: { type: { const: 'block' }, index: { type: 'integer', minimum: 0 } }, required: ['type', 'index'] },
        { type: 'object', properties: { type: { const: 'position' }, block: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 } }, required: ['type', 'block', 'offset'] },
        { type: 'object', properties: { type: { const: 'path' }, path: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1 }, offset: { type: 'integer', minimum: 0 } }, required: ['type', 'path'] },
      ],
    },
  },
  required: ['docGuid', 'target'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {object} args.target - Target location
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Cursor position after move
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('goto tool not initialized');

  const { docGuid, target } = args;
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

  if (blocks.length === 0) {
    throw new Error('Document is empty');
  }

  let newPos = null;

  // Calculate new position based on target type
  switch (target.type) {
    case 'document_start':
      newPos = createCursorPosition(xmlFragment, 0, 0);
      break;

    case 'document_end':
      newPos = createCursorPosition(xmlFragment, blocks.length - 1, Infinity);
      break;

    case 'block':
      if (target.index >= blocks.length) {
        throw new Error(`Block index ${target.index} out of bounds (0-${blocks.length - 1})`);
      }
      newPos = createCursorPosition(xmlFragment, target.index, 0);
      break;

    case 'block_start': {
      const current = resolveCursorPosition(xmlFragment, session.cursor.head);
      if (!current) throw new Error('Could not resolve current cursor position');
      newPos = createCursorPosition(xmlFragment, current.blockIndex, 0);
      break;
    }

    case 'block_end': {
      const current = resolveCursorPosition(xmlFragment, session.cursor.head);
      if (!current) throw new Error('Could not resolve current cursor position');
      newPos = createCursorPosition(xmlFragment, current.blockIndex, Infinity);
      break;
    }

    case 'position':
      if (target.block >= blocks.length) {
        throw new Error(`Block index ${target.block} out of bounds (0-${blocks.length - 1})`);
      }
      newPos = createCursorPosition(xmlFragment, target.block, target.offset);
      break;

    case 'path':
      // Navigate to nested element by path
      newPos = createCursorPositionFromPath(xmlFragment, target.path, target.offset || 0);
      break;

    default:
      throw new Error(`Unknown target type: ${target.type}`);
  }

  // Update session cursor (collapsed: anchor = head)
  agentPresence.updateSessionCursor(session.sessionId, newPos, newPos);

  // Resolve new position for response
  const resolved = resolveCursorPosition(xmlFragment, newPos);
  const context = getCursorContext(xmlFragment, newPos, 50, 50);

  return {
    success: true,
    cursor: {
      block: resolved.blockIndex,
      offset: resolved.offset,
      blockType: resolved.blockType,
      context: context ? `${context.before}|${context.after}` : '',
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
