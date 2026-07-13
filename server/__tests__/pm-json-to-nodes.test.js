/**
 * Unit tests for the PM-JSON → Yjs materialization seam (feature 002, T005/T006).
 *
 * Drives the seam with canonical serializer output: build a Yjs doc, serialize
 * with toMarkdown, parse with the shared markdownToPm (tolerant default),
 * materialize with pmJsonToNodes, insert into a fresh doc, and assert
 * toMarkdown equivalence (the mini round-trip). Registry-driven so new marks
 * are automatically covered.
 */
const Y = require('yjs');
const { toMarkdown } = require('../mcp/yjs/serialization');
const { markdownToPm } = require('../../shared/markdown');
const { INLINE_MARKS, STYLE_PROPS } = require('../../shared/format-registry');
const { pmJsonToNodes } = require('../mcp/yjs/pm-json-to-nodes');

/** Materialize markdown into a fresh Y.Doc via the seam; return its fragment. */
function materialize(markdown, options = {}) {
  const pmJson = markdownToPm(markdown);
  const nodes = pmJsonToNodes(pmJson, options);
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  doc.transact(() => fragment.insert(0, nodes));
  return { fragment, nodes, doc };
}

/** Canonical markdown for a Yjs-built doc, and its seam round-trip result. */
function miniRoundTrip(buildFn) {
  const src = new Y.Doc();
  const srcFragment = src.getXmlFragment('default');
  src.transact(() => buildFn(srcFragment));
  const canonical = toMarkdown(srcFragment);
  src.destroy();
  const { fragment, doc } = materialize(canonical);
  const result = toMarkdown(fragment);
  doc.destroy();
  return { canonical, result };
}

function styledParagraphDoc(text, attrs) {
  return (fragment) => {
    const para = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, text, attrs);
    para.insert(0, [t]);
    fragment.insert(0, [para]);
  };
}

describe('pmJsonToNodes mini round-trip (toMarkdown equivalence)', () => {
  describe('inline marks (from registry)', () => {
    for (const mark of INLINE_MARKS) {
      test(`${mark.name} survives materialization`, () => {
        const { canonical, result } = miniRoundTrip(
          styledParagraphDoc('hello', { [mark.yjsAttr]: true })
        );
        expect(result).toBe(canonical);
      });
    }
  });

  describe('textStyle properties (from schema)', () => {
    for (const prop of STYLE_PROPS) {
      test(`${prop.attr} survives materialization`, () => {
        const value =
          prop.attr === 'color' || prop.attr === 'backgroundColor'
            ? '#ff0000'
            : prop.attr === 'fontSize'
              ? '18px'
              : prop.attr === 'lineHeight'
                ? '1.5'
                : 'monospace';
        const { canonical, result } = miniRoundTrip(
          styledParagraphDoc('styled', { textStyle: { [prop.attr]: value } })
        );
        expect(result).toBe(canonical);
      });
    }
  });

  test('link mark survives materialization', () => {
    const { canonical, result } = miniRoundTrip(
      styledParagraphDoc('Example', { link: { href: 'https://example.com/x' } })
    );
    expect(result).toBe(canonical);
    expect(result).toContain('[Example](https://example.com/x)');
  });

  test('heading levels survive materialization', () => {
    const { canonical, result } = miniRoundTrip((fragment) => {
      for (let level = 1; level <= 5; level++) {
        const h = new Y.XmlElement('heading');
        h.setAttribute('level', level);
        const t = new Y.XmlText();
        t.insert(0, `Heading ${level}`);
        h.insert(0, [t]);
        fragment.insert(fragment.length, [h]);
      }
    });
    expect(result).toBe(canonical);
  });

  test('codeBlock with language survives materialization', () => {
    const { canonical, result } = miniRoundTrip((fragment) => {
      const cb = new Y.XmlElement('codeBlock');
      cb.setAttribute('language', 'js');
      const t = new Y.XmlText();
      t.insert(0, 'const x = 1;\nconsole.log(x);');
      cb.insert(0, [t]);
      fragment.insert(0, [cb]);
    });
    expect(result).toBe(canonical);
    expect(result).toContain('```js');
  });

  test('mermaid diagram block survives materialization', () => {
    const { canonical, result } = miniRoundTrip((fragment) => {
      const m = new Y.XmlElement('mermaid');
      const t = new Y.XmlText();
      t.insert(0, 'graph TD\n  A --> B');
      m.insert(0, [t]);
      fragment.insert(0, [m]);
    });
    expect(result).toBe(canonical);
    const { fragment, doc } = materialize(canonical);
    expect(fragment.get(0).nodeName).toBe('mermaid');
    doc.destroy();
  });

  test('svg diagram block survives materialization', () => {
    const { canonical, result } = miniRoundTrip((fragment) => {
      const s = new Y.XmlElement('svg');
      const t = new Y.XmlText();
      t.insert(0, '<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>');
      s.insert(0, [t]);
      fragment.insert(0, [s]);
    });
    expect(result).toBe(canonical);
  });

  test('nested bullet list survives materialization', () => {
    const md = '- top one\n  - nested one\n  - nested two\n- top two\n';
    const { fragment, doc } = materialize(md);
    const result = toMarkdown(fragment);
    expect(result).toBe(toMarkdown(materialize(result).fragment)); // stable
    expect(result).toContain('- top one');
    expect(result).toContain('  - nested one');
    // Structure: one bulletList block, first item contains a nested list.
    expect(fragment.length).toBe(1);
    expect(fragment.get(0).nodeName).toBe('bulletList');
    const firstItem = fragment.get(0).get(0);
    expect(firstItem.nodeName).toBe('listItem');
    const childNames = firstItem.toArray().map((n) => n.nodeName);
    expect(childNames).toContain('bulletList');
    doc.destroy();
  });

  test('ordered list survives materialization', () => {
    const md = '1. first\n2. second\n3. third\n';
    const { fragment, doc } = materialize(md);
    expect(fragment.get(0).nodeName).toBe('orderedList');
    expect(toMarkdown(fragment)).toContain('1. first');
    expect(toMarkdown(fragment)).toContain('2. second');
    doc.destroy();
  });

  test('blockquote survives materialization', () => {
    const { canonical, result } = miniRoundTrip((fragment) => {
      const bq = new Y.XmlElement('blockquote');
      const para = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'quoted wisdom');
      para.insert(0, [t]);
      bq.insert(0, [para]);
      fragment.insert(0, [bq]);
    });
    expect(result).toBe(canonical);
    expect(result).toContain('> quoted wisdom');
  });

  test('horizontalRule survives materialization', () => {
    const { canonical, result } = miniRoundTrip((fragment) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'above');
      p.insert(0, [t]);
      fragment.insert(0, [p, new Y.XmlElement('horizontalRule')]);
    });
    expect(result).toBe(canonical);
    expect(result).toContain('---');
  });

  test('table survives materialization', () => {
    // NOTE: cells containing literal pipes are excluded — the shared dialect
    // splits cells on every pipe, escaped or not (pre-existing quirk,
    // characterized by 001 in markdown-tolerant.test.js "pipe-leading table").
    const { canonical, result } = miniRoundTrip((fragment) => {
      const table = new Y.XmlElement('table');
      const mkCell = (tag, text) => {
        const cell = new Y.XmlElement(tag);
        const para = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, text);
        para.insert(0, [t]);
        cell.insert(0, [para]);
        return cell;
      };
      const header = new Y.XmlElement('tableRow');
      header.insert(0, [mkCell('tableHeader', 'Col A'), mkCell('tableHeader', 'Col B')]);
      const row = new Y.XmlElement('tableRow');
      row.insert(0, [mkCell('tableCell', 'cell one'), mkCell('tableCell', 'plain')]);
      table.insert(0, [header, row]);
      fragment.insert(0, [table]);
    });
    expect(result).toBe(canonical);
  });

  test('image node survives materialization (canonical serializer emission)', () => {
    // The parser has no image grammar (001 scope note) — image PM JSON reaching
    // the seam must still materialize. Feed the seam image PM JSON directly.
    const pmJson = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: '/api/docs/d1/images/i1', alt: 'alt text' } },
      ],
    };
    const nodes = pmJsonToNodes(pmJson);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeName).toBe('image');
    // Attributes on detached Yjs nodes are readable only after integration.
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    doc.transact(() => fragment.insert(0, nodes));
    expect(fragment.get(0).getAttribute('src')).toBe('/api/docs/d1/images/i1');
    expect(fragment.get(0).getAttribute('alt')).toBe('alt text');
    doc.destroy();
  });

  test('hard break survives materialization structurally', () => {
    const { fragment, doc } = materialize('line1  \nline2\n');
    expect(fragment.length).toBe(1);
    const para = fragment.get(0);
    const childNames = para.toArray().map((n) => (n instanceof Y.XmlText ? 'text' : n.nodeName));
    expect(childNames).toEqual(['text', 'hardBreak', 'text']);
    doc.destroy();
  });

  test('multiple marks stacked on one run survive materialization', () => {
    const { canonical, result } = miniRoundTrip(
      styledParagraphDoc('stacked', { bold: true, italic: true, link: { href: 'https://x.dev' } })
    );
    expect(result).toBe(canonical);
  });
});

describe('pmJsonToNodes contract', () => {
  test('empty / invalid inputs return []', () => {
    expect(pmJsonToNodes(null)).toEqual([]);
    expect(pmJsonToNodes({})).toEqual([]);
    expect(pmJsonToNodes({ type: 'doc' })).toEqual([]);
    expect(pmJsonToNodes({ type: 'doc', content: [] })).toEqual([]);
    expect(pmJsonToNodes({ type: 'paragraph', content: [] })).toEqual([]);
  });

  test('nodes are detached and insertable into any fragment', () => {
    const nodes = pmJsonToNodes(markdownToPm('# H\n\npara\n'));
    expect(nodes).toHaveLength(2);
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    expect(() => doc.transact(() => fragment.insert(0, nodes))).not.toThrow();
    expect(fragment.length).toBe(2);
    doc.destroy();
  });

  test('injected constructors are used for every created node (options pattern)', () => {
    const elements = [];
    const texts = [];
    class TrackedElement extends Y.XmlElement {
      constructor(...args) {
        super(...args);
        elements.push(this);
      }
    }
    class TrackedText extends Y.XmlText {
      constructor(...args) {
        super(...args);
        texts.push(this);
      }
    }
    const nodes = pmJsonToNodes(markdownToPm('# H\n\npara **bold**\n'), {
      XmlElement: TrackedElement,
      XmlText: TrackedText,
    });
    expect(nodes.length).toBe(2);
    for (const node of nodes) {
      expect(node).toBeInstanceOf(TrackedElement);
    }
    expect(elements.length).toBeGreaterThanOrEqual(2);
    expect(texts.length).toBeGreaterThanOrEqual(2);
  });
});
