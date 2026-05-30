/**
 * Server-side diagram rendering.
 *
 * Renders diagram-as-code blocks to SVG + PNG in-process so MCP tools can hand
 * an agent an image it can actually see. Graphviz only for now: it renders in
 * Node via the same WASM engine the browser uses (@hpcc-js/wasm-graphviz), and
 * @resvg/resvg-js rasterizes the SVG to PNG without a browser. Mermaid is not
 * supported here — it needs a real DOM (headless Chromium) to lay out text.
 */

const { Resvg } = require('@resvg/resvg-js');
// @hpcc-js/wasm-graphviz is ESM-only but has no top-level await, so Node's
// require(esm) (Node 22+) loads it synchronously. Cache the initialized
// instance (one-time WASM init), mirroring the client.
const { Graphviz } = require('@hpcc-js/wasm-graphviz');

let graphvizPromise = null;
function loadGraphviz() {
  if (!graphvizPromise) {
    graphvizPromise = Graphviz.load();
  }
  return graphvizPromise;
}

// Graphviz returns a full XML document (<?xml?> + <!DOCTYPE>) before <svg>;
// trim to the <svg> element so resvg parses cleanly.
function toInlineSvg(out) {
  const i = out.indexOf('<svg');
  return i === -1 ? out : out.slice(i);
}

const DEFAULT_PNG_WIDTH = 1000;

/**
 * Render Graphviz/DOT source to SVG + PNG.
 * @param {string} source - DOT source
 * @param {object} [opts]
 * @param {number} [opts.width] - target PNG width in px (default 1000)
 * @returns {Promise<{svg: string, pngBase64: string, width: number, height: number}>}
 * @throws {Error} with code 'DIAGRAM_SYNTAX' on invalid DOT
 */
async function renderGraphviz(source, opts = {}) {
  const graphviz = await loadGraphviz();
  let svg;
  try {
    svg = toInlineSvg(graphviz.dot(source));
  } catch (err) {
    const e = new Error(`Graphviz syntax error: ${err && err.message ? err.message : err}`);
    e.code = 'DIAGRAM_SYNTAX';
    throw e;
  }
  const resvg = new Resvg(svg, {
    font: { loadSystemFonts: true },
    fitTo: { mode: 'width', value: opts.width || DEFAULT_PNG_WIDTH },
  });
  const rendered = resvg.render();
  const png = rendered.asPng();
  return {
    svg,
    pngBase64: png.toString('base64'),
    width: rendered.width,
    height: rendered.height,
  };
}

// Diagram node types this module can render server-side.
const SUPPORTED_TYPES = ['graphviz'];

const RENDERERS = {
  graphviz: renderGraphviz,
};

/**
 * Render any supported diagram type.
 * @throws {Error} with code 'DIAGRAM_UNSUPPORTED' for types we can't render here.
 */
async function renderDiagram(type, source, opts) {
  const renderer = RENDERERS[type];
  if (!renderer) {
    const e = new Error(
      `Server-side rendering is not supported for '${type}'. Supported: ${SUPPORTED_TYPES.join(', ')}.` +
        (type === 'mermaid' ? ' (Mermaid requires a headless browser.)' : ''),
    );
    e.code = 'DIAGRAM_UNSUPPORTED';
    throw e;
  }
  return renderer(source, opts);
}

module.exports = { renderDiagram, renderGraphviz, loadGraphviz, SUPPORTED_TYPES };
