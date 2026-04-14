/**
 * HTML Serialization tests
 *
 * Tests for toHTML and fromHTML conversion functions used in
 * Google Docs sync. Verifies round-trip fidelity for all node types and marks.
 */
const Y = require('yjs');
const { toHTML, fromHTML } = require('../../yjs/html-serialization');
const { toPlainText, toStructured } = require('../../yjs/serialization');

// --- Helpers ---

/** Create a fresh Yjs fragment for testing */
function createFragment() {
  const ydoc = new Y.Doc();
  return ydoc.get('test', Y.XmlFragment);
}

/** Create a Yjs element with text content */
function makeElement(nodeName, text, attrs = {}) {
  const el = new Y.XmlElement(nodeName);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
  if (text) {
    const t = new Y.XmlText();
    t.insert(0, text);
    el.insert(0, [t]);
  }
  return el;
}

/** Parse HTML into a fresh fragment and return it */
function parseHTML(html) {
  const frag = createFragment();
  fromHTML(html, frag);
  return frag;
}

// --- toHTML tests ---

describe('toHTML', () => {
  test('paragraph', () => {
    const frag = createFragment();
    frag.insert(0, [makeElement('paragraph', 'Hello world')]);
    expect(toHTML(frag)).toBe('<p>Hello world</p>');
  });

  test('heading levels', () => {
    const frag = createFragment();
    frag.insert(0, [makeElement('heading', 'Title', { level: 1 })]);
    frag.insert(1, [makeElement('heading', 'Subtitle', { level: 3 })]);
    const html = toHTML(frag);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<h3>Subtitle</h3>');
  });

  test('bold text', () => {
    const frag = createFragment();
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'normal ');
    text.insert(7, 'bold', { bold: true });
    para.insert(0, [text]);
    frag.insert(0, [para]);
    expect(toHTML(frag)).toBe('<p>normal <strong>bold</strong></p>');
  });

  test('italic text', () => {
    const frag = createFragment();
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'emphasis', { italic: true });
    para.insert(0, [text]);
    frag.insert(0, [para]);
    expect(toHTML(frag)).toBe('<p><em>emphasis</em></p>');
  });

  test('link', () => {
    const frag = createFragment();
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'click here', { link: { href: 'https://example.com' } });
    para.insert(0, [text]);
    frag.insert(0, [para]);
    const html = toHTML(frag);
    expect(html).toContain('<a href="https://example.com">click here</a>');
  });

  test('bullet list', () => {
    const frag = createFragment();
    const ul = new Y.XmlElement('bulletList');
    const li = new Y.XmlElement('listItem');
    li.insert(0, [makeElement('paragraph', 'item')]);
    ul.insert(0, [li]);
    frag.insert(0, [ul]);
    expect(toHTML(frag)).toBe('<ul><li><p>item</p></li></ul>');
  });

  test('ordered list with start', () => {
    const frag = createFragment();
    const ol = new Y.XmlElement('orderedList');
    ol.setAttribute('start', '3');
    const li = new Y.XmlElement('listItem');
    li.insert(0, [makeElement('paragraph', 'third')]);
    ol.insert(0, [li]);
    frag.insert(0, [ol]);
    expect(toHTML(frag)).toContain('<ol start="3">');
  });

  test('table', () => {
    const frag = createFragment();
    const table = new Y.XmlElement('table');
    const row = new Y.XmlElement('tableRow');
    const cell = new Y.XmlElement('tableCell');
    cell.insert(0, [makeElement('paragraph', 'data')]);
    row.insert(0, [cell]);
    table.insert(0, [row]);
    frag.insert(0, [table]);
    const html = toHTML(frag);
    expect(html).toContain('<table>');
    expect(html).toContain('<td>');
    expect(html).toContain('data');
  });

  test('blockquote', () => {
    const frag = createFragment();
    const bq = new Y.XmlElement('blockquote');
    bq.insert(0, [makeElement('paragraph', 'quoted')]);
    frag.insert(0, [bq]);
    expect(toHTML(frag)).toBe('<blockquote><p>quoted</p></blockquote>');
  });

  test('code block', () => {
    const frag = createFragment();
    const cb = new Y.XmlElement('codeBlock');
    const text = new Y.XmlText();
    text.insert(0, 'const x = 1;');
    cb.insert(0, [text]);
    frag.insert(0, [cb]);
    expect(toHTML(frag)).toBe('<pre><code>const x = 1;</code></pre>');
  });

  test('horizontal rule', () => {
    const frag = createFragment();
    frag.insert(0, [new Y.XmlElement('horizontalRule')]);
    frag.insert(1, [makeElement('paragraph', 'after')]);
    const html = toHTML(frag);
    expect(html).toContain('<hr>');
  });

  test('textStyle with color', () => {
    const frag = createFragment();
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'red text', { textStyle: { color: 'red' } });
    para.insert(0, [text]);
    frag.insert(0, [para]);
    const html = toHTML(frag);
    expect(html).toContain('color: red');
    expect(html).toContain('red text');
  });
});

// --- fromHTML tests ---

describe('fromHTML', () => {
  test('standard semantic HTML', () => {
    const frag = parseHTML('<h1>Title</h1><p>Text with <strong>bold</strong> and <em>italic</em></p>');
    const structured = toStructured(frag);
    expect(structured[0].type).toBe('heading');
    expect(structured[0].level).toBe(1);
    expect(structured[1].type).toBe('paragraph');
  });

  test('style-based bold (font-weight:700)', () => {
    const frag = parseHTML('<p><span style="font-weight:700">bold text</span></p>');
    const structured = toStructured(frag);
    const content = structured[0].content;
    // Should be parsed as bold mark
    const boldSegment = Array.isArray(content)
      ? content.find((s) => typeof s === 'object' && s.marks?.some((m) => m === 'bold' || m.type === 'bold'))
      : null;
    expect(boldSegment).toBeTruthy();
  });

  test('style-based italic (font-style:italic)', () => {
    const frag = parseHTML('<p><span style="font-style:italic">italic text</span></p>');
    const structured = toStructured(frag);
    const content = structured[0].content;
    const italicSegment = Array.isArray(content)
      ? content.find((s) => typeof s === 'object' && s.marks?.some((m) => m === 'italic' || m.type === 'italic'))
      : null;
    expect(italicSegment).toBeTruthy();
  });

  test('nested lists', () => {
    const html = '<ul><li><p>outer</p><ul><li><p>inner</p></li></ul></li></ul>';
    const frag = parseHTML(html);
    const structured = toStructured(frag);
    expect(structured[0].type).toBe('bulletList');
    // The inner list should be nested inside the first list item
    const firstItem = structured[0].children[0];
    expect(firstItem.children.length).toBeGreaterThanOrEqual(2);
  });

  test('links with attributes', () => {
    const frag = parseHTML('<p><a href="https://example.com" target="_blank">link</a></p>');
    const structured = toStructured(frag);
    const content = structured[0].content;
    const linkSegment = Array.isArray(content)
      ? content.find((s) => typeof s === 'object' && s.marks?.some((m) => m.type === 'link'))
      : null;
    expect(linkSegment).toBeTruthy();
  });

  test('table', () => {
    const html = '<table><tr><td><p>A</p></td><td><p>B</p></td></tr></table>';
    const frag = parseHTML(html);
    const structured = toStructured(frag);
    expect(structured[0].type).toBe('table');
  });

  test('empty paragraph', () => {
    const frag = parseHTML('<p></p>');
    const structured = toStructured(frag);
    expect(structured.length).toBeGreaterThanOrEqual(1);
    expect(structured[0].type).toBe('paragraph');
  });

  test('hard break', () => {
    const frag = parseHTML('<p>line one<br>line two</p>');
    const text = toPlainText(frag);
    expect(text).toContain('line one');
    expect(text).toContain('line two');
  });
});

// --- Round-trip tests ---

describe('round-trip (toHTML → fromHTML)', () => {
  function roundTrip(buildFn) {
    const frag1 = createFragment();
    buildFn(frag1);
    const html = toHTML(frag1);
    const frag2 = createFragment();
    fromHTML(html, frag2);
    return {
      original: toStructured(frag1),
      roundTripped: toStructured(frag2),
      originalText: toPlainText(frag1),
      roundTrippedText: toPlainText(frag2),
    };
  }

  test('paragraph with plain text', () => {
    const { originalText, roundTrippedText } = roundTrip((frag) => {
      frag.insert(0, [makeElement('paragraph', 'Hello world')]);
    });
    expect(roundTrippedText).toBe(originalText);
  });

  test('heading preserves level', () => {
    const { original, roundTripped } = roundTrip((frag) => {
      frag.insert(0, [makeElement('heading', 'H2 Title', { level: 2 })]);
    });
    expect(roundTripped[0].type).toBe('heading');
    expect(roundTripped[0].level).toBe(original[0].level);
  });

  test('bold and italic marks', () => {
    const { roundTripped } = roundTrip((frag) => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'plain ');
      text.insert(6, 'bold', { bold: true });
      text.insert(10, ' ');
      text.insert(11, 'italic', { italic: true });
      para.insert(0, [text]);
      frag.insert(0, [para]);
    });
    const content = roundTripped[0].content;
    // After round-trip, whitespace may merge with adjacent marks differently.
    // Verify the bold and italic marks exist on the correct text.
    const hasBold = content.some(
      (s) => typeof s === 'object' && s.text?.includes('bold') && s.marks?.some((m) => m.type === 'bold')
    );
    const hasItalic = content.some(
      (s) => typeof s === 'object' && s.text?.includes('italic') && s.marks?.some((m) => m.type === 'italic')
    );
    expect(hasBold).toBe(true);
    expect(hasItalic).toBe(true);
  });

  test('link preserves href', () => {
    const { roundTripped } = roundTrip((frag) => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'click', { link: { href: 'https://example.com' } });
      para.insert(0, [text]);
      frag.insert(0, [para]);
    });
    const linkMark = roundTripped[0].content.find(
      (s) => typeof s === 'object' && s.marks?.some((m) => m.type === 'link')
    );
    expect(linkMark).toBeTruthy();
    const link = linkMark.marks.find((m) => m.type === 'link');
    expect(link.href).toBe('https://example.com');
  });

  test('bullet list', () => {
    const { original, roundTripped } = roundTrip((frag) => {
      const ul = new Y.XmlElement('bulletList');
      const li1 = new Y.XmlElement('listItem');
      li1.insert(0, [makeElement('paragraph', 'one')]);
      const li2 = new Y.XmlElement('listItem');
      li2.insert(0, [makeElement('paragraph', 'two')]);
      ul.insert(0, [li1]);
      ul.insert(1, [li2]);
      frag.insert(0, [ul]);
    });
    expect(roundTripped[0].type).toBe('bulletList');
    expect(roundTripped[0].children.length).toBe(original[0].children.length);
  });

  test('table structure', () => {
    const { roundTripped } = roundTrip((frag) => {
      const table = new Y.XmlElement('table');
      const row = new Y.XmlElement('tableRow');
      const cell1 = new Y.XmlElement('tableCell');
      cell1.insert(0, [makeElement('paragraph', 'A')]);
      const cell2 = new Y.XmlElement('tableCell');
      cell2.insert(0, [makeElement('paragraph', 'B')]);
      row.insert(0, [cell1]);
      row.insert(1, [cell2]);
      table.insert(0, [row]);
      frag.insert(0, [table]);
    });
    expect(roundTripped[0].type).toBe('table');
    expect(roundTripped[0].children[0].children.length).toBe(2);
  });

  test('blockquote', () => {
    const { originalText, roundTrippedText } = roundTrip((frag) => {
      const bq = new Y.XmlElement('blockquote');
      bq.insert(0, [makeElement('paragraph', 'quoted text')]);
      frag.insert(0, [bq]);
    });
    expect(roundTrippedText).toBe(originalText);
  });

  test('code block', () => {
    const { originalText, roundTrippedText } = roundTrip((frag) => {
      const cb = new Y.XmlElement('codeBlock');
      const text = new Y.XmlText();
      text.insert(0, 'function foo() {}');
      cb.insert(0, [text]);
      frag.insert(0, [cb]);
    });
    expect(roundTrippedText).toBe(originalText);
  });

  test('mixed complex document', () => {
    const { originalText, roundTrippedText } = roundTrip((frag) => {
      frag.insert(0, [makeElement('heading', 'Title', { level: 1 })]);
      frag.insert(1, [makeElement('paragraph', 'Intro paragraph')]);

      const ul = new Y.XmlElement('bulletList');
      const li = new Y.XmlElement('listItem');
      li.insert(0, [makeElement('paragraph', 'list item')]);
      ul.insert(0, [li]);
      frag.insert(2, [ul]);

      frag.insert(3, [new Y.XmlElement('horizontalRule')]);
      frag.insert(4, [makeElement('paragraph', 'End')]);
    });
    expect(roundTrippedText).toBe(originalText);
  });
});
