/**
 * Characterization-snapshot generator for the STRICT markdown parser (CN-2).
 *
 * Runs the CURRENT parser over a representative corpus of canonical serializer
 * output, diff-hunk fragments, and edge inputs, and writes the exact output to
 * `strict-characterization.json`. That snapshot is the byte-identity baseline
 * the strict parser must reproduce forever (feature 001, task T001).
 *
 * IMPORTANT: this script requires the parser via `resolveParser()` which prefers
 * the frozen `shared/markdown/strict-parser.js` if it exists (post-move) and
 * falls back to the pre-move `server/markdown-to-pm.js`. Re-running it MUST
 * produce a byte-identical file (T019): a non-empty `git diff` means strict
 * mode drifted.
 *
 * Run:  node server/__tests__/fixtures/markdown/generate-strict-characterization.js
 */

const fs = require('fs');
const path = require('path');
const Y = require('yjs');
const { toMarkdown } = require('../../../mcp/yjs/serialization');
const { STYLE_PROPS } = require('../../../../shared/format-registry');

// Prefer the frozen strict parser once it exists; otherwise the pre-move parser.
function resolveParser() {
  const strictPath = path.join(__dirname, '../../../../shared/markdown/strict-parser.js');
  if (fs.existsSync(strictPath)) return require(strictPath).markdownToPm;
  return require('../../../markdown-to-pm').markdownToPm;
}
const markdownToPm = resolveParser();

// ---------------------------------------------------------------------------
// Y.Doc builders — produce canonical markdown via the real serializer
// ---------------------------------------------------------------------------

function fragmentOf(build) {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  doc.transact(() => build(fragment, doc));
  const md = toMarkdown(fragment);
  doc.destroy();
  return md;
}

function textEl(tag, text, attrs) {
  const el = new Y.XmlElement(tag);
  const t = new Y.XmlText();
  t.insert(0, text, attrs);
  el.insert(0, [t]);
  return el;
}

function styledParagraph(text, attrs) {
  return fragmentOf((frag) => frag.insert(0, [textEl('paragraph', text, attrs)]));
}

// ---------------------------------------------------------------------------
// Corpus assembly
// ---------------------------------------------------------------------------

const canonical = [];

// Every registry inline mark (via yjsAttr → serializer wrap/tag).
const { INLINE_MARKS } = require('../../../../shared/format-registry');
for (const m of INLINE_MARKS) {
  canonical.push({
    name: `inline-mark-${m.name}`,
    input: styledParagraph('hello', { [m.yjsAttr]: true }),
  });
}

// Every textStyle style prop, plus a multi-prop span.
const styleValue = (attr) =>
  attr === 'color' ? '#ff0000'
    : attr === 'backgroundColor' ? '#00ff00'
      : attr === 'fontSize' ? '18px'
        : attr === 'fontFamily' ? 'Georgia'
          : attr === 'lineHeight' ? '1.8'
            : 'test';
for (const prop of STYLE_PROPS) {
  canonical.push({
    name: `style-prop-${prop.attr}`,
    input: styledParagraph('styled', { textStyle: { [prop.attr]: styleValue(prop.attr) } }),
  });
}
canonical.push({
  name: 'style-multi',
  input: styledParagraph('multi', { textStyle: { color: '#333', fontSize: '20px', lineHeight: '1.5' } }),
});

// Link.
canonical.push({
  name: 'link',
  input: styledParagraph('click here', { link: { href: 'https://example.com' } }),
});

// Nested marks.
canonical.push({
  name: 'nested-bold-italic',
  input: styledParagraph('both', { bold: true, italic: true }),
});

// Newline inside styled text (continuation-line join path).
canonical.push({
  name: 'styled-newline',
  input: styledParagraph('line1\nline2', { textStyle: { fontSize: '17px' } }),
});

// Block types.
canonical.push({
  name: 'block-heading',
  input: fragmentOf((frag) => {
    const h = textEl('heading', 'Title');
    h.setAttribute('level', '2');
    frag.insert(0, [h]);
  }),
});
canonical.push({
  name: 'block-codeblock-language',
  input: fragmentOf((frag) => {
    const cb = textEl('codeBlock', 'const x = 1;');
    cb.setAttribute('language', 'js');
    frag.insert(0, [cb]);
  }),
});
canonical.push({
  name: 'block-codeblock-nolang',
  input: fragmentOf((frag) => frag.insert(0, [textEl('codeBlock', 'plain code')])),
});
canonical.push({
  name: 'block-mermaid',
  input: fragmentOf((frag) => frag.insert(0, [textEl('mermaid', 'graph TD\n  A --> B')])),
});
canonical.push({
  name: 'block-svg',
  input: fragmentOf((frag) => frag.insert(0, [textEl('svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>')])),
});
canonical.push({
  name: 'block-bulletlist',
  input: fragmentOf((frag) => {
    const list = new Y.XmlElement('bulletList');
    const items = ['alpha', 'beta'].map((text) => {
      const li = new Y.XmlElement('listItem');
      li.insert(0, [textEl('paragraph', text)]);
      return li;
    });
    list.insert(0, items);
    frag.insert(0, [list]);
  }),
});
canonical.push({
  name: 'block-bulletlist-nested',
  input: fragmentOf((frag) => {
    const list = new Y.XmlElement('bulletList');
    const li = new Y.XmlElement('listItem');
    li.insert(0, [textEl('paragraph', 'parent')]);
    const nested = new Y.XmlElement('bulletList');
    const nli = new Y.XmlElement('listItem');
    nli.insert(0, [textEl('paragraph', 'child')]);
    nested.insert(0, [nli]);
    li.insert(1, [nested]);
    list.insert(0, [li]);
    frag.insert(0, [list]);
  }),
});
canonical.push({
  name: 'block-orderedlist',
  input: fragmentOf((frag) => {
    const list = new Y.XmlElement('orderedList');
    const li = new Y.XmlElement('listItem');
    li.insert(0, [textEl('paragraph', 'first')]);
    list.insert(0, [li]);
    frag.insert(0, [list]);
  }),
});
canonical.push({
  name: 'block-blockquote',
  input: fragmentOf((frag) => {
    const bq = new Y.XmlElement('blockquote');
    bq.insert(0, [textEl('paragraph', 'quoted')]);
    frag.insert(0, [bq]);
  }),
});
canonical.push({
  name: 'block-horizontalrule',
  input: fragmentOf((frag) => {
    frag.insert(0, [
      textEl('paragraph', 'above'),
      new Y.XmlElement('horizontalRule'),
      textEl('paragraph', 'below'),
    ]);
  }),
});
canonical.push({
  name: 'block-table',
  input: fragmentOf((frag) => {
    const table = new Y.XmlElement('table');
    const row = new Y.XmlElement('tableRow');
    const cell = new Y.XmlElement('tableCell');
    cell.insert(0, [textEl('paragraph', 'data')]);
    row.insert(0, [cell]);
    table.insert(0, [row]);
    frag.insert(0, [table]);
  }),
});
canonical.push({
  name: 'block-table-escaped-pipe',
  input: fragmentOf((frag) => {
    const table = new Y.XmlElement('table');
    const row = new Y.XmlElement('tableRow');
    const cell = new Y.XmlElement('tableCell');
    cell.insert(0, [textEl('paragraph', 'a | b')]);
    row.insert(0, [cell]);
    table.insert(0, [row]);
    frag.insert(0, [table]);
  }),
});
canonical.push({
  name: 'block-paragraph',
  input: fragmentOf((frag) => frag.insert(0, [textEl('paragraph', 'a plain paragraph')])),
});

// ---------------------------------------------------------------------------
// Diff-hunk-style fragments (line-diffing splits blocks at arbitrary lines).
// ---------------------------------------------------------------------------

const fragments = [
  { name: 'fragment-ends-in-hr', input: 'paragraph line\n---' },
  { name: 'fragment-canonical-hr', input: 'paragraph\n\n---\n' },
  { name: 'fragment-partial-list', input: '- alpha\n- beta' },
  { name: 'fragment-unclosed-fence', input: '```js\nconst x = 1;' },
  { name: 'fragment-span-continuation', input: '<span style="color:#333">line one\nline two</span>' },
  { name: 'fragment-lone-closing-tag', input: '</span>' },
  { name: 'fragment-partial-ordered', input: '1. first\n2. second' },
  { name: 'fragment-heading-only', input: '## just a heading' },
];

// ---------------------------------------------------------------------------
// Edge inputs.
// ---------------------------------------------------------------------------

const edges = [
  { name: 'edge-empty', input: '' },
  { name: 'edge-whitespace-only', input: '   \n  \n' },
  { name: 'edge-crlf', input: 'line one\r\nline two\r\n' },
  { name: 'edge-image-markdown', input: '![alt text](https://example.com/x.png)' },
  { name: 'edge-plain-text', input: 'just some words' },
];

// ---------------------------------------------------------------------------
// diffMark variants: null for all; insert/delete for a representative subset.
// ---------------------------------------------------------------------------

const DIFF_SUBSET = new Set([
  'inline-mark-bold',
  'style-multi',
  'link',
  'block-heading',
  'block-codeblock-language',
  'block-bulletlist',
  'block-blockquote',
  'block-table',
  'block-horizontalrule',
  'fragment-ends-in-hr',
  'fragment-unclosed-fence',
  'edge-image-markdown',
]);

const corpus = [...canonical, ...fragments, ...edges];
const cases = [];
for (const c of corpus) {
  cases.push({ name: c.name, input: c.input, diffMark: null, expected: markdownToPm(c.input, null) });
  if (DIFF_SUBSET.has(c.name)) {
    cases.push({ name: `${c.name}--diffInsert`, input: c.input, diffMark: 'diffInsert', expected: markdownToPm(c.input, 'diffInsert') });
    cases.push({ name: `${c.name}--diffDelete`, input: c.input, diffMark: 'diffDelete', expected: markdownToPm(c.input, 'diffDelete') });
  }
}

const outPath = path.join(__dirname, 'strict-characterization.json');
fs.writeFileSync(outPath, JSON.stringify(cases, null, 2) + '\n');
console.log(`Wrote ${cases.length} characterization cases to ${outPath}`);
