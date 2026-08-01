/**
 * Feature 039 US4 (SC-003) — the two inline-diff surfaces agree about which
 * words changed.
 *
 * Feature 022 ratified SC-003 ("the chat diff and the version-history diff
 * highlight the same words for the same change"). It regressed because the two
 * surfaces stopped sharing a *region unit*: version history segments the WHOLE
 * replace region in one call, while chat segmented row PAIRS positionally
 * (`Math.min(delCount, addCount)`), so a region whose rows shifted produced
 * different — and often much noisier — emphasis, and surplus rows got none at
 * all. 039 gives both surfaces one shared per-region segmentation
 * (`computeLineWordSegments`).
 *
 * ── Scoping note (039 analyze finding A1) ────────────────────────────────────
 * The two surfaces do NOT segment the same bytes in general. Chat segments
 * hard-break-stripped, span-stripped MARKDOWN rows (`**bold**` syntax still
 * present); version history segments POST-PARSE plain text
 * (`plainTextOf(markdownToPm(...))`). Byte-equal changed-character ranges are
 * therefore not achievable across arbitrary input, and asserting them would be
 * asserting a falsehood.
 *
 * So the parity corpus below is deliberately scoped to plain-prose regions with
 * no inline markdown syntax and no hard breaks — precisely the inputs where the
 * two pipelines' segmentation inputs genuinely coincide. Outside that corpus we
 * assert *algorithmic* parity instead: same helper, same region unit, same
 * whole-region fallback. Together those two claims are SC-003.
 */

const { postProcessDiffLines } = require('../mcp/diff-postprocess');
const { applyWordMarks } = require('../diff/apply-word-marks');
const { MAX_SIDE_CHARS } = require('../../shared/diff/word-diff');

// ---------------------------------------------------------------------------
// Range extraction — the common currency. The surfaces' native output shapes
// legitimately differ (keyed Segment[] vs. ProseMirror JSON), so we reduce both
// to the same thing: per row, the ordered list of row-relative [start, end)
// character ranges that are marked as changed.
// ---------------------------------------------------------------------------

/** Chat: Segment[] for one row → ordered changed ranges. */
function rangesFromSegments(segments) {
  const ranges = [];
  let cursor = 0;
  for (const seg of segments || []) {
    if (seg.changed && seg.text.length > 0) ranges.push([cursor, cursor + seg.text.length]);
    cursor += seg.text.length;
  }
  return ranges;
}

/**
 * Version history: one refined PM block → ordered changed ranges, relative to
 * that block's own text. `strongMark` is diffDeleteWord / diffInsertWord.
 */
function rangesFromBlock(block, strongMark) {
  const ranges = [];
  let cursor = 0;
  const walk = (node) => {
    if (!node || !Array.isArray(node.content)) return;
    for (const child of node.content) {
      if (child.type === 'text') {
        const len = child.text.length;
        if ((child.marks || []).some((m) => m.type === strongMark)) {
          ranges.push([cursor, cursor + len]);
        }
        cursor += len;
      } else {
        walk(child);
      }
    }
  };
  walk(block);
  // Coalesce ranges that abut — a block's text may be split across several
  // nodes for reasons unrelated to the diff (e.g. formatting marks).
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && last[1] === r[0]) last[1] = r[1];
    else merged.push([...r]);
  }
  return merged;
}

/**
 * Drive the CHAT pipeline over one replace region and return the per-row
 * changed ranges for each side.
 */
function chatRanges(beforeRows, afterRows) {
  const lines = [...beforeRows.map((r) => '-' + r), ...afterRows.map((r) => '+' + r)];
  const out = postProcessDiffLines(lines, []);
  const segs = out.inlineSegments || {};
  return {
    before: beforeRows.map((_, k) => rangesFromSegments(segs[k])),
    after: afterRows.map((_, k) => rangesFromSegments(segs[beforeRows.length + k])),
    raw: out,
  };
}

/**
 * Drive the VERSION-HISTORY pipeline over the same region. Rows are joined with
 * a blank line so each row parses to its own top-level block — which is what
 * makes `plainTextOf` produce `rows.join('\n')`, byte-identical to what the
 * chat surface feeds `computeLineWordSegments`. That byte-identity is the whole
 * basis of the comparison.
 */
function historyRanges(beforeRows, afterRows) {
  const removedMd = beforeRows.join('\n\n') + '\n';
  const addedMd = afterRows.join('\n\n') + '\n';
  const blocks = applyWordMarks(removedMd, addedMd);
  const before = blocks.slice(0, beforeRows.length);
  const after = blocks.slice(beforeRows.length);
  return {
    before: before.map((b) => rangesFromBlock(b, 'diffDeleteWord')),
    after: after.map((b) => rangesFromBlock(b, 'diffInsertWord')),
    raw: blocks,
  };
}

// ---------------------------------------------------------------------------

describe('SC-003 — chat and version history agree about which words changed', () => {
  // The scoped parity corpus: plain prose, no inline markdown syntax, no hard
  // breaks. See the scoping note at the top of this file.
  const corpus = [
    {
      name: 'PAR-1a: one word changed on each of two rows',
      before: ['The quick brown fox', 'jumps over the lazy dog'],
      after: ['The slow brown fox', 'jumps over the lazy cat'],
    },
    {
      name: 'PAR-1b: a row inserted at the top of an otherwise unchanged block',
      before: ['alpha line', 'beta line'],
      after: ['brand new line', 'alpha line', 'beta line'],
    },
    {
      name: 'PAR-1c: more removed rows than added (surplus on the before side)',
      before: ['one two three', 'four five six', 'seven eight nine'],
      after: ['one two THREE'],
    },
    {
      name: 'PAR-1d: more added rows than removed (surplus on the after side)',
      before: ['alpha beta gamma'],
      after: ['alpha beta GAMMA', 'delta epsilon zeta', 'eta theta iota'],
    },
    {
      name: 'PAR-1e: multi-byte UTF-8 prose',
      before: ['añejo café señor', 'naïve résumé façade'],
      after: ['añejo café SEÑOR', 'naïve résumé façade'],
    },
  ];

  for (const { name, before, after } of corpus) {
    test(name, () => {
      const chat = chatRanges(before, after);
      const history = historyRanges(before, after);

      // Row-for-row, per side, the changed-character ranges are identical.
      expect(chat.before).toEqual(history.before);
      expect(chat.after).toEqual(history.after);

      // And every row on both sides is accounted for — no surplus row is
      // silently skipped by either surface (FR-009 / LS-5).
      expect(chat.before).toHaveLength(before.length);
      expect(chat.after).toHaveLength(after.length);
      expect(history.before).toHaveLength(before.length);
      expect(history.after).toHaveLength(after.length);
    });
  }

  test('PAR-1f: unchanged rows in the region carry NO emphasis on either surface', () => {
    const before = ['alpha line', 'beta line', 'gamma line'];
    const after = ['brand new line', 'alpha line', 'beta line', 'gamma line'];

    const chat = chatRanges(before, after);
    const history = historyRanges(before, after);

    expect(chat.before).toEqual(history.before);
    expect(chat.after).toEqual(history.after);
    // Nothing was removed, so no before-side row carries emphasis at all.
    expect(chat.before.flat()).toEqual([]);
    // On the after side only the genuinely new row is emphasised; the three
    // shifted-but-identical rows stay clean. (Pre-039 the chat surface paired
    // row 0↔0, 1↔1, 2↔2 positionally and lit up all of them.)
    expect(chat.after.slice(1).flat()).toEqual([]);
    expect(chat.after[0].length).toBeGreaterThan(0);
  });

  // PAR-2 — guardrails trip identically, for the WHOLE region, on both surfaces.
  test('PAR-2: an oversized region falls back for the WHOLE region on both surfaces', () => {
    const filler = 'alpha beta gamma delta '.repeat(Math.ceil(MAX_SIDE_CHARS / 23) + 1);
    const before = [filler, 'small tail row'];
    const after = [filler.replace('alpha', 'omega'), 'small tail ROW'];

    const chat = chatRanges(before, after);
    const history = historyRanges(before, after);

    // Chat: no inlineSegments for ANY row of the region — including the small
    // trailing row, which pre-039 would still have been segmented as its own
    // pair. This is one of the four approved visible changes (SC-008).
    expect(chat.before.flat()).toEqual([]);
    expect(chat.after.flat()).toEqual([]);

    // Version history: line-level marks only, no strong word marks anywhere.
    expect(history.before.flat()).toEqual([]);
    expect(history.after.flat()).toEqual([]);

    // Both surfaces agree, which is the actual claim.
    expect(chat.before).toEqual(history.before);
    expect(chat.after).toEqual(history.after);
  });

  // Algorithmic parity — the claim that covers the inputs the byte-level corpus
  // above deliberately excludes (A1).
  test('both surfaces segment ONE region per replace block, not one per row pair', () => {
    const wordDiff = require('../../shared/diff/word-diff');
    const before = ['one two three', 'four five six', 'seven eight nine'];
    const after = ['one two THREE', 'four five SIX', 'seven eight NINE'];

    // Chat goes through the line-aware wrapper...
    const lineSpy = jest.spyOn(wordDiff, 'computeLineWordSegments');
    chatRanges(before, after);
    expect(lineSpy).toHaveBeenCalledTimes(1);
    // ...over ALL rows of the region at once (not min(3,3) separate pairs).
    expect(lineSpy.mock.calls[0][0]).toHaveLength(3);
    expect(lineSpy.mock.calls[0][1]).toHaveLength(3);
    lineSpy.mockRestore();

    // ...and version history goes straight to the region segmenter, once.
    const wordSpy = jest.spyOn(wordDiff, 'computeWordSegments');
    historyRanges(before, after);
    expect(wordSpy).toHaveBeenCalledTimes(1);
    wordSpy.mockRestore();

    // The wrapper is a re-split of exactly one `computeWordSegments` result, so
    // "one wrapper call" and "one segmenter call" are the same region unit.
    // (Pinned directly by the LS-* suite in shared/diff/__tests__/word-diff.test.js.)
  });
});
