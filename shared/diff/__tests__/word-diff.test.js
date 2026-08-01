const { computeWordSegments, MAX_SIDE_CHARS } = require('../word-diff');

// Picked up by the backend Jest project (CommonJS, alongside shared/markdown tests).

describe('computeWordSegments', () => {
  test('faithfulness: each side rejoins to its exact input', () => {
    const before = 'the quick brown fox';
    const after = 'the slow  brown cat';
    const { before: b, after: a } = computeWordSegments(before, after);
    expect(b.map((s) => s.text).join('')).toBe(before);
    expect(a.map((s) => s.text).join('')).toBe(after);
  });

  test('one-word change isolates the changed word on both sides', () => {
    const { before, after } = computeWordSegments('the quick fox', 'the slow fox');
    // before: only "quick" changed; surrounding "the " / " fox" unchanged
    const beforeChanged = before.filter((s) => s.changed).map((s) => s.text);
    expect(beforeChanged).toEqual(['quick']);
    const afterChanged = after.filter((s) => s.changed).map((s) => s.text);
    expect(afterChanged).toEqual(['slow']);
    // surrounding context is unchanged on both sides
    expect(before.filter((s) => !s.changed).map((s) => s.text).join('')).toBe('the  fox');
    expect(after.filter((s) => !s.changed).map((s) => s.text).join('')).toBe('the  fox');
  });

  test('identical inputs yield no changed segments (one coalesced segment per side)', () => {
    const { before, after } = computeWordSegments('same words here', 'same words here');
    expect(before.some((s) => s.changed)).toBe(false);
    expect(after.some((s) => s.changed)).toBe(false);
    expect(before).toEqual([{ text: 'same words here', changed: false }]);
    expect(after).toEqual([{ text: 'same words here', changed: false }]);
  });

  test('whitespace-only change yields a changed whitespace segment (RBD-1)', () => {
    const { before, after } = computeWordSegments('a  b', 'a b');
    // the differing whitespace run is surfaced as a changed segment
    expect(before.some((s) => s.changed && /\s/.test(s.text))).toBe(true);
    expect(after.some((s) => s.changed && /\s/.test(s.text))).toBe(true);
    // still faithful
    expect(before.map((s) => s.text).join('')).toBe('a  b');
    expect(after.map((s) => s.text).join('')).toBe('a b');
  });

  test('adjacent same-flag segments are coalesced (never two changed in a row)', () => {
    const { before, after } = computeWordSegments('alpha beta gamma', 'ONE TWO THREE');
    for (const segs of [before, after]) {
      for (let i = 1; i < segs.length; i++) {
        expect(segs[i].changed).not.toBe(segs[i - 1].changed);
      }
    }
  });

  test('parity: identical inputs give identical outputs regardless of caller (SC-003)', () => {
    const a = computeWordSegments('the quick fox', 'the slow fox');
    const b = computeWordSegments('the quick fox', 'the slow fox');
    expect(a).toEqual(b);
  });

  test('oversized input returns null so callers degrade to line-level (perf guardrail)', () => {
    const big = 'word '.repeat(MAX_SIDE_CHARS / 5 + 1); // just over the cap
    expect(big.length).toBeGreaterThan(MAX_SIDE_CHARS);
    expect(computeWordSegments(big, 'small')).toBeNull();
    expect(computeWordSegments('small', big)).toBeNull();
    // At/under the cap still segments normally
    const ok = 'a'.repeat(MAX_SIDE_CHARS);
    expect(computeWordSegments(ok, ok)).not.toBeNull();
  });
});

// ===========================================================================
// Feature 039 — degradation reporting (WD-1..WD-4) and the per-region,
// per-row segmentation that restores two-surface parity (LS-T1..LS-T5).
//
// Contract: specs/039-diff-cache-integrity/contracts/word-segmentation.md
// ===========================================================================

const wordDiffModule = require('../word-diff');
const { computeLineWordSegments, DIFF_TIMEOUT_MS } = wordDiffModule;

describe('039 — degradation report (computeWordSegments)', () => {
  // WD-1
  test('WD-1: an oversized side stamps reason "size" and still returns null', () => {
    const big = 'word '.repeat(MAX_SIDE_CHARS / 5 + 1);
    const report = {};
    expect(computeWordSegments(big, 'small', report)).toBeNull();
    expect(report.reason).toBe('size');
    // Accumulating flag set; the timeout accumulator explicitly is NOT, because
    // only a timeout suppresses the cache write (CW-2).
    expect(report.sizeCapped).toBe(true);
    expect(report.timedOut).toBeUndefined();
  });

  // WD-2
  test('WD-2: a jsdiff timeout stamps reason "timeout" and still returns null', () => {
    // jsdiff returns undefined when its time budget is exceeded. Forcing that
    // deterministically means intercepting the dependency rather than hoping a
    // real input takes >250ms on this machine.
    jest.isolateModules(() => {
      jest.doMock('diff', () => ({ diffWordsWithSpace: () => undefined }));
      const isolated = require('../word-diff');
      const report = {};
      expect(isolated.computeWordSegments('a b c', 'a x c', report)).toBeNull();
      expect(report.reason).toBe('timeout');
      expect(report.timedOut).toBe(true);
      expect(report.sizeCapped).toBeUndefined();
      jest.dontMock('diff');
    });
  });

  // WD-3
  test('WD-3: calling with NO report behaves exactly as today', () => {
    const big = 'word '.repeat(MAX_SIDE_CHARS / 5 + 1);
    expect(() => computeWordSegments(big, 'small')).not.toThrow();
    expect(computeWordSegments(big, 'small')).toBeNull();
    // And the normal path is untouched by the parameter's existence.
    const { before, after } = computeWordSegments('the quick fox', 'the slow fox');
    expect(before.filter((s) => s.changed).map((s) => s.text)).toEqual(['quick']);
    expect(after.filter((s) => s.changed).map((s) => s.text)).toEqual(['slow']);
  });

  test('a non-object report argument is tolerated (no throw)', () => {
    const big = 'word '.repeat(MAX_SIDE_CHARS / 5 + 1);
    expect(() => computeWordSegments(big, 'small', null)).not.toThrow();
    expect(() => computeWordSegments(big, 'small', false)).not.toThrow();
  });

  // WD-4 — pinned constants. DIFF_TIMEOUT_MS is an EVENT-LOOP GUARD (the word
  // diff runs synchronously on the single Node process), not a tuning knob.
  test('WD-4: the guardrail constants are pinned', () => {
    expect(DIFF_TIMEOUT_MS).toBe(250);
    expect(MAX_SIDE_CHARS).toBe(20000);
  });
});

describe('039 — computeLineWordSegments (per-region, per-row)', () => {
  // LS-T1
  test('LS-T1: row counts are preserved on both sides', () => {
    const cases = [
      [['a one', 'b two'], ['a ONE', 'b TWO']],
      [['a one', 'b two', 'c three'], ['a ONE']],             // unequal
      [['a one'], ['a ONE', 'b two', 'c three']],             // unequal, other way
      [['first', '', 'third'], ['FIRST', '', 'third']],       // empty row in the middle
      [['alpha', ''], ['ALPHA', '']],                         // trailing empty row
      [[''], ['now has text']],                               // empty → non-empty
    ];
    for (const [before, after] of cases) {
      const res = computeLineWordSegments(before, after);
      expect(res).not.toBeNull();
      expect(res.before).toHaveLength(before.length);
      expect(res.after).toHaveLength(after.length);
    }
  });

  // LS-T2 — the invariant the whole re-split rests on. Bytes, not plausibility.
  test('LS-T2: every row rejoins BYTE-IDENTICALLY to its input row', () => {
    const before = [
      'plain ascii row',
      '  leading and trailing whitespace  ',
      'multi-byte: añejo café señor — em-dash',
      'emoji 🎉 and CJK 日本語テキスト',
      '',
      'tabs\tand   runs of spaces',
    ];
    const after = [
      'plain ASCII row',
      '  leading and trailing whitespace  ',
      'multi-byte: añejo café SEÑOR — em-dash',
      'emoji 🎉 and CJK 日本語テキスト!',
      '',
      'tabs\tand   runs of SPACES',
    ];
    const res = computeLineWordSegments(before, after);
    expect(res).not.toBeNull();
    for (let k = 0; k < before.length; k++) {
      expect(res.before[k].map((s) => s.text).join('')).toBe(before[k]);
    }
    for (let k = 0; k < after.length; k++) {
      expect(res.after[k].map((s) => s.text).join('')).toBe(after[k]);
    }
  });

  test('no segment text ever contains a newline (the separator is dropped)', () => {
    const res = computeLineWordSegments(['one', 'two', 'three'], ['one', 'TWO', 'three']);
    for (const row of [...res.before, ...res.after]) {
      for (const seg of row) expect(seg.text).not.toContain('\n');
    }
  });

  // LS-T3 — the headline parity case.
  test('LS-T3: a row inserted at the top leaves the unchanged rows with NO changed segments', () => {
    const before = ['alpha line', 'beta line', 'gamma line'];
    const after = ['brand new line', 'alpha line', 'beta line', 'gamma line'];
    const res = computeLineWordSegments(before, after);

    // Nothing was removed at all.
    expect(res.before.flat().filter((s) => s.changed)).toEqual([]);
    // Only the genuinely new row is emphasised; the three shifted-but-identical
    // rows stay clean. Positional pairing lit up every one of them.
    expect(res.after[0].some((s) => s.changed)).toBe(true);
    expect(res.after.slice(1).flat().filter((s) => s.changed)).toEqual([]);
  });

  // LS-T4 / LS-5 — no Math.min anywhere.
  test('LS-T4: unequal row counts give EVERY row segments, surplus included', () => {
    const res = computeLineWordSegments(
      ['one two three', 'four five six', 'seven eight nine'],
      ['one two THREE']
    );
    expect(res.before).toHaveLength(3);
    expect(res.after).toHaveLength(1);
    // Every surplus row is a real, populated Segment[] — not an empty hole.
    for (const row of res.before) expect(row.length).toBeGreaterThan(0);

    const other = computeLineWordSegments(
      ['alpha beta gamma'],
      ['alpha beta GAMMA', 'delta epsilon', 'zeta eta']
    );
    expect(other.after).toHaveLength(3);
    for (const row of other.after) expect(row.length).toBeGreaterThan(0);
  });

  // LS-T5 / LS-3 — the guardrails apply to the JOINED region.
  test('LS-T5: an oversized region returns null for the WHOLE region', () => {
    const huge = 'alpha beta '.repeat(MAX_SIDE_CHARS / 10);
    expect(huge.length).toBeGreaterThan(MAX_SIDE_CHARS);
    // Note the small trailing row: pre-039 the chat surface segmented it as its
    // own pair and kept its emphasis. Now the region degrades as a unit, which
    // is precisely what makes the two surfaces agree.
    expect(computeLineWordSegments([huge, 'small row'], ['other', 'small ROW'])).toBeNull();
  });

  test('the degradation report is threaded through the wrapper', () => {
    const huge = 'alpha beta '.repeat(MAX_SIDE_CHARS / 10);
    const report = {};
    expect(computeLineWordSegments([huge], ['small'], report)).toBeNull();
    expect(report.reason).toBe('size');
    expect(report.sizeCapped).toBe(true);
  });

  test('the wrapper delegates to computeWordSegments exactly ONCE per region', () => {
    const spy = jest.spyOn(wordDiffModule, 'computeWordSegments');
    wordDiffModule.computeLineWordSegments(
      ['a one', 'b two', 'c three'],
      ['a ONE', 'b TWO', 'c THREE']
    );
    // The region is the unit — not three separate row-pair calls.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('a one\nb two\nc three');
    expect(spy.mock.calls[0][1]).toBe('a ONE\nb TWO\nc THREE');
    spy.mockRestore();
  });

  test('a single-row region behaves like a plain computeWordSegments call', () => {
    const res = computeLineWordSegments(['the quick fox'], ['the slow fox']);
    expect(res.before).toHaveLength(1);
    expect(res.before[0].filter((s) => s.changed).map((s) => s.text)).toEqual(['quick']);
    expect(res.after[0].filter((s) => s.changed).map((s) => s.text)).toEqual(['slow']);
  });

  test('identical rows produce no changed segments anywhere', () => {
    const rows = ['same one', 'same two'];
    const res = computeLineWordSegments(rows, rows);
    expect(res.before.flat().some((s) => s.changed)).toBe(false);
    expect(res.after.flat().some((s) => s.changed)).toBe(false);
  });
});
