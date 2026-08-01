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

// Guardrails against pathological inputs (post-merge review HIGH, 2026-07-19):
// Myers word-diff is O(N*D) and runs synchronously on the single Node process —
// two large, mostly-dissimilar sides (whole-doc rewrite, giant single-line
// paragraph) would block the event loop for seconds to minutes. Beyond ~20k
// chars a side, word emphasis has no skim value anyway (a rewrite reads as all
// strong). Oversized or slow inputs return null and the callers degrade to the
// existing line-level presentation (RBD-3 fail-open).
const MAX_SIDE_CHARS = 20000;
const DIFF_TIMEOUT_MS = 250;

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
 * Returns null (caller degrades to line-level, no word emphasis) when either
 * side exceeds MAX_SIDE_CHARS or the diff exceeds DIFF_TIMEOUT_MS.
 *
 * The `null` return is deliberately PRESERVED (039 CD-6): every caller guards
 * with `if (!segs)`, and returning a truthy `{ degraded }` object instead would
 * slip past all of them. The degradation reason is reported out of band.
 *
 * WHY THE TWO REASONS ARE NOT INTERCHANGEABLE (039 FR-005c):
 *   - `size` is a PURE FUNCTION OF THE INPUTS. The same version pair exceeds
 *     MAX_SIDE_CHARS every time, so the line-level result is the correct and
 *     reproducible answer for that pair — it is safe to cache.
 *   - `timeout` is WALL-CLOCK and load-dependent. The same version pair may well
 *     produce full word emphasis on a quieter run, so caching the degraded
 *     render would make an accident of scheduling permanent for a full hour.
 * The diff service caches the former and refuses the latter.
 *
 * @param {string} before
 * @param {string} after
 * @param {{timedOut?: boolean, sizeCapped?: boolean, reason?: string}} [report] -
 *   optional out-of-band degradation sink. On degradation this stamps
 *   `report.reason` ('size' | 'timeout') AND sets the corresponding ACCUMULATING
 *   flag (`sizeCapped` / `timedOut`). Callers that segment several regions
 *   against ONE shared report must read the accumulating flags, never `reason`:
 *   `reason` describes only the most recent call, so a later `size` region would
 *   otherwise erase an earlier `timeout` and wrongly permit a cache write.
 *   Passing no `report` reproduces pre-039 behavior exactly (WS-3).
 * @returns {{ before: Array<{text: string, changed: boolean}>,
 *             after:  Array<{text: string, changed: boolean}> } | null}
 */
function markDegraded(report, reason) {
  if (!report || typeof report !== 'object') return;
  report.reason = reason;
  // Accumulating and never reset — see the caller note above.
  if (reason === 'timeout') report.timedOut = true;
  else if (reason === 'size') report.sizeCapped = true;
}

function computeWordSegments(before, after, report) {
  if (before.length > MAX_SIDE_CHARS || after.length > MAX_SIDE_CHARS) {
    markDegraded(report, 'size');
    return null;
  }
  // jsdiff returns undefined when the timeout is exceeded.
  const parts = diffWordsWithSpace(before, after, { timeout: DIFF_TIMEOUT_MS });
  if (!parts) {
    markDegraded(report, 'timeout');
    return null;
  }
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

/**
 * Segment a MULTI-ROW replace region and hand back per-row segments (feature
 * 039, FR-008).
 *
 * This is the parity fix. Version history has always segmented a replace region
 * as ONE unit — both sides' full text in a single `computeWordSegments` call —
 * while the chat surface segmented row PAIRS positionally, `k`-th removed row
 * against `k`-th added row, up to `min(delCount, addCount)`. Those two produce
 * genuinely different answers: insert a line at the top of a block and the
 * positional pairing lights up every following row as "changed" (each row is
 * being compared to its neighbour, not to itself), and any surplus row past the
 * shorter side got no emphasis at all. Segmenting the region as a whole and then
 * splitting the result back out per row gives both surfaces one answer.
 *
 * The re-split is exact rather than approximate, and that is a DERIVED
 * consequence of the segmenter's faithfulness invariant (WS-1): the returned
 * segments rejoin to exactly the input string, so the joined region contains
 * precisely the `rows.length - 1` newlines we put in it, in order. Cutting the
 * segment stream at those newlines therefore reproduces the original rows
 * byte-for-byte (LS-2). If faithfulness ever broke, this would break loudly.
 *
 * @param {string[]} beforeLines - rendered text of each removed row
 * @param {string[]} afterLines - rendered text of each added row
 * @param {object} [report] - optional degradation sink, forwarded verbatim
 * @returns {{ before: Array<Array<{text: string, changed: boolean}>>,
 *             after:  Array<Array<{text: string, changed: boolean}>> } | null}
 *   one Segment[] per input row, in order; `null` when the region degraded (the
 *   WHOLE region then falls back to row tint — LS-3, identically on both
 *   surfaces).
 */
function splitStreamByRow(segments, rowCount) {
  const rows = [[]];
  for (const seg of segments) {
    // A coalesced segment may span several rows, so split on every newline. The
    // newline itself is a row SEPARATOR, not row content, and is dropped.
    const pieces = seg.text.split('\n');
    for (let i = 0; i < pieces.length; i++) {
      if (i > 0) rows.push([]);
      if (pieces[i].length > 0) {
        rows[rows.length - 1].push({ text: pieces[i], changed: seg.changed });
      }
    }
  }
  // Defensive: faithfulness (WS-1) makes this exact, so a mismatch means the
  // invariant broke. Fail open to row tint rather than emit misaligned rows.
  return rows.length === rowCount ? rows : null;
}

function computeLineWordSegments(beforeLines, afterLines, report) {
  const before = beforeLines.join('\n');
  const after = afterLines.join('\n');
  // Called through the module export rather than the local binding so tests can
  // observe/inject it with jest.spyOn — the same reason server/diff/apply-word-marks.js
  // and server/mcp/diff-postprocess.js use namespace imports. It is what lets the
  // parity suite prove both surfaces segment at one call per region.
  const segs = module.exports.computeWordSegments(before, after, report);
  if (!segs) return null;

  const beforeRows = splitStreamByRow(segs.before, beforeLines.length);
  const afterRows = splitStreamByRow(segs.after, afterLines.length);
  if (!beforeRows || !afterRows) return null;

  return { before: beforeRows, after: afterRows };
}

module.exports = {
  computeWordSegments,
  computeLineWordSegments,
  MAX_SIDE_CHARS,
  DIFF_TIMEOUT_MS,
};
