/**
 * redo MCP Tool
 *
 * Redo a previously undone operation.
 */

const { handleUndoRedo } = require('./undo-redo-handler');

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
  return handleUndoRedo(args, agentToken, persistenceProvider, {
    operationName: 'redo',
  });
}

module.exports = { init, name, description, inputSchema, handler };
