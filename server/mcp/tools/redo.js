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

═══════════════════════════════════════════════════════════════════════════
REDO OPERATIONS
═══════════════════════════════════════════════════════════════════════════

Redo is derived from the document's durable edit log, scoped to your own
undone edits: it reapplies this agent identity's most-recently-undone edit
first (last undone, first redone). Like undo, it works from any server
instance, at any time, and survives session expiry and server restarts —
the undo/redo chain never breaks across restarts.

Redo obeys the same surgical rules as undo: edits made in the meantime (by
anyone) are preserved untouched, and anything later edits already superseded
is skipped, not resurrected.

WHEN TO USE THIS:
- Restore an undone change
- Go forward in edit history

PARAMETERS:
- docGuid: Document UUID (required)

RETURNS:
- success: true if the operation executed
- redone: true if an edit was reapplied; false with an explanatory message
  when there is honestly nothing (left) to redo — no undone edit of yours
  with a recorded inverse (edits undone before this feature shipped cannot
  be redone), everything superseded, or a concurrent request got there
  first. Never an error for an empty result.
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
    operationName: 'redo',
  });
}

module.exports = { init, name, description, inputSchema, handler };
