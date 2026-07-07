/**
 * Server-side diagram-block validation (Mermaid syntax, SVG sanitization).
 *
 * Diagram blocks are only rendered in the browser (see
 * client/src/extensions/MermaidNode.js and SvgNode.js). When the agent writes
 * an invalid diagram via the `modify` tool, the user sees a "Diagram error"
 * panel (or silently loses sanitized content) but the agent never finds out.
 * This module runs the same checks the browser applies — `mermaid.parse()`
 * for Mermaid, the shared/svg-sanitizer.mjs policy plus an XML
 * well-formedness check for SVG — so problems can be folded into the tool
 * result and the agent can self-correct.
 *
 * Scope is parse/sanitize-only. Full mermaid render() needs real DOM layout
 * (getBBox / text measurement) which jsdom does not implement, so we do not
 * attempt it.
 *
 * Mermaid 11 is ESM-only and (with dompurify) touches `document` at module-eval
 * time, so it needs jsdom globals. We run the validators in a dedicated worker
 * thread (diagram-worker.js) so those globals stay confined to the worker —
 * setting them on the main process's `global` leaked process-wide and broke
 * gaxios (google-auth-library) during OAuth, which feature-detects `window` and
 * then reaches for the nonexistent `window.fetch`.
 */

const { Worker } = require('worker_threads');
const path = require('path');
const { findByNodeName, getTextContent } = require('./sandbox/helpers');

// Truncate echoed source so a huge diagram can't bloat the tool result.
const MAX_SOURCE_CHARS = 200;
// Cap a single validation round so a wedged worker can't hang `modify`'s await.
// Generous enough to cover the worker's one-time cold start (jsdom + ESM mermaid
// import + initialize) on the first request.
const REQUEST_TIMEOUT_MS = 10000;

let worker = null; // cached long-lived Worker | null
let nextRequestId = 1; // monotonic request-correlation id
const pending = new Map(); // id -> { resolve, reject, timer }

/**
 * Reject every in-flight request and drop the cached worker so the next call
 * spawns a fresh one. Used when the worker errors or exits unexpectedly.
 */
function resetWorker(err) {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(err);
  }
  pending.clear();
  worker = null;
}

/** Lazily spawn and cache the validation worker, wiring its event handlers. */
function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'diagram-worker.js'));
  // Don't let an idle worker keep the process (or a Jest run) alive.
  worker.unref();
  worker.on('message', (msg) => {
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.results);
  });
  worker.on('error', (err) => resetWorker(err));
  worker.on('exit', (code) => {
    if (code !== 0) resetWorker(new Error(`diagram worker exited with code ${code}`));
    else resetWorker(new Error('diagram worker exited'));
  });
  return worker;
}

/**
 * Send sources to the worker and resolve with per-index validation results
 * (error message string, or null if valid). Rejects on worker failure or
 * timeout so the caller can fail open.
 *
 * @param {'mermaid'|'svg'} type - which validator to run
 * @param {string[]} sources
 * @returns {Promise<Array<string|null>>}
 */
function sendToWorker(type, sources) {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = getWorker();
    } catch (err) {
      reject(err);
      return;
    }
    const id = nextRequestId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${type} validation timed out`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      w.postMessage({ id, type, sources });
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
}

/**
 * Validate every block of the given node name in a document and report errors.
 *
 * Non-blocking by design: callers surface the returned errors to the agent but
 * do not roll back the edit. Fails open — if the validator itself can't run, we
 * return [] rather than risk a false positive that blocks a legitimate edit.
 *
 * @param {Y.XmlFragment} xmlFragment - live document fragment to inspect
 * @param {'mermaid'|'svg'} type - block node name / worker validator type
 * @returns {Promise<Array<{block: number, error: string, source: string}>>}
 *   one entry per invalid block (`block` is 1-based among blocks of this type)
 */
async function validateDiagramBlocks(xmlFragment, type) {
  const blocks = findByNodeName(xmlFragment, type);
  // Short-circuit before paying the worker spawn/init cost (the common case).
  if (blocks.length === 0) return [];

  // Extract plain source strings in the main thread — the live Yjs fragment
  // cannot cross the worker boundary, only structured-cloneable values.
  const sources = blocks.map((b) => getTextContent(b));

  let results;
  try {
    results = await sendToWorker(type, sources);
  } catch (err) {
    console.error(`[diagram-validate] ${type} worker validation failed:`, err.message);
    return [];
  }

  const errors = [];
  for (let i = 0; i < results.length; i++) {
    const message = results[i];
    if (message == null) continue; // valid (or empty) block
    const source = sources[i];
    errors.push({
      block: i + 1,
      error: message,
      source: source.length > MAX_SOURCE_CHARS
        ? source.slice(0, MAX_SOURCE_CHARS) + '…'
        : source,
    });
  }
  return errors;
}

/** Validate every Mermaid block (syntax via mermaid.parse). */
function validateMermaidBlocks(xmlFragment) {
  return validateDiagramBlocks(xmlFragment, 'mermaid');
}

/**
 * Validate every SVG block: sanitize-policy violations (content the editor
 * will strip at render time) and XML well-formedness.
 */
function validateSvgBlocks(xmlFragment) {
  return validateDiagramBlocks(xmlFragment, 'svg');
}

/** Terminate the cached worker, if any. Primarily for test teardown. */
async function shutdownDiagramWorker() {
  if (!worker) return;
  const w = worker;
  resetWorker(new Error('diagram worker shutting down'));
  await w.terminate();
}

module.exports = { validateMermaidBlocks, validateSvgBlocks, shutdownDiagramWorker };
