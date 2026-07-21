const { postProcessDiffLines, stripSpanTags, extractPlainText, describeMarks } = require('../diff-postprocess');
const { computeChatDiff, stripHardBreakMarkers } = require('../diff-utils');

// ---------------------------------------------------------------------------
// stripSpanTags
// ---------------------------------------------------------------------------

describe('stripSpanTags', () => {
  test('strips span wrappers and preserves inner text', () => {
    expect(stripSpanTags('<span style="color:red">hello</span>')).toBe('hello');
  });

  test('strips multiple spans', () => {
    expect(stripSpanTags('<span style="color:red">a</span> <span style="font-size:14px">b</span>'))
      .toBe('a b');
  });

  test('leaves non-span HTML intact', () => {
    expect(stripSpanTags('<u>underlined</u>')).toBe('<u>underlined</u>');
  });

  test('handles line with no spans', () => {
    expect(stripSpanTags('plain text')).toBe('plain text');
  });

  test('handles empty string', () => {
    expect(stripSpanTags('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractPlainText
// ---------------------------------------------------------------------------

describe('extractPlainText', () => {
  test('strips diff prefix and markdown bold', () => {
    expect(extractPlainText('+**hello**')).toBe('hello');
  });

  test('strips diff prefix and markdown italic', () => {
    expect(extractPlainText('-_hello_ world')).toBe('hello world');
  });

  test('strips strikethrough and code', () => {
    expect(extractPlainText(' ~~struck~~ `code`')).toBe('struck code');
  });

  test('strips HTML tags', () => {
    expect(extractPlainText('+<u>underlined</u> <mark>marked</mark>')).toBe('underlined marked');
  });

  test('strips span style tags', () => {
    expect(extractPlainText('+<span style="color:red">red text</span>')).toBe('red text');
  });

  test('preserves escaped underscores', () => {
    expect(extractPlainText('+some\\_name')).toBe('some\\_name');
  });
});

// ---------------------------------------------------------------------------
// describeMarks
// ---------------------------------------------------------------------------

describe('describeMarks', () => {
  test('detects bold', () => {
    expect(describeMarks('**hello**')).toContain('bold');
  });

  test('detects italic', () => {
    expect(describeMarks('_hello_')).toContain('italic');
  });

  test('detects strikethrough', () => {
    expect(describeMarks('~~hello~~')).toContain('strikethrough');
  });

  test('detects code', () => {
    expect(describeMarks('`hello`')).toContain('code');
  });

  test('detects underline', () => {
    expect(describeMarks('<u>hello</u>')).toContain('underline');
  });

  test('detects highlight', () => {
    expect(describeMarks('<mark>hello</mark>')).toContain('highlight');
  });

  test('detects color from span style', () => {
    const marks = describeMarks('<span style="color: red">hello</span>');
    expect(marks).toContain('red');
  });

  test('detects background-color from span style', () => {
    const marks = describeMarks('<span style="background-color: yellow">hello</span>');
    expect(marks).toContain('bg:yellow');
  });

  test('detects font-family from span style', () => {
    const marks = describeMarks('<span style="font-family: monospace">hello</span>');
    expect(marks).toContain('font:monospace');
  });

  test('detects font-size from span style', () => {
    const marks = describeMarks('<span style="font-size: 24px">hello</span>');
    expect(marks).toContain('size:24px');
  });

  test('does not confuse background-color with color', () => {
    const marks = describeMarks('<span style="background-color: blue">hello</span>');
    expect(marks).not.toContain('blue');
    expect(marks).toContain('bg:blue');
  });

  test('deduplicates marks', () => {
    const marks = describeMarks('**bold** **also bold**');
    expect(marks.filter(m => m === 'bold')).toHaveLength(1);
  });

  test('returns empty array for plain text', () => {
    expect(describeMarks('just plain text')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// postProcessDiffLines
// ---------------------------------------------------------------------------

describe('postProcessDiffLines', () => {
  test('strips span tags from regular lines', () => {
    const lines = [' <span style="color:red">hello</span>'];
    const result = postProcessDiffLines(lines, []);
    expect(result.lines).toEqual([' hello']);
  });

  test('strips span tags from added/removed lines', () => {
    const lines = [
      '-<span style="color:red">old</span>',
      '+<span style="color:blue">new text</span>',
    ];
    const result = postProcessDiffLines(lines, []);
    expect(result.lines).toEqual(['-old', '+new text']);
  });

  test('passes separators through unchanged', () => {
    const lines = [' context', '~~~', ' more context'];
    const result = postProcessDiffLines(lines, []);
    expect(result.lines).toEqual([' context', '~~~', ' more context']);
  });

  test('detects formatting-only change and keeps both lines with annotation', () => {
    const lines = [
      '-**hello**',
      '+_hello_',
    ];
    const result = postProcessDiffLines(lines, []);
    // Both lines preserved
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toBe('-**hello**');
    expect(result.lines[1]).toBe('+_hello_');
    // Annotation on the + line (index 1)
    expect(result.formatAnnotations).toBeDefined();
    expect(result.formatAnnotations[1]).toMatch(/bold.*italic|italic.*bold/);
  });

  test('does not annotate when text content differs', () => {
    const lines = [
      '-**hello**',
      '+_goodbye_',
    ];
    const result = postProcessDiffLines(lines, []);
    expect(result.lines).toHaveLength(2);
    expect(result.formatAnnotations).toBeUndefined();
  });

  test('does not annotate empty/whitespace-only lines', () => {
    const lines = [
      '-  ',
      '+  ',
    ];
    const result = postProcessDiffLines(lines, []);
    // Lines pass through but no format annotation (trimmed text is empty)
    expect(result.formatAnnotations).toBeUndefined();
  });

  test('remaps hunkStarts when lines are unchanged', () => {
    const lines = [' context1', ' context2', '-old', '+new'];
    const hunkStarts = [{ index: 0, oldStart: 1, newStart: 1 }];
    const result = postProcessDiffLines(lines, hunkStarts);
    expect(result.hunkStarts[0].index).toBe(0);
    expect(result.hunkStarts[0].oldStart).toBe(1);
  });

  test('remaps hunkStarts correctly with separator', () => {
    const lines = [' a', '~~~', ' b'];
    const hunkStarts = [
      { index: 0, oldStart: 1, newStart: 1 },
      { index: 2, oldStart: 10, newStart: 10 },
    ];
    const result = postProcessDiffLines(lines, hunkStarts);
    expect(result.hunkStarts[0].index).toBe(0);
    expect(result.hunkStarts[1].index).toBe(2);
  });

  test('handles empty input', () => {
    const result = postProcessDiffLines([], []);
    expect(result.lines).toEqual([]);
    expect(result.hunkStarts).toEqual([]);
    expect(result.formatAnnotations).toBeUndefined();
  });

  test('strips spans from format-only pairs', () => {
    const lines = [
      '-<span style="color:red">hello</span>',
      '+<span style="color:blue">hello</span>',
    ];
    const result = postProcessDiffLines(lines, []);
    expect(result.lines[0]).toBe('-hello');
    expect(result.lines[1]).toBe('+hello');
    expect(result.formatAnnotations[1]).toMatch(/red.*blue|blue.*red/);
  });

  test('format-only annotation describes removed and added marks', () => {
    const lines = [
      '-**hello**',
      '+<u>hello</u>',
    ];
    const result = postProcessDiffLines(lines, []);
    expect(result.formatAnnotations[1]).toContain('bold');
    expect(result.formatAnnotations[1]).toContain('underline');
    expect(result.formatAnnotations[1]).toContain('\u2192'); // arrow
  });

  test('detects format-only in multi-line blocks (del block then add block)', () => {
    const lines = [
      '-**line one**',
      '-**line two**',
      '+_line one_',
      '+_line two_',
    ];
    const result = postProcessDiffLines(lines, []);
    expect(result.lines).toHaveLength(4);
    expect(result.formatAnnotations).toBeDefined();
    expect(result.formatAnnotations[1]).toMatch(/bold.*italic|italic.*bold/);
    expect(result.formatAnnotations[3]).toMatch(/bold.*italic|italic.*bold/);
  });

  test('multi-line block with mismatched sizes falls through (no annotation)', () => {
    const lines = [
      '-**line one**',
      '-**line two**',
      '+_line one_',
    ];
    const result = postProcessDiffLines(lines, []);
    expect(result.lines).toHaveLength(3);
    expect(result.formatAnnotations).toBeUndefined();
  });

  test('multi-line block with any text change falls through (no annotation)', () => {
    const lines = [
      '-**hello**',
      '-**world**',
      '+_hello_',
      '+_CHANGED_',
    ];
    const result = postProcessDiffLines(lines, []);
    expect(result.lines).toHaveLength(4);
    expect(result.formatAnnotations).toBeUndefined();
  });

  test('multi-line format-only block remaps hunkStarts correctly', () => {
    const lines = [
      ' context',
      '-**a**',
      '-**b**',
      '+_a_',
      '+_b_',
      ' more context',
    ];
    const hunkStarts = [{ index: 0, oldStart: 1, newStart: 1 }];
    const result = postProcessDiffLines(lines, hunkStarts);
    expect(result.hunkStarts[0].index).toBe(0);
    // 1 context + 4 diff lines + 1 context = 6 lines
    expect(result.lines).toHaveLength(6);
    // Annotations on the + lines (indices 2 and 4)
    expect(result.formatAnnotations[2]).toBeDefined();
    expect(result.formatAnnotations[4]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// inlineSegments — word-level inline diff (feature 022, T004)
// ---------------------------------------------------------------------------

describe('postProcessDiffLines — inlineSegments (word-level)', () => {
  test('a word-changed -/+ pair yields segments keyed by output index (prefix-stripped)', () => {
    const lines = ['-the quick fox', '+the slow fox'];
    const result = postProcessDiffLines(lines, []);
    expect(result.inlineSegments).toBeDefined();
    // del row is output index 0, add row is output index 1
    const before = result.inlineSegments[0];
    const after = result.inlineSegments[1];
    // Segment text is prefix-stripped: rejoins to the row content without prefix
    expect(before.map((s) => s.text).join('')).toBe('the quick fox');
    expect(after.map((s) => s.text).join('')).toBe('the slow fox');
    // Only the changed word is flagged on each side
    expect(before.filter((s) => s.changed).map((s) => s.text)).toEqual(['quick']);
    expect(after.filter((s) => s.changed).map((s) => s.text)).toEqual(['slow']);
  });

  test('segments strip span wrappers so they match the rendered row', () => {
    const lines = [
      '-<span style="color:red">the quick fox</span>',
      '+<span style="color:blue">the slow fox</span>',
    ];
    const result = postProcessDiffLines(lines, []);
    // result rows are span-stripped; segments must rejoin to the same content
    expect(result.lines).toEqual(['-the quick fox', '+the slow fox']);
    expect(result.inlineSegments[0].map((s) => s.text).join('')).toBe('the quick fox');
    expect(result.inlineSegments[1].map((s) => s.text).join('')).toBe('the slow fox');
  });

  test('format-only annotated pairs yield NO segments', () => {
    const lines = ['-**hello**', '+_hello_'];
    const result = postProcessDiffLines(lines, []);
    expect(result.formatAnnotations).toBeDefined();
    expect(result.inlineSegments).toBeUndefined();
  });

  test('pure add-only block yields NO segments', () => {
    const lines = ['+added line one', '+added line two'];
    const result = postProcessDiffLines(lines, []);
    expect(result.inlineSegments).toBeUndefined();
  });

  test('pure remove-only block yields NO segments', () => {
    const lines = ['-removed line one', '-removed line two'];
    const result = postProcessDiffLines(lines, []);
    expect(result.inlineSegments).toBeUndefined();
  });

  test('an oversized -/+ pair degrades to tint-only (no segments, no throw) — perf guardrail', () => {
    const { MAX_SIDE_CHARS } = require('../../../shared/diff/word-diff');
    const hugeBefore = '-' + 'aa bb '.repeat(MAX_SIDE_CHARS / 6 + 1);
    const hugeAfter = '+' + 'cc dd '.repeat(MAX_SIDE_CHARS / 6 + 1);
    const result = postProcessDiffLines([hugeBefore, hugeAfter, '-small x', '+small y'], []);
    // The huge pair (output idx 0/1) gets no segments; the small pair (2/3) still does
    expect(result.inlineSegments[0]).toBeUndefined();
    expect(result.inlineSegments[1]).toBeUndefined();
    expect(result.inlineSegments[2].filter((s) => s.changed).map((s) => s.text)).toEqual(['x']);
    expect(result.inlineSegments[3].filter((s) => s.changed).map((s) => s.text)).toEqual(['y']);
  });

  test('unequal -/+ counts pair up to min(del,add); surplus rows are segment-free', () => {
    // 3 del, 1 add — a text change so it is NOT format-only.
    const lines = ['-alpha one', '-beta two', '-gamma three', '+alpha ONE'];
    const result = postProcessDiffLines(lines, []);
    // del rows: output idx 0,1,2 ; add row: output idx 3
    expect(result.inlineSegments).toBeDefined();
    const keys = Object.keys(result.inlineSegments).map(Number).sort((a, b) => a - b);
    // min(3,1)=1 pair → del row 0 + add row 3 only
    expect(keys).toEqual([0, 3]);
    expect(result.inlineSegments[1]).toBeUndefined();
    expect(result.inlineSegments[2]).toBeUndefined();
  });

  test('context lines get no segments', () => {
    const lines = [' unchanged context', '-a x', '+a y'];
    const result = postProcessDiffLines(lines, []);
    expect(result.inlineSegments[0]).toBeUndefined(); // context row
    expect(result.inlineSegments[1]).toBeDefined();   // del row
    expect(result.inlineSegments[2]).toBeDefined();   // add row
  });
});

// ---------------------------------------------------------------------------
// computeChatDiff — inlineSegments threading + truncation filter (T005)
// ---------------------------------------------------------------------------

describe('computeChatDiff — inlineSegments', () => {
  test('threads inlineSegments through on the normal branch', () => {
    const diff = computeChatDiff('the quick fox', 'the slow fox');
    expect(diff.truncatedByServer).toBeUndefined();
    expect(diff.inlineSegments).toBeDefined();
    // some row has a changed segment for the replaced word
    const allSegs = Object.values(diff.inlineSegments).flat();
    expect(allSegs.some((s) => s.changed && (s.text === 'quick' || s.text === 'slow'))).toBe(true);
  });

  test('on truncatedByServer, inlineSegments keys are filtered to < MAX_DIFF_LINES (200)', () => {
    // Build a large diff: 260 lines, each changed by one word, long enough to
    // exceed the 50,000-char cap and the 200-line cap.
    const pad = 'x'.repeat(180);
    const before = Array.from({ length: 260 }, (_, n) => `${pad} alpha ${n}`).join('\n');
    const after = Array.from({ length: 260 }, (_, n) => `${pad} beta ${n}`).join('\n');
    const diff = computeChatDiff(before, after);
    expect(diff.truncatedByServer).toBe(true);
    expect(diff.inlineSegments).toBeDefined();
    const keys = Object.keys(diff.inlineSegments).map(Number);
    expect(keys.length).toBeGreaterThan(0);
    // No key references a truncated-away line
    for (const k of keys) expect(k).toBeLessThan(200);
    expect(Math.max(...keys)).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// stripHardBreakMarkers — grammar-exact hard-break marker removal (feature 028,
// T002 unit spec). Each case pins one row of research.md R3's grammar table, or
// one of the mandatory MEDIUM cases (M1 nested fence, M2 prefix-tolerance).
//
// In these JS string literals `\\` is a single backslash character. The input
// strings are representative canonical serializations (paragraphs join with a
// blank line; hardBreak emits `\` immediately before its `\n`; blockquote
// continuations carry a `> ` prefix; list continuations carry content-column
// indentation; fences — code and diagram — are emitted with ``` syntax).
// ---------------------------------------------------------------------------

describe('stripHardBreakMarkers', () => {
  // (a) top-level poem stanza: internal markers stripped; block-final `\` kept.
  test('(a) top-level stanza strips internal markers, preserves the block-final backslash', () => {
    const input = 'Roses are red\\\nViolets are blue\\\nSugar is sweet\n\nAnd so are you\\';
    const expected = 'Roses are red\nViolets are blue\nSugar is sweet\n\nAnd so are you\\';
    expect(stripHardBreakMarkers(input)).toBe(expected);
  });

  // (b) list-item continuation: `- a\` / `␠␠b` (content-column indent).
  test('(b) list-item hard break: marker stripped, indent preserved', () => {
    const input = '- first line\\\n  second line';
    const expected = '- first line\n  second line';
    expect(stripHardBreakMarkers(input)).toBe(expected);
  });

  // (c) blockquote continuation: `> a\` / `> b`.
  test('(c) blockquote hard break: marker stripped, `> ` prefix preserved', () => {
    const input = '> quoted one\\\n> quoted two';
    const expected = '> quoted one\n> quoted two';
    expect(stripHardBreakMarkers(input)).toBe(expected);
  });

  // (d) block-final trailing `\` (RBD-1): preserved, both before a blank line
  //     (literal-content OR trailing-hardBreak, grammar-ambiguous) and at EOF.
  test('(d) block-final backslash before a blank line is preserved', () => {
    const input = 'text ends with backslash\\\n\nnext paragraph';
    expect(stripHardBreakMarkers(input)).toBe(input);
  });
  test('(d) block-final backslash at EOF is preserved', () => {
    const input = 'only line\\';
    expect(stripHardBreakMarkers(input)).toBe(input);
  });
  // (d, prefix-aware) blockquote block-final: next line is a bare `>` separator,
  //     which is empty after `>`-run strip → preserve (pins prefix-aware emptiness).
  test('(d) blockquote block-final before a bare `>` separator is preserved', () => {
    const input = '> para one\\\n>\n> para two';
    expect(stripHardBreakMarkers(input)).toBe(input);
  });

  // (e) double backslash + continuation (edge f): strip exactly one; literal `\` kept.
  test('(e) double backslash before a continuation: exactly one stripped, literal backslash kept', () => {
    const input = 'text\\\\\ncontinues';   // `text\\` then continuation
    const expected = 'text\\\ncontinues';  // `text\` kept
    expect(stripHardBreakMarkers(input)).toBe(expected);
  });

  // (f) code fence with a trailing-`\` content line: preserved (SC-002c).
  test('(f) code fence content backslash is preserved even with a non-empty next line', () => {
    const input = '```js\ncode line one\\\ncode line two\n```';
    expect(stripHardBreakMarkers(input)).toBe(input);
  });

  // (g) diagram fences (mermaid/svg) with a trailing-`\` content line: preserved (SC-002d, RBD-3).
  test('(g) mermaid diagram fence content backslash is preserved', () => {
    const input = '```mermaid\ngraph TD\nA --> B \\\nC\n```';
    expect(stripHardBreakMarkers(input)).toBe(input);
  });
  test('(g) svg diagram fence content backslash is preserved', () => {
    const input = '```svg\n<path d="M0 0 \\\nL1 1"/>\n```';
    expect(stripHardBreakMarkers(input)).toBe(input);
  });

  // (h) a fence that opens several lines before a mid-fence content backslash:
  //     the full-doc scan keeps fence state, so the mid-fence `\` is preserved,
  //     while a hard break AFTER the fence closes is still stripped.
  test('(h) whole-doc fence state preserves mid-fence backslash; post-fence marker still stripped', () => {
    const input = '```\nline1\nline2\nmid content\\\nline4\n```\nafter fence\\\nmore';
    const expected = '```\nline1\nline2\nmid content\\\nline4\n```\nafter fence\nmore';
    expect(stripHardBreakMarkers(input)).toBe(expected);
  });

  // (i) heading and table-cell lines (serializer already `<br>`) pass through unchanged.
  test('(i) heading and table-cell lines (already <br>) pass through unchanged', () => {
    const input = '# Heading with<br>break\n\n| a<br>b | c |\n| --- | --- |';
    expect(stripHardBreakMarkers(input)).toBe(input);
  });

  // (j) a marker-only difference collapses: cleaning the marked form yields the
  //     same string as the already-unmarked form (basis for "no hunk", FR-004).
  test('(j) marker-only difference collapses after cleanup', () => {
    const marked = 'alpha\\\nbeta';
    const unmarked = 'alpha\nbeta';
    expect(stripHardBreakMarkers(marked)).toBe(stripHardBreakMarkers(unmarked));
    expect(stripHardBreakMarkers(marked)).toBe('alpha\nbeta');
  });

  // M1 (mandatory MEDIUM): a fenced code block NESTED under a prefix must still
  //     be recognized as a fence, so its trailing-backslash content is preserved.
  test('M1 blockquote-nested code fence: content backslash preserved (prefix-aware fence)', () => {
    const input = '> ```\n> code line\\\n> more code\n> ```';
    expect(stripHardBreakMarkers(input)).toBe(input);
  });
  test('M1 indent-nested code fence (list item): content backslash preserved (prefix-aware fence)', () => {
    // A list item whose first block child is a code block: `-` on its own line,
    // the fence at the 2-space content column.
    const input = '-\n  ```\n  code\\\n  more\n  ```';
    expect(stripHardBreakMarkers(input)).toBe(input);
  });
  test('M1 prefix-nested fence toggles back off: a hard break after the fence closes is stripped', () => {
    const input = '> ```\n> code\\\n> ```\n> after\\\n> tail';
    const expected = '> ```\n> code\\\n> ```\n> after\n> tail';
    expect(stripHardBreakMarkers(input)).toBe(expected);
  });

  // M2 (mandatory MEDIUM): the continuation check AND fence toggling are both
  //     prefix-tolerant. Marker stripping under a prefix is pinned by (b)/(c);
  //     fence recognition under a prefix by M1. This case combines a stripped
  //     blockquote hard break with a preserved blockquote-nested fence in one doc.
  test('M2 combined: prefixed hard break stripped AND prefixed fence content preserved', () => {
    const input = '> intro line\\\n> body line\n>\n> ```\n> x = 1 \\\n> ```';
    const expected = '> intro line\n> body line\n>\n> ```\n> x = 1 \\\n> ```';
    expect(stripHardBreakMarkers(input)).toBe(expected);
  });
});
