/**
 * Link-protocol allowlist at agent write boundaries (D-6, Sam 2026-07-13).
 *
 * Covers the two content-inspectable write boundaries that promote import's
 * href allowlist beyond import:
 *   - the modify post-script pass over the live Yjs fragment
 *     (image-validate.sanitizeLinkHrefs), and
 *   - the sandbox `fromMarkdown` helper (which sanitizes at the PM-JSON stage
 *     via the shared sanitizeLinkMarks before materializing).
 * Plus a regression that legitimate links survive an undo/redo replay (those
 * paths are out of scope by design — they author no new href).
 *
 * Pure Yjs — no database or presence session needed.
 */
const Y = require('yjs');
const { sanitizeLinkHrefs } = require('../mcp/image-validate');
const { buildFromMarkdown } = require('../mcp/sandbox/from-markdown');
const { extractLinks, getTextContent } = require('../mcp/sandbox/helpers');

/**
 * Attach a paragraph to `fragment` whose text is `prefix + linkText`, with a
 * link mark carrying `href` over the linkText range — the exact shape a modify
 * script produces with createFormattedText / format().
 */
function addLinkedParagraph(fragment, prefix, linkText, href) {
  const para = new Y.XmlElement('paragraph');
  fragment.insert(fragment.length, [para]);
  const text = new Y.XmlText();
  para.insert(0, [text]);
  text.insert(0, prefix + linkText);
  text.format(prefix.length, linkText.length, { link: { href } });
}

/** All remaining link hrefs in document order. */
function hrefsIn(fragment) {
  return extractLinks(fragment).map((l) => (typeof l.href === 'string' ? l.href : l.href && l.href.href));
}

describe('sanitizeLinkHrefs (modify write boundary)', () => {
  test('strips javascript:/data:/vbscript:/file: marks with a report, keeps the text', () => {
    const doc = new Y.Doc();
    const fragment = doc.get('default', Y.XmlFragment);

    addLinkedParagraph(fragment, 'click ', 'js link', 'javascript:alert(1)');
    addLinkedParagraph(fragment, 'a ', 'data link', 'data:text/html,<script>x</script>');
    addLinkedParagraph(fragment, 'a ', 'vb link', 'vbscript:msgbox(1)');
    addLinkedParagraph(fragment, 'a ', 'file link', 'file:///etc/passwd');

    const errors = sanitizeLinkHrefs(fragment);

    // All four marks removed; every text run preserved.
    expect(hrefsIn(fragment)).toEqual([]);
    const text = getTextContent(fragment);
    for (const kept of ['js link', 'data link', 'vb link', 'file link']) {
      expect(text).toContain(kept);
    }

    // Instructive report, one entry per stripped mark, protocol named.
    expect(errors).toHaveLength(4);
    expect(errors.map((e) => e.href)).toEqual([
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]);
    expect(errors.map((e) => e.reason)).toEqual([
      'disallowed link protocol "javascript:"',
      'disallowed link protocol "data:"',
      'disallowed link protocol "vbscript:"',
      'disallowed link protocol "file:"',
    ]);
  });

  test('keeps http/https/mailto and app-relative (/… , #…) links untouched', () => {
    const doc = new Y.Doc();
    const fragment = doc.get('default', Y.XmlFragment);

    addLinkedParagraph(fragment, 'a ', 'http', 'http://example.com/page');
    addLinkedParagraph(fragment, 'a ', 'https', 'https://example.com/page');
    addLinkedParagraph(fragment, 'a ', 'mail', 'mailto:sam@example.com');
    addLinkedParagraph(fragment, 'a ', 'rel', '/d/some-doc-guid');
    addLinkedParagraph(fragment, 'a ', 'frag', '#section');

    const errors = sanitizeLinkHrefs(fragment);

    expect(errors).toEqual([]);
    expect(hrefsIn(fragment)).toEqual([
      'http://example.com/page',
      'https://example.com/page',
      'mailto:sam@example.com',
      '/d/some-doc-guid',
      '#section',
    ]);
  });

  test('mixed doc: strips only the disallowed mark, leaves the sibling link', () => {
    const doc = new Y.Doc();
    const fragment = doc.get('default', Y.XmlFragment);

    // One paragraph, one text node with two adjacent linked runs.
    const para = new Y.XmlElement('paragraph');
    fragment.insert(0, [para]);
    const text = new Y.XmlText();
    para.insert(0, [text]);
    text.insert(0, 'good then bad');
    text.format(0, 4, { link: { href: 'https://ok.example' } }); // "good"
    text.format(10, 3, { link: { href: 'javascript:evil()' } }); // "bad"

    const errors = sanitizeLinkHrefs(fragment);

    expect(errors).toEqual([{ href: 'javascript:evil()', reason: 'disallowed link protocol "javascript:"' }]);
    expect(hrefsIn(fragment)).toEqual(['https://ok.example']);
    expect(getTextContent(fragment)).toBe('good then bad');
  });

  test('control-character obfuscated javascript scheme is still stripped', () => {
    const doc = new Y.Doc();
    const fragment = doc.get('default', Y.XmlFragment);
    addLinkedParagraph(fragment, 'x ', 'sneaky', 'jav\tascript:alert(1)');

    const errors = sanitizeLinkHrefs(fragment);

    expect(errors).toHaveLength(1);
    expect(hrefsIn(fragment)).toEqual([]);
    expect(getTextContent(fragment)).toContain('sneaky');
  });
});

describe('fromMarkdown link sanitization (sandbox write boundary)', () => {
  const fromMarkdown = buildFromMarkdown({ XmlElement: Y.XmlElement, XmlText: Y.XmlText });

  test('drops a javascript: link mark (keeps text), keeps a legitimate link', () => {
    const nodes = fromMarkdown('[bad](javascript:alert(1)) and [good](https://example.com/page)');
    const doc = new Y.Doc();
    const fragment = doc.get('default', Y.XmlFragment);
    fragment.insert(0, nodes);

    expect(hrefsIn(fragment)).toEqual(['https://example.com/page']);
    const text = getTextContent(fragment);
    expect(text).toContain('bad'); // text kept, mark gone
    expect(text).toContain('good');

    // Belt-and-suspenders: the live-fragment pass finds nothing left to strip.
    expect(sanitizeLinkHrefs(fragment)).toEqual([]);
  });
});

describe('undo/redo replay is out of scope (regression)', () => {
  test('a legitimate link survives an undo/redo cycle intact', () => {
    const doc = new Y.Doc();
    const fragment = doc.get('default', Y.XmlFragment);
    const undoManager = new Y.UndoManager(fragment);

    doc.transact(() => {
      addLinkedParagraph(fragment, 'visit ', 'the site', 'https://example.com/page');
    });

    // The write boundary would run here and find nothing to strip.
    expect(sanitizeLinkHrefs(fragment)).toEqual([]);
    expect(hrefsIn(fragment)).toEqual(['https://example.com/page']);

    undoManager.undo();
    expect(hrefsIn(fragment)).toEqual([]); // link gone with the paragraph

    undoManager.redo();
    // Link is replayed unchanged and remains valid — replay authors no new href,
    // so no re-sanitization is needed or performed.
    expect(hrefsIn(fragment)).toEqual(['https://example.com/page']);
    expect(getTextContent(fragment)).toContain('the site');
  });
});
