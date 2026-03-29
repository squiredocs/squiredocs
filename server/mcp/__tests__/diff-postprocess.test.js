const { postProcessDiffLines, stripSpanTags, extractPlainText, describeMarks } = require('../diff-postprocess');

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
