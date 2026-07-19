/**
 * Shared word-segmentation helper for the two inline-diff surfaces (feature 022).
 *
 * BOTH the chat tool-output diff (server/mcp/diff-postprocess.js) and the
 * version-history diff (server/diff/apply-word-marks.js) consume this single
 * helper so the two surfaces can never disagree about which words changed
 * (FR-001 / SC-003).
 *
 * CommonJS to match the rest of shared/ (e.g. shared/markdown/*), so the server
 * can `require` it and the client bundler can consume it unchanged.
 */

const { diffWordsWithSpace } = require('diff');

/**
 * Coalesce adjacent segments that share the same `changed` flag, concatenating
 * their text. Guarantees no two consecutive segments carry the same flag.
 *
 * @param {Array<{text: string, changed: boolean}>} segments
 * @returns {Array<{text: string, changed: boolean}>}
 */
function coalesce(segments) {
  const out = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.changed === seg.changed) {
      last.text += seg.text;
    } else {
      out.push({ text: seg.text, changed: seg.changed });
    }
  }
  return out;
}

/**
 * Compute word-level, whitespace-preserving segments for the two sides of a
 * change. Uses `diffWordsWithSpace` so whitespace-only edits surface honestly
 * (RBD-1) — they are real edits in a prose/document app.
 *
 * For each jsdiff part:
 *   - `.removed` → `{ text, changed: true }` on the BEFORE side.
 *   - `.added`   → `{ text, changed: true }` on the AFTER side.
 *   - neither    → `{ text, changed: false }` on BOTH sides.
 *
 * Adjacent same-flag segments are coalesced on each side.
 *
 * Faithfulness: `before.map(s => s.text).join('') === before` (same for after).
 *
 * @param {string} before
 * @param {string} after
 * @returns {{ before: Array<{text: string, changed: boolean}>,
 *             after:  Array<{text: string, changed: boolean}> }}
 */
function computeWordSegments(before, after) {
  const parts = diffWordsWithSpace(before, after);
  const beforeSegs = [];
  const afterSegs = [];

  for (const part of parts) {
    if (part.removed) {
      beforeSegs.push({ text: part.value, changed: true });
    } else if (part.added) {
      afterSegs.push({ text: part.value, changed: true });
    } else {
      beforeSegs.push({ text: part.value, changed: false });
      afterSegs.push({ text: part.value, changed: false });
    }
  }

  return {
    before: coalesce(beforeSegs),
    after: coalesce(afterSegs),
  };
}

module.exports = { computeWordSegments };
