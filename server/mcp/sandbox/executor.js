/**
 * Sandbox executor
 * Executes compiled JavaScript with access to wrapped Yjs objects
 *
 * Note: This uses a direct execution approach with wrapped Yjs objects.
 * The security model relies on:
 * 1. No access to require() or other Node.js APIs (except Y namespace)
 * 2. Timeout enforcement
 * 3. Operation tracking via Yjs object wrappers
 *
 * Future enhancement: Consider isolated-vm for stronger process isolation
 */

const vm = require('vm');
const Y = require('yjs');

/**
 * Executes JavaScript code with access to wrapped Yjs fragment
 * @param {string} jsCode - Compiled JavaScript code
 * @param {object} wrappedFragment - Wrapped Y.XmlFragment with operation tracking
 * @param {number} timeout - Execution timeout in milliseconds
 * @returns {object} - Execution result
 * @throws {Error} - If execution fails or times out
 */
function executeSandboxed(jsCode, wrappedFragment, timeout = 5000) {
  // Create a sandbox context with limited access
  const sandbox = {
    // Expose wrapped fragment
    _doc: wrappedFragment,

    // Expose Yjs namespace for creating new elements
    Y: {
      XmlFragment: Y.XmlFragment,
      XmlElement: Y.XmlElement,
      XmlText: Y.XmlText,
      Doc: Y.Doc,
    },

    // Exports object for module pattern
    exports: {},
    module: { exports: {} },

    // Console for debugging (optional, can be removed for production)
    console: {
      log: (...args) => console.log('[Sandbox]', ...args),
      error: (...args) => console.error('[Sandbox]', ...args),
    },

    // No access to require, process, or other Node.js APIs
  };

  try {
    // Compile the script
    const script = new vm.Script(`
      ${jsCode}

      // Call the default export function if it exists
      // esbuild compiles "export default" to module.exports = { default: fn }
      let editFunction;
      if (typeof module.exports === 'object' && typeof module.exports.default === 'function') {
        editFunction = module.exports.default;
      } else if (typeof exports.default === 'function') {
        editFunction = exports.default;
      } else if (typeof module.exports === 'function') {
        editFunction = module.exports;
      } else {
        throw new Error('Script must export a default function: export default function edit(doc) { ... }');
      }

      // Execute the edit function with the document
      editFunction(_doc);
    `, {
      filename: 'sandbox-script.js',
      timeout,
    });

    // Run the script
    script.runInNewContext(sandbox, {
      timeout,
      displayErrors: true,
    });

    return { success: true };
  } catch (error) {
    if (error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error(`Script execution timed out after ${timeout}ms`);
    }
    throw new Error(`Script execution failed: ${error.message}`);
  }
}

module.exports = { executeSandboxed };
