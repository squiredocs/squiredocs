/**
 * Sandbox executor
 * Executes compiled JavaScript inside an isolated-vm isolate.
 *
 * Security model:
 * 1. isolated-vm creates a true V8 isolate with zero Node.js APIs
 * 2. No process, require, fs, net — nothing to escape to
 * 3. Timeout enforcement via isolate
 * 4. Memory limit via isolate (128MB)
 * 5. Operation tracking via Yjs object wrappers (inside isolate)
 */

const fs = require('fs');
const path = require('path');

const BUNDLE_PATH = path.join(__dirname, 'isolate-bundle.js');
let cachedBundleCode = null;

function getBundleCode() {
  if (!cachedBundleCode) {
    cachedBundleCode = fs.readFileSync(BUNDLE_PATH, 'utf8');
  }
  return cachedBundleCode;
}

/**
 * Executes JavaScript code inside an isolated-vm isolate
 * @param {string} jsCode - Compiled JavaScript code
 * @param {Buffer|Uint8Array} snapshot - Y.Doc snapshot
 * @param {number} timeout - Execution timeout in milliseconds
 * @param {Function} onBatch - Callback: (operations, updateBuffer) for streaming batches
 * @param {Function} onHighlights - Callback: (positions) for highlight sequences
 * @returns {object} - { operationCount, summary }
 * @throws {Error} - If execution fails or times out
 */
function executeSandboxed(jsCode, snapshot, timeout = 5000, onBatch = null, onHighlights = null) {
  const ivm = require('isolated-vm');

  // 1. Create isolate with memory limit
  const isolate = new ivm.Isolate({ memoryLimit: 128 });
  const context = isolate.createContextSync();
  const jail = context.global;

  try {
    // 2. Inject polyfills required by bundled Yjs (lib0)
    //    The isolate has no Web/Node APIs, so we provide minimal shims.
    jail.setSync('__cryptoGetRandomValues', new ivm.Reference(function(length) {
      const bytes = require('crypto').randomBytes(length);
      return JSON.stringify(Array.from(bytes));
    }));

    isolate.compileScriptSync(`
      // crypto.getRandomValues — used by lib0 for client ID generation
      globalThis.crypto = {
        getRandomValues: function(arr) {
          var randomStr = __cryptoGetRandomValues.applySync(undefined, [arr.length]);
          var randomBytes = JSON.parse(randomStr);
          for (var i = 0; i < arr.length; i++) {
            arr[i] = randomBytes[i];
          }
          return arr;
        }
      };

      // Timer APIs — lib0's eventloop module references these.
      // No-ops since execution is fully synchronous.
      var __nextId = 1;
      globalThis.setTimeout = function(fn, ms) { return __nextId++; };
      globalThis.clearTimeout = function(id) {};
      globalThis.setInterval = function(fn, ms) { return __nextId++; };
      globalThis.clearInterval = function(id) {};
      globalThis.queueMicrotask = function(fn) { fn(); };
    `).runSync(context);

    // 3. Load pre-built bundle (defines __setup, __finalize on globalThis)
    const bundleCode = getBundleCode();
    isolate.compileScriptSync(bundleCode).runSync(context);

    // 4. Set up Reference callbacks for isolate → worker communication
    //    Data is serialized as JSON strings inside the isolate for reliable transfer.
    jail.setSync('__onBatch', new ivm.Reference(function(opsJson, updateJson) {
      if (onBatch) {
        const ops = JSON.parse(opsJson);
        const update = new Uint8Array(JSON.parse(updateJson));
        onBatch(ops, update);
      }
    }));

    jail.setSync('__queueHighlights', new ivm.Reference(function(posJson) {
      if (onHighlights) {
        const positions = JSON.parse(posJson);
        onHighlights(positions);
      }
    }));

    jail.setSync('__console_log', new ivm.Reference(function(msg) {
      console.log('[Sandbox]', msg);
    }));

    // 5. Transfer snapshot into isolate
    const snapshotArray = new Uint8Array(snapshot);
    jail.setSync('__snapshot',
      new ivm.ExternalCopy(snapshotArray.buffer).copyInto());

    // 6. Run setup (creates Y.Doc, wraps fragment, sets up globals)
    isolate.compileScriptSync('__setup(__snapshot)').runSync(context);

    // 7. Compile and run user code with timeout
    const userWrapper = `
      ${jsCode}

      // Detect and call the default export function
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

      editFunction(_doc);
    `;

    isolate.compileScriptSync(userWrapper, { filename: 'sandbox-script.js' })
      .runSync(context, { timeout });

    // 8. Finalize (flush remaining ops, return stats)
    const resultJson = isolate.compileScriptSync('__finalize()').runSync(context);
    return JSON.parse(resultJson);
  } catch (error) {
    // Try to flush pending ops even on error (host will roll back)
    try {
      isolate.compileScriptSync('__finalize()').runSync(context, { timeout: 1000 });
    } catch (e) {
      // Ignore finalize errors after user code error
    }

    // Enhanced error handling with better context
    if (error.message && error.message.includes('Script execution timed out')) {
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
    } else if (error.message.includes('Cannot read properties of undefined')) {
      hint = `\nHint: You're trying to access a property on undefined. Common causes:\n` +
             `  - findByText(), findElements(), or xpath() returned an empty array and you accessed [0]\n` +
             `  - findTextNode() returned null because no text node was found\n` +
             `  - doc.get(index) returned undefined because the index doesn't exist\n` +
             `  Solution: Always check if the result exists before using it:\n` +
             `    const results = findByText(doc, 'text');\n` +
             `    if (results.length > 0) { /* use results[0] */ }`;
    } else if (error.message.includes('Cannot read properties of null')) {
      hint = `\nHint: You're trying to access a property on null. Common causes:\n` +
             `  - findTextNode() returned null (no text node found in the element)\n` +
             `  - xpathFirst() returned null (no matching element found)\n` +
             `  Solution: Always check for null before using the result:\n` +
             `    const textNode = findTextNode(element);\n` +
             `    if (textNode) { /* use textNode */ }`;
    } else if (error.message.includes('is not a function')) {
      hint = `\nHint: Check that you're calling methods on the correct Yjs object types.\n` +
             `  - XmlElement has: toArray(), insert(), delete(), get(), getAttribute(), setAttribute()\n` +
             `  - XmlText has: insert(), delete(), format(), toDelta(), toString()`;
    } else if (error.message.includes('default function')) {
      hint = `\nHint: Your script must export a default function like:\n` +
             `  export default function edit(doc) { ... }`;
    } else if (error.message.includes('Cannot set properties of undefined') ||
               error.message.includes('Cannot set properties of null')) {
      hint = `\nHint: You're trying to set a property on undefined/null.\n` +
             `  Check that the object you're modifying exists before accessing it.`;
    }

    throw new Error(
      `Script execution failed${lineInfo}: ${error.message}${hint}\n\n` +
      `Stack trace:\n${error.stack || 'No stack trace available'}`
    );
  } finally {
    // 9. Cleanup
    context.release();
    isolate.dispose();
  }
}

module.exports = { executeSandboxed };
