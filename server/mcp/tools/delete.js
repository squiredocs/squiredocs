/**
 * delete MCP Tool
 *
 * Delete text (selection or by direction/unit/count).
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition, moveCursor, getTextInSelection, createCursorPosition, resolveCursorPositionToPath, createCursorPositionFromPath } = require('../yjs/cursor-operations');
const { deleteText, getElementTextLength } = require('../yjs/text-operations');

// Persistence provider - set by init function
let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
}

const name = 'delete';

const description = `Delete selected text or delete by direction/unit/count.

═══════════════════════════════════════════════════════════════════════════
TEXT DELETION
═══════════════════════════════════════════════════════════════════════════

Delete text in two modes:
1. If selection exists: Delete selected text
2. If no selection: Delete in specified direction by unit/count

WHEN TO USE THIS:
- Remove selected text
- Backspace/delete key simulation
- Remove words or blocks

PARAMETERS:
- docGuid: Document UUID (required)
- direction: "forward" or "backward" (optional, default: "backward")
- unit: "char", "word", or "block" (optional, default: "char")
- count: Number of units (optional, default: 1)

If selection exists, direction/unit/count parameters are ignored.

RETURNS:
- success, deletedText, deletedLength, cursor`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: { type: 'string', format: 'uuid' },
    direction: { type: 'string', enum: ['forward', 'backward'] },
    unit: { type: 'string', enum: ['char', 'word', 'block'] },
    count: { type: 'integer', minimum: 1 },
  },
  required: ['docGuid'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('delete tool not initialized');

  const { docGuid, direction = 'backward', unit = 'char', count = 1 } = args;
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

  const anchorPos = session.cursor.anchor;
  const headPos = session.cursor.head;
  const hasSelection = JSON.stringify(anchorPos) !== JSON.stringify(headPos);

  let deletedText = '';
  let newCursorPos;

  if (hasSelection) {
    // Delete selection
    deletedText = getTextInSelection(xmlFragment, anchorPos, headPos);

    const anchorResolved = resolveCursorPosition(xmlFragment, anchorPos);
    const headResolved = resolveCursorPosition(xmlFragment, headPos);

    if (!anchorResolved || !headResolved) {
      throw new Error('Could not resolve selection positions');
    }

    const isForward = anchorResolved.blockIndex < headResolved.blockIndex ||
      (anchorResolved.blockIndex === headResolved.blockIndex && anchorResolved.offset < headResolved.offset);

    const startResolved = isForward ? anchorResolved : headResolved;
    const endResolved = isForward ? headResolved : anchorResolved;

    const blocks = xmlFragment.toArray();

    ydoc.transact(() => {
      if (startResolved.blockIndex === endResolved.blockIndex) {
        // Single-block deletion
        const block = blocks[startResolved.blockIndex];
        deleteText(block, startResolved.offset, endResolved.offset);
      } else {
        // Multi-block deletion - delete complete blocks to match copy behavior
        // This ensures cut/paste operations are symmetric and don't leave remnants
        const blockCount = endResolved.blockIndex - startResolved.blockIndex + 1;
        xmlFragment.delete(startResolved.blockIndex, blockCount);
      }
    }, undoManager);

    // Cursor at deletion point
    newCursorPos = isForward ? anchorPos : headPos;
  } else {
    // Delete by direction/unit/count
    const currentResolved = resolveCursorPosition(xmlFragment, headPos);

    // Special case: if unit is 'block', delete the block or nested element
    if (unit === 'block') {
      // Check if we're at a nested position (e.g., inside a listItem)
      const pathInfo = resolveCursorPositionToPath(xmlFragment, headPos);

      if (pathInfo && pathInfo.path.length > 1) {
        // We're in a nested position - find the nearest block-level element to delete
        const cursorPath = pathInfo.path;
        const blocks = xmlFragment.toArray();

        // Block-level elements that should be deleted as units
        const blockTypes = ['paragraph', 'heading', 'listItem', 'codeBlock', 'bulletList', 'orderedList'];

        // Navigate the path to find the nearest block-level element
        const [blockIndex, ...childIndices] = cursorPath;
        let currentElement = blocks[blockIndex];
        let blockPath = [blockIndex];

        // Traverse down the path, stopping at the first block-level element
        for (let i = 0; i < childIndices.length; i++) {
          const children = currentElement.toArray();
          const childIndex = childIndices[i];
          const childElement = children[childIndex];

          if (childElement instanceof Y.XmlElement && blockTypes.includes(childElement.nodeName)) {
            // Found a block-level element - this is what we want to delete
            blockPath = [blockIndex, ...childIndices.slice(0, i + 1)];
            break;
          }

          currentElement = childElement;
        }

        // Now delete the element at blockPath
        const [targetBlockIndex, ...targetChildIndices] = blockPath;
        let parentElement = blocks[targetBlockIndex];

        // Navigate to the direct parent of the element to delete
        for (let i = 0; i < targetChildIndices.length - 1; i++) {
          const children = parentElement.toArray();
          parentElement = children[targetChildIndices[i]];
        }

        // Get the index of the element to delete within its parent
        const deleteIndex = targetChildIndices[targetChildIndices.length - 1];
        const parentChildren = parentElement.toArray();

        if (deleteIndex >= 0 && deleteIndex < parentChildren.length) {
          ydoc.transact(() => {
            parentElement.delete(deleteIndex, 1);
          }, undoManager);

          // Move cursor to previous sibling, next sibling, or parent
          let newPath;
          if (deleteIndex > 0) {
            // Move to previous sibling
            newPath = [...blockPath.slice(0, -1), deleteIndex - 1];
          } else if (parentChildren.length > 1) {
            // Move to next sibling (which is now at the same index)
            newPath = blockPath;
          } else {
            // No siblings left, move to parent
            newPath = blockPath.slice(0, -1);
          }

          newCursorPos = createCursorPositionFromPath(xmlFragment, newPath, 0);
          agentPresence.updateSessionCursor(session.sessionId, newCursorPos, newCursorPos);

          const newResolved = resolveCursorPosition(xmlFragment, newCursorPos);
          return {
            success: true,
            deletedText: '',
            deletedLength: 0,
            deletedBlock: true,
            deletedPath: blockPath,
            cursor: {
              block: newResolved.blockIndex,
              offset: newResolved.offset,
              blockType: newResolved.blockType,
            },
          };
        }
      }

      // Top-level block deletion (original logic)
      const blocks = xmlFragment.toArray();
      const currentBlock = blocks[currentResolved.blockIndex];
      const blockLength = getElementTextLength(currentBlock);

      if (blockLength === 0 && blocks.length > 1) {
        // Block is empty and we have other blocks, delete it
        ydoc.transact(() => {
          xmlFragment.delete(currentResolved.blockIndex, 1);
        }, undoManager);

        // Move cursor to previous block or next block
        const newBlockIndex = currentResolved.blockIndex > 0
          ? currentResolved.blockIndex - 1
          : 0;
        newCursorPos = createCursorPosition(xmlFragment, newBlockIndex, 0);
        agentPresence.updateSessionCursor(session.sessionId, newCursorPos, newCursorPos);

        const newResolved = resolveCursorPosition(xmlFragment, newCursorPos);
        return {
          success: true,
          deletedText: '',
          deletedLength: 0,
          deletedBlock: true,
          cursor: {
            block: newResolved.blockIndex,
            offset: newResolved.offset,
            blockType: newResolved.blockType,
          },
        };
      }
    }

    // Calculate range to delete
    let startPos, endPos;

    if (direction === 'backward') {
      // Move backward to find start
      const moveResult = moveCursor(xmlFragment, headPos, 'backward', unit, count);
      if (!moveResult || moveResult.movedCount === 0) {

        return {
          success: true,
          deletedText: '',
          deletedLength: 0,
          cursor: {
            block: currentResolved.blockIndex,
            offset: currentResolved.offset,
            blockType: currentResolved.blockType,
          },
        };
      }
      startPos = moveResult.newPos;
      endPos = headPos;
    } else {
      // Move forward to find end
      const moveResult = moveCursor(xmlFragment, headPos, 'forward', unit, count);
      if (!moveResult || moveResult.movedCount === 0) {
        return {
          success: true,
          deletedText: '',
          deletedLength: 0,
          cursor: {
            block: currentResolved.blockIndex,
            offset: currentResolved.offset,
            blockType: currentResolved.blockType,
          },
        };
      }
      startPos = headPos;
      endPos = moveResult.newPos;
    }

    deletedText = getTextInSelection(xmlFragment, startPos, endPos);

    const startResolved = resolveCursorPosition(xmlFragment, startPos);
    const endResolved = resolveCursorPosition(xmlFragment, endPos);

    if (!startResolved || !endResolved) {
      throw new Error('Could not resolve deletion positions');
    }

    const blocks = xmlFragment.toArray();

    ydoc.transact(() => {
      if (startResolved.blockIndex === endResolved.blockIndex) {
        // Single-block deletion
        const block = blocks[startResolved.blockIndex];
        deleteText(block, startResolved.offset, endResolved.offset);
      } else {
        // Multi-block deletion
        // Delete from start position to end of first block
        const startBlock = blocks[startResolved.blockIndex];
        const startBlockLength = getElementTextLength(startBlock);
        if (startResolved.offset < startBlockLength) {
          deleteText(startBlock, startResolved.offset, startBlockLength);
        }

        // Delete complete blocks in between
        for (let i = startResolved.blockIndex + 1; i < endResolved.blockIndex; i++) {
          xmlFragment.delete(startResolved.blockIndex + 1, 1);
        }

        // Delete from start of last block to end position
        const adjustedEndBlockIndex = startResolved.blockIndex + 1;
        if (adjustedEndBlockIndex < xmlFragment.length) {
          const endBlock = xmlFragment.get(adjustedEndBlockIndex);
          if (endResolved.offset > 0) {
            deleteText(endBlock, 0, endResolved.offset);
          }
        }
      }
    }, undoManager);

    newCursorPos = startPos;
  }

  agentPresence.updateSessionCursor(session.sessionId, newCursorPos, newCursorPos);

  const newResolved = resolveCursorPosition(xmlFragment, newCursorPos);

  return {
    success: true,
    deletedText,
    deletedLength: deletedText.length,
    cursor: {
      block: newResolved.blockIndex,
      offset: newResolved.offset,
      blockType: newResolved.blockType,
    },
  };
}

module.exports = { init, name, description, inputSchema, handler };
