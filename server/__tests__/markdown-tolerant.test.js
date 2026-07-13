/**
 * Tolerant-grammar construct tests (feature 001, T012 + T016).
 *
 * Covers the nine US1 acceptance scenarios, every spec Edge Case, and the US2
 * degradation ladder. Parses through the public shared entry in tolerant mode.
 */

const { markdownToPm } = require('../../shared/markdown');
const { schema } = require('../../shared/prosemirror-schema');

// --- helpers ---------------------------------------------------------------

const parse = (md, diffMark = null) => markdownToPm(md, diffMark);

/** Recursively collect all text from a PM doc. */
function plainText(node) {
  if (node.type === 'text') return node.text;
  if (!node.content) return '';
  return node.content.map(plainText).join('');
}

/** Collect the ordered list of block types at the top level. */
function blockTypes(doc) {
  return doc.content.map((b) => b.type);
}

/** Find every node (deep) matching a predicate. */
function findAll(node, pred, acc = []) {
  if (pred(node)) acc.push(node);
  if (node.content) for (const c of node.content) findAll(c, pred, acc);
  return acc;
}

const marksOf = (doc) => findAll(doc, (n) => n.type === 'text').flatMap((n) => (n.marks || []).map((m) => m.type));

function expectValid(doc) {
  expect(() => schema.nodeFromJSON(doc).check()).not.toThrow();
}

// ---------------------------------------------------------------------------
// US1 acceptance scenarios
// ---------------------------------------------------------------------------

describe('US1 — real-world markdown parses into correct structure', () => {
  test('AS-1: emphasis variants and nesting (CommonMark flanking)', () => {
    const doc = parse('**bold** __bold__ *italic* _italic_ **b with *i* inside**');
    const marks = marksOf(doc);
    expect(marks).toContain('bold');
    expect(marks).toContain('italic');
    // nested: some text carries both bold and italic
    const both = findAll(doc, (n) => n.type === 'text' && (n.marks || []).some((m) => m.type === 'bold') && (n.marks || []).some((m) => m.type === 'italic'));
    expect(both.length).toBeGreaterThan(0);
    expectValid(doc);
  });

  test('AS-2: loose and tight lists produce one identical structure (FR-005)', () => {
    const loose = parse('- a\n\n- b');
    const tight = parse('- a\n- b');
    expect(blockTypes(loose)).toEqual(['bulletList']);
    expect(loose.content[0].content.length).toBe(2);
    // loose vs tight → same structure
    expect(loose).toEqual(tight);
  });

  test('AS-2b: multi-paragraph item keeps both paragraphs inside the item', () => {
    const doc = parse('- first\n\n  second');
    const list = doc.content[0];
    expect(list.type).toBe('bulletList');
    const item = list.content[0];
    expect(item.content.filter((n) => n.type === 'paragraph').length).toBe(2);
    expect(plainText(doc)).toContain('first');
    expect(plainText(doc)).toContain('second');
    expectValid(doc);
  });

  test('AS-2c: lazy continuation line stays in its item', () => {
    const doc = parse('- item text\ncontinued lazily');
    const item = doc.content[0].content[0];
    expect(plainText(item)).toContain('continued lazily');
    expectValid(doc);
  });

  test('AS-3: setext headings', () => {
    expect(parse('Title\n===').content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(parse('Sub\n---').content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
  });

  test('AS-4: indented code block, de-indented verbatim', () => {
    const doc = parse('    const x = 1;\n    const y = 2;');
    expect(doc.content[0].type).toBe('codeBlock');
    expect(plainText(doc)).toBe('const x = 1;\nconst y = 2;');
    expectValid(doc);
  });

  test('AS-5: autolinks — angle, bare http, www', () => {
    for (const [md, href] of [
      ['<https://example.com>', 'https://example.com'],
      ['bare https://example.com here', 'https://example.com'],
      ['see www.example.com now', 'http://www.example.com'],
    ]) {
      const links = findAll(parse(md), (n) => (n.marks || []).some((m) => m.type === 'link'));
      expect(links.length).toBeGreaterThan(0);
      const link = links[0].marks.find((m) => m.type === 'link');
      expect(link.attrs.href).toBe(href);
    }
  });

  test('AS-6: escapes and entities', () => {
    const doc = parse('\\*not emphasis\\* and &amp; and &#65;');
    expect(marksOf(doc)).not.toContain('bold');
    expect(marksOf(doc)).not.toContain('italic');
    expect(plainText(doc)).toBe('*not emphasis* and & and A');
  });

  test('AS-7: GFM task list degrades to bullets with marker preserved (CN-3)', () => {
    const doc = parse('- [ ] todo\n- [x] done');
    expect(doc.content[0].type).toBe('bulletList');
    expect(plainText(doc.content[0].content[0])).toBe('[ ] todo');
    expect(plainText(doc.content[0].content[1])).toBe('[x] done');
    expectValid(doc);
  });

  test('AS-8: registry-known HTML → marks; <br> → hardBreak', () => {
    const doc = parse('<u>u</u> <mark>m</mark> <sub>b</sub> <sup>p</sup> <span style="color:#333">s</span> a<br>b');
    const marks = marksOf(doc);
    expect(marks).toEqual(expect.arrayContaining(['underline', 'highlight', 'subscript', 'superscript', 'textStyle']));
    expect(findAll(doc, (n) => n.type === 'hardBreak').length).toBe(1);
    expectValid(doc);
  });

  test('AS-9: unknown HTML becomes literal visible text, never dropped', () => {
    const doc = parse('before <div>x</div> <script>alert(1)</script> <custom-tag> after');
    const text = plainText(doc);
    expect(text).toContain('<div>x</div>');
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('<custom-tag>');
    expectValid(doc);
  });
});

// ---------------------------------------------------------------------------
// Edge Cases (spec §Edge Cases)
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  test('--- disambiguation: after paragraph = setext H2; after blank = HR', () => {
    expect(parse('para\n---').content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(blockTypes(parse('para\n\n---\n'))).toEqual(['paragraph', 'horizontalRule']);
  });

  test('thematic-break variants ***/___ (I2)', () => {
    expect(blockTypes(parse('***'))).toEqual(['horizontalRule']);
    expect(blockTypes(parse('___'))).toEqual(['horizontalRule']);
    expect(blockTypes(parse('- - -'))).toEqual(['horizontalRule']);
  });

  test('ATX trailing hashes stripped (I2)', () => {
    expect(plainText(parse('## Title ##'))).toBe('Title');
    expect(parse('## Title ##').content[0].attrs.level).toBe(2);
  });

  test('unclosed fence consumes to EOF', () => {
    const doc = parse('```js\nconst x = 1;\nmore');
    expect(doc.content[0].type).toBe('codeBlock');
    expect(plainText(doc)).toContain('const x = 1;');
    expect(plainText(doc)).toContain('more');
  });

  test('escapes and entities are NOT processed inside code spans/blocks', () => {
    const span = parse('`a\\*b &amp;`');
    expect(plainText(span)).toBe('a\\*b &amp;');
    const block = parse('```\n\\*x &amp;\n```');
    expect(plainText(block)).toBe('\\*x &amp;');
  });

  test('<span style> policy: recognized props apply, unrecognized-only stays literal (CN-6)', () => {
    const ok = parse('<span style="color:#333;text-shadow:1px">x</span>');
    const styled = findAll(ok, (n) => (n.marks || []).some((m) => m.type === 'textStyle'));
    expect(styled.length).toBe(1);
    expect(styled[0].marks.find((m) => m.type === 'textStyle').attrs.color).toBe('#333');
    const literal = parse('<span style="text-shadow:1px">x</span>');
    expect(marksOf(literal)).not.toContain('textStyle');
    expect(plainText(literal)).toContain('<span style="text-shadow:1px">x</span>');
  });

  test('unbalanced whitelist tag degrades to literal', () => {
    const doc = parse('<u>unclosed underline');
    expect(marksOf(doc)).not.toContain('underline');
    expect(plainText(doc)).toContain('<u>unclosed underline');
  });

  test('ordered-list checkbox stays literal item text (CN-3 edge)', () => {
    const doc = parse('1. [x] item');
    expect(doc.content[0].type).toBe('orderedList');
    expect(plainText(doc)).toBe('[x] item');
  });

  test('ordered list honors start number; strict fixes start at 1', () => {
    expect(parse('3. third').content[0].attrs.start).toBe(3);
    expect(markdownToPm('3. third', null, { strict: true }).content[0].attrs.start).toBe(1);
  });

  test('CRLF normalized, no \\r leaks into text', () => {
    const doc = parse('line one\r\nline two\r\n\r\n- item\r\n');
    expect(plainText(doc)).not.toContain('\r');
    expect(findAll(doc, (n) => n.type === 'bulletList').length).toBe(1);
  });

  test('empty and whitespace-only input → single empty paragraph', () => {
    expect(parse('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(parse('   \n  \n')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });

  test('YAML frontmatter parses as normal markdown (no frontmatter awareness)', () => {
    const doc = parse('---\nkey: value\n---\nbody');
    // CommonMark precedence: HR, then setext H2 from "key: value", then body.
    expect(doc.content[0].type).toBe('horizontalRule');
    expect(plainText(doc)).toContain('key: value');
    expect(plainText(doc)).toContain('body');
    expectValid(doc);
  });

  test('non-pipe table row degrades to a paragraph preserving text (CN-8)', () => {
    const doc = parse('a | b | c');
    expect(doc.content[0].type).toBe('paragraph');
    expect(plainText(doc)).toBe('a | b | c');
  });

  test('pipe-leading table parses identically in both modes (CN-8/FR-012)', () => {
    // The current dialect splits cells on every pipe (escaped \| is a
    // pre-existing quirk); tolerant mode reproduces strict byte-for-byte so
    // canonical parses never change (US3 AS-3).
    const md = '| a \\| b |\n| --- |\n| d |';
    const tolerant = parse(md);
    const strict = markdownToPm(md, null, { strict: true });
    expect(tolerant.content[0].type).toBe('table');
    expect(tolerant).toEqual(strict);
    expect(plainText(tolerant)).toContain('b');
    expect(plainText(tolerant)).toContain('d');
  });

  test('diffMark applied as last mark on every text node', () => {
    const doc = parse('**bold** text', 'diffInsert');
    for (const t of findAll(doc, (n) => n.type === 'text')) {
      expect(t.marks[t.marks.length - 1]).toEqual({ type: 'diffInsert' });
    }
  });
});

// ---------------------------------------------------------------------------
// US2 — no input ever loses content (degradation ladder, FR-013) — T016
// ---------------------------------------------------------------------------

describe('US2 — degradation ladder', () => {
  test('AS-1: unknown HTML appears as literal visible text (FR-010)', () => {
    for (const md of ['<div>x</div>', '<script>alert(1)</script>', '<custom-tag>y</custom-tag>', '<!-- a comment -->', '<section>\nblock html\n</section>']) {
      const doc = parse(md);
      // no mark applied from unknown tags
      expect(marksOf(doc)).not.toContain('underline');
      // the raw tag text survives somewhere in the document
      const text = plainText(doc);
      expect(text.length).toBeGreaterThan(0);
      expectValid(doc);
    }
    expect(plainText(parse('<script>alert(1)</script>'))).toContain('alert(1)');
    expect(plainText(parse('<custom-tag>y</custom-tag>'))).toContain('<custom-tag>');
    expect(plainText(parse('<!-- a comment -->'))).toContain('a comment');
  });

  test('AS-2: unsupported constructs preserve their text', () => {
    expect(plainText(parse('a footnote[^1] ref'))).toContain('[^1]');
    expect(plainText(parse('math $x^2$ inline'))).toContain('$x^2$');
    const callout = parse('> [!NOTE]\n> important body');
    expect(callout.content[0].type).toBe('blockquote');
    expect(plainText(callout)).toContain('[!NOTE]');
    expect(plainText(callout)).toContain('important body');
    [parse('a footnote[^1] ref'), parse('math $x^2$ inline'), callout].forEach(expectValid);
  });

  test('AS-3: unclosed fence and unbalanced tags terminate normally, text preserved', () => {
    const fence = parse('```\nnever closed\nmore text');
    expect(fence.content[0].type).toBe('codeBlock');
    expect(plainText(fence)).toContain('never closed');
    expect(plainText(fence)).toContain('more text');
    expectValid(fence);

    const tag = parse('<mark>highlighted but never closed');
    expect(marksOf(tag)).not.toContain('highlight');
    expect(plainText(tag)).toContain('highlighted but never closed');
    expectValid(tag);
  });

  test('every degraded output validates against the schema', () => {
    const inputs = [
      '<div><span><b>x', '```\nunclosed', '- [ ] a\n\t\tweird', '> [!TIP] q', '$$block math$$',
      '<u><mark>nested unclosed', '####### too many hashes', '\x00\x01 control chars',
    ];
    for (const md of inputs) {
      const doc = parse(md);
      expectValid(doc);
      expect(doc.content.length).toBeGreaterThan(0);
    }
  });
});
