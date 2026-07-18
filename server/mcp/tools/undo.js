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

═══════════════════════════════════════════════════════════════════════════
UNDO OPERATIONS
═══════════════════════════════════════════════════════════════════════════

Undo is derived from the document's durable edit log, scoped to your own
edits: only edits made by this agent identity are candidates — never another
agent's or a human's. It works from any server instance, at any time after
the edit, and survives session expiry and server restarts.

The undo is surgical, not a rollback: edits made after yours (by anyone) are
preserved untouched; content your edit deleted comes back; content that later
edits already deleted or replaced is skipped, not resurrected. Repeated calls
step back through your prior edits in reverse chronological order, skipping
edits already undone.

WHEN TO USE THIS:
- Reverse a mistake
- Try different approaches
- Experiment with edits

PARAMETERS:
- docGuid: Document UUID (required)

RETURNS:
- success: true if the operation executed
- undone: true if an edit was reverted; false with an explanatory message
  when there is honestly nothing (left) to undo — no recorded edit of yours,
  everything already superseded by later edits, or a concurrent request got
  there first. Never an error for an empty result.
- message: what happened, in plain words
- clock: the document's post-operation log clock (use it to keep your
  observed document state current without a re-read)`;

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
