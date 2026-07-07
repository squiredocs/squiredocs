/**
 * Worker thread for server-side diagram-block validation (Mermaid syntax,
 * SVG sanitization/well-formedness).
 *
 * Mermaid 11 is ESM-only and (with its DOMPurify dependency) touches `document`
 * at module-eval time, so it needs jsdom globals. Setting those on the main
 * process's `global` leaks process-wide and breaks unrelated libraries that
 * feature-detect `window` (notably gaxios via google-auth-library, which then
 * grabs the nonexistent `window.fetch` and throws during Google OAuth login).
 *
 * Running the validators here, in a dedicated worker, confines the jsdom
 * globals to the worker's own scope — the main thread never sees a `window`.
 * See diagram-validate.js for the host side.
 *
 * Protocol:
 *   request  { id, type: 'mermaid'|'svg', sources: string[] }
 *   response { id, results: (string|null)[] }  // results[k] = error message for
 *                                                  sources[k], or null if valid
 *            { id, error: string }              // init failed; host fails open
 */

const { parentPort } = require('worker_threads');
const path = require('path');
const { pathToFileURL } = require('url');

let domInstance = null;

/** Worker-scoped jsdom window, created once and shared by both validators. */
function getDom() {
  if (!domInstance) {
    const { JSDOM } = require('jsdom');
    domInstance = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      pretendToBeVisual: true,
    });
  }
  return domInstance;
}

let mermaidPromise = null;

/**
 * Lazily set up jsdom globals (worker-scoped) and import + initialize Mermaid,
 * once. Mirrors loadMermaid() in client/src/extensions/MermaidNode.js. Only
 * paid on the first 'mermaid' request — svg-only validation never imports the
 * (heavy, ESM-only) mermaid module.
 *
 * @returns {Promise<object>} the initialized mermaid instance
 */
function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      const w = getDom().window;
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

let svgValidatorPromise = null;

/**
 * Lazily build the SVG validator: an isolated DOMPurify instance bound to the
 * worker's jsdom window, running the same sanitize policy the editor enforces
 * at render time (shared/svg-sanitizer.mjs), plus an XML well-formedness check.
 *
 * @returns {Promise<(source: string) => string|null>} per-source validator
 */
function getSvgValidator() {
  if (!svgValidatorPromise) {
    svgValidatorPromise = (async () => {
      const dom = getDom();
      // Isolated instance — never the shared default export, whose hooks
      // mermaid's own sanitize calls would pick up.
      const createDOMPurify = require('dompurify');
      const purify = createDOMPurify(dom.window);
      const sanitizerUrl = pathToFileURL(
        path.join(__dirname, '../../shared/svg-sanitizer.mjs'),
      ).href;
      const { createSvgSanitizer } = await import(sanitizerUrl);
      const { sanitizeSvg } = createSvgSanitizer(purify);

      return (source) => {
        // The client renders through the (lenient) HTML parser, so sanitize
        // problems come first; well-formedness matters for SVG export and
        // strict consumers, so it's still reported.
        let removed;
        try {
          ({ removed } = sanitizeSvg(source));
        } catch (err) {
          return String((err && err.message) || err);
        }

        const xmlDoc = new dom.window.DOMParser().parseFromString(
          source,
          'image/svg+xml',
        );
        const parseError = xmlDoc.getElementsByTagName('parsererror')[0];
        if (parseError) {
          const detail = (parseError.textContent || '').trim().split('\n')[0];
          return `SVG is not well-formed XML: ${detail}`;
        }

        if (removed.length > 0) {
          return (
            "the editor's sanitizer will strip disallowed content: " +
            removed.join(', ') +
            '. Remove scripts, event handlers, foreignObject, and external ' +
            'references (only #fragment refs and data:image URIs are allowed).'
          );
        }
        return null;
      };
    })();
  }
  return svgValidatorPromise;
}

parentPort.on('message', async ({ id, type, sources }) => {
  let validate;
  try {
    if (type === 'svg') {
      const validateSvg = await getSvgValidator();
      validate = async (source) => validateSvg(source);
    } else {
      const mermaid = await getMermaid();
      validate = async (source) => {
        try {
          await mermaid.parse(source);
          return null;
        } catch (err) {
          // Stringify here: mermaid errors carry non-cloneable bits that would
          // otherwise break structured-clone across the worker boundary.
          return String((err && err.message) || err);
        }
      };
    }
  } catch (err) {
    // Reset so a later request can retry init. Report the failure so the host
    // fails open rather than us silently reporting all diagrams as valid.
    if (type === 'svg') svgValidatorPromise = null;
    else mermaidPromise = null;
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
    results.push(await validate(source));
  }
  parentPort.postMessage({ id, results });
});
