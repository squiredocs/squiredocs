/**
 * Sandbox module
 * Main entry point for sandboxed TypeScript execution
 *
 * This module orchestrates:
 * 1. TypeScript compilation
 * 2. Yjs object wrapping with operation tracking
 * 3. Sandboxed execution
 * 4. Real-time selection highlighting
 */

const Y = require('yjs');
const { compileTypeScript } = require('./compiler');
const { executeSandboxed } = require('./executor');
const { wrapForTracking } = require('./yjs-interceptor');
const { OperationTracker } = require('./operation-tracker');
const { createCursorPositionFromPath } = require('../yjs/cursor-operations');
const agentPresence = require('../agent-presence');

/**
 * Compute the range covering all mutations
 * @param {Y.XmlFragment} xmlFragment - Document fragment
 * @param {Array<object>} mutations - Array of mutation operations
 * @returns {object|null} { anchor, head } RelativePositions or null
 */
function computeModifiedRange(xmlFragment, mutations) {
  if (!mutations || mutations.length === 0) {
    return null;
  }

  // Find min and max block indices from paths
  let minBlockIdx = Infinity;
  let maxBlockIdx = -1;

  for (const op of mutations) {
    if (op.path && op.path.length > 0) {
      const blockIdx = op.path[0];
      minBlockIdx = Math.min(minBlockIdx, blockIdx);
      maxBlockIdx = Math.max(maxBlockIdx, blockIdx);
    } else {
      // Root-level operation (like insert at doc level)
      if (op.args && typeof op.args[0] === 'number') {
        const idx = op.args[0];
        minBlockIdx = Math.min(minBlockIdx, idx);
        maxBlockIdx = Math.max(maxBlockIdx, idx);
      }
    }
  }

  if (minBlockIdx === Infinity || maxBlockIdx === -1) {
    return null;
  }

  // Create positions for the range
  const blocks = xmlFragment.toArray();
  if (blocks.length === 0) {
    return null;
  }

  // Clamp to valid range
  minBlockIdx = Math.max(0, Math.min(minBlockIdx, blocks.length - 1));
  maxBlockIdx = Math.max(0, Math.min(maxBlockIdx, blocks.length - 1));

  // Find first text node in first modified block
  const firstBlock = blocks[minBlockIdx];
  const firstTextNode = findFirstTextNode(firstBlock);
  if (!firstTextNode) {
    return null;
  }

  // Find last text node in last modified block
  const lastBlock = blocks[maxBlockIdx];
  const lastTextNode = findLastTextNode(lastBlock);
  if (!lastTextNode) {
    return null;
  }

  // Create RelativePositions
  const anchorRel = Y.createRelativePositionFromTypeIndex(firstTextNode, 0);
  const headRel = Y.createRelativePositionFromTypeIndex(lastTextNode, lastTextNode.length);

  return {
    anchor: Y.relativePositionToJSON(anchorRel),
    head: Y.relativePositionToJSON(headRel),
  };
}

/**
 * Find the first text node in a block (depth-first)
 */
function findFirstTextNode(node) {
  if (node instanceof Y.XmlText) {
    return node;
  }
  if (node instanceof Y.XmlElement) {
    const children = node.toArray();
    for (const child of children) {
      const textNode = findFirstTextNode(child);
      if (textNode) return textNode;
    }
  }
  return null;
}

/**
 * Find the last text node in a block (depth-first, reversed)
 */
function findLastTextNode(node) {
  if (node instanceof Y.XmlText) {
    return node;
  }
  if (node instanceof Y.XmlElement) {
    const children = node.toArray();
    for (let i = children.length - 1; i >= 0; i--) {
      const textNode = findLastTextNode(children[i]);
      if (textNode) return textNode;
    }
  }
  return null;
}

/**
 * Executes a TypeScript script in a sandboxed environment with operation tracking
 *
 * @param {string} tsScript - TypeScript source code
 * @param {object} session - Agent session (contains provider, ydoc, sessionId)
 * @param {Y.XmlFragment} xmlFragment - Document fragment to edit
 * @param {object} options - Execution options
 * @param {number} [options.timeout=5000] - Execution timeout in milliseconds
 * @returns {Promise<object>} - Execution result { success, operationCount, summary, error }
 */
async function executeScript(tsScript, session, xmlFragment, options = {}) {
  const { timeout = 5000 } = options;

  let jsCode;
  let tracker;
  let executionError = null;

  // Create onOperation callback for real-time selection highlighting
  const onOperation = (operation, target) => {
    try {
      // For read operations, show a brief selection highlight
      if (operation.category === 'read' && operation.path.length > 0) {
        // Try to create a selection for the accessed element
        const pos = createCursorPositionFromPath(xmlFragment, operation.path, 0);
        if (pos) {
          // Brief highlight for reads (300ms)
          agentPresence.setTemporarySelection(session.sessionId, pos, pos, 300);
        }
      }
      // For mutation operations, update cursor position
      else if (operation.category === 'mutation') {
        const pos = createCursorPositionFromPath(xmlFragment, operation.path, 0);
        if (pos) {
          agentPresence.updateSessionCursor(session.sessionId, pos, pos);
        }
      }
    } catch (err) {
      // Non-fatal: log but don't interrupt execution
      console.warn('[executeScript] onOperation error:', err.message);
    }
  };

  try {
    // 1. Compile TypeScript to JavaScript
    jsCode = compileTypeScript(tsScript);

    // 2. Create operation tracker
    tracker = new OperationTracker();

    // 3. Wrap Yjs fragment with operation tracking and real-time selection callback
    const wrappedFragment = wrapForTracking(xmlFragment, tracker, [], onOperation);

    // 4. Execute script in a transaction for atomic undo
    const ydoc = session.provider.doc;
    ydoc.transact(() => {
      try {
        executeSandboxed(jsCode, wrappedFragment, tracker, timeout, onOperation);
      } catch (error) {
        // Capture error but don't throw yet (transaction will commit)
        executionError = error;
      }
    }, session.undoManager);

    // 5. If execution failed, undo the changes and return error
    if (executionError) {
      // Undo the changes that were made before the error
      if (session.undoManager.canUndo()) {
        session.undoManager.undo();
      }
      return {
        success: false,
        error: executionError.message,
        operationCount: tracker.getOperationCount(),
      };
    }

    // 6. Get operation summary
    const operationCount = tracker.getOperationCount();
    const summary = tracker.getOperationSummary();

    // 7. Highlight final modified range for 3 seconds
    const mutations = tracker.getOperations().filter(op => op.category === 'mutation');
    if (mutations.length > 0) {
      try {
        // Find the range covering all mutations
        const modifiedRange = computeModifiedRange(xmlFragment, mutations);
        if (modifiedRange) {
          agentPresence.setTemporarySelection(
            session.sessionId,
            modifiedRange.anchor,
            modifiedRange.head,
            3000
          );
        }
      } catch (err) {
        console.warn('[executeScript] Could not highlight modified range:', err.message);
      }
    }

    return {
      success: true,
      operationCount,
      summary,
    };
  } catch (error) {
    // Compilation error or other error before execution
    return {
      success: false,
      error: error.message,
      operationCount: tracker ? tracker.getOperationCount() : 0,
    };
  }
}

module.exports = {
  executeScript,
  // Export individual components for testing
  compileTypeScript,
  executeSandboxed,
  wrapForTracking,
  OperationTracker,
};
