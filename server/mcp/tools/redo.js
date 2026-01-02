/**
 * redo MCP Tool
 *
 * Redo a previously undone operation.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition, getCursorContext } = require('../yjs/cursor-operations');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
}

const name = 'redo';

const description = `Redo a previously undone operation.

═══════════════════════════════════════════════════════════════════════════
REDO OPERATIONS
═══════════════════════════════════════════════════════════════════════════

Redo an operation that was undone. Each agent has an independent redo stack.
Cursor position is restored to where it was after the operation.

WHEN TO USE THIS:
- Restore an undone change
- Go forward in edit history

PARAMETERS:
- docGuid: Document UUID (required)

RETURNS:
- success: true if operation succeeded
- redone: true if something was redone, false if nothing to redo
- cursor: Restored cursor position`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: { type: 'string', format: 'uuid' },
  },
  required: ['docGuid'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('redo tool not initialized');

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

  const undoManager = session.undoManager;

  if (!undoManager || !undoManager.canRedo()) {
    return {
      success: true,
      redone: false,
      message: 'Nothing to redo',
      cursor: null,
    };
  }

  // Perform redo
  undoManager.redo();

  // Re-resolve cursor positions (they may have changed)
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  const currentHead = session.cursor.head;
  const resolved = resolveCursorPosition(xmlFragment, currentHead);

  if (!resolved) {
    throw new Error('Cursor position became invalid after redo');
  }

  const context = getCursorContext(xmlFragment, currentHead, 50, 50);

  return {
    success: true,
    redone: true,
    cursor: {
      block: resolved.blockIndex,
      offset: resolved.offset,
      blockType: resolved.blockType,
      context: context ? `${context.before}|${context.after}` : '',
    },
  };
}

module.exports = { init, name, description, inputSchema, handler };
