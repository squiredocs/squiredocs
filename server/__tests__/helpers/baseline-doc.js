/**
 * Byte-compat baseline document (feature 003, FR-022 / SC-003).
 *
 * Builds a deterministic Y.Doc exercising every pre-feature-003 construct the
 * serializer emits: all registry inline marks, every textStyle property,
 * links, headings, nested bullet/ordered lists, blockquote, horizontal rule,
 * table, code/mermaid/svg fences, and an image.
 *
 * The fixture `../fixtures/pre-feature-export-baseline.md` was generated from
 * this builder at the feature's merge base (ef49f5c, before any 003 serializer
 * change). The round-trip suite asserts that a default-option
 * `toMarkdown(fragment)` of this document still equals those bytes — pinning
 * the FR-022 guarantee that existing consumers see byte-identical output.
 *
 * Deliberately excludes taskList and hardBreak: those constructs are the
 * spec's declared bug-fix exception (previously exported lossily).
 */
const Y = require('yjs');
const { INLINE_MARKS, STYLE_PROPS } = require('../../../shared/format-registry');

const STYLE_VALUES = {
  color: '#ff0000',
  backgroundColor: '#00ff00',
  fontSize: '18px',
  fontFamily: 'Georgia',
  lineHeight: '1.8',
};

/** Build the baseline document; returns { doc, fragment }. */
function buildBaselineDoc() {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');

  const el = (tag, text, attrs) => {
    const e = new Y.XmlElement(tag);
    if (text !== undefined) {
      const t = new Y.XmlText();
      t.insert(0, text, attrs);
      e.insert(0, [t]);
    }
    return e;
  };

  doc.transact(() => {
    const blocks = [];

    // Headings at several levels
    const h1 = el('heading', 'Baseline Title');
    h1.setAttribute('level', '1');
    const h3 = el('heading', 'Subsection');
    h3.setAttribute('level', '3');
    blocks.push(h1, el('paragraph', 'Plain paragraph text.'), h3);

    // One paragraph per registry inline mark
    for (const mark of INLINE_MARKS) {
      blocks.push(el('paragraph', `${mark.name} text`, { [mark.yjsAttr]: true }));
    }

    // One paragraph per textStyle property, plus a combined span
    for (const prop of STYLE_PROPS) {
      blocks.push(el('paragraph', `${prop.attr} styled`, {
        textStyle: { [prop.attr]: STYLE_VALUES[prop.attr] || 'x' },
      }));
    }
    blocks.push(el('paragraph', 'multi styled', {
      textStyle: { color: '#333333', fontSize: '20px' },
    }));

    // Link + combined native marks
    blocks.push(el('paragraph', 'a link', { link: { href: 'https://example.com/page' } }));
    blocks.push(el('paragraph', 'bold italic', { bold: true, italic: true }));

    // Nested bullet list
    const list = new Y.XmlElement('bulletList');
    const li = new Y.XmlElement('listItem');
    li.insert(0, [el('paragraph', 'parent item')]);
    const nested = new Y.XmlElement('bulletList');
    const nli = new Y.XmlElement('listItem');
    nli.insert(0, [el('paragraph', 'child item')]);
    nested.insert(0, [nli]);
    li.insert(1, [nested]);
    const li2 = new Y.XmlElement('listItem');
    li2.insert(0, [el('paragraph', 'second item')]);
    list.insert(0, [li, li2]);
    blocks.push(list);

    // Ordered list
    const olist = new Y.XmlElement('orderedList');
    for (const text of ['first step', 'second step']) {
      const oli = new Y.XmlElement('listItem');
      oli.insert(0, [el('paragraph', text)]);
      olist.insert(olist.length, [oli]);
    }
    blocks.push(olist);

    // Blockquote, horizontal rule
    const bq = new Y.XmlElement('blockquote');
    bq.insert(0, [el('paragraph', 'quoted wisdom')]);
    blocks.push(bq, new Y.XmlElement('horizontalRule'));

    // Table (header + data row)
    const table = new Y.XmlElement('table');
    const hrow = new Y.XmlElement('tableRow');
    for (const text of ['Col A', 'Col B']) {
      const th = new Y.XmlElement('tableHeader');
      th.insert(0, [el('paragraph', text)]);
      hrow.insert(hrow.length, [th]);
    }
    const drow = new Y.XmlElement('tableRow');
    for (const text of ['a1', 'b1']) {
      const td = new Y.XmlElement('tableCell');
      td.insert(0, [el('paragraph', text)]);
      drow.insert(drow.length, [td]);
    }
    table.insert(0, [hrow, drow]);
    blocks.push(table);

    // Code, mermaid, svg fences
    const cb = el('codeBlock', 'const x = 1;\nconsole.log(x);');
    cb.setAttribute('language', 'js');
    blocks.push(cb);
    blocks.push(el('mermaid', 'graph TD\n  A --> B'));
    blocks.push(el('svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>'));

    // Image (app URL shape)
    const img = new Y.XmlElement('image');
    img.setAttribute('src', '/api/docs/00000000-0000-4000-8000-000000000000/images/11111111-1111-4111-8111-111111111111');
    img.setAttribute('alt', 'baseline image');
    blocks.push(img);

    fragment.insert(0, blocks);
  });

  return { doc, fragment };
}

module.exports = { buildBaselineDoc };
