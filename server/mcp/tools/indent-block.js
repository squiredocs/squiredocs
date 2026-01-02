/**
 * indent_block MCP Tool
 *
 * Move the current block into its previous sibling's children (creates hierarchy).
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

const name = 'indent_block';

const description = `Move the current block into its previous sibling's children to create hierarchical structure.

This enables creating nested lists, sub-sections, and other hierarchical content.

PARAMETERS:
- docGuid: Document UUID (required)

RETURNS:
- success, newPath (hierarchical path of indented block)`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: { type: 'string', format: 'uuid' },
  },
  required: ['docGuid'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('indent_block tool not initialized');

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
  const currentBlockIndex = currentPath[0];
  const siblingIndex = getSiblingIndex(currentPath);

  // Must be at top level and not the first block to indent
  if (currentPath.length !== 1) {
    throw new Error('Can only indent top-level blocks');
  }

  if (siblingIndex <= 0) {
    throw new Error('Cannot indent the first block or block without previous sibling');
  }

  const blocks = xmlFragment.toArray();
  const targetBlock = blocks[currentBlockIndex];
  const previousBlock = blocks[currentBlockIndex - 1];

  // The previous block must be able to contain children (list, etc.)
  if (!(previousBlock instanceof Y.XmlElement)) {
    throw new Error('Previous block cannot contain child elements');
  }

  // For now, only allow indenting into lists
  if (!['bulletList', 'orderedList'].includes(previousBlock.nodeName)) {
    throw new Error('Can only indent into list blocks for now');
  }

  // Remove the block from top level
  let removedBlock;
  ydoc.transact(() => {
    removedBlock = xmlFragment.delete(currentBlockIndex, 1)[0];

    // Convert the block to a listItem if it's not already
    if (removedBlock.nodeName !== 'listItem') {
      // Wrap the block content in a listItem
      const listItem = new Y.XmlElement('listItem');
      // Move the paragraph from the block into the listItem
      const paragraph = removedBlock.toArray()[0]; // Assume first child is paragraph
      if (paragraph) {
        removedBlock.delete(0, 1);
        listItem.insert(0, [paragraph]);
      }
      removedBlock = listItem;
    }

    // Add as child of previous block (list)
    previousBlock.insert(previousBlock.length, [removedBlock]);
  }, undoManager);

  // Update cursor to new position (inside the indented block)
  const newPath = [currentBlockIndex - 1, previousBlock.length - 1, 0, 0]; // [listBlock, listItem, paragraph, text]
  const newPos = createCursorPosition(xmlFragment, currentBlockIndex - 1, 0); // For now, keep it simple

  agentPresence.updateSessionCursor(session.sessionId, newPos, newPos);

  return {
    success: true,
    newPath,
    message: 'Block indented successfully',
  };
}

module.exports = { init, name, description, inputSchema, handler };
