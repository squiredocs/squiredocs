/**
 * Server-side diagram rendering.
 *
 * Renders diagram-as-code blocks to SVG + PNG in-process so MCP tools can hand
 * an agent an image it can actually see. Graphviz and D2 are supported: each
 * renders in Node via the same WASM engine the browser uses
 * (@hpcc-js/wasm-graphviz, @terrastruct/d2), and @resvg/resvg-js rasterizes the
 * SVG to PNG without a browser. Mermaid is not supported here — it needs a real
 * DOM (headless Chromium) to lay out text.
 */

// The renderer deps are loaded lazily (inside the functions below), not at
// module load. @hpcc-js/wasm-graphviz is ESM-only — Node's require(esm) loads
// it fine at call time, but requiring it at module top would drag the WASM
// package into anything that merely loads this module (e.g. the tool registry),
// which Jest's VM can't parse. Lazy loading keeps `require('./diagram-render')`
// cheap and parseable, and defers the one-time WASM/native init to first use.
//
// @terrastruct/d2 is loaded via dynamic import(), not require(): its CJS build
// uses import.meta.url and resolves to an empty module under require(), so only
// the ESM entry actually works from Node.

let graphvizPromise = null;
function loadGraphviz() {
  if (!graphvizPromise) {
    const { Graphviz } = require('@hpcc-js/wasm-graphviz');
    graphvizPromise = Graphviz.load();
  }
  return graphvizPromise;
}

let d2Promise = null;
function loadD2() {
  if (!d2Promise) {
    d2Promise = import('@terrastruct/d2').then(({ D2 }) => new D2());
  }
  return d2Promise;
}

// D2 runs in one worker that tracks a single in-flight request, so concurrent
// renders on the shared instance race. Serialize all D2 work through a promise
// chain (separate MCP requests can otherwise overlap).
let d2Chain = Promise.resolve();
function withD2(fn) {
  const run = d2Chain.then(fn);
  d2Chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

function getResvg() {
  return require('@resvg/resvg-js').Resvg;
}

// Trim a full XML document (<?xml?> + <!DOCTYPE>) down to the <svg> element so
// resvg parses cleanly. Graphviz always emits the prolog; D2 with noXMLTag does
// not, but trimming is harmless either way.
function toInlineSvg(out) {
  const i = out.indexOf('<svg');
  return i === -1 ? out : out.slice(i);
}

const DEFAULT_PNG_WIDTH = 1000;

// Rasterize an SVG string to PNG via resvg (no browser). Shared by all
// renderers; returns the diagram's natural rendered dimensions.
function rasterize(svg, opts = {}) {
  const Resvg = getResvg();
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
  return rasterize(svg, opts);
}

/**
 * Render D2 source to SVG + PNG using the ELK layout engine.
 * @param {string} source - D2 source
 * @param {object} [opts]
 * @param {number} [opts.width] - target PNG width in px (default 1000)
 * @returns {Promise<{svg: string, pngBase64: string, width: number, height: number}>}
 * @throws {Error} with code 'DIAGRAM_SYNTAX' on invalid D2
 */
async function renderD2(source, opts = {}) {
  const svg = await withD2(async () => {
    const d2 = await loadD2();
    let result;
    try {
      result = await d2.compile(source, { layout: 'elk' });
    } catch (err) {
      const e = new Error(`D2 syntax error: ${err && err.message ? err.message : err}`);
      e.code = 'DIAGRAM_SYNTAX';
      throw e;
    }
    return toInlineSvg(
      await d2.render(result.diagram, { ...result.renderOptions, noXMLTag: true }),
    );
  });
  return rasterize(svg, opts);
}

// D2 compile errors arrive as a JSON array of {range, errmsg}. Pull out the
// human-readable errmsg(s); fall back to the raw string if it isn't that shape.
function formatD2Error(msg) {
  try {
    const arr = JSON.parse(msg);
    if (Array.isArray(arr) && arr.length) {
      return arr.map((e) => e.errmsg || JSON.stringify(e)).join('; ');
    }
  } catch {
    /* not JSON — use the raw message */
  }
  return msg;
}

/**
 * Validate diagram source by compiling it (no rasterization), so callers can
 * cheaply surface syntax errors. Never throws. Returns:
 *   { ok: true }                - compiles cleanly
 *   { ok: false, error }        - syntax/config error (error is a string)
 *   { ok: true, skipped: true } - type can't be validated server-side (mermaid)
 * @param {string} type - diagram node type
 * @param {string} source - diagram source
 * @returns {Promise<{ok: boolean, error?: string, skipped?: boolean}>}
 */
async function validateDiagram(type, source) {
  try {
    if (type === 'graphviz') {
      const graphviz = await loadGraphviz();
      graphviz.dot(source); // throws on invalid DOT
      return { ok: true };
    }
    if (type === 'd2') {
      return await withD2(async () => {
        const d2 = await loadD2();
        await d2.compile(source, { layout: 'elk' }); // throws on invalid D2
        return { ok: true };
      });
    }
    return { ok: true, skipped: true };
  } catch (err) {
    const raw = err && err.message ? err.message : String(err);
    return { ok: false, error: type === 'd2' ? formatD2Error(raw) : raw };
  }
}

// Diagram node types this module can render server-side.
const SUPPORTED_TYPES = ['graphviz', 'd2'];

const RENDERERS = {
  graphviz: renderGraphviz,
  d2: renderD2,
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

module.exports = { renderDiagram, renderGraphviz, renderD2, validateDiagram, loadGraphviz, loadD2, SUPPORTED_TYPES };
