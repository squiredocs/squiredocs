/**
 * Worker thread for server-side Mermaid syntax validation.
 *
 * Mermaid 11 is ESM-only and (with its DOMPurify dependency) touches `document`
 * at module-eval time, so it needs jsdom globals. Setting those on the main
 * process's `global` leaks process-wide and breaks unrelated libraries that
 * feature-detect `window` (notably gaxios via google-auth-library, which then
 * grabs the nonexistent `window.fetch` and throws during Google OAuth login).
 *
 * Running mermaid here, in a dedicated worker, confines the jsdom globals to the
 * worker's own scope — the main thread never sees a `window`. See
 * mermaid-validate.js for the host side.
 *
 * Protocol:
 *   request  { id, sources: string[] }
 *   response { id, results: (string|null)[] }  // results[k] = parse error for
 *                                                  sources[k], or null if valid
 *            { id, error: string }              // init failed; host fails open
 */

const { parentPort } = require('worker_threads');

let mermaidPromise = null;

/**
 * Lazily set up jsdom globals (worker-scoped) and import + initialize Mermaid,
 * once. Mirrors loadMermaid() in client/src/extensions/MermaidNode.js.
 *
 * @returns {Promise<object>} the initialized mermaid instance
 */
function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      const { JSDOM } = require('jsdom');
      const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        pretendToBeVisual: true,
      });
      const w = dom.window;
      // Mermaid (and its dompurify dependency) reference these at import and
      // parse time. Assign before importing mermaid. These live on the WORKER's
      // global only — the main thread is never touched, which is the whole point.
      global.window = w;
      global.document = w.document;
      global.navigator = w.navigator;
      global.DOMParser = w.DOMParser;
      global.Node = w.Node;
      global.Element = w.Element;
      global.HTMLElement = w.HTMLElement;
      global.SVGElement = w.SVGElement;
      global.getComputedStyle = w.getComputedStyle;

      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
      });
      return mermaid;
    })();
  }
  return mermaidPromise;
}

parentPort.on('message', async ({ id, sources }) => {
  let mermaid;
  try {
    mermaid = await getMermaid();
  } catch (err) {
    // Reset so a later request can retry init. Report the failure so the host
    // fails open rather than us silently reporting all diagrams as valid.
    mermaidPromise = null;
    parentPort.postMessage({ id, error: String((err && err.message) || err) });
    return;
  }

  const results = [];
  for (const source of sources) {
    // Empty source is valid/blank, matching the client (renders nothing).
    if (!source || !source.trim()) {
      results.push(null);
      continue;
    }
    try {
      await mermaid.parse(source);
      results.push(null);
    } catch (err) {
      // Stringify here: mermaid errors carry non-cloneable bits that would
      // otherwise break structured-clone across the worker boundary.
      results.push(String((err && err.message) || err));
    }
  }
  parentPort.postMessage({ id, results });
});
