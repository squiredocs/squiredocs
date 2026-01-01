/**
 * delete MCP Tool
 *
 * Delete text (selection or by direction/unit/count).
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition, moveCursor, getTextInSelection } = require('../yjs/cursor-operations');
const { deleteText } = require('../yjs/text-operations');

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
  const hasSelection = JSON.stringify(anchorPos) !== JSON.stringify(headPos);

  let deletedText = '';
  let newCursorPos;

  if (hasSelection) {
    // Delete selection
    deletedText = getTextInSelection(xmlFragment, anchorPos, headPos);

    const anchorResolved = resolveCursorPosition(xmlFragment, anchorPos);
    const headResolved = resolveCursorPosition(xmlFragment, headPos);

    const isForward = anchorResolved.blockIndex < headResolved.blockIndex ||
      (anchorResolved.blockIndex === headResolved.blockIndex && anchorResolved.offset < headResolved.offset);

    const startResolved = isForward ? anchorResolved : headResolved;
    const endResolved = isForward ? headResolved : anchorResolved;

    ydoc.transact(() => {
      deleteText(xmlFragment, startResolved.blockIndex, startResolved.offset,
        endResolved.blockIndex, endResolved.offset);
    }, undoManager);

    // Cursor at deletion point
    newCursorPos = isForward ? anchorPos : headPos;
  } else {
    // Delete by direction/unit/count
    const currentResolved = resolveCursorPosition(xmlFragment, headPos);

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

    ydoc.transact(() => {
      deleteText(xmlFragment, startResolved.blockIndex, startResolved.offset,
        endResolved.blockIndex, endResolved.offset);
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
