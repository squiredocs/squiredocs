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
const { createOperationSelection } = require('../yjs/cursor-operations');
const agentPresence = require('../agent-presence');
const { MutationAggregator } = require('../mutation-aggregator');

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
  let mutationAggregator;
  let executionError = null;

  // Flag to prevent recursive onOperation calls during cursor position creation
  let inOnOperation = false;

  // Create mutation aggregator for time-based mutation buffering
  mutationAggregator = new MutationAggregator({
    sessionId: session.sessionId,
    xmlFragment,
    windowMs: 200, // Aggregate mutations within 200ms windows
    onFlush: (spans) => {
      // Clear any pending XPath highlights so mutations appear immediately
      const highlightSession = agentPresence.getSession(session.sessionId);
      if (highlightSession && highlightSession.highlightQueue) {
        console.log(`[MutationAggregator] Clearing ${highlightSession.highlightQueue.positions.length - highlightSession.highlightQueue.currentIndex} pending XPath highlights`);
        // Cancel the pending timeout to stop the old queue
        if (highlightSession.highlightQueue.timeoutId) {
          clearTimeout(highlightSession.highlightQueue.timeoutId);
        }
        highlightSession.highlightQueue = null;
      }

      // Queue aggregated expanding spans with random delays (80-240ms) to show progression
      agentPresence.queueHighlightSequence(session.sessionId, spans, 80, 240);
    },
  });

  // Create onOperation callback for real-time selection highlighting
  const onOperation = (operation, target) => {
    // Prevent recursion - createOperationSelection uses toArray which triggers onOperation
    if (inOnOperation) {
      return;
    }

    // Only highlight mutations, not reads (to avoid noise)
    if (operation.category !== 'mutation') {
      return;
    }

    try {
      inOnOperation = true;

      const selection = createOperationSelection(xmlFragment, operation);
      if (selection) {
        mutationAggregator.addMutation({
          ...selection,
          timestamp: operation.timestamp,
        });
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
      // Flush any pending highlights (both xpath/read highlights and buffered mutations)
      // before queueing new ones. This ensures the caller's highlights don't get cleared
      // when MutationAggregator flushes its buffered mutations.
      flushPendingHighlights: () => {
        mutationAggregator.flush();
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

    // 6. Force flush aggregated mutations after transaction completes
    // This ensures immediate visual feedback without waiting for the time window
    await mutationAggregator.flush();

    // 7. If execution failed, undo the changes and return error
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

    // 8. Get operation summary
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
  } finally {
    // Always destroy aggregator to prevent memory leaks
    if (mutationAggregator) {
      mutationAggregator.destroy();
    }
  }
}

/**
 * Executes a TypeScript comparison script in read-only mode
 *
 * @param {string} tsScript - TypeScript source code
 * @param {Y.XmlFragment} doc1 - First document version
 * @param {Y.XmlFragment} doc2 - Second document version
 * @param {object} options - Execution options
 * @param {number} [options.timeout=5000] - Execution timeout in milliseconds
 * @returns {Promise<any>} - Value returned by the script
 */
async function executeComparisonScript(tsScript, doc1, doc2, options = {}) {
  const { timeout = 5000 } = options;

  try {
    // 1. Compile TypeScript to JavaScript
    const jsCode = compileTypeScript(tsScript);

    // 2. Wrap documents in read-only proxies
    const readOnlyDoc1 = makeReadOnly(doc1);
    const readOnlyDoc2 = makeReadOnly(doc2);

    // 3. Execute in sandbox with comparison-specific context
    const result = await executeComparisonSandboxed(
      jsCode,
      readOnlyDoc1,
      readOnlyDoc2,
      timeout
    );

    return result;
  } catch (error) {
    throw error;
  }
}

/**
 * Wrap Y.js object in read-only proxy to prevent modifications
 * @param {object} obj - Y.js object to wrap
 * @returns {Proxy} - Read-only proxy
 */
function makeReadOnly(obj) {
  return new Proxy(obj, {
    set() {
      throw new Error('Cannot modify documents in comparison mode');
    },
    get(target, prop) {
      const value = target[prop];

      // Intercept mutation methods
      if (typeof value === 'function') {
        const mutationMethods = ['insert', 'delete', 'push', 'unshift', 'setAttribute', 'format'];
        if (mutationMethods.includes(prop)) {
          return () => {
            throw new Error('Cannot modify documents in comparison mode');
          };
        }

        // Wrap read methods that return Y.js objects
        const readMethods = ['get', 'toArray'];
        if (readMethods.includes(prop)) {
          return (...args) => {
            const result = value.apply(target, args);
            // Wrap returned objects recursively
            if (result && typeof result === 'object') {
              if (Array.isArray(result)) {
                return result.map(item => makeReadOnly(item));
              }
              return makeReadOnly(result);
            }
            return result;
          };
        }
      }

      return value;
    }
  });
}

/**
 * Execute comparison script in sandboxed environment
 * Similar to executeSandboxed but simplified for read-only comparison
 * @param {string} jsCode - Compiled JavaScript code
 * @param {Proxy} doc1 - Read-only wrapped first document
 * @param {Proxy} doc2 - Read-only wrapped second document
 * @param {number} timeout - Execution timeout
 * @returns {any} - Script result
 */
function executeComparisonSandboxed(jsCode, doc1, doc2, timeout) {
  const vm = require('vm');
  const Y = require('yjs');
  const helpers = require('./helpers');
  const { xpath: xpathQuery, xpathFirst: xpathFirstQuery } = require('./xpath');

  // Create a sandbox context for comparison (no tracking, no operations)
  const sandbox = {
    // Expose both documents
    _doc1: doc1,
    _doc2: doc2,

    // Expose Yjs namespace (read-only, no new instances needed)
    Y: {
      XmlFragment: Y.XmlFragment,
      XmlElement: Y.XmlElement,
      XmlText: Y.XmlText,
    },

    // Helper functions (existing helpers from modify tool)
    findTextNode: helpers.findTextNode,
    extractText: helpers.extractText,
    getTextContent: helpers.getTextContent,
    findElements: helpers.findElements,
    findByNodeName: helpers.findByNodeName,
    findByText: helpers.findByText,

    // Comparison-specific helpers (will be added to helpers.js)
    extractPlainText: helpers.extractPlainText || helpers.getTextContent, // Alias
    getBlockCount: helpers.getBlockCount,
    getWordCount: helpers.getWordCount,
    getCharacterCount: helpers.getCharacterCount,
    getElementByType: helpers.getElementByType,
    extractLinks: helpers.extractLinks,
    getAttributes: helpers.getAttributes,
    hasAttribute: helpers.hasAttribute,
    findAllByText: helpers.findAllByText || helpers.findByText, // Alias

    // XPath query functions (no highlighting in comparison mode)
    xpath: (expression, contextNode) => {
      return xpathQuery(expression, contextNode);
    },

    xpathFirst: (expression, contextNode) => {
      return xpathFirstQuery(expression, contextNode);
    },

    // Exports for module pattern
    exports: {},
    module: { exports: {} },

    // Console for debugging
    console: {
      log: (...args) => console.log('[ComparisonSandbox]', ...args),
      error: (...args) => console.error('[ComparisonSandbox]', ...args),
    },
  };

  try {
    // Compile the script with comparison signature
    const script = new vm.Script(`
      ${jsCode}

      // Call the default export function with both documents
      let compareFunction;
      if (typeof module.exports === 'object' && typeof module.exports.default === 'function') {
        compareFunction = module.exports.default;
      } else if (typeof exports.default === 'function') {
        compareFunction = exports.default;
      } else if (typeof module.exports === 'function') {
        compareFunction = module.exports;
      } else {
        throw new Error('Script must export a default function: export default function compare(doc1, doc2) { ... }');
      }

      // Execute the comparison function with both documents
      compareFunction(_doc1, _doc2);
    `, {
      filename: 'comparison-script.js',
      timeout,
    });

    // Run the script and capture the result
    const result = script.runInNewContext(sandbox, {
      timeout,
      displayErrors: true,
    });

    return result;
  } catch (error) {
    // Enhanced error handling
    if (error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error(
        `Script execution timed out after ${timeout}ms.\n` +
        `Hint: Check for infinite loops or long-running operations.`
      );
    }

    throw new Error(`Script execution failed: ${error.message}`);
  }
}

module.exports = {
  executeScript,
  executeComparisonScript,
  // Export individual components for testing
  compileTypeScript,
  executeSandboxed,
  wrapForTracking,
  OperationTracker,
  makeReadOnly,
};
