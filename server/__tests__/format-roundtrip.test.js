/**
 * Round-trip tests for the format registry.
 *
 * Verifies that toMarkdown() → markdownToPm() preserves all marks and
 * block types defined in the format registry. Tests are driven by the
 * registry itself, so new marks are automatically covered.
 */

const Y = require('yjs');
const fs = require('fs');
const path = require('path');
const { prosemirrorJSONToYDoc } = require('y-prosemirror');
const { toMarkdown, toStructured, toPlainText } = require('../mcp/yjs/serialization');
const { markdownToPm } = require('../../shared/markdown');
const { INLINE_MARKS, STYLE_PROPS, TEXTSTYLE_PORTABLE } = require('../../shared/format-registry');
const { schema } = require('../../shared/prosemirror-schema');
const { buildBaselineDoc } = require('./helpers/baseline-doc');

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

// ---------------------------------------------------------------------------
// Feature 003 — Portable Export
// ---------------------------------------------------------------------------

/** markdown → PM JSON (tolerant) → Y.Doc (shared schema) → markdown. */
function reserialize(md, options) {
  const pm = markdownToPm(md);
  const ydoc = prosemirrorJSONToYDoc(schema, pm, 'default');
  const out = toMarkdown(ydoc.getXmlFragment('default'), options);
  ydoc.destroy();
  return out;
}

/** Yjs fragment builder from PM-style JSON via the shared schema. */
function docFromPm(pmDoc) {
  return prosemirrorJSONToYDoc(schema, pmDoc, 'default');
}

const p = (text, marks) => ({
  type: 'paragraph',
  content: text === undefined ? undefined : [{ type: 'text', text, ...(marks ? { marks } : {}) }],
});
const taskItem = (checked, content) => ({ type: 'taskItem', attrs: { checked }, content });
const taskList = (...items) => ({ type: 'taskList', content: items });

describe('taskList round-trip (FR-004/FR-005/FR-006, SC-001)', () => {
  test('flat list: GFM markers, checked state, byte-stable', () => {
    const ydoc = docFromPm({ type: 'doc', content: [
      taskList(taskItem(false, [p('todo')]), taskItem(true, [p('done')])),
    ] });
    const md = toMarkdown(ydoc.getXmlFragment('default'));
    expect(md).toBe('- [ ] todo\n- [x] done');

    const pm = markdownToPm(md);
    expect(pm.content[0].type).toBe('taskList');
    expect(pm.content[0].content.map((i) => i.attrs.checked)).toEqual([false, true]);

    expect(reserialize(md)).toBe(md); // byte-stable
  });

  test('nested task-in-task: 6-column continuation, byte-stable', () => {
    const md = '- [ ] parent\n      - [x] child';
    const pm = markdownToPm(md);
    const parent = pm.content[0].content[0];
    expect(parent.type).toBe('taskItem');
    const nested = parent.content.find((n) => n.type === 'taskList');
    expect(nested.content[0].attrs.checked).toBe(true);
    expect(reserialize(md)).toBe(md);
  });

  test('task-in-bullet and bullet-in-task nesting re-parse to the same structure', () => {
    for (const md of ['- parent\n  - [ ] child', '- [ ] parent\n      - plainchild']) {
      const once = reserialize(md);
      expect(once).toBe(md);
      expect(reserialize(once)).toBe(once);
    }
  });

  test('mixed task/plain items split into homogeneous lists; no literal [x] leaks', () => {
    const pm = markdownToPm('- [ ] task\n- plain');
    expect(pm.content.map((b) => b.type)).toEqual(['taskList', 'bulletList']);
    expect(JSON.stringify(pm)).not.toContain('[x]');
    expect(JSON.stringify(pm)).not.toContain('[ ]');
  });

  test('multi-paragraph task item (6-space continuation) is byte-stable', () => {
    const md = '- [ ] first\n\n      second para';
    const pm = markdownToPm(md);
    const item = pm.content[0].content[0];
    expect(item.content.filter((n) => n.type === 'paragraph')).toHaveLength(2);
    expect(reserialize(md)).toBe(md);
  });

  test('empty task item serializes a valid marker line and re-parses', () => {
    const ydoc = docFromPm({ type: 'doc', content: [taskList(taskItem(false, [p()]))] });
    const md = toMarkdown(ydoc.getXmlFragment('default'));
    expect(md).toBe('- [ ]');
    const pm = markdownToPm(md);
    expect(pm.content[0].type).toBe('taskList');
    expect(reserialize(md)).toBe(md);
  });

  test('- [X] parses checked and canonically re-emits lowercase x (RD-8)', () => {
    const pm = markdownToPm('- [X] shout');
    expect(pm.content[0].content[0].attrs.checked).toBe(true);
    expect(reserialize('- [X] shout')).toBe('- [x] shout');
    expect(reserialize('- [x] shout')).toBe('- [x] shout');
  });

  test('markers identical across flavors (FR-004)', () => {
    const ydoc = docFromPm({ type: 'doc', content: [
      taskList(taskItem(true, [p('same')])),
    ] });
    const frag = ydoc.getXmlFragment('default');
    expect(toMarkdown(frag, { flavor: 'portable' })).toBe(toMarkdown(frag));
  });

  test.each(['squire', 'portable'])(
    'multi-block task item (paragraph + codeBlock) round-trips structure-stable (%s)',
    (flavor) => {
      const ydoc = docFromPm({ type: 'doc', content: [
        taskList(taskItem(false, [
          p('run this'),
          { type: 'codeBlock', content: [{ type: 'text', text: 'const x = 1;' }] },
        ])),
      ] });
      const md = toMarkdown(ydoc.getXmlFragment('default'), { flavor });
      // The fenced block survives (not flattened to plain text).
      expect(md).toContain('```');
      const pm = markdownToPm(md);
      const item = pm.content[0].content[0];
      expect(item.type).toBe('taskItem');
      expect(item.content.map((n) => n.type)).toEqual(['paragraph', 'codeBlock']);
      const code = item.content.find((n) => n.type === 'codeBlock');
      expect(JSON.stringify(code.content)).toContain('const x = 1;');
      // Byte-stable across further round-trips.
      expect(reserialize(md, { flavor })).toBe(md);
      ydoc.destroy();
    }
  );

  test.each(['squire', 'portable'])(
    'task item with a blockquote child keeps the quote structure (%s)',
    (flavor) => {
      const ydoc = docFromPm({ type: 'doc', content: [
        taskList(taskItem(true, [
          p('review'),
          { type: 'blockquote', content: [p('a noted caveat')] },
        ])),
      ] });
      const md = toMarkdown(ydoc.getXmlFragment('default'), { flavor });
      const pm = markdownToPm(md);
      const item = pm.content[0].content[0];
      expect(item.content.map((n) => n.type)).toEqual(['paragraph', 'blockquote']);
      expect(reserialize(md, { flavor })).toBe(md);
      ydoc.destroy();
    }
  );

  test('structured output exposes checked booleans; plain text keeps item text (FR-005)', () => {
    const ydoc = docFromPm({ type: 'doc', content: [
      taskList(taskItem(false, [p('todo')]), taskItem(true, [p('done')])),
    ] });
    const frag = ydoc.getXmlFragment('default');
    const structured = toStructured(frag);
    expect(structured[0].type).toBe('taskList');
    expect(structured[0].children.map((c) => c.checked)).toEqual([false, true]);
    const text = toPlainText(frag);
    expect(text).toContain('todo');
    expect(text).toContain('done');
  });
});

describe('hardBreak round-trip (FR-007/FR-008, SC-007)', () => {
  test('paragraph hard break emits trailing backslash and is byte-stable', () => {
    const ydoc = docFromPm({ type: 'doc', content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'line1' }, { type: 'hardBreak' }, { type: 'text', text: 'line2' },
      ] },
    ] });
    const md = toMarkdown(ydoc.getXmlFragment('default'));
    expect(md).toBe('line1\\\nline2');
    expect(reserialize(md)).toBe(md);
  });

  test('both input forms parse to hardBreak; backslash is canonical (RD-7)', () => {
    for (const input of ['line1\\\nline2', 'line1<br>line2', 'line1<br/>line2']) {
      const pm = markdownToPm(input);
      expect(JSON.stringify(pm)).toContain('"type":"hardBreak"');
      expect(reserialize(input)).toBe('line1\\\nline2');
    }
  });

  test('hard break inside a list item keeps the continuation in the item', () => {
    const md = '- item1\\\n  cont';
    const pm = markdownToPm(md);
    const item = pm.content[0].content[0];
    expect(JSON.stringify(item)).toContain('"type":"hardBreak"');
    expect(reserialize(md)).toBe(md);
  });

  test('hard break inside a task item indents to the content column', () => {
    const md = '- [ ] line1\\\n      line2';
    expect(reserialize(md)).toBe(md);
  });

  test('hard break inside a blockquote re-prefixes the continuation', () => {
    const md = '> line1\\\n> line2';
    const pm = markdownToPm(md);
    expect(JSON.stringify(pm.content[0])).toContain('"type":"hardBreak"');
    expect(reserialize(md)).toBe(md);
  });

  test('identical in both flavors; never dropped (FR-007)', () => {
    const ydoc = docFromPm({ type: 'doc', content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' },
      ] },
    ] });
    const frag = ydoc.getXmlFragment('default');
    expect(toMarkdown(frag, { flavor: 'portable' })).toBe(toMarkdown(frag));
    expect(toMarkdown(frag)).toContain('\\');
  });
});

// ---------------------------------------------------------------------------
// Portable flavor — coverage DERIVED from registry declarations (FR-011,
// FR-023, SC-006): a future mark with a `portable` declaration gains these
// cases with zero test-file edits.
// ---------------------------------------------------------------------------

describe('portable flavor (registry-derived, SC-002/SC-003/SC-006)', () => {
  function markedDoc(markEntries) {
    // one paragraph per mark name, text = mark name
    return docFromPm({ type: 'doc', content: markEntries.map((m) =>
      p(`${m.name} text`, [{ type: m.name }])) });
  }

  const degradable = INLINE_MARKS.filter((m) => m.portable);
  const nonDegrading = INLINE_MARKS.filter((m) => !m.portable);

  for (const m of degradable) {
    describe(`degradable mark: ${m.name}`, () => {
      test('portable output has no HTML tag, contains the declared wrap, and reports lossy', () => {
        const ydoc = markedDoc([m]);
        const lossy = new Set();
        const md = toMarkdown(ydoc.getXmlFragment('default'), { flavor: 'portable', lossy });
        expect(md).not.toContain(`<${m.htmlTag}>`);
        expect(md).not.toContain(`</${m.htmlTag}>`);
        expect(md).toBe(`${m.portable.wrap[0]}${m.name} text${m.portable.wrap[1]}`);
        expect([...lossy]).toEqual([m.name]);
      });

      test('portable output parses back to a valid document with the degraded form', () => {
        const ydoc = markedDoc([m]);
        const md = toMarkdown(ydoc.getXmlFragment('default'), { flavor: 'portable' });
        const pm = markdownToPm(md);
        expect(() => schema.nodeFromJSON(pm).check()).not.toThrow();
        // Text content survives (styling degraded, content never lost)
        expect(JSON.stringify(pm)).toContain(`${m.name} text`);
      });

      if (m.portable.collapsesWith) {
        test(`collapses with ${m.portable.collapsesWith}: single delimiter pair (FR-012)`, () => {
          const native = INLINE_MARKS.find((n) => n.name === m.portable.collapsesWith);
          const ydoc = docFromPm({ type: 'doc', content: [
            p('both marks', [{ type: m.name }, { type: native.name }]),
          ] });
          const lossy = new Set();
          const md = toMarkdown(ydoc.getXmlFragment('default'), { flavor: 'portable', lossy });
          const [open, close] = m.portable.wrap;
          expect(md).toBe(`${open}both marks${close}`);
          // never doubled delimiters
          expect(md).not.toContain(open + open);
          // still counted as an actual degradation
          expect(lossy.has(m.name)).toBe(true);
        });
      }
    });
  }

  for (const m of nonDegrading) {
    test(`non-degrading mark ${m.name}: squire and portable outputs identical`, () => {
      const ydoc = markedDoc([m]);
      const frag = ydoc.getXmlFragment('default');
      expect(toMarkdown(frag, { flavor: 'portable' })).toBe(toMarkdown(frag));
    });
  }

  test('textStyle drops styling, keeps text, reports lossy (registry TEXTSTYLE_PORTABLE)', () => {
    expect(TEXTSTYLE_PORTABLE.drop).toBe(true);
    const ydoc = docFromPm({ type: 'doc', content: [
      p('colored words', [{ type: 'textStyle', attrs: { color: '#ff0000' } }]),
    ] });
    const lossy = new Set();
    const md = toMarkdown(ydoc.getXmlFragment('default'), { flavor: 'portable', lossy });
    expect(md).toBe('colored words');
    expect(md).not.toContain('<span');
    expect([...lossy]).toEqual(['textStyle']);
  });

  test('document with no degradable marks: identical output, empty lossy (SC-003)', () => {
    const ydoc = docFromPm({ type: 'doc', content: [
      p('bold words', [{ type: 'bold' }]),
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
    ] });
    const frag = ydoc.getXmlFragment('default');
    const lossy = new Set();
    expect(toMarkdown(frag, { flavor: 'portable', lossy })).toBe(toMarkdown(frag));
    expect(lossy.size).toBe(0);
  });

  test('diagram fences identical across flavors (FR-013)', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => {
      const m = new Y.XmlElement('mermaid');
      const t = new Y.XmlText();
      t.insert(0, 'graph TD\n  A --> B');
      m.insert(0, [t]);
      frag.insert(0, [m]);
    });
    expect(toMarkdown(frag, { flavor: 'portable' })).toBe(toMarkdown(frag));
    expect(toMarkdown(frag)).toContain('```mermaid');
    doc.destroy();
  });

  // FR-012 across an op boundary: two neighbouring segments whose
  // portable-effective wraps coincide must merge into ONE delimiter pair.
  // underline degrades to italic `_`, so underline"foo" + italic"bar" would
  // naively emit `_foo__bar_`, which re-parses as italic "foo__bar" with a
  // LITERAL `__` injected into the text (content corruption). The merge emits
  // `_foobar_`, re-parsing to italic "foobar" with the text intact.
  test('adjacent segments with identical portable wraps do not double delimiters', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => {
      const para = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'foo', { underline: true });
      t.insert(3, 'bar', { italic: true });
      para.insert(0, [t]);
      frag.insert(0, [para]);
    });
    const md = toMarkdown(frag, { flavor: 'portable' });
    expect(md).toBe('_foobar_');
    expect(md).not.toContain('__'); // no doubled delimiter
    // Round-trips with text content intact (no literal underscores leak).
    const pm = markdownToPm(md);
    const runs = pm.content[0].content;
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe('foobar');
    expect(runs[0].marks.map((m) => m.type)).toEqual(['italic']);
    // Squire flavor is untouched: distinct delimiters, no merge.
    expect(toMarkdown(frag)).toBe('<u>foo</u>_bar_');
    doc.destroy();
  });

  // highlight → bold `**`; adjacent to a native bold run it likewise merges.
  test('adjacent highlight+bold merge to a single bold delimiter pair', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => {
      const para = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'hi', { highlight: true });
      t.insert(2, 'there', { bold: true });
      para.insert(0, [t]);
      frag.insert(0, [para]);
    });
    const md = toMarkdown(frag, { flavor: 'portable' });
    expect(md).toBe('**hithere**');
    const pm = markdownToPm(md);
    expect(pm.content[0].content).toHaveLength(1);
    expect(pm.content[0].content[0].text).toBe('hithere');
    doc.destroy();
  });
});

// ---------------------------------------------------------------------------
// FR-022 / SC-003 byte-compat regression: default-option export of the
// baseline document equals its pre-feature snapshot exactly.
// ---------------------------------------------------------------------------

describe('byte-compat with the pre-feature serializer (FR-022, SC-003)', () => {
  test('default-option toMarkdown of the baseline doc equals the pre-feature fixture', () => {
    const { doc, fragment } = buildBaselineDoc();
    const baseline = fs.readFileSync(
      path.join(__dirname, 'fixtures/pre-feature-export-baseline.md'), 'utf8');
    expect(toMarkdown(fragment)).toBe(baseline);
    // squire flavor explicitly requested is the same bytes
    expect(toMarkdown(fragment, { flavor: 'squire' })).toBe(baseline);
    // and an empty options object changes nothing
    expect(toMarkdown(fragment, {})).toBe(baseline);
    doc.destroy();
  });
});

// ---------------------------------------------------------------------------
// Frontmatter strip/preserve round-trip (FR-023, SC-005) — the full-file
// cycle: export with frontmatter → parseFrontmatter → re-export preserves
// foreign keys byte-verbatim and the body exactly.
// ---------------------------------------------------------------------------

describe('frontmatter strip/preserve round-trip (FR-023, SC-005)', () => {
  const { parseFrontmatter } = require('../../shared/markdown/frontmatter');
  const { buildFrontmatter } = require('../mcp/yjs/serialization');

  test('export → parse → re-export: foreign keys verbatim, body byte-identical', () => {
    // A document body exercising task lists and hard breaks
    const ydoc = docFromPm({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Doc' }] },
      taskList(taskItem(true, [p('shipped')])),
      { type: 'paragraph', content: [
        { type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' },
      ] },
    ] });
    const body = toMarkdown(ydoc.getXmlFragment('default'));

    const foreign = 'speckit:\n  phase: implement\nlayout: doc';
    const meta = {
      docGuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      title: 'Doc',
      clock: 3,
      exportedAt: '2026-07-13T00:00:00Z',
      lastModifiedBy: 'sam@example.com',
      flavor: 'squire',
    };
    const exported = buildFrontmatter(meta, foreign) + '\n' + body;

    const parsed = parseFrontmatter(exported);
    expect(parsed.body).toBe(body);
    expect(parsed.foreignRaw).toBe(foreign);
    expect(parsed.squire.docGuid).toBe(meta.docGuid);

    // Re-export with a regenerated squire key, carrying foreignRaw through
    const reExported = buildFrontmatter({ ...meta, clock: 4 }, parsed.foreignRaw) + '\n' + parsed.body;
    expect(reExported.match(/^---$/gm)).toHaveLength(2); // single block
    const again = parseFrontmatter(reExported);
    expect(again.foreignRaw).toBe(foreign);           // byte-verbatim across cycles
    expect(again.body).toBe(body);                    // body byte-identical
    expect(again.squire.clock).toBe(4);
  });

  test('no frontmatter option: parser sees the bare body unchanged', () => {
    const ydoc = docFromPm({ type: 'doc', content: [p('plain body')] });
    const body = toMarkdown(ydoc.getXmlFragment('default'));
    const parsed = parseFrontmatter(body);
    expect(parsed).toEqual({ body, squire: null, foreignRaw: null });
  });
});

// ---------------------------------------------------------------------------
// Feature 004 — Two-way sync round-trip invariant (T019, FR-016/SC-001/SC-009)
// ---------------------------------------------------------------------------
describe('sync round-trip invariant (push(export(doc)) is a no-op)', () => {
  const { toMarkdownWithSourceMap } = require('../mcp/yjs/serialization');
  const { canonicalizePushed, computeHunks, planPush } = require('../markdown-sync');

  const elx = (tag, text, attrs) => {
    const e = new Y.XmlElement(tag);
    if (text !== undefined) { const t = new Y.XmlText(); t.insert(0, text, attrs); e.insert(0, [t]); }
    return e;
  };
  const li = (txt) => { const x = new Y.XmlElement('listItem'); x.insert(0, [elx('paragraph', txt)]); return x; };
  const ti = (checked, txt) => { const x = new Y.XmlElement('taskItem'); x.setAttribute('checked', checked); x.insert(0, [elx('paragraph', txt)]); return x; };
  const cell = (txt) => { const c = new Y.XmlElement('tableCell'); c.insert(0, [elx('paragraph', txt)]); return c; };
  const row = (...cells) => { const r = new Y.XmlElement('tableRow'); r.insert(0, cells.map(cell)); return r; };

  // Registry-driven corpus: one doc per inline mark + representative block types.
  const corpus = {};
  for (const mark of INLINE_MARKS) {
    corpus[`mark:${mark.name}`] = () => [elx('paragraph', 'styled', { [mark.yjsAttr]: true })];
  }
  corpus['headings'] = () => [1, 2, 3].map((lvl) => { const h = elx('heading', `H${lvl}`); h.setAttribute('level', String(lvl)); return h; });
  corpus['code + mermaid'] = () => { const cb = elx('codeBlock', 'const x=1;'); cb.setAttribute('language', 'js'); return [cb, elx('mermaid', 'graph TD')]; };
  corpus['bullet + ordered lists'] = () => { const b = new Y.XmlElement('bulletList'); b.insert(0, [li('one'), li('two')]); const o = new Y.XmlElement('orderedList'); o.insert(0, [li('a'), li('b')]); return [b, o]; };
  corpus['nested list'] = () => { const outer = new Y.XmlElement('bulletList'); const item = li('parent'); const inner = new Y.XmlElement('bulletList'); inner.insert(0, [li('child')]); item.insert(1, [inner]); outer.insert(0, [item]); return [outer]; };
  corpus['task list'] = () => { const tl = new Y.XmlElement('taskList'); tl.insert(0, [ti(false, 'todo'), ti(true, 'done')]); return [tl]; };
  corpus['blockquote + hr'] = () => { const bq = new Y.XmlElement('blockquote'); bq.insert(0, [elx('paragraph', 'quoted')]); return [bq, new Y.XmlElement('horizontalRule')]; };
  corpus['table'] = () => { const t = new Y.XmlElement('table'); t.insert(0, [row('h1', 'h2'), row('a', 'b')]); return [t]; };
  corpus['link'] = () => { const p = new Y.XmlElement('paragraph'); const t = new Y.XmlText(); t.insert(0, 'label', { link: { href: 'https://example.com' } }); p.insert(0, [t]); return [p]; };
  corpus['mixed document'] = () => { const h = elx('heading', 'Title'); h.setAttribute('level', '1'); const b = new Y.XmlElement('bulletList'); b.insert(0, [li('x'), li('y')]); return [h, elx('paragraph', 'intro para'), b, elx('paragraph', 'outro para')]; };

  for (const [name, build] of Object.entries(corpus)) {
    for (const flavor of ['squire', 'portable']) {
      test(`${name} — push(export) is a no-op [${flavor}]`, () => {
        const doc = new Y.Doc();
        doc.transact(() => doc.getXmlFragment('default').insert(0, build()));
        const nodes = doc.getXmlFragment('default').toArray();
        const { markdown: baselineMd, sourceMap } = toMarkdownWithSourceMap(nodes, { flavor });

        // (a) push(export) — empty canonical diff, zero ops, no version entry
        const pushed = canonicalizePushed(baselineMd, { flavor });
        expect(pushed).toBe(baselineMd);
        expect(computeHunks(baselineMd, pushed)).toHaveLength(0);
        const plan = planPush(computeHunks(baselineMd, pushed), sourceMap, baselineMd);
        expect(plan.counts).toEqual({ textHunks: 0, structuralHunks: 0 });

        // (c) repeated pull→push cycle (≥3 iterations) stays a no-op (SC-009)
        let md = baselineMd;
        for (let i = 0; i < 3; i++) {
          const next = canonicalizePushed(md, { flavor });
          expect(next).toBe(md); // phantom-edit guard
          md = next;
        }
        doc.destroy();
      });
    }
  }

  test('export → import → export is byte-stable in squire flavor (FR-016)', () => {
    const doc = new Y.Doc();
    doc.transact(() => doc.getXmlFragment('default').insert(0, corpus['mixed document']()));
    const md = toMarkdown(doc.getXmlFragment('default'));
    expect(reserialize(md)).toBe(md); // import(export) re-exports identically
    doc.destroy();
  });
});
