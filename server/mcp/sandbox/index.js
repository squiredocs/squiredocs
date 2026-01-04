/**
 * Sandbox module
 * Main entry point for sandboxed TypeScript execution
 *
 * This module orchestrates:
 * 1. TypeScript compilation
 * 2. Yjs object wrapping with operation tracking
 * 3. Sandboxed execution
 * 4. Cursor animation
 */

const { compileTypeScript } = require('./compiler');
const { executeSandboxed } = require('./executor');
const { wrapForTracking } = require('./yjs-interceptor');
const { OperationTracker } = require('./operation-tracker');
const { animateCursor } = require('./cursor-animator');

/**
 * Executes a TypeScript script in a sandboxed environment with operation tracking
 *
 * @param {string} tsScript - TypeScript source code
 * @param {object} session - Agent session (contains provider, ydoc, sessionId)
 * @param {Y.XmlFragment} xmlFragment - Document fragment to edit
 * @param {object} options - Execution options
 * @param {number} [options.timeout=5000] - Execution timeout in milliseconds
 * @param {boolean} [options.animate=true] - Whether to animate cursor
 * @returns {Promise<object>} - Execution result { success, operationCount, summary, error }
 */
async function executeScript(tsScript, session, xmlFragment, options = {}) {
  const {
    timeout = 5000,
    animate = true,
  } = options;

  let jsCode;
  let tracker;
  let executionError = null;

  try {
    // 1. Compile TypeScript to JavaScript
    jsCode = compileTypeScript(tsScript);

    // 2. Create operation tracker
    tracker = new OperationTracker();

    // 3. Wrap Yjs fragment with operation tracking
    const wrappedFragment = wrapForTracking(xmlFragment, tracker);

    // 4. Execute script in a transaction for atomic undo
    const ydoc = session.provider.doc;
    ydoc.transact(() => {
      try {
        executeSandboxed(jsCode, wrappedFragment, tracker, timeout);
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

    // 7. Animate cursor (async, non-blocking)
    if (animate && operationCount > 0) {
      const cursorSequence = tracker.generateCursorSequence();
      // Fire and forget - don't await
      animateCursor(session, xmlFragment, cursorSequence);
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
  animateCursor,
};
