/**
 * nest_block MCP Tool
 *
 * Insert a block as a child of a specified parent element.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { createNodeSpec, buildYjsNode } = require('../yjs/node-builder');
const {
  resolveCursorPosition,
  createCursorPosition,
  createCursorPositionFromPath,
  resolveCursorPositionToPath
} = require('../yjs/cursor-operations');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
}

const name = 'nest_block';

const description = `Insert a block as a child of a specified parent element.

This creates nested hierarchical structures like sub-lists or nested content.

PARAMETERS:
- docGuid: Document UUID (required)
- parentPath: Array specifying the parent element path (required)
  - Example: [2] nests under block 2
  - Example: [2, 1] nests under listItem 1 of block 2
- type: Block type to create (required): "paragraph", "heading", "bulletList", "orderedList"
- attributes: Type-specific attributes (optional)
- content: Initial text content (optional)
  - Inserted instantly (not streamed)
  - Best for short content like headings or list items
  - For longer content, create empty block then use 'insert' tool (which streams automatically)
- childIndex: Position within parent children (optional, defaults to end)

RETURNS:
- success, newPath (full path to the nested block)

TIP: The 'insert' tool automatically streams text in chunks for visual feedback.
For longer content, create an empty nested block here, then use 'insert' to add the text.`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: { type: 'string', format: 'uuid' },
    parentPath: {
      type: 'array',
      items: { type: 'integer', minimum: 0 },
      minItems: 1,
      description: 'Path to parent element'
    },
    type: { type: 'string', enum: ['paragraph', 'heading', 'bulletList', 'orderedList', 'codeBlock'] },
    attributes: { type: 'object' },
    content: { type: 'string' },
    childIndex: {
      type: 'integer',
      minimum: 0,
      description: 'Position within parent children (defaults to end)'
    },
  },
  required: ['docGuid', 'parentPath', 'type'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('nest_block tool not initialized');

  const { docGuid, parentPath, type, attributes = {}, content = '', childIndex } = args;
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

  // Navigate to the parent element
  const blocks = xmlFragment.toArray();
  const [blockIndex, ...childIndices] = parentPath;

  if (blockIndex < 0 || blockIndex >= blocks.length) {
    throw new Error(`Parent block index ${blockIndex} out of bounds`);
  }

  let parentElement = blocks[blockIndex];

  // Navigate through the path
  for (let i = 0; i < childIndices.length; i++) {
    const childIdx = childIndices[i];
    if (!(parentElement instanceof Y.XmlElement)) {
      throw new Error(`Parent path element at depth ${i} is not an XmlElement`);
    }

    const children = parentElement.toArray();
    if (childIdx < 0 || childIdx >= children.length) {
      throw new Error(`Child index ${childIdx} out of bounds at depth ${i + 1}`);
    }

    parentElement = children[childIdx];
  }

  if (!(parentElement instanceof Y.XmlElement)) {
    throw new Error('Parent element must be an XmlElement that can contain children');
  }

  // Create the new block
  const nodeSpec = createNodeSpec(type, attributes, content);
  const newBlock = buildYjsNode(nodeSpec);

  // Insert as child
  const insertAt = childIndex !== undefined ? childIndex : parentElement.length;

  ydoc.transact(() => {
    parentElement.insert(insertAt, [newBlock]);
  }, undoManager);

  // Move cursor to the new nested block
  const newPath = [...parentPath, insertAt];
  const newPos = createCursorPositionFromPath(xmlFragment, [...newPath, 0, 0], 0); // Assume first child is paragraph with text

  agentPresence.updateSessionCursor(session.sessionId, newPos, newPos);

  return {
    success: true,
    newPath,
    message: 'Block nested successfully',
  };
}

module.exports = { init, name, description, inputSchema, handler };

