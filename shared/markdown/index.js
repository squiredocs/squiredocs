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
  // TOLERANT PATH lands in T012 — until then both branches call the frozen
  // strict parser so the relocation is behavior-preserving.
  return strictMarkdownToPm(markdown, diffMark);
}

module.exports = { markdownToPm, parseInline };
