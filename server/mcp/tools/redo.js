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

const description = `Redo an edit of yours that was previously undone.

Scoped to your own undone edits — this agent identity's only, reapplying the
most recently undone first. Derived from the durable edit log: works from any
server instance, at any time, and survives session expiry and server
restarts. Same surgical rules as undo: edits made in the meantime (by anyone)
are preserved untouched; anything later edits superseded is skipped.

RETURNS: success; redone (false with an explanatory message when there is
nothing left to redo — no undone edit of yours with a recorded inverse,
everything superseded, or a concurrent request won; never an error); message;
clock (the post-operation log clock).`;

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
