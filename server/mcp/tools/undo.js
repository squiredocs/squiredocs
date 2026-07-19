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

const description = `Undo your most recent edit to this document.

Scoped to your own edits — only this agent identity's, never another agent's
or a human's. Derived from the durable edit log: works from any server
instance, at any time, and survives session expiry and server restarts.
Surgical, not a rollback: edits made after yours (by anyone) are preserved
untouched; content later edits already replaced is skipped, not resurrected.
Repeated calls step back through your prior edits.

RETURNS: success; undone (false with an explanatory message when there is
nothing left to undo — never an error); message; clock (the post-operation
log clock).`;

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
  });
}

module.exports = { init, name, description, inputSchema, handler };
