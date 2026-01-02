/**
 * insert_block MCP Tool
 *
 * Insert a new block element.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition, createCursorPosition } = require('../yjs/cursor-operations');
const { buildYjsNode } = require('../yjs/node-builder');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
}

const name = 'insert_block';

const description = `Insert a new block (paragraph, heading, list, etc.).

Position is relative to current cursor block.

PARAMETERS:
- docGuid: Document UUID (required)
- position: "before" or "after" current block (required)
- type: Block type (required): "paragraph", "heading", "bulletList", "orderedList", "codeBlock"
- attributes: Type-specific attributes (optional)
  - For heading: {level: 1|2|3}
  - For codeBlock: {language: "javascript"}
- content: Initial text content (optional)

RETURNS:
- success, newBlockIndex, cursor (moved to new block)`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: { type: 'string', format: 'uuid' },
    position: { type: 'string', enum: ['before', 'after'] },
    type: { type: 'string', enum: ['paragraph', 'heading', 'bulletList', 'orderedList', 'codeBlock'] },
    attributes: { type: 'object' },
    content: { type: 'string' },
  },
  required: ['docGuid', 'position', 'type'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('insert_block tool not initialized');

  const { docGuid, position, type, attributes = {}, content = '' } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  const accessResult = await pool.query(
    `SELECT d.id, ds.role FROM documents d
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

  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);
  const undoManager = session.undoManager;

  const currentResolved = resolveCursorPosition(xmlFragment, session.cursor.head);
  const currentBlockIndex = currentResolved.blockIndex;

  // Build node specification
  const nodeSpec = {
    type,
    ...attributes,
    content: content ? [{ type: 'text', text: content }] : [],
  };

  // Build Yjs node
  const newBlock = buildYjsNode(nodeSpec);

  // Calculate insertion index
  const insertIndex = position === 'before' ? currentBlockIndex : currentBlockIndex + 1;

  ydoc.transact(() => {
    xmlFragment.insert(insertIndex, [newBlock]);
  }, undoManager);

  // Move cursor to new block
  const newPos = createCursorPosition(xmlFragment, insertIndex, 0);
  agentPresence.updateSessionCursor(session.sessionId, newPos, newPos);

  const newResolved = resolveCursorPosition(xmlFragment, newPos);

  return {
    success: true,
    newBlockIndex: insertIndex,
    cursor: {
      block: newResolved.blockIndex,
      offset: newResolved.offset,
      blockType: newResolved.blockType,
    },
  };
}

module.exports = { init, name, description, inputSchema, handler };
