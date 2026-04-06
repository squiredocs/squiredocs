/**
 * undo MCP Tool
 *
 * Undo the last operation made by this agent.
 */

const { handleUndoRedo } = require('./undo-redo-handler');

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
  return handleUndoRedo(args, agentToken, persistenceProvider, {
    operationName: 'undo',
    resultKey: 'undone',
    canPerform: (um) => um.canUndo(),
    perform: (um) => um.undo(),
  });
}

module.exports = { init, name, description, inputSchema, handler };
