/**
 * undo MCP Tool
 *
 * Undo the last operation made by this agent.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition, getCursorContext } = require('../yjs/cursor-operations');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
}

const name = 'undo';

const description = `Undo the last operation made by this agent.

═══════════════════════════════════════════════════════════════════════════
UNDO OPERATIONS
═══════════════════════════════════════════════════════════════════════════

Undo your last edit. Each agent has an independent undo stack.
Cursor position is restored to where it was before the operation.

WHEN TO USE THIS:
- Reverse a mistake
- Try different approaches
- Experiment with edits

PARAMETERS:
- docGuid: Document UUID (required)

RETURNS:
- success: true if operation succeeded
- undone: true if something was undone, false if nothing to undo
- cursor: Restored cursor position`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: { type: 'string', format: 'uuid' },
  },
  required: ['docGuid'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('undo tool not initialized');

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

  if (!undoManager || !undoManager.canUndo()) {
    return {
      success: true,
      undone: false,
      message: 'Nothing to undo',
      cursor: null,
    };
  }

  // Perform undo
  undoManager.undo();

  // Re-resolve cursor positions (they may have changed)
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  const currentHead = session.cursor.head;
  const resolved = resolveCursorPosition(xmlFragment, currentHead);

  if (!resolved) {
    // Cursor position became invalid, reset to start
    throw new Error('Cursor position became invalid after undo');
  }

  const context = getCursorContext(xmlFragment, currentHead, 50, 50);

  return {
    success: true,
    undone: true,
    cursor: {
      block: resolved.blockIndex,
      offset: resolved.offset,
      blockType: resolved.blockType,
      context: context ? `${context.before}|${context.after}` : '',
    },
  };
}

module.exports = { init, name, description, inputSchema, handler };
