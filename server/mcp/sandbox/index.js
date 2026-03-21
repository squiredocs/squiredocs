/**
 * Sandbox module
 * Main entry point for sandboxed TypeScript execution
 *
 * This module orchestrates:
 * 1. TypeScript compilation (on the host thread)
 * 2. Worker thread spawning for isolated script execution
 * 3. Real-time streaming of incremental Y.Doc updates
 * 4. Selection highlighting via unified queue (mutations and XPath queries)
 *
 * Script execution runs in a separate V8 isolate (worker_threads) with:
 * - Separate V8 heap (no shared JS objects)
 * - vm.createContext sandbox inside the worker (defense in depth)
 * - Resource limits (memory caps)
 * - External timeout enforcement
 */

const { compileTypeScript } = require('./compiler');
const { executeSandboxed } = require('./executor');
const { wrapForTracking } = require('./yjs-interceptor');
const { OperationTracker } = require('./operation-tracker');
const { executeInWorker } = require('./bridge');

/**
 * Executes a TypeScript script in a sandboxed worker thread with operation tracking
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

  try {
    // 1. Compile TypeScript to JavaScript on the host (avoids bundling esbuild in worker)
    jsCode = compileTypeScript(tsScript);
  } catch (error) {
    return {
      success: false,
      error: error.message,
      operationCount: 0,
    };
  }

  // 2. Delegate execution to the worker bridge
  return executeInWorker(jsCode, session, xmlFragment, { timeout });
}

/**
 * Executes a TypeScript comparison script
 *
 * @param {string} tsScript - TypeScript source code
 * @param {Y.XmlFragment} doc1 - First document version (ephemeral snapshot)
 * @param {Y.XmlFragment} doc2 - Second document version (ephemeral snapshot)
 * @param {object} options - Execution options
 * @param {number} [options.timeout=5000] - Execution timeout in milliseconds
 * @returns {Promise<any>} - Value returned by the script
 */
async function executeComparisonScript(tsScript, doc1, doc2, options = {}) {
  const { timeout = 5000 } = options;

  try {
    // 1. Compile TypeScript to JavaScript
    const jsCode = compileTypeScript(tsScript);

    // 2. Execute in sandbox
    // Note: documents are ephemeral snapshots - modifications won't persist
    const result = await executeComparisonSandboxed(
      jsCode,
      doc1,
      doc2,
      timeout
    );

    return result;
  } catch (error) {
    throw error;
  }
}

/**
 * Execute comparison script in sandboxed environment
 * Simplified version of executeSandboxed for comparing ephemeral document snapshots
 * @param {string} jsCode - Compiled JavaScript code
 * @param {Y.XmlFragment} doc1 - First document snapshot
 * @param {Y.XmlFragment} doc2 - Second document snapshot
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

    // Formatted content helpers (read/write symmetry)
    getFormattedContent: helpers.getFormattedContent,
    setFormattedContent: helpers.setFormattedContent,
    getPlainText: helpers.getPlainText,
    getParagraphs: helpers.getParagraphs,
    setParagraphs: helpers.setParagraphs,

    // Comparison-specific helpers
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
    // Note: These don't have a default context, so you must pass doc1 or doc2
    xpath: (expression, contextNode) => {
      if (!contextNode) {
        throw new Error('xpath() requires a context node. Usage: xpath(expression, doc1) or xpath(expression, doc2)');
      }
      return xpathQuery(expression, contextNode);
    },

    xpathFirst: (expression, contextNode) => {
      if (!contextNode) {
        throw new Error('xpathFirst() requires a context node. Usage: xpathFirst(expression, doc1) or xpathFirst(expression, doc2)');
      }
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
};
