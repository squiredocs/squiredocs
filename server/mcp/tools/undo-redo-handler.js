/**
 * Shared handler for the undo/redo MCP tools — and, through executeTool, for
 * the chat endpoints (POST /api/docs/:docId/undo|redo). One mechanism, both
 * surfaces (feature 016): both dispatch into the log-derived
 * server/undo/undo-service.js core.
 *
 * The session Y.UndoManager era is over: no presence session is created,
 * extended, or consulted here (FR-008) — the editor-role check is a direct
 * role lookup (FR-025), and cursor restoration is retired from the result
 * shape (RBD-5; the result carries the post-operation document `clock`
 * instead).
 */
const documents = require('../../documents');
const undoService = require('../../undo/undo-service');

/**
 * @param {object} args - { docGuid }
 * @param {object} agentToken - Decoded agent token (userId, agentName)
 * @param {object} persistenceProvider - PostgresPersistence
 * @param {object} opts
 * @param {'undo'|'redo'} opts.operationName
 */
async function handleUndoRedo(args, agentToken, persistenceProvider, opts) {
  if (!persistenceProvider) throw new Error(`${opts.operationName} tool not initialized`);

  const { docGuid } = args;

  // Editor role, verified WITHOUT creating a presence session (FR-025).
  const role = await documents.getRole(docGuid, agentToken.userId);
  if (!role || role === 'viewer') {
    throw new Error(`You need editor access to ${opts.operationName} in this document`);
  }

  // Link-protocol allowlist (D-6) is NOT applied here by design: undo/redo
  // replay previously-stored CRDT state — they never author a new href. Any
  // href these reintroduce was already validated by the write boundary that
  // first stored it (modify's sanitizeLinkHrefs, or the import pipeline). The
  // only href sources are those write boundaries, so re-sanitizing on replay
  // would be redundant work with no new input to inspect.
  const target = {
    docGuid,
    userId: agentToken.userId,
    agentName: agentToken.agentName,
  };
  const deps = { persistence: persistenceProvider };

  if (opts.operationName === 'undo') {
    return undoService.performUndo(target, deps);
  }
  return undoService.performRedo(target, deps);
}

module.exports = { handleUndoRedo };
