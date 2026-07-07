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
const { executeSandboxed, executeComparisonSandboxed } = require('./executor');
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
 * @param {Array<{docGuid: string, snapshot: Buffer}>} [options.sources] - Read-only
 *   source document snapshots exposed to the script as the `sources` global
 * @returns {Promise<object>} - Execution result { success, operationCount, summary, error }
 */
async function executeScript(tsScript, session, xmlFragment, options = {}) {
  const { timeout = 5000, sources = [] } = options;

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
  return executeInWorker(jsCode, session, xmlFragment, { timeout, sources });
}

/**
 * Executes a TypeScript comparison script in an isolated-vm isolate
 *
 * @param {string} tsScript - TypeScript source code
 * @param {Buffer|Uint8Array} snapshot1 - First document version (Y.Doc update bytes)
 * @param {Buffer|Uint8Array} snapshot2 - Second document version (Y.Doc update bytes)
 * @param {object} options - Execution options
 * @param {number} [options.timeout=5000] - Execution timeout in milliseconds
 * @returns {Promise<any>} - Value returned by the script
 */
async function executeComparisonScript(tsScript, snapshot1, snapshot2, options = {}) {
  const { timeout = 5000 } = options;

  // 1. Compile TypeScript to JavaScript
  const jsCode = compileTypeScript(tsScript);

  // 2. Execute in isolated-vm (same isolation as edit scripts)
  return executeComparisonSandboxed(jsCode, snapshot1, snapshot2, timeout);
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
