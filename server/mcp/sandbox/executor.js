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
const { xpath: xpathQuery, xpathFirst: xpathFirstQuery } = require('./xpath');
const { createCursorPositionFromPath } = require('../yjs/cursor-operations');

/**
 * Get the path from document root to a Yjs node
 * @param {Y.XmlFragment} root - Document root
 * @param {Y.XmlElement|Y.XmlText} target - Target node to find
 * @returns {number[]|null} - Array of indices representing path, or null if not found
 */
function getNodePath(root, target) {
  // Breadth-first search to find the node and build path
  const queue = [{ node: root, path: [] }];

  while (queue.length > 0) {
    const { node, path } = queue.shift();

    // Check if this node has children
    if (typeof node.toArray === 'function') {
      const children = node.toArray();
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const childPath = [...path, i];

        // Check if this is the target
        if (child === target) {
          return childPath;
        }

        // Add to queue to search children
        queue.push({ node: child, path: childPath });
      }
    }
  }

  return null;
}

/**
 * Get the total text length of a Yjs node (recursive)
 * @param {Y.XmlElement|Y.XmlText|Y.XmlFragment} node - Node to measure
 * @returns {number} - Total character count
 */
function getNodeTextLength(node) {
  if (node instanceof Y.XmlText) {
    return node.length;
  }
  if (typeof node.toArray === 'function') {
    return node.toArray().reduce((sum, child) => sum + getNodeTextLength(child), 0);
  }
  return 0;
}

/**
 * Executes JavaScript code with access to wrapped Yjs fragment
 * @param {string} jsCode - Compiled JavaScript code
 * @param {object} wrappedFragment - Wrapped Y.XmlFragment with operation tracking
 * @param {object} tracker - Operation tracker for recording operations
 * @param {number} timeout - Execution timeout in milliseconds
 * @param {Function} [onOperation] - Optional callback called when an operation is recorded
 * @param {object} [highlightContext] - Optional context for xpath highlighting
 * @param {Y.XmlFragment} [highlightContext.xmlFragment] - Document fragment for cursor position creation
 * @param {Function} [highlightContext.queueHighlights] - Function to queue highlight positions
 * @returns {object} - Execution result
 * @throws {Error} - If execution fails or times out
 */
function executeSandboxed(jsCode, wrappedFragment, tracker, timeout = 5000, onOperation = null, highlightContext = null) {
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

    // XPath query functions for flexible element selection
    // These allow selecting elements using standard XPath expressions
    // instead of fragile index-based access
    xpath: (expression, contextNode = null) => {
      // Use document root if no context provided
      const context = contextNode || wrappedFragment;
      // Query and wrap results for operation tracking
      const results = xpathQuery(expression, context);

      // Queue highlights for visual feedback if context is available
      // Note: We query the UNWRAPPED xmlFragment to get correct node references for path finding
      if (highlightContext && highlightContext.queueHighlights && results.length > 0) {
        try {
          // Query the unwrapped fragment to get real Yjs node references
          const unwrappedResults = xpathQuery(expression, highlightContext.xmlFragment);
          const positions = [];
          for (const node of unwrappedResults) {
            // Get the path to this node in the document
            const path = getNodePath(highlightContext.xmlFragment, node);
            if (path) {
              const anchor = createCursorPositionFromPath(highlightContext.xmlFragment, path, 0);
              // Calculate actual text length for proper full-element highlighting
              const textLength = getNodeTextLength(node);
              const head = createCursorPositionFromPath(highlightContext.xmlFragment, path, textLength);
              if (anchor && head) {
                positions.push({ anchor, head });
              }
            }
          }
          if (positions.length > 0) {
            highlightContext.queueHighlights(positions);
          }
        } catch (err) {
          // Non-fatal: don't interrupt execution if highlighting fails
          console.warn('[xpath] highlight error:', err.message);
        }
      }

      return results.map(node => wrapForTracking(node, tracker, [], onOperation));
    },

    xpathFirst: (expression, contextNode = null) => {
      const context = contextNode || wrappedFragment;
      const result = xpathFirstQuery(expression, context);
      if (result) {
        // Queue single highlight for visual feedback if context is available
        // Note: We query the UNWRAPPED xmlFragment to get correct node reference for path finding
        if (highlightContext && highlightContext.queueHighlights) {
          try {
            const unwrappedResult = xpathFirstQuery(expression, highlightContext.xmlFragment);
            if (unwrappedResult) {
              const path = getNodePath(highlightContext.xmlFragment, unwrappedResult);
              if (path) {
                const anchor = createCursorPositionFromPath(highlightContext.xmlFragment, path, 0);
                // Calculate actual text length for proper full-element highlighting
                const textLength = getNodeTextLength(unwrappedResult);
                const head = createCursorPositionFromPath(highlightContext.xmlFragment, path, textLength);
                if (anchor && head) {
                  highlightContext.queueHighlights([{ anchor, head }]);
                }
              }
            }
          } catch (err) {
            // Non-fatal: don't interrupt execution if highlighting fails
            console.warn('[xpathFirst] highlight error:', err.message);
          }
        }
        return wrapForTracking(result, tracker, [], onOperation);
      }
      return null;
    },

    // createFormattedText needs special handling - it must use the wrapped
    // Y.XmlText constructor so operations are tracked. We create a closure
    // that captures the wrapped constructor.
    createFormattedText: (function(WrappedXmlText) {
      return function createFormattedText(segments) {
        if (!Array.isArray(segments) || segments.length === 0) {
          throw new Error('createFormattedText requires a non-empty array of segments');
        }

        // Use the wrapped constructor so operations are tracked
        const xmlText = new WrappedXmlText();

        // First pass: collect all text and track format ranges
        const formatRanges = [];
        let fullText = '';

        for (const segment of segments) {
          if (typeof segment === 'string') {
            fullText += segment;
          } else if (segment && typeof segment.text === 'string') {
            const start = fullText.length;
            fullText += segment.text;
            if (segment.attrs && Object.keys(segment.attrs).length > 0) {
              formatRanges.push({
                start,
                length: segment.text.length,
                attrs: segment.attrs,
              });
            }
          }
        }

        // Insert all text at once (avoids the reversal bug)
        xmlText.insert(0, fullText);

        // Apply formatting to each range
        for (const range of formatRanges) {
          xmlText.format(range.start, range.length, range.attrs);
        }

        return xmlText;
      };
    })(createWrappedConstructor(Y.XmlText)),

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
               `Available: Y.XmlElement, Y.XmlText, doc, xpath(), xpathFirst(), and helper functions.`;
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
