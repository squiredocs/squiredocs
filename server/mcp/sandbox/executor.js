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
const { wrapForTracking } = require('./yjs-interceptor');
const helpers = require('./helpers');

/**
 * Executes JavaScript code with access to wrapped Yjs fragment
 * @param {string} jsCode - Compiled JavaScript code
 * @param {object} wrappedFragment - Wrapped Y.XmlFragment with operation tracking
 * @param {object} tracker - Operation tracker for recording operations
 * @param {number} timeout - Execution timeout in milliseconds
 * @param {Function} [onOperation] - Optional callback called when an operation is recorded
 * @returns {object} - Execution result
 * @throws {Error} - If execution fails or times out
 */
function executeSandboxed(jsCode, wrappedFragment, tracker, timeout = 5000, onOperation = null) {
  // Create wrapped constructors that automatically track operations
  // while preserving instanceof checks
  const createWrappedConstructor = (Constructor) => {
    // Create a wrapper function that wraps instances
    const WrappedConstructor = function(...args) {
      const instance = new Constructor(...args);
      // Wrap the newly created instance for tracking
      return wrapForTracking(instance, tracker, [], onOperation);
    };

    // Preserve the prototype so instanceof works
    // This allows: wrappedInstance instanceof Y.XmlElement to work
    Object.setPrototypeOf(WrappedConstructor, Constructor);
    WrappedConstructor.prototype = Constructor.prototype;

    return WrappedConstructor;
  };

  // Create a sandbox context with limited access
  const sandbox = {
    // Expose wrapped fragment
    _doc: wrappedFragment,

    // Expose Yjs namespace with wrapped constructors
    // This ensures all new objects created in scripts are tracked
    Y: {
      XmlFragment: Y.XmlFragment, // Don't wrap XmlFragment constructor
      XmlElement: createWrappedConstructor(Y.XmlElement),
      XmlText: createWrappedConstructor(Y.XmlText),
      Doc: Y.Doc,
    },

    // Helper functions to reduce boilerplate
    // These are common operations that users would otherwise copy-paste
    findTextNode: helpers.findTextNode,
    extractText: helpers.extractText,
    getTextContent: helpers.getTextContent,
    findElements: helpers.findElements,
    findByNodeName: helpers.findByNodeName,
    findByText: helpers.findByText,

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
    // Enhanced error handling with better context
    if (error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error(
        `Script execution timed out after ${timeout}ms.\n` +
        `Hint: Check for infinite loops or long-running operations.`
      );
    }

    // Extract line number from stack trace if available
    let lineInfo = '';
    if (error.stack) {
      const stackMatch = error.stack.match(/sandbox-script\.js:(\d+):(\d+)/);
      if (stackMatch) {
        lineInfo = ` at line ${stackMatch[1]}, column ${stackMatch[2]}`;
      }
    }

    // Common error types with helpful messages
    let hint = '';
    if (error.message.includes('is not defined')) {
      const match = error.message.match(/(\w+) is not defined/);
      if (match) {
        hint = `\nHint: "${match[1]}" is not available in the sandbox. ` +
               `Only Y.XmlElement, Y.XmlText, and the doc parameter are available.`;
      }
    } else if (error.message.includes('is not a function')) {
      hint = `\nHint: Check that you're calling methods on the correct Yjs object types.`;
    } else if (error.message.includes('default function')) {
      hint = `\nHint: Your script must export a default function like:\n` +
             `  export default function edit(doc) { ... }`;
    }

    throw new Error(
      `Script execution failed${lineInfo}: ${error.message}${hint}\n\n` +
      `Stack trace:\n${error.stack || 'No stack trace available'}`
    );
  }
}

module.exports = { executeSandboxed };
