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

/** Round-trip: YJS → markdown → ProseMirror JSON string */
function roundTrip(doc, diffMark = null) {
  const fragment = doc.getXmlFragment('default');
  const md = toMarkdown(fragment);
  const pmJson = markdownToPm(md, diffMark);
  doc.destroy();
  return { md, pmJson, pmStr: JSON.stringify(pmJson) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Format round-trip', () => {
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
