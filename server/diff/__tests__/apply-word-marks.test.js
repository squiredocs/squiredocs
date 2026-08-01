/**
 * Feature 039 — `applyWordMarks` degradation-report threading and traversal
 * agreement (US3 T019, US4 T027).
 *
 * NOTE ON LOCATION (039 analyze finding I1): before this feature there was no
 * `server/diff/__tests__/` directory at all — `applyWordMarks` was exercised
 * only indirectly, through the `computeMarkdownDiff — word-level marks
 * (feature 022, US2)` describe block in `server/__tests__/diff-service.test.js`.
 * Those tests stay where they are (they assert the diff-service-level result);
 * this file is the direct unit surface for the two properties 039 adds:
 *   (a) the degradation reason reaches the caller's report sink, and
 *   (b) `plainTextOf` and `stampSide`'s `isTextBlock` — two separate
 *       implementations of one traversal — stay in agreement (plan hazard #4).
 */

const { applyWordMarks } = require('../apply-word-marks');
const wordDiff = require('../../../shared/diff/word-diff');

/** Collect every text run in a PM block tree that carries `markType`. */
function runsWithMark(blocks, markType) {
  const found = [];
  const walk = (node) => {
    if (!node || !Array.isArray(node.content)) return;
    for (const child of node.content) {
      if (child.type === 'text') {
        if ((child.marks || []).some((m) => m.type === markType)) found.push(child.text);
      } else {
        walk(child);
      }
    }
  };
  for (const b of blocks) walk(b);
  return found;
}

describe('applyWordMarks — degradation report threading (039 US3)', () => {
  afterEach(() => jest.restoreAllMocks());

  test('propagates a size-cap degradation into the caller report', () => {
    // A genuinely oversized side: no mocking, the real guardrail trips.
    const huge = 'alpha beta '.repeat(wordDiff.MAX_SIDE_CHARS / 10);
    const report = {};
    const blocks = applyWordMarks(huge, 'small replacement text', report);

    expect(report.reason).toBe('size');
    expect(report.sizeCapped).toBe(true);
    // A size cap is deterministic — it must NOT set the timeout accumulator,
    // because only `timeout` suppresses the cache write (FR-005c, CW-2).
    expect(report.timedOut).toBeUndefined();
    // Degradation is silent line-level marks, never a throw.
    expect(runsWithMark(blocks, 'diffDeleteWord')).toEqual([]);
    expect(runsWithMark(blocks, 'diffInsertWord')).toEqual([]);
  });

  test('propagates a timeout degradation into the caller report', () => {
    jest.spyOn(wordDiff, 'computeWordSegments').mockImplementation((b, a, report) => {
      if (report) {
        report.reason = 'timeout';
        report.timedOut = true;
      }
      return null;
    });

    const report = {};
    const blocks = applyWordMarks('the quick fox', 'the slow fox', report);

    expect(report.reason).toBe('timeout');
    expect(report.timedOut).toBe(true);
    expect(runsWithMark(blocks, 'diffDeleteWord')).toEqual([]);
  });

  test('forwards the report as the third argument to computeWordSegments', () => {
    const spy = jest.spyOn(wordDiff, 'computeWordSegments');
    const report = {};
    applyWordMarks('the quick fox', 'the slow fox', report);
    expect(spy).toHaveBeenCalledWith(expect.any(String), expect.any(String), report);
  });

  test('called with NO report behaves exactly as today (WS-3 / CD-6)', () => {
    const withReport = applyWordMarks('the quick fox', 'the slow fox', {});
    const withoutReport = applyWordMarks('the quick fox', 'the slow fox');
    expect(withoutReport).toEqual(withReport);
    expect(runsWithMark(withoutReport, 'diffDeleteWord')).toEqual(['quick']);
  });

  test('VH-1: the fail-open catch still returns line-level blocks without throwing', () => {
    jest.spyOn(wordDiff, 'computeWordSegments').mockImplementation(() => {
      throw new Error('boom');
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const report = {};
    let blocks;
    expect(() => {
      blocks = applyWordMarks('the quick fox', 'the slow fox', report);
    }).not.toThrow();

    // Line-level fallback: subtle marks present, strong word marks absent.
    expect(runsWithMark(blocks, 'diffDelete')).toEqual(['the quick fox']);
    expect(runsWithMark(blocks, 'diffInsert')).toEqual(['the slow fox']);
    expect(runsWithMark(blocks, 'diffDeleteWord')).toEqual([]);
  });
});

describe('applyWordMarks — traversal agreement (039 US4, VH-T1)', () => {
  /**
   * `plainTextOf` builds the string that `computeWordSegments` segments, and
   * `stampSide` re-walks the same tree assigning character offsets. They are
   * SEPARATE implementations of one traversal. If they disagree about which
   * nodes are textblocks — in particular for a block with NO direct text child
   * — every offset after the disagreement shifts and the strong marks land on
   * the wrong words. These cases pin the agreement (plan hazard #4).
   */

  test('a list wrapper (container block, no direct text child) keeps offsets aligned', () => {
    const removed = '- alpha one\n- beta two\n';
    const added = '- alpha one\n- beta CHANGED\n';
    const blocks = applyWordMarks(removed, added);

    // If the two traversals disagreed on the list wrapper, the offset would
    // slip and a different word (or none) would carry the strong mark.
    expect(runsWithMark(blocks, 'diffDeleteWord')).toEqual(['two']);
    expect(runsWithMark(blocks, 'diffInsertWord')).toEqual(['CHANGED']);
  });

  test('an empty paragraph between text blocks keeps offsets aligned', () => {
    // The blank line produces a block that `isTextBlock` must classify the same
    // way in both walks; a mismatch shifts the inter-block '\n' accounting.
    const removed = 'first line\n\n\\\n\nlast word here\n';
    const added = 'first line\n\n\\\n\nlast word THERE\n';
    const blocks = applyWordMarks(removed, added);

    expect(runsWithMark(blocks, 'diffDeleteWord')).toEqual(['here']);
    expect(runsWithMark(blocks, 'diffInsertWord')).toEqual(['THERE']);
  });

  test('a blockquote wrapping a paragraph keeps offsets aligned', () => {
    const removed = '> quoted alpha\n\ntail word\n';
    const added = '> quoted BETA\n\ntail word\n';
    const blocks = applyWordMarks(removed, added);

    expect(runsWithMark(blocks, 'diffDeleteWord')).toEqual(['alpha']);
    expect(runsWithMark(blocks, 'diffInsertWord')).toEqual(['BETA']);
    // The unchanged trailing block stays subtle on both sides.
    expect(runsWithMark(blocks, 'diffDelete')).toContain('tail word');
  });
});
