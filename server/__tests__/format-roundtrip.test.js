/**
 * Round-trip tests for the format registry.
 *
 * Verifies that toMarkdown() → markdownToPm() preserves all marks and
 * block types defined in the format registry. Tests are driven by the
 * registry itself, so new marks are automatically covered.
 */

const Y = require('yjs');
const { toMarkdown } = require('../mcp/yjs/serialization');
const { markdownToPm } = require('../../shared/markdown');
const { INLINE_MARKS, STYLE_PROPS } = require('../../shared/format-registry');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a Y.Doc with a single paragraph containing text with the given YJS attrs. */
function createStyledDoc(text, attrs) {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  doc.transact(() => {
    const para = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, text, attrs);
    para.insert(0, [t]);
    fragment.insert(0, [para]);
  });
  return doc;
}

// ---------------------------------------------------------------------------
// Tests — run every registry-driven assertion in BOTH parser modes (TR-002).
// ---------------------------------------------------------------------------

describe.each([false, true])('Format round-trip (strict=%s)', (strict) => {
  /** Round-trip: YJS → markdown → ProseMirror JSON string, in the given mode. */
  function roundTrip(doc, diffMark = null) {
    const fragment = doc.getXmlFragment('default');
    const md = toMarkdown(fragment);
    const pmJson = markdownToPm(md, diffMark, { strict });
    doc.destroy();
    return { md, pmJson, pmStr: JSON.stringify(pmJson) };
  }

  describe('inline marks (from registry)', () => {
    for (const mark of INLINE_MARKS) {
      test(`${mark.name} round-trips correctly`, () => {
        const attrs = { [mark.yjsAttr]: true };
        const { pmStr } = roundTrip(createStyledDoc('hello', attrs));
        expect(pmStr).toContain(`"type":"${mark.name}"`);
        expect(pmStr).toContain('"text":"hello"');
      });
    }
  });

  describe('textStyle properties (from schema)', () => {
    for (const prop of STYLE_PROPS) {
      test(`${prop.attr} round-trips correctly`, () => {
        const value = prop.attr === 'color' ? '#ff0000'
          : prop.attr === 'backgroundColor' ? '#00ff00'
          : prop.attr === 'fontSize' ? '18px'
          : prop.attr === 'fontFamily' ? 'Georgia'
          : prop.attr === 'lineHeight' ? '1.8'
          : 'test';
        const attrs = { textStyle: { [prop.attr]: value } };
        const { pmStr } = roundTrip(createStyledDoc('styled', attrs));
        expect(pmStr).toContain(`"${prop.attr}":"${value}"`);
      });
    }

    test('multiple textStyle properties in one span', () => {
      const attrs = {
        textStyle: { color: '#333', fontSize: '20px', lineHeight: '1.5' },
      };
      const { pmStr } = roundTrip(createStyledDoc('multi', attrs));
      expect(pmStr).toContain('"color":"#333"');
      expect(pmStr).toContain('"fontSize":"20px"');
      expect(pmStr).toContain('"lineHeight":"1.5"');
    });
  });

  describe('link mark', () => {
    test('link round-trips correctly', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const para = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'click here', { link: { href: 'https://example.com' } });
        para.insert(0, [t]);
        fragment.insert(0, [para]);
      });
      const { pmStr } = roundTrip(doc);
      expect(pmStr).toContain('"type":"link"');
      expect(pmStr).toContain('"href":"https://example.com"');
      expect(pmStr).toContain('"text":"click here"');
    });
  });

  describe('diff marks', () => {
    test('diffInsert applied to all text nodes', () => {
      const { pmStr } = roundTrip(createStyledDoc('hello', { bold: true }), 'diffInsert');
      expect(pmStr).toContain('"type":"diffInsert"');
      expect(pmStr).toContain('"type":"bold"');
    });

    test('diffDelete applied to all text nodes', () => {
      const { pmStr } = roundTrip(createStyledDoc('hello', {}), 'diffDelete');
      expect(pmStr).toContain('"type":"diffDelete"');
    });
  });

  describe('block types', () => {
    test('heading round-trips', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const h = new Y.XmlElement('heading');
        h.setAttribute('level', '2');
        const t = new Y.XmlText();
        t.insert(0, 'Title');
        h.insert(0, [t]);
        fragment.insert(0, [h]);
      });
      const { pmStr } = roundTrip(doc);
      expect(pmStr).toContain('"type":"heading"');
      expect(pmStr).toContain('"level":2');
      expect(pmStr).toContain('"text":"Title"');
    });

    test('codeBlock round-trips', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const cb = new Y.XmlElement('codeBlock');
        cb.setAttribute('language', 'js');
        const t = new Y.XmlText();
        t.insert(0, 'const x = 1;');
        cb.insert(0, [t]);
        fragment.insert(0, [cb]);
      });
      const { pmStr } = roundTrip(doc);
      expect(pmStr).toContain('"type":"codeBlock"');
      expect(pmStr).toContain('"language":"js"');
      expect(pmStr).toContain('const x = 1;');
    });

    test('mermaid round-trips', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const m = new Y.XmlElement('mermaid');
        const t = new Y.XmlText();
        t.insert(0, 'graph TD\n  A --> B');
        m.insert(0, [t]);
        fragment.insert(0, [m]);
      });
      const { md, pmStr } = roundTrip(doc);
      expect(md).toContain('```mermaid');
      expect(md).toContain('graph TD');
      expect(pmStr).toContain('"type":"mermaid"');
      expect(pmStr).not.toContain('"type":"codeBlock"');
      expect(pmStr).toContain('graph TD');
    });

    test('svg round-trips', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const s = new Y.XmlElement('svg');
        const t = new Y.XmlText();
        t.insert(0, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>');
        s.insert(0, [t]);
        fragment.insert(0, [s]);
      });
      const { md, pmStr } = roundTrip(doc);
      expect(md).toContain('```svg');
      expect(md).toContain('<rect width="5" height="5"/>');
      expect(pmStr).toContain('"type":"svg"');
      expect(pmStr).not.toContain('"type":"codeBlock"');
      expect(pmStr).toContain('rect');
    });

    test('codeBlock with language=svg is treated as svg', () => {
      const { markdownToPm } = require('../../shared/markdown');
      const pm = markdownToPm('```svg\n<svg><circle r="4"/></svg>\n```');
      const str = JSON.stringify(pm);
      expect(str).toContain('"type":"svg"');
      expect(str).not.toContain('"language":"svg"');
      expect(str).toContain('circle');
    });

    test('codeBlock with language=mermaid is treated as mermaid', () => {
      // Documents authored by AI agents may emit a ```mermaid fence; parser
      // should route that to the mermaid node, not a generic codeBlock.
      const { markdownToPm } = require('../../shared/markdown');
      const pm = markdownToPm('```mermaid\nflowchart LR; A-->B\n```');
      const str = JSON.stringify(pm);
      expect(str).toContain('"type":"mermaid"');
      expect(str).not.toContain('"language":"mermaid"');
      expect(str).toContain('flowchart LR');
    });

    test('bulletList round-trips', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const list = new Y.XmlElement('bulletList');
        for (const text of ['alpha', 'beta']) {
          const li = new Y.XmlElement('listItem');
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, text);
          p.insert(0, [t]);
          li.insert(0, [p]);
          list.insert(list.length, [li]);
        }
        fragment.insert(0, [list]);
      });
      const { pmStr } = roundTrip(doc);
      expect(pmStr).toContain('"type":"bulletList"');
      expect(pmStr).toContain('"type":"listItem"');
      expect(pmStr).toContain('"text":"alpha"');
      expect(pmStr).toContain('"text":"beta"');
    });

    test('orderedList round-trips', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const list = new Y.XmlElement('orderedList');
        const li = new Y.XmlElement('listItem');
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'first');
        p.insert(0, [t]);
        li.insert(0, [p]);
        list.insert(0, [li]);
        fragment.insert(0, [list]);
      });
      const { pmStr } = roundTrip(doc);
      expect(pmStr).toContain('"type":"orderedList"');
      expect(pmStr).toContain('"text":"first"');
    });

    test('blockquote round-trips', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const bq = new Y.XmlElement('blockquote');
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'quoted');
        p.insert(0, [t]);
        bq.insert(0, [p]);
        fragment.insert(0, [bq]);
      });
      const { pmStr } = roundTrip(doc);
      expect(pmStr).toContain('"type":"blockquote"');
      expect(pmStr).toContain('"text":"quoted"');
    });

    test('horizontalRule round-trips', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'above');
        p.insert(0, [t]);
        const hr = new Y.XmlElement('horizontalRule');
        const p2 = new Y.XmlElement('paragraph');
        const t2 = new Y.XmlText();
        t2.insert(0, 'below');
        p2.insert(0, [t2]);
        fragment.insert(0, [p, hr, p2]);
      });
      const { pmStr } = roundTrip(doc);
      expect(pmStr).toContain('"type":"horizontalRule"');
      expect(pmStr).toContain('"text":"above"');
      expect(pmStr).toContain('"text":"below"');
    });

    test('table round-trips', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const table = new Y.XmlElement('table');
        const row = new Y.XmlElement('tableRow');
        const cell = new Y.XmlElement('tableCell');
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'data');
        p.insert(0, [t]);
        cell.insert(0, [p]);
        row.insert(0, [cell]);
        table.insert(0, [row]);
        fragment.insert(0, [table]);
      });
      const { pmStr } = roundTrip(doc);
      expect(pmStr).toContain('"type":"table"');
      expect(pmStr).toContain('"text":"data"');
    });
  });

  describe('edge cases', () => {
    test('newlines inside styled text', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'line1\nline2', { textStyle: { fontSize: '17px' } });
        p.insert(0, [t]);
        fragment.insert(0, [p]);
      });
      const { pmStr } = roundTrip(doc);
      expect(pmStr).toContain('line1\\nline2');
      expect(pmStr).not.toContain('"text":"</span>');
    });

    test('nested marks (bold + italic)', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'both', { bold: true, italic: true });
        p.insert(0, [t]);
        fragment.insert(0, [p]);
      });
      const { pmStr } = roundTrip(doc);
      expect(pmStr).toContain('"type":"bold"');
      expect(pmStr).toContain('"type":"italic"');
      expect(pmStr).toContain('"text":"both"');
    });

    test('empty document produces valid ProseMirror JSON', () => {
      const doc = new Y.Doc();
      doc.getXmlFragment('default'); // empty fragment
      const { pmJson } = roundTrip(doc);
      expect(pmJson.type).toBe('doc');
      expect(pmJson.content.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Canonical equivalence: for serializer output, tolerant structure MUST equal
// strict structure (FR-012, FR-016, TR-002, SC-005, US3 AS-3). Tolerance
// extends the accepted grammar; it never changes the meaning of the canonical
// dialect.
// ---------------------------------------------------------------------------

describe('canonical equivalence (tolerant === strict on serializer output)', () => {
  function buildFrag(build) {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => build(frag));
    return { doc, frag };
  }
  function el(tag, text, attrs) {
    const e = new Y.XmlElement(tag);
    if (text !== undefined) {
      const t = new Y.XmlText();
      t.insert(0, text, attrs);
      e.insert(0, [t]);
    }
    return e;
  }

  const corpus = {
    // NOTE: mark text is not space-padded. A mark applied to text with a
    // leading/trailing space (e.g. `** x **`) is emitted verbatim by the
    // serializer but rejected as emphasis by CommonMark flanking rules, so it
    // is one of the rare inputs where tolerant != strict. That divergence is a
    // deliberate consequence of adopting CommonMark flanking (recorded in the
    // clarifications ledger); the diff engine is unaffected (it uses strict).
    'every inline mark': (frag) => {
      for (const mark of INLINE_MARKS) {
        frag.insert(frag.length, [el('paragraph', mark.name, { [mark.yjsAttr]: true })]);
      }
    },
    'every style prop': (frag) => {
      for (const prop of STYLE_PROPS) {
        const value = prop.attr === 'color' ? '#ff0000'
          : prop.attr === 'backgroundColor' ? '#00ff00'
            : prop.attr === 'fontSize' ? '18px'
              : prop.attr === 'fontFamily' ? 'Georgia'
                : prop.attr === 'lineHeight' ? '1.8' : 'x';
        frag.insert(frag.length, [el('paragraph', 'v', { textStyle: { [prop.attr]: value } })]);
      }
    },
    'heading + code + diagrams': (frag) => {
      const h = el('heading', 'Title'); h.setAttribute('level', '3');
      const cb = el('codeBlock', 'const x=1;'); cb.setAttribute('language', 'js');
      frag.insert(0, [h, cb, el('mermaid', 'graph TD'), el('svg', '<svg><rect/></svg>')]);
    },
    'lists nested + blockquote + hr + table': (frag) => {
      const list = new Y.XmlElement('bulletList');
      const li = new Y.XmlElement('listItem');
      li.insert(0, [el('paragraph', 'parent')]);
      const nested = new Y.XmlElement('bulletList');
      const nli = new Y.XmlElement('listItem'); nli.insert(0, [el('paragraph', 'child')]);
      nested.insert(0, [nli]); li.insert(1, [nested]); list.insert(0, [li]);
      const bq = new Y.XmlElement('blockquote'); bq.insert(0, [el('paragraph', 'quoted')]);
      const table = new Y.XmlElement('table'); const row = new Y.XmlElement('tableRow');
      const cell = new Y.XmlElement('tableCell'); cell.insert(0, [el('paragraph', 'data')]);
      row.insert(0, [cell]); table.insert(0, [row]);
      frag.insert(0, [list, bq, new Y.XmlElement('horizontalRule'), table]);
    },
    'link + nested marks': (frag) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'link', { link: { href: 'https://example.com' } });
      p.insert(0, [t]);
      const p2 = el('paragraph', 'both', { bold: true, italic: true });
      frag.insert(0, [p, p2]);
    },
  };

  for (const [name, build] of Object.entries(corpus)) {
    for (const diffMark of [null, 'diffInsert', 'diffDelete']) {
      test(`${name} — tolerant === strict (diffMark=${diffMark})`, () => {
        const { doc, frag } = buildFrag(build);
        const md = toMarkdown(frag);
        const tolerant = markdownToPm(md, diffMark);
        const strict = markdownToPm(md, diffMark, { strict: true });
        doc.destroy();
        expect(tolerant).toEqual(strict);
      });
    }
  }
});
