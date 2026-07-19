const { computeWordSegments } = require('../word-diff');

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
});
