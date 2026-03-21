/**
 * Isolate bundle entry point
 *
 * Bundled by esbuild into isolate-bundle.js with all dependencies
 * (yjs, fontoxpath, helpers, xpath, interceptor, tracker, cursor-operations).
 *
 * Runs inside an isolated-vm isolate within the worker thread.
 * Exposes __setup() and __finalize() on globalThis for the host to call.
 *
 * Host-set globals (must be set before __setup is called):
 *   __onBatch         - ivm.Reference: callback(opsJson, updateJson) for streaming batches
 *   __queueHighlights - ivm.Reference: callback(positionsJson) for highlight sequences
 *   __console_log     - ivm.Reference: callback(message) for console output
 */

const Y = require('yjs');
const helpers = require('./helpers');
const { xpath: xpathQuery, xpathFirst: xpathFirstQuery } = require('./xpath');
const { wrapForTracking } = require('./yjs-interceptor');
const { OperationTracker } = require('./operation-tracker');
const {
  createNodeSelection,
  createExpandingBlockHighlights,
} = require('../yjs/cursor-operations');

const BATCH_SIZE = 10;

// Module-level state shared between __setup and __finalize
let doc, xmlFragment, tracker, wrappedFragment;
let lastSV, pendingOps;

function serializeOp(op) {
  return {
    type: op.type,
    category: op.category,
    target: op.target,
    path: [...op.path],
    args: serializeArgs(op),
    timestamp: op.timestamp,
  };
}

function serializeArgs(op) {
  if (op.type === 'insert' && op.target === 'XmlText') {
    // [offset, text_string]
    return [op.args[0], op.args[1]];
  }
  if (op.type === 'insert') {
    // [index, array_of_elements] — send array length placeholder
    return [op.args[0], Array.isArray(op.args[1]) ? new Array(op.args[1].length) : []];
  }
  if (op.type === 'format') {
    // [offset, length]
    return [op.args[0], op.args[1]];
  }
  if (op.type === 'delete') {
    // [offset, length]
    return [op.args[0], op.args[1]];
  }
  return op.args?.length > 0 ? [op.args[0]] : [];
}

function flushBatch() {
  if (pendingOps.length === 0) return;

  const update = Y.encodeStateAsUpdate(doc, lastSV);
  lastSV = Y.encodeStateVector(doc);

  // Serialize for cross-boundary transfer (strings are always transferable)
  const opsJson = JSON.stringify(pendingOps);
  const updateJson = JSON.stringify(Array.from(update));

  __onBatch.applySync(undefined, [opsJson, updateJson]);
  pendingOps = [];
}

function onOperation(operation) {
  if (operation.category !== 'mutation') return;
  pendingOps.push(serializeOp(operation));
  if (pendingOps.length >= BATCH_SIZE) {
    flushBatch();
  }
}

function logToHost() {
  try {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) {
      const a = arguments[i];
      if (typeof a === 'string') parts.push(a);
      else if (a === null) parts.push('null');
      else if (a === undefined) parts.push('undefined');
      else if (typeof a === 'number' || typeof a === 'boolean') parts.push(String(a));
      else try { parts.push(JSON.stringify(a)); } catch (e) { parts.push('[Object]'); }
    }
    __console_log.applySync(undefined, [parts.join(' ')]);
  } catch (e) { /* ignore logging errors */ }
}

globalThis.__setup = function(snapshotBytes) {
  // 1. Create Y.Doc from snapshot
  doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(snapshotBytes));
  xmlFragment = doc.get('default', Y.XmlFragment);

  // 2. Set up tracking
  tracker = new OperationTracker();
  lastSV = Y.encodeStateVector(doc);
  pendingOps = [];

  // 3. Wrap fragment with operation tracking
  wrappedFragment = wrapForTracking(xmlFragment, tracker, [], onOperation);

  // 4. Create wrapped constructors that track operations on new objects
  const createWrappedConstructor = (Constructor) => {
    const Wrapped = function(...args) {
      const instance = new Constructor(...args);
      return wrapForTracking(instance, tracker, [], onOperation);
    };
    Object.setPrototypeOf(Wrapped, Constructor);
    Wrapped.prototype = Constructor.prototype;
    return Wrapped;
  };

  const WrappedXmlElement = createWrappedConstructor(Y.XmlElement);
  const WrappedXmlText = createWrappedConstructor(Y.XmlText);

  // 5. Highlight context
  const highlightContext = {
    xmlFragment,
    queueHighlights: (positions) => {
      flushBatch();
      __queueHighlights.applySync(undefined, [JSON.stringify(positions)]);
    },
    flushPendingHighlights: () => flushBatch(),
  };

  // 6. Set up sandbox globals
  globalThis._doc = wrappedFragment;

  globalThis.Y = {
    XmlFragment: Y.XmlFragment,
    XmlElement: WrappedXmlElement,
    XmlText: WrappedXmlText,
    Doc: Y.Doc,
  };

  // Helper functions
  globalThis.findTextNode = helpers.findTextNode;
  globalThis.extractText = helpers.extractText;
  globalThis.getTextContent = helpers.getTextContent;
  globalThis.findElements = helpers.findElements;
  globalThis.findByNodeName = helpers.findByNodeName;
  globalThis.findByText = helpers.findByText;
  globalThis.getFormattedContent = helpers.getFormattedContent;
  globalThis.setFormattedContent = helpers.setFormattedContent;
  globalThis.getPlainText = helpers.getPlainText;
  globalThis.getParagraphs = helpers.getParagraphs;
  globalThis.setParagraphs = helpers.setParagraphs;

  // XPath with highlighting
  globalThis.xpath = (expression, contextNode) => {
    const context = contextNode != null ? contextNode : wrappedFragment;
    const results = xpathQuery(expression, context);

    if (results.length > 0) {
      try {
        const unwrappedResults = xpathQuery(expression, xmlFragment);
        const positions = [];
        for (const node of unwrappedResults) {
          const selection = createNodeSelection(xmlFragment, node);
          if (selection) positions.push(selection);
        }
        if (positions.length > 0) {
          highlightContext.queueHighlights(positions);
        }
      } catch (err) {
        // Non-fatal: don't interrupt execution if highlighting fails
      }
    }

    return results.map(node => wrapForTracking(node, tracker, [], onOperation));
  };

  globalThis.xpathFirst = (expression, contextNode) => {
    const context = contextNode != null ? contextNode : wrappedFragment;
    const result = xpathFirstQuery(expression, context);
    if (result) {
      try {
        const unwrappedResult = xpathFirstQuery(expression, xmlFragment);
        if (unwrappedResult) {
          const selection = createNodeSelection(xmlFragment, unwrappedResult);
          if (selection) {
            highlightContext.queueHighlights([selection]);
          }
        }
      } catch (err) {
        // Non-fatal
      }
      return wrapForTracking(result, tracker, [], onOperation);
    }
    return null;
  };

  // createFormattedText using wrapped constructor for tracking
  globalThis.createFormattedText = (function(WXT) {
    return function createFormattedText(segments) {
      if (!Array.isArray(segments) || segments.length === 0) {
        throw new Error('createFormattedText requires a non-empty array of segments');
      }
      const xmlText = new WXT();
      const formatRanges = [];
      let fullText = '';

      for (const segment of segments) {
        if (typeof segment === 'string') {
          fullText += segment;
        } else if (segment && typeof segment.text === 'string') {
          const start = fullText.length;
          fullText += segment.text;
          if (segment.attrs && Object.keys(segment.attrs).length > 0) {
            formatRanges.push({ start, length: segment.text.length, attrs: segment.attrs });
          }
        }
      }

      xmlText.insert(0, fullText);
      for (const range of formatRanges) {
        xmlText.format(range.start, range.length, range.attrs);
      }
      return xmlText;
    };
  })(WrappedXmlText);

  // appendBlocks using wrapped constructors for tracking
  globalThis.appendBlocks = (function(WXE, WXT) {
    return function appendBlocks(container, blocks, position) {
      const numBlocks = blocks.length;

      // Pre-calculate insert index for highlighting
      let insertIndex;
      if (!position || (position.at && position.at === 'end')) {
        insertIndex = xmlFragment.length;
      } else if (position.at === 'start') {
        insertIndex = 0;
      } else if (position.before !== undefined || position.after !== undefined) {
        const targetXpath = position.before || position.after;
        if (typeof targetXpath === 'string') {
          const targetElement = xpathFirstQuery(targetXpath, xmlFragment);
          if (targetElement) {
            const items = xmlFragment.toArray();
            for (let i = 0; i < items.length; i++) {
              if (items[i] === targetElement) {
                insertIndex = position.before ? i : i + 1;
                break;
              }
            }
          }
        }
      }

      // Create xpathFirst that wraps results for consistent identity comparison
      const sandboxXpathFirst = (expression, contextNode) => {
        const ctx = contextNode || wrappedFragment;
        const res = xpathFirstQuery(expression, ctx);
        if (res) return wrapForTracking(res, tracker, [], onOperation);
        return null;
      };

      const elements = helpers.appendBlocks(container, blocks, position, {
        XmlElement: WXE,
        XmlText: WXT,
        xpathFirst: sandboxXpathFirst,
      });

      // Queue expanding highlight for visual feedback
      if (numBlocks > 0 && insertIndex !== undefined) {
        try {
          highlightContext.flushPendingHighlights();
          const expandingPositions = createExpandingBlockHighlights(
            xmlFragment, insertIndex, numBlocks
          );
          if (expandingPositions.length > 0) {
            highlightContext.queueHighlights(expandingPositions);
          }
        } catch (err) {
          // Non-fatal
        }
      }

      return elements;
    };
  })(WrappedXmlElement, WrappedXmlText);

  // Console
  globalThis.console = {
    log: logToHost,
    error: logToHost,
    warn: logToHost,
  };

  // Exports for module pattern (user code uses exports.default or module.exports)
  globalThis.exports = {};
  globalThis.module = { exports: {} };
};

globalThis.__finalize = function() {
  flushBatch();
  return JSON.stringify({
    operationCount: tracker.getOperationCount(),
    summary: tracker.getOperationSummary(),
  });
};

/**
 * Comparison mode setup — creates two read-only document fragments
 * No operation tracking, no highlighting, no streaming
 */
globalThis.__setupComparison = function(snapshot1Bytes, snapshot2Bytes) {
  // 1. Create two Y.Docs from snapshots
  const doc1 = new Y.Doc();
  Y.applyUpdate(doc1, new Uint8Array(snapshot1Bytes));
  const frag1 = doc1.get('default', Y.XmlFragment);

  const doc2 = new Y.Doc();
  Y.applyUpdate(doc2, new Uint8Array(snapshot2Bytes));
  const frag2 = doc2.get('default', Y.XmlFragment);

  // 2. Set up globals
  globalThis._doc1 = frag1;
  globalThis._doc2 = frag2;

  globalThis.Y = {
    XmlFragment: Y.XmlFragment,
    XmlElement: Y.XmlElement,
    XmlText: Y.XmlText,
  };

  // 3. Helper functions
  globalThis.findTextNode = helpers.findTextNode;
  globalThis.extractText = helpers.extractText;
  globalThis.getTextContent = helpers.getTextContent;
  globalThis.findElements = helpers.findElements;
  globalThis.findByNodeName = helpers.findByNodeName;
  globalThis.findByText = helpers.findByText;
  globalThis.getFormattedContent = helpers.getFormattedContent;
  globalThis.setFormattedContent = helpers.setFormattedContent;
  globalThis.getPlainText = helpers.getPlainText;
  globalThis.getParagraphs = helpers.getParagraphs;
  globalThis.setParagraphs = helpers.setParagraphs;

  // Comparison-specific helpers
  globalThis.extractPlainText = helpers.extractPlainText;
  globalThis.getBlockCount = helpers.getBlockCount;
  globalThis.getWordCount = helpers.getWordCount;
  globalThis.getCharacterCount = helpers.getCharacterCount;
  globalThis.getElementByType = helpers.getElementByType;
  globalThis.extractLinks = helpers.extractLinks;
  globalThis.getAttributes = helpers.getAttributes;
  globalThis.hasAttribute = helpers.hasAttribute;
  globalThis.findAllByText = helpers.findAllByText;

  // 4. XPath (require explicit context node — no default doc)
  globalThis.xpath = (expression, contextNode) => {
    if (!contextNode) {
      throw new Error('xpath() requires a context node. Usage: xpath(expression, doc1) or xpath(expression, doc2)');
    }
    return xpathQuery(expression, contextNode);
  };

  globalThis.xpathFirst = (expression, contextNode) => {
    if (!contextNode) {
      throw new Error('xpathFirst() requires a context node. Usage: xpathFirst(expression, doc1) or xpathFirst(expression, doc2)');
    }
    return xpathFirstQuery(expression, contextNode);
  };

  // 5. Console
  globalThis.console = {
    log: logToHost,
    error: logToHost,
    warn: logToHost,
  };

  // 6. Module exports
  globalThis.exports = {};
  globalThis.module = { exports: {} };
};
