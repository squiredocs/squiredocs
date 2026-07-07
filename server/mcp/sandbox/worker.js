/**
 * Worker thread entry point for sandboxed script execution
 *
 * Thin shell that delegates to executor.js (isolated-vm) and relays
 * messages to the host via parentPort.
 *
 * Security layers:
 * 1. Worker thread — separate V8 heap, no shared JS objects
 * 2. isolated-vm inside worker — true V8 isolate with zero Node.js APIs
 * 3. resourceLimits on worker — caps memory
 * 4. External timeout — host terminates worker if it exceeds timeout + grace period
 */

const { parentPort, workerData } = require('worker_threads');
const { executeSandboxed } = require('./executor');

const { snapshot, jsCode, timeout, sources = [] } = workerData;

function onBatch(operations, update) {
  // Copy to fresh ArrayBuffer for transfer (Yjs Uint8Arrays may share a pool buffer)
  const ab = new ArrayBuffer(update.byteLength);
  new Uint8Array(ab).set(update);
  parentPort.postMessage(
    { type: 'ops', operations, update: ab },
    [ab] // transfer the ArrayBuffer
  );
}

function onHighlights(positions) {
  parentPort.postMessage({ type: 'highlights', positions });
}

try {
  const result = executeSandboxed(jsCode, snapshot, timeout, onBatch, onHighlights, sources);
  parentPort.postMessage({
    type: 'complete',
    operationCount: result.operationCount,
    summary: result.summary,
  });
} catch (error) {
  parentPort.postMessage({
    type: 'error',
    error: error.message,
    stack: error.stack,
    operationCount: 0,
  });
}
