/**
 * insert_block MCP Tool
 *
 * Insert a new block element.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const {
  resolveCursorPosition,
  createCursorPosition,
  createCursorPositionFromPath,
  resolveCursorPositionToPath
} = require('../yjs/cursor-operations');
const { buildYjsNode, createNodeSpec } = require('../yjs/node-builder');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
}

const name = 'insert_block';

const description = `Insert a new block (paragraph, heading, list, etc.).

Position is relative to current cursor block, or at a specific parent path for nested insertion.

PARAMETERS:
- docGuid: Document UUID (required)
- position: "before" or "after" current block (required when not using parentPath)
- type: Block type (required): "paragraph", "heading", "bulletList", "orderedList", "codeBlock", "listItem"
- attributes: Type-specific attributes (optional)
  - For heading: {level: 1|2|3}
  - For codeBlock: {language: "javascript"}
- content: Initial text content (optional)
  - Inserted instantly (not streamed)
  - Best for short content like headings or list items
  - For longer content, create empty block then use 'insert' tool (which streams automatically)
- parentPath: Array of indices specifying parent location (optional)
  - Example: [2] inserts as child of block 2
  - Example: [2, 1] inserts as child of listItem 1 in block 2
- childIndex: Index within parent children (optional, defaults to end)
- autoListItem: Automatically wrap in listItem when inserting into lists (optional, default: true)

RETURNS:
- success, newBlockIndex or newPath, cursor (moved to new block)

TIP: The 'insert' tool automatically streams text in chunks for visual feedback.
For longer content, create an empty block here, then use 'insert' to add the text.`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: { type: 'string', format: 'uuid' },
    position: { type: 'string', enum: ['before', 'after'] },
    type: { type: 'string', enum: ['paragraph', 'heading', 'bulletList', 'orderedList', 'codeBlock', 'listItem'] },
    attributes: { type: 'object' },
    content: { type: 'string' },
    parentPath: {
      type: 'array',
      items: { type: 'integer', minimum: 0 },
      description: 'Path to parent element for nested insertion'
    },
    childIndex: {
      type: 'integer',
      minimum: 0,
      description: 'Index within parent children (defaults to end)'
    },
    autoListItem: {
      type: 'boolean',
      description: 'Automatically wrap in listItem when inserting into lists (default: true)',
      default: true
    },
  },
  required: ['docGuid', 'type'],
  dependencies: {
    position: { not: { required: ['parentPath'] } },
    parentPath: { not: { required: ['position'] } }
  },
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('insert_block tool not initialized');

  const {
    docGuid,
    position,
    type,
    attributes = {},
    content = '',
    parentPath,
    childIndex,
    autoListItem = true
  } = args;
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

  let actualType = type;
  let actualContent = content;

  // Handle hierarchical insertion with auto-wrapping
  if (parentPath && Array.isArray(parentPath)) {
    // Check if parent is a list and we need to auto-wrap
    const blocks = xmlFragment.toArray();
    const [blockIndex, ...childIndices] = parentPath;

    if (blockIndex >= 0 && blockIndex < blocks.length) {
      let parentElement = blocks[blockIndex];

      // Navigate through the path
      for (let i = 0; i < childIndices.length; i++) {
        const childIdx = childIndices[i];
        if (parentElement instanceof Y.XmlElement) {
          const children = parentElement.toArray();
          if (childIdx >= 0 && childIdx < children.length) {
            parentElement = children[childIdx];
          }
        }
      }

      // If inserting directly into a list and autoListItem is true, wrap content in listItem
      if (parentElement instanceof Y.XmlElement &&
          ['bulletList', 'orderedList'].includes(parentElement.nodeName) &&
          autoListItem && type !== 'listItem') {
        actualType = 'listItem';
        // The content stays the same - createNodeSpec will handle wrapping
      }
    }
  }

  // Build node specification (handles list vs non-list blocks)
  const nodeSpec = createNodeSpec(actualType, attributes, actualContent);
  const newBlock = buildYjsNode(nodeSpec);

  let newPos;
  let resultInfo;

  if (parentPath && Array.isArray(parentPath)) {
    // Hierarchical insertion at specified parent path
    const blocks = xmlFragment.toArray();
    const [blockIndex, ...childIndices] = parentPath;

    if (blockIndex < 0 || blockIndex >= blocks.length) {
      throw new Error(`Parent block index ${blockIndex} out of bounds`);
    }

    let parentElement = blocks[blockIndex];

    // Navigate to the target parent element
    for (let i = 0; i < childIndices.length; i++) {
      const childIndex = childIndices[i];
      if (!(parentElement instanceof Y.XmlElement)) {
        throw new Error(`Parent path element at depth ${i} is not an XmlElement`);
      }

      const children = parentElement.toArray();
      if (childIndex < 0 || childIndex >= children.length) {
        throw new Error(`Child index ${childIndex} out of bounds at depth ${i + 1}`);
      }

      parentElement = children[childIndex];
    }

    if (!(parentElement instanceof Y.XmlElement)) {
      throw new Error('Parent element must be an XmlElement');
    }

    // Insert as child of the parent element
    const insertAt = childIndex !== undefined ? childIndex : parentElement.length;

    ydoc.transact(() => {
      parentElement.insert(insertAt, [newBlock]);
    }, undoManager);

    // Create cursor position for the new child
    const newPath = [...parentPath, insertAt];
    newPos = createCursorPositionFromPath(xmlFragment, newPath, 0);
    resultInfo = { newPath };

  } else {
    // Traditional top-level insertion (backward compatibility)
    const currentResolved = resolveCursorPosition(xmlFragment, session.cursor.head);
    const currentBlockIndex = currentResolved.blockIndex;

    // Calculate insertion index
    const insertIndex = position === 'before' ? currentBlockIndex : currentBlockIndex + 1;

    ydoc.transact(() => {
      xmlFragment.insert(insertIndex, [newBlock]);
    }, undoManager);

    // Move cursor to new block
    newPos = createCursorPosition(xmlFragment, insertIndex, 0);
    resultInfo = { newBlockIndex: insertIndex };
  }

  agentPresence.updateSessionCursor(session.sessionId, newPos, newPos);

  const newResolved = resolveCursorPosition(xmlFragment, newPos);

  return {
    success: true,
    ...resultInfo,
    cursor: {
      block: newResolved.blockIndex,
      offset: newResolved.offset,
      blockType: newResolved.blockType,
    },
  };
}

module.exports = { init, name, description, inputSchema, handler };
