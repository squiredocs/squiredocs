/**
 * outdent_block MCP Tool
 *
 * Move the current block up one level in the hierarchy (reduce nesting).
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const {
  resolveCursorPosition,
  createCursorPosition,
  resolveCursorPositionToPath,
  getParentPath,
  getSiblingIndex
} = require('../yjs/cursor-operations');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
}

const name = 'outdent_block';

const description = `Move the current block up one level in the hierarchy (reduce nesting).

This extracts nested blocks back to a higher level.

PARAMETERS:
- docGuid: Document UUID (required)

RETURNS:
- success, newPath (hierarchical path of outdented block)`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: { type: 'string', format: 'uuid' },
  },
  required: ['docGuid'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('outdent_block tool not initialized');

  const { docGuid } = args;
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

  // Get current cursor position as path
  const currentPathResolved = resolveCursorPositionToPath(xmlFragment, session.cursor.head);
  if (!currentPathResolved) {
    throw new Error('Cannot determine current cursor position');
  }

  const currentPath = currentPathResolved.path;

  // Must be nested (path length > 1) to outdent
  if (currentPath.length <= 1) {
    throw new Error('Block is already at top level, cannot outdent');
  }

  const parentPath = getParentPath(currentPath);
  const siblingIndex = getSiblingIndex(currentPath);

  // Navigate to the parent and grandparent
  const blocks = xmlFragment.toArray();
  let parentElement = blocks[parentPath[0]];

  // Navigate through parent path
  for (let i = 1; i < parentPath.length; i++) {
    if (!(parentElement instanceof Y.XmlElement)) {
      throw new Error('Invalid parent path');
    }
    parentElement = parentElement.toArray()[parentPath[i]];
  }

  if (!(parentElement instanceof Y.XmlElement)) {
    throw new Error('Parent element must be an XmlElement');
  }

  // Remove the block from its current parent
  let removedBlock;
  ydoc.transact(() => {
    removedBlock = parentElement.delete(siblingIndex, 1)[0];

    // If it's a listItem, extract the paragraph content
    if (removedBlock.nodeName === 'listItem') {
      const paragraph = removedBlock.toArray()[0]; // Assume first child is paragraph
      if (paragraph && paragraph.nodeName === 'paragraph') {
        // Convert listItem back to a standalone paragraph block
        removedBlock = paragraph;
      }
    }

    // Insert at the grandparent level (or top level if parent is top-level)
    if (parentPath.length === 1) {
      // Parent is top-level, insert after the parent block
      const insertIndex = parentPath[0] + 1;
      xmlFragment.insert(insertIndex, [removedBlock]);
    } else {
      // Parent is nested, insert as sibling of parent
      const grandParentPath = getParentPath(parentPath);
      let grandParent = blocks[grandParentPath[0]];

      // Navigate to grandparent
      for (let i = 1; i < grandParentPath.length; i++) {
        grandParent = grandParent.toArray()[grandParentPath[i]];
      }

      const parentSiblingIndex = getSiblingIndex(parentPath);
      grandParent.insert(parentSiblingIndex + 1, [removedBlock]);
    }
  }, undoManager);

  // Update cursor to new position
  const newResolved = resolveCursorPosition(xmlFragment, session.cursor.head);
  const newPos = createCursorPosition(xmlFragment, newResolved.blockIndex, newResolved.offset);

  agentPresence.updateSessionCursor(session.sessionId, newPos, newPos);

  const newPathResolved = resolveCursorPositionToPath(xmlFragment, newPos);

  return {
    success: true,
    newPath: newPathResolved ? newPathResolved.path : null,
    message: 'Block outdented successfully',
  };
}

module.exports = { init, name, description, inputSchema, handler };
