/**
 * Server-side rasterization of SVG blocks for AI vision input.
 *
 * The in-app assistant writes raw SVG blocks through `modify` but has no eyes:
 * it can't tell whether what it drew actually looks right. This module renders
 * a document's SVG blocks to PNG so the chat layer (view_svg_blocks tool) can
 * feed the rendered results to the model's vision input.
 *
 * Blocks are addressed the way the rest of the toolset addresses nodes — all
 * blocks by default, optionally narrowed by the same XPath dialect
 * read_document uses — never by a bare positional argument (models are
 * unreliable with indexes). Each rendered block is labeled with its canonical
 * `//svg[n]` xpath so a follow-up read/modify can target it unambiguously.
 *
 * Sources are sanitized through the same policy the editor renders with
 * (shared/svg-sanitizer.mjs, via the diagram worker), so the agent sees what
 * users see — not what it wrote. Rasterization uses @resvg/resvg-js (native,
 * no browser, no network access), so text needs system fonts: fontconfig +
 * DejaVu are installed in the runtime image.
 */

const { Resvg } = require('@resvg/resvg-js');
const { xpath } = require('./sandbox/xpath');
const { findByNodeName, getTextContent } = require('./sandbox/helpers');
const { sanitizeSvgSource } = require('./diagram-validate');

// Rasterize to a comfortable reading width for vision input; retry smaller if
// the PNG comes out too large to ship to the model.
const RENDER_WIDTH_PX = 800;
const FALLBACK_WIDTH_PX = 400;
const MAX_PNG_BYTES = 3 * 1024 * 1024;
// Vision input is expensive — cap how many blocks render in one call. The
// caller reports what was skipped so the agent can narrow with xpath.
const MAX_BLOCKS_PER_CALL = 4;

/**
 * Collect the document's SVG blocks, optionally narrowed by an XPath
 * expression (same dialect as read_document). Each entry carries the block's
 * canonical `//svg[n]` label (1-based among ALL svg blocks in document
 * order), valid as an xpath for read_document/modify targeting.
 *
 * @param {Y.XmlFragment} xmlFragment - live document fragment
 * @param {string} [xpathExpr] - optional filter; matches that aren't svg
 *   blocks are ignored
 * @returns {Array<{ label: string, source: string }>}
 * @throws {Error} on invalid xpath, no svg blocks, or a filter matching none
 */
function collectSvgBlocks(xmlFragment, xpathExpr) {
  const allSvgBlocks = findByNodeName(xmlFragment, 'svg');
  if (allSvgBlocks.length === 0) {
    throw new Error('This document has no SVG blocks.');
  }

  let matched = allSvgBlocks;
  if (xpathExpr) {
    let nodes;
    try {
      nodes = xpath(xpathExpr, xmlFragment);
    } catch (err) {
      throw new Error(`Invalid XPath expression: ${err.message}`);
    }
    matched = nodes.filter((n) => allSvgBlocks.includes(n));
    if (matched.length === 0) {
      throw new Error(
        `XPath "${xpathExpr}" matched no SVG blocks — the document has `
          + `${allSvgBlocks.length} (address them as //svg[1] … //svg[${allSvgBlocks.length}]).`,
      );
    }
  }

  return matched.map((block) => ({
    label: `//svg[${allSvgBlocks.indexOf(block) + 1}]`,
    source: getTextContent(block),
  }));
}

/**
 * Sanitize and rasterize raw SVG source to PNG.
 *
 * @param {string} source - raw SVG block source
 * @returns {Promise<{ png: Buffer, width: number, height: number }>}
 * @throws {Error} with an agent-actionable message when the source can't be
 *   sanitized or resvg can't render it
 */
async function renderSvgToPng(source) {
  const svg = await sanitizeSvgSource(source);

  const rasterize = (widthPx) => {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: widthPx },
      background: '#ffffff',
      font: { loadSystemFonts: true },
      logLevel: 'off',
    });
    const rendered = resvg.render();
    return { png: rendered.asPng(), width: rendered.width, height: rendered.height };
  };

  let result;
  try {
    result = rasterize(RENDER_WIDTH_PX);
  } catch (err) {
    throw new Error(`SVG could not be rasterized: ${String((err && err.message) || err)}`);
  }
  if (result.png.length > MAX_PNG_BYTES) {
    result = rasterize(FALLBACK_WIDTH_PX);
  }
  return result;
}

/**
 * Render the document's SVG blocks (optionally xpath-filtered) to PNGs.
 * A block that fails to render carries an `error` instead of failing the
 * whole batch, so the agent still sees the healthy blocks.
 *
 * @param {Y.XmlFragment} xmlFragment - live document fragment
 * @param {string} [xpathExpr]
 * @returns {Promise<{
 *   rendered: Array<{ label: string, png?: Buffer, width?: number, height?: number, error?: string }>,
 *   totalSvgBlocks: number,
 *   skipped: Array<string>,
 * }>}
 */
async function renderSvgBlocks(xmlFragment, xpathExpr) {
  const blocks = collectSvgBlocks(xmlFragment, xpathExpr);
  const totalSvgBlocks = findByNodeName(xmlFragment, 'svg').length;
  const toRender = blocks.slice(0, MAX_BLOCKS_PER_CALL);
  const skipped = blocks.slice(MAX_BLOCKS_PER_CALL).map((b) => b.label);

  const rendered = [];
  for (const { label, source } of toRender) {
    try {
      const { png, width, height } = await renderSvgToPng(source);
      rendered.push({ label, png, width, height });
    } catch (err) {
      rendered.push({ label, error: String((err && err.message) || err) });
    }
  }
  return { rendered, totalSvgBlocks, skipped };
}

module.exports = { collectSvgBlocks, renderSvgToPng, renderSvgBlocks, MAX_BLOCKS_PER_CALL };
