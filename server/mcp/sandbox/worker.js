/**
 * Worker thread entry point for sandboxed script execution
 *
 * Runs in a separate V8 isolate (worker_threads) for true heap isolation.
 * Communicates with the host via MessagePort using count-based batching
 * to stream incremental Y.Doc updates in real-time.
 *
 * Security layers:
 * 1. Worker thread — separate V8 heap, no shared JS objects
 * 2. vm.createContext inside worker — same sandbox as current (blocks require, process, etc.)
 * 3. resourceLimits on worker — caps memory
 * 4. External timeout — host terminates worker if it exceeds timeout + grace period
 */

const { parentPort, workerData } = require('worker_threads');
const Y = require('yjs');
const { executeSandboxed } = require('./executor');
const { wrapForTracking } = require('./yjs-interceptor');
const { OperationTracker } = require('./operation-tracker');

const { snapshot, jsCode, timeout } = workerData;

// Count-based batching — since execution is synchronous, no timers available
const BATCH_SIZE = 10;
let pendingOps = [];

// Create isolated Y.Doc and apply snapshot
const doc = new Y.Doc();
Y.applyUpdate(doc, new Uint8Array(snapshot));

const xmlFragment = doc.get('default', Y.XmlFragment);

// Track state vector for incremental update encoding
let lastSV = Y.encodeStateVector(doc);

/**
 * Serialize an operation for transmission to the host.
 * Only includes the fields createOperationSelection() needs.
 */
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

/**
 * Serialize operation args to only the subset needed for cursor position creation.
 * createOperationSelection needs: args[0]=offset/index, args[1]=text/length/count
 */
function serializeArgs(op) {
  if (op.type === 'insert' && op.target === 'XmlText') {
    // [offset, text_string]
    return [op.args[0], op.args[1]];
  }
  if (op.type === 'insert') {
    // [index, array_of_elements] — send array length placeholder for counting
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

/**
 * Flush pending operations and incremental Y.Doc update to the host.
 */
function flushBatch() {
  if (pendingOps.length === 0) return;

  const update = Y.encodeStateAsUpdate(doc, lastSV);
  lastSV = Y.encodeStateVector(doc);

  // Copy into a fresh ArrayBuffer for transfer (Yjs Uint8Arrays may share a pool buffer)
  const ab = new ArrayBuffer(update.byteLength);
  new Uint8Array(ab).set(update);
  parentPort.postMessage(
    { type: 'ops', operations: pendingOps, update: ab },
    [ab] // transfer the ArrayBuffer
  );
  pendingOps = [];
}

/**
 * Callback invoked for each operation recorded by the tracker.
 * Batches mutations and flushes every BATCH_SIZE operations.
 */
function onOperation(operation) {
  if (operation.category !== 'mutation') return;

  pendingOps.push(serializeOp(operation));
  if (pendingOps.length >= BATCH_SIZE) {
    flushBatch();
  }
}

// Create highlight context that posts messages via parentPort
const highlightContext = {
  xmlFragment,
  queueHighlights: (positions) => {
    // Ensure host has current doc state before sending highlight positions
    flushBatch();
    parentPort.postMessage({ type: 'highlights', positions });
  },
  flushPendingHighlights: () => flushBatch(),
};

try {
  // Create operation tracker
  const tracker = new OperationTracker();

  // Wrap fragment with operation tracking (same as current inline execution)
  const wrappedFragment = wrapForTracking(xmlFragment, tracker, [], onOperation);

  // Execute the script — this is synchronous
  // No ydoc.transact() wrapper — each Yjs operation is its own micro-transaction.
  // This enables incremental update encoding via Y.encodeStateAsUpdate(doc, lastSV).
  // Atomicity is handled on the host side via UndoManager grouping.
  executeSandboxed(jsCode, wrappedFragment, tracker, timeout, onOperation, highlightContext);

  // Final flush of any remaining batched operations
  flushBatch();

  // Send completion with final stats
  const operationCount = tracker.getOperationCount();
  const summary = tracker.getOperationSummary();

  parentPort.postMessage({
    type: 'complete',
    operationCount,
    summary,
  });
} catch (error) {
  // Flush any pending operations before reporting error
  // (host will roll back all changes)
  flushBatch();

  parentPort.postMessage({
    type: 'error',
    error: error.message,
    stack: error.stack,
    operationCount: 0,
  });
}
