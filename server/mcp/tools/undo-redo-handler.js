/**
 * Shared handler for undo/redo MCP tools.
 *
 * Both tools follow the same flow: get session, check ability,
 * perform operation, resolve cursor, return result.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { createCursorPosition, resolveCursorPosition, getCursorContext } = require('../yjs/cursor-operations');

/**
 * @param {object} opts
 * @param {string} opts.operationName - 'undo' or 'redo'
 * @param {string} opts.resultKey - 'undone' or 'redone'
 * @param {Function} opts.canPerform - (undoManager) => boolean
 * @param {Function} opts.perform - (undoManager) => void
 */
async function handleUndoRedo(args, agentToken, persistenceProvider, opts) {
  if (!persistenceProvider) throw new Error(`${opts.operationName} tool not initialized`);

  const { docGuid } = args;

  // Get or create session (verifies access and role internally)
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 3600, { requiredRole: 'editor' });

  if (!session || !session.cursor) {
    throw new Error('Failed to get session');
  }

  const undoManager = session.undoManager;

  if (!undoManager || !opts.canPerform(undoManager)) {
    return {
      success: true,
      [opts.resultKey]: false,
      message: `Nothing to ${opts.operationName}`,
      cursor: null,
    };
  }

  // Link-protocol allowlist (D-6) is NOT applied here by design: undo/redo
  // replay previously-stored CRDT state — they never author a new href. Any
  // href these reintroduce was already validated by the write boundary that
  // first stored it (modify's sanitizeLinkHrefs, or the import pipeline). The
  // only href sources are those write boundaries, so re-sanitizing on replay
  // would be redundant work with no new input to inspect.
  opts.perform(undoManager);

  // Re-resolve cursor positions (they may have changed)
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  let currentHead = session.cursor.head;
  let resolved = resolveCursorPosition(xmlFragment, currentHead);
  let warning = null;

  if (!resolved) {
    const safePos = createCursorPosition(xmlFragment, 0, 0);
    agentPresence.updateSessionCursor(session.sessionId, safePos, safePos);
    currentHead = safePos;
    resolved = resolveCursorPosition(xmlFragment, currentHead);
    warning = `Cursor position became invalid after ${opts.operationName}, reset to document start`;
  }

  const context = getCursorContext(xmlFragment, currentHead, 50, 50);

  const result = {
    success: true,
    [opts.resultKey]: true,
    cursor: {
      block: resolved.blockIndex,
      offset: resolved.offset,
      blockType: resolved.blockType,
      context: context ? `${context.before}|${context.after}` : '',
    },
  };

  if (warning) {
    result.warning = warning;
  }

  return result;
}

module.exports = { handleUndoRedo };
