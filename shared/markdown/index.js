/**
 * Public entry for the shared markdown parser (feature 001).
 *
 * `markdownToPm(markdown, diffMark, { strict })` dispatches on mode:
 *   - strict: the frozen pre-feature parser (byte-identical output — CN-2),
 *     used by the diff engine for fragment-stable parsing of hunk fragments.
 *   - tolerant (default): the CommonMark + GFM subset parser used by import
 *     surfaces (feature 002+) and editor paste (M5).
 *
 * The signature is backward compatible: existing 2-arg callers
 * `markdownToPm(md, diffMark)` get tolerant mode (FR-002).
 *
 * CommonJS, zero Node built-ins — loadable in both server and client bundles
 * (FR-014). See specs/001-general-markdown-parser/contracts/parser-api.md.
 */

const { markdownToPm: strictMarkdownToPm, parseInline } = require('./strict-parser');
const { markdownToPm: tolerantMarkdownToPm } = require('./tolerant/block-parser');

/**
 * Last-resort degradation (data-model ladder rung 6): if the tolerant parser
 * ever throws on some pathological input, never propagate — return the whole
 * input as literal-text paragraphs (one per non-blank line). Structure is lost,
 * words never are (FR-013).
 */
function literalFallback(markdown, diffMark) {
  const blocks = [];
  const src = typeof markdown === 'string' ? markdown : String(markdown == null ? '' : markdown);
  for (const line of src.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') continue;
    const text = { type: 'text', text: line };
    if (diffMark) text.marks = [{ type: diffMark }];
    blocks.push({ type: 'paragraph', content: [text] });
  }
  if (blocks.length === 0) blocks.push({ type: 'paragraph' });
  return { type: 'doc', content: blocks };
}

/**
 * @param {string} markdown - Untrusted markdown input, any content, any size.
 * @param {string|null} diffMark - 'diffInsert' | 'diffDelete' | null; applied as
 *   the last mark on every emitted text node.
 * @param {{ strict?: boolean }} [options] - strict mode selector (default false).
 * @returns {object} ProseMirror document JSON ({ type: 'doc', content: [...] }).
 */
function markdownToPm(markdown, diffMark = null, { strict = false } = {}) {
  if (strict) {
    return strictMarkdownToPm(markdown, diffMark);
  }
  // TOLERANT PATH (default): the CommonMark + GFM subset grammar, wrapped in a
  // top-level never-throw safety net (FR-013).
  try {
    return tolerantMarkdownToPm(markdown, diffMark);
  } catch {
    return literalFallback(markdown, diffMark);
  }
}

module.exports = { markdownToPm, parseInline };
