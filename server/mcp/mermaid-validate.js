/**
 * Server-side Mermaid syntax validation.
 *
 * Mermaid diagrams are only parsed/rendered in the browser (see
 * client/src/extensions/MermaidNode.js). When the agent writes an invalid
 * diagram via the `modify` tool, the user sees a "Diagram error" panel but the
 * agent never finds out. This module runs the same `mermaid.parse()` the browser
 * uses, so syntax errors can be folded into the tool result and the agent can
 * self-correct.
 *
 * Scope is parse-only (syntax). Full render() needs real DOM layout (getBBox /
 * text measurement) which jsdom does not implement, so we do not attempt it.
 *
 * Mermaid 11 is ESM-only and touches `document` at module-eval time, so we set
 * up jsdom globals before dynamically importing it from our CommonJS server.
 */

const { findByNodeName, getTextContent } = require('./sandbox/helpers');

// Truncate echoed source so a huge diagram can't bloat the tool result.
const MAX_SOURCE_CHARS = 200;

let mermaidPromise = null;

/**
 * Lazily set up a jsdom DOM and import + initialize Mermaid, once.
 * Mirrors loadMermaid() in client/src/extensions/MermaidNode.js.
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
      // parse time. Assign before importing mermaid.
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

/**
 * Validate every Mermaid block in a document and report syntax errors.
 *
 * Non-blocking by design: callers surface the returned errors to the agent but
 * do not roll back the edit. Fails open — if the validator itself can't load, we
 * return [] rather than risk a false positive that blocks a legitimate edit.
 *
 * @param {Y.XmlFragment} xmlFragment - live document fragment to inspect
 * @returns {Promise<Array<{block: number, error: string, source: string}>>}
 *   one entry per invalid diagram (`block` is 1-based among mermaid blocks)
 */
async function validateMermaidBlocks(xmlFragment) {
  const blocks = findByNodeName(xmlFragment, 'mermaid');
  // Short-circuit before paying the jsdom/mermaid init cost (the common case).
  if (blocks.length === 0) return [];

  let mermaid;
  try {
    mermaid = await getMermaid();
  } catch (err) {
    console.error('[mermaid-validate] failed to load mermaid:', err.message);
    return [];
  }

  const errors = [];
  for (let i = 0; i < blocks.length; i++) {
    const source = getTextContent(blocks[i]);
    // Empty source is valid/blank, matching the client (renders nothing).
    if (!source.trim()) continue;
    try {
      await mermaid.parse(source);
    } catch (err) {
      errors.push({
        block: i + 1,
        error: String((err && err.message) || err),
        source: source.length > MAX_SOURCE_CHARS
          ? source.slice(0, MAX_SOURCE_CHARS) + '…'
          : source,
      });
    }
  }
  return errors;
}

module.exports = { validateMermaidBlocks, getMermaid };
