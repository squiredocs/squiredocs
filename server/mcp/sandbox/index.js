/**
 * Sandbox module
 * Main entry point for sandboxed TypeScript execution
 *
 * This module orchestrates:
 * 1. TypeScript compilation
 * 2. Yjs object wrapping with operation tracking
 * 3. Sandboxed execution
 * 4. Real-time selection highlighting via unified queue (mutations and XPath queries)
 */

const { compileTypeScript } = require('./compiler');
const { executeSandboxed } = require('./executor');
const { wrapForTracking } = require('./yjs-interceptor');
const { OperationTracker } = require('./operation-tracker');
const { createCursorPositionFromPath } = require('../yjs/cursor-operations');
const agentPresence = require('../agent-presence');

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

  // Flag to prevent recursive onOperation calls during cursor position creation
  let inOnOperation = false;

  // Create onOperation callback for real-time selection highlighting
  const onOperation = (operation, target) => {
    // Prevent recursion - createCursorPositionFromPath uses toArray which triggers onOperation
    if (inOnOperation) {
      return;
    }

    // Only highlight mutations, not reads (to avoid noise)
    if (operation.category !== 'mutation') {
      return;
    }

    try {
      inOnOperation = true;

      let anchor = null;
      let head = null;

      // Determine the path to use
      let path = operation.path;
      if (path.length === 0 && operation.args && typeof operation.args[0] === 'number') {
        // Root-level operation - use the index as the block path
        const blockIndex = operation.args[0];
        const blocks = xmlFragment.toArray();
        if (blockIndex >= 0 && blockIndex < blocks.length) {
          path = [blockIndex];
        }
      }

      if (path.length === 0) {
        return; // Can't create a selection without a valid path
      }

      // Calculate selection range based on operation type
      const { type, args } = operation;

      if (type === 'insert' && operation.target === 'XmlText' && typeof args[0] === 'number') {
        // text.insert(offset, content) - select the inserted text
        const startOffset = args[0];
        const content = args[1];
        const length = typeof content === 'string' ? content.length : 0;
        anchor = createCursorPositionFromPath(xmlFragment, path, startOffset);
        head = createCursorPositionFromPath(xmlFragment, path, startOffset + length);
      } else if (type === 'format' && typeof args[0] === 'number' && typeof args[1] === 'number') {
        // text.format(offset, length, attrs) - select the formatted range
        const startOffset = args[0];
        const length = args[1];
        anchor = createCursorPositionFromPath(xmlFragment, path, startOffset);
        head = createCursorPositionFromPath(xmlFragment, path, startOffset + length);
      } else if (type === 'delete' && typeof args[0] === 'number') {
        // delete(offset, length) - just show cursor at deletion point
        const offset = args[0];
        anchor = createCursorPositionFromPath(xmlFragment, path, offset);
        head = anchor;
      } else {
        // Default: show cursor at start of the affected element
        anchor = createCursorPositionFromPath(xmlFragment, path, 0);
        head = anchor;
      }

      // Queue the highlight (adds to queue with random delay)
      if (anchor && head) {
        agentPresence.queueHighlight(session.sessionId, anchor, head);
      }
    } catch (err) {
      // Non-fatal: log but don't interrupt execution
      console.warn('[executeScript] onOperation error:', err.message);
    } finally {
      inOnOperation = false;
    }
  };

  try {
    // 1. Compile TypeScript to JavaScript
    jsCode = compileTypeScript(tsScript);

    // 2. Create operation tracker
    tracker = new OperationTracker();

    // 3. Wrap Yjs fragment with operation tracking and real-time selection callback
    const wrappedFragment = wrapForTracking(xmlFragment, tracker, [], onOperation);

    // 4. Create highlight context for XPath query visualization
    const highlightContext = {
      xmlFragment,
      queueHighlights: (positions) => {
        // Random delay between 80-240ms for each highlight
        agentPresence.queueHighlightSequence(session.sessionId, positions);
      },
    };

    // 5. Execute script in a transaction for atomic undo
    const ydoc = session.provider.doc;
    ydoc.transact(() => {
      try {
        executeSandboxed(jsCode, wrappedFragment, tracker, timeout, onOperation, highlightContext);
      } catch (error) {
        // Capture error but don't throw yet (transaction will commit)
        executionError = error;
      }
    }, session.undoManager);

    // 6. If execution failed, undo the changes and return error
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

    // 7. Get operation summary
    const operationCount = tracker.getOperationCount();
    const summary = tracker.getOperationSummary();

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
