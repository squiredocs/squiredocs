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

  // Review 028-M1: closing is asymmetric — inside a fence, only a bare ``` line
  // closes (the serializer's sole closing form). A code body line that merely
  // STARTS with ``` (e.g. a code block quoting fence syntax) must not flip the
  // state and poison classification for the rest of the document.
  test('M1 regression: ```-prefixed code content does not close the fence', () => {
    const input = [
      '```',
      '```js is how you open a fence',
      'path = base \\',
      '```',
      '',
      'prose one\\',
      'prose two',
    ].join('\n');
    const expected = [
      '```',
      '```js is how you open a fence',
      'path = base \\', // fence content: preserved
      '```',
      '',
      'prose one',      // real marker after the block: stripped
      'prose two',
    ].join('\n');
    expect(stripHardBreakMarkers(input)).toBe(expected);
  });

  // Accepted string-level ambiguities (review 028-M1 residual): pinned so any
  // behavior change is loud. Both fail SAFE (markers leak — cosmetic — rather
  // than content being stripped).
  test('accepted ambiguity: a bare ``` code-body line reads as a close (markers after it leak)', () => {
    // Code block whose BODY is a bare ``` line: open(0) closes at body(1),
    // reopens at real close(2) — leaving phantom fence state afterward.
    const input = '```\n```\n```\n\nprose\\\ncontinues';
    const out = stripHardBreakMarkers(input);
    expect(out).toContain('prose\\'); // marker preserved (leak), never content-stripped
  });
  test('accepted ambiguity: a paragraph starting with ``` reads as an open (markers after it leak)', () => {
    const input = '```js as literal paragraph text\n\nprose\\\ncontinues';
    const out = stripHardBreakMarkers(input);
    expect(out).toContain('prose\\'); // phantom fence → preserve-side failure only
  });

  // Review 028-L4: pin the serializer's actual emission for a trailing hard
  // break in a list item — an indent-only continuation line before the sibling
  // (serialization.js renderListItem). The whitespace-only continuation must
  // read as block-final → marker preserved (RBD-1).
  test('L4: trailing list-item hard break followed by indent-only line is preserved', () => {
    const input = '- first\\\n  \n- second';
    expect(stripHardBreakMarkers(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// computeChatDiff — hard-break marker removal (feature 028). Integration cases
// that assert the cleaned line diff. `endsWithMarker` treats any rendered row
// (prefix + content) ending in a backslash as a would-be marker leak.
// ---------------------------------------------------------------------------

const endsWithMarker = (line) => line.endsWith('\\');

// US1 (T005) — screenshot scenario: hard-broken prose renders clean.
describe('computeChatDiff — US1 hard-broken prose (screenshot scenario)', () => {
  test('poem-stanza edit: no removed/added/context row ends in a hard-break marker; structure intact', () => {
    // A single paragraph, five lines separated by hard breaks (trailing `\`),
    // the last line block-final (no marker). Edit only line three.
    const before = 'Line one of the poem\\\nLine two of the poem\\\n'
      + 'Line three original\\\nLine four of the poem\\\nLine five of the poem';
    const after = 'Line one of the poem\\\nLine two of the poem\\\n'
      + 'Line three EDITED\\\nLine four of the poem\\\nLine five of the poem';
    const diff = computeChatDiff(before, after);

    // No row of any kind (removed `-`, added `+`, context ` `) leaks a marker.
    expect(diff.lines.some(endsWithMarker)).toBe(false);
    // Context rows specifically are cleaned too (the amendment covers all rows).
    const contextRows = diff.lines.filter((l) => l.startsWith(' '));
    expect(contextRows.length).toBeGreaterThan(0);
    expect(contextRows.some(endsWithMarker)).toBe(false);

    // The change is present, marker-free, on both sides.
    expect(diff.lines).toContain('-Line three original');
    expect(diff.lines).toContain('+Line three EDITED');

    // Line structure is unchanged by cleanup: a single hunk starting at 1/1
    // (cleanup removes characters, never lines), so no `~~~` separator and
    // gutter numbering indexes into the 5-line document as before.
    expect(diff.lines).not.toContain('~~~');
    expect(diff.hunkStarts).toHaveLength(1);
    expect(diff.hunkStarts[0]).toMatchObject({ index: 0, oldStart: 1, newStart: 1 });
  });
});

// US1 (T006) — container continuation: list-item and blockquote hard breaks.
describe('computeChatDiff — US1 container continuation (list + blockquote)', () => {
  test('markers removed on prefixed continuation forms; indent and `> ` preserved', () => {
    // A bullet item whose paragraph has hard breaks (continuations at the
    // 2-space content column) and a blockquote paragraph with hard breaks
    // (continuations carry `> `). Edit the middle line of each.
    const before = '- alpha one\\\n  alpha two\\\n  alpha three\n\n'
      + '> quote one\\\n> quote two\\\n> quote three';
    const after = '- alpha one\\\n  alpha TWO\\\n  alpha three\n\n'
      + '> quote one\\\n> quote TWO\\\n> quote three';
    const diff = computeChatDiff(before, after);

    expect(diff.lines.some(endsWithMarker)).toBe(false);
    // List continuation: content-column indent preserved, marker gone.
    expect(diff.lines).toContain('-  alpha two');
    expect(diff.lines).toContain('+  alpha TWO');
    // Blockquote continuation: `> ` prefix preserved, marker gone.
    expect(diff.lines).toContain('-> quote two');
    expect(diff.lines).toContain('+> quote TWO');
  });
});

// US1 (T007) — 022 inlineSegments and format-only detection on cleaned text.
describe('computeChatDiff — US1 word segments + format-only on cleaned text', () => {
  test('inlineSegments carry no marker and concatenate exactly to each row (AS3, SC-004)', () => {
    const before = 'intro line\\\nthe quick brown fox\\\noutro line';
    const after = 'intro line\\\nthe slow brown fox\\\noutro line';
    const diff = computeChatDiff(before, after);

    expect(diff.lines.some(endsWithMarker)).toBe(false);
    expect(diff.inlineSegments).toBeDefined();

    // No segment text contains a hard-break marker.
    const allSegs = Object.values(diff.inlineSegments).flat();
    expect(allSegs.some((s) => s.text.includes('\\'))).toBe(false);

    // Each keyed row's segments concatenate byte-identically to that row's
    // rendered text (the diff line with its one-char prefix removed).
    for (const [k, segs] of Object.entries(diff.inlineSegments)) {
      const rendered = diff.lines[Number(k)].slice(1);
      expect(segs.map((s) => s.text).join('')).toBe(rendered);
    }
    // The changed word pair is present on the cleaned rows.
    expect(diff.lines).toContain('-the quick brown fox');
    expect(diff.lines).toContain('+the slow brown fox');
  });

  test('formatting-only change on a hard-broken line detects as format-only, not a -/+ change (AS4)', () => {
    // Line two is block-final (no marker); only its formatting changes (bold),
    // so plain text matches on both sides → format-only annotation, no segments.
    const before = 'first line\\\nsecond line';
    const after = 'first line\\\n**second line**';
    const diff = computeChatDiff(before, after);

    expect(diff.lines.some(endsWithMarker)).toBe(false);
    expect(diff.formatAnnotations).toBeDefined();
    // Context row for the hard-broken first line is cleaned.
    expect(diff.lines).toContain(' first line');
  });
});

// US2 (T008) — undo/redo cards get the identical treatment via the one shared path.
describe('computeChatDiff — US2 undo/redo shared generation point', () => {
  test('an undo-shaped (pre, post) call is marker-free and byte-identical to the modify-shaped call on the same pair (SC-003)', () => {
    const original = 'stanza line one\\\nstanza line two\\\nstanza line three';
    const edited = 'stanza line one\\\nstanza line TWO\\\nstanza line three';

    // The 020 undo path calls the SAME function as modify with the inverse's
    // (preMarkdown, postMarkdown) — here reverting `edited` back to `original`.
    const undoDiff = computeChatDiff(edited, original);
    expect(undoDiff.lines.some(endsWithMarker)).toBe(false);
    expect(undoDiff.lines).toContain('-stanza line TWO');
    expect(undoDiff.lines).toContain('+stanza line two');

    // The single-shared-cleanup-point property is architectural, not assertable
    // here: modify.js and undo-service.js both call diffUtils.computeChatDiff
    // (the undo call site is pinned to the namespace import precisely so suites
    // can spy on it — see undo-service.js's import comment). A duplicate call
    // with identical args would only prove determinism (review 028-L3).

    // The forward modify direction is likewise clean.
    const modifyForward = computeChatDiff(original, edited);
    expect(modifyForward.lines.some(endsWithMarker)).toBe(false);
  });
});

// US3 (T009) — genuine backslashes and everything else are untouched.
describe('computeChatDiff — US3 preservation of content backslashes', () => {
  test('(i) code-block trailing-backslash content survives (SC-002c)', () => {
    const before = '```js\nconst a = 1; \\\nconst b = 2;\n```';
    const after = '```js\nconst a = 1; \\\nconst b = 3;\n```';
    const diff = computeChatDiff(before, after);
    // The `const a = 1; \` line is a context row inside the fence — backslash kept.
    expect(diff.lines).toContain(' const a = 1; \\');
  });

  test('(ii) mermaid diagram-fence trailing-backslash content survives (SC-002d, RBD-3)', () => {
    const before = '```mermaid\ngraph TD\nA-->B \\\nC-->D\n```';
    const after = '```mermaid\ngraph TD\nA-->B \\\nC-->E\n```';
    const diff = computeChatDiff(before, after);
    expect(diff.lines).toContain(' A-->B \\');
  });

  test('(iii) a paragraph whose text legitimately ends in a backslash is preserved (RBD-1, SC-002e)', () => {
    const before = 'para ends backslash\\\n\nsecond para original';
    const after = 'para ends backslash\\\n\nsecond para EDITED';
    const diff = computeChatDiff(before, after);
    // Block-final backslash (next line blank) → preserved as a context row.
    expect(diff.lines).toContain(' para ends backslash\\');
  });

  test('(iv) double-backslash-plus-continuation: exactly one stripped, literal backslash kept', () => {
    const before = 'alpha\\\\\nbravo original';   // `alpha\\` then continuation
    const after = 'alpha\\\\\nbravo EDITED';
    const diff = computeChatDiff(before, after);
    // Context row keeps exactly one backslash (the literal), the marker is gone.
    expect(diff.lines).toContain(' alpha\\');
    expect(diff.lines).not.toContain(' alpha\\\\');
  });

  test('(v) mixed diff: prose markers stripped while code and literal backslashes are preserved', () => {
    const before = 'poem uno\\\npoem dos\\\npoem tres\n\n'
      + '```\ncode uno \\\ncode dos\n```\n\n'
      + 'ends with slash\\\n\ntail text';
    const after = 'poem uno\\\npoem dos\\\npoem TRES\n\n'
      + '```\ncode uno \\\ncode DOS\n```\n\n'
      + 'ends with slash\\\n\ntail TEXT';
    const diff = computeChatDiff(before, after);
    // Prose marker stripped (context row) — and NOT present with its marker.
    expect(diff.lines).toContain(' poem dos');
    expect(diff.lines).not.toContain(' poem dos\\');
    // Code-fence content backslash preserved.
    expect(diff.lines).toContain(' code uno \\');
    // Literal block-final backslash preserved.
    expect(diff.lines).toContain(' ends with slash\\');
  });

  test('a marker-only difference produces no hunk (FR-004)', () => {
    // The two serializations differ only by a hard-break marker; after cleanup
    // they are equal, so the line diff yields no hunk at all.
    const before = 'alpha\\\nbeta';
    const after = 'alpha\nbeta';
    const diff = computeChatDiff(before, after);
    expect(diff.lines).toHaveLength(0);
    expect(diff.hunkStarts).toHaveLength(0);
  });
});

// US3 (T010) — guard: cleanup is a lossless subset transform (only backslashes
// removed, line count invariant), so it cannot corrupt content or the untouched
// version-history / word-diff pipelines (SC-005/SC-006, FR-006/FR-008).
describe('stripHardBreakMarkers — lossless subset guard (T010)', () => {
  const samples = [
    'plain paragraph',
    'poem uno\\\npoem dos\\\npoem tres',
    '```js\ncode a; \\\ncode b;\n```',
    '```mermaid\nA-->B \\\nC\n```',
    '> quote one\\\n> quote two\n>\n> quote three',
    '- item one\\\n  item two\\\n  item three',
    'trailing literal\\',
    'double\\\\\ncont',
    '# Heading<br>break\n\n| a<br>b | c |\n| --- | --- |',
  ];

  test('never changes the line count (never removes a newline) — FR-006', () => {
    for (const s of samples) {
      expect(stripHardBreakMarkers(s).split('\n')).toHaveLength(s.split('\n').length);
    }
  });

  test('removes only backslash characters — every other character is preserved in order', () => {
    const withoutBackslashes = (s) => s.split('').filter((c) => c !== '\\').join('');
    for (const s of samples) {
      const out = stripHardBreakMarkers(s);
      expect(out.length).toBeLessThanOrEqual(s.length);
      // Removing all backslashes from input and output yields identical strings,
      // proving nothing but `\` was ever deleted and no character was reordered.
      expect(withoutBackslashes(out)).toBe(withoutBackslashes(s));
    }
  });
});
