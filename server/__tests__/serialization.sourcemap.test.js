/**
 * Source-map correctness (feature 004, T002 / FR-006, research R1/R2).
 *
 * Verifies toMarkdownWithSourceMap: every document-text character maps back to
 * the right Y.XmlText + offset via exactly one run; syntax characters map to no
 * run; escaped `\|` splits runs; block extents tile the document; and the
 * assembled markdown is byte-identical to toMarkdownNodes for the whole corpus.
 * Registry-driven so new marks inherit coverage by construction.
 */
const Y = require('yjs');
const {
  toMarkdownNodes,
  toMarkdownWithSourceMap,
} = require('../mcp/yjs/serialization');
const { INLINE_MARKS } = require('../../shared/format-registry');

// ---- builders --------------------------------------------------------------
function el(tag, text, attrs) {
  const e = new Y.XmlElement(tag);
  if (text !== undefined) {
    const t = new Y.XmlText();
    t.insert(0, text, attrs);
    e.insert(0, [t]);
  }
  return e;
}
function docNodes(build) {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  doc.transact(() => build(frag));
  return { doc, nodes: frag.toArray() };
}
function plainText(textNode) {
  return textNode.toDelta().map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('');
}
function allTextNodes(node, out = []) {
  if (node instanceof Y.XmlText) { out.push(node); return out; }
  if (node instanceof Y.XmlElement) for (const c of node.toArray()) allTextNodes(c, out);
  return out;
}

/** Core invariants shared by every corpus case. Returns { markdown, sourceMap }. */
function verify(nodes) {
  const { markdown, sourceMap } = toMarkdownWithSourceMap(nodes);
  const { runs, blocks } = sourceMap;

  // (e) byte-identical to the fast path
  expect(markdown).toBe(toMarkdownNodes(nodes));

  // runs sorted, non-overlapping, in-bounds; substring matches the text node
  let covered = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    expect(r.mdStart).toBeLessThan(r.mdEnd);
    expect(r.mdStart).toBeGreaterThanOrEqual(0);
    expect(r.mdEnd).toBeLessThanOrEqual(markdown.length);
    if (i > 0) expect(r.mdStart).toBeGreaterThanOrEqual(runs[i - 1].mdEnd);
    const mdSlice = markdown.slice(r.mdStart, r.mdEnd);
    const textSlice = plainText(r.textNode).slice(r.textOff, r.textOff + (r.mdEnd - r.mdStart));
    expect(mdSlice).toBe(textSlice); // (a) correct node + offset
    covered += r.mdEnd - r.mdStart;
    // every run lies inside exactly one block extent
    const owning = blocks.filter((b) => r.mdStart >= b.mdStart && r.mdEnd <= b.mdEnd);
    expect(owning.length).toBe(1);
  }

  // (a) coverage: total run length === total document-text chars (each once)
  const totalPlain = nodes
    .flatMap((n) => allTextNodes(n))
    .reduce((s, tn) => s + plainText(tn).length, 0);
  expect(covered).toBe(totalPlain);

  // (d) blocks tile in order and never overlap
  for (let i = 1; i < blocks.length; i++) {
    expect(blocks[i].mdStart).toBeGreaterThanOrEqual(blocks[i - 1].mdEnd);
  }

  return { markdown, sourceMap };
}

/** Set of markdown indices covered by any run. */
function coveredSet(runs) {
  const s = new Set();
  for (const r of runs) for (let i = r.mdStart; i < r.mdEnd; i++) s.add(i);
  return s;
}

describe('source map — coverage & byte-identity (registry-driven)', () => {
  test('every inline mark: text covered, delimiters are syntax', () => {
    for (const mark of INLINE_MARKS) {
      const { doc, nodes } = docNodes((f) =>
        f.insert(0, [el('paragraph', 'hello', { [mark.yjsAttr]: true })])
      );
      const { markdown, sourceMap } = verify(nodes);
      const cov = coveredSet(sourceMap.runs);
      // the literal word 'hello' is covered
      const at = markdown.indexOf('hello');
      for (let i = at; i < at + 5; i++) expect(cov.has(i)).toBe(true);
      // at least one delimiter/syntax char exists and is NOT covered
      const firstSyntax = markdown[0];
      expect('#*_~`<[!'.includes(firstSyntax) || markdown.length > 5).toBe(true);
      expect(cov.has(0)).toBe(false); // leading delimiter/tag is syntax
      doc.destroy();
    }
  });

  test('heading: # and space are syntax, text covered', () => {
    const { doc, nodes } = docNodes((f) => {
      const h = el('heading', 'Title'); h.setAttribute('level', '2');
      f.insert(0, [h]);
    });
    const { markdown, sourceMap } = verify(nodes);
    expect(markdown).toBe('## Title');
    const cov = coveredSet(sourceMap.runs);
    expect(cov.has(0)).toBe(false); // #
    expect(cov.has(1)).toBe(false); // #
    expect(cov.has(2)).toBe(false); // space
    expect(cov.has(3)).toBe(true); // T
    doc.destroy();
  });

  test('link: brackets and url are syntax, label is text', () => {
    const { doc, nodes } = docNodes((f) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'lbl', { link: { href: 'https://x.com' } });
      p.insert(0, [t]);
      f.insert(0, [p]);
    });
    const { markdown, sourceMap } = verify(nodes);
    expect(markdown).toBe('[lbl](https://x.com)');
    const cov = coveredSet(sourceMap.runs);
    expect(cov.has(0)).toBe(false); // [
    expect([...'lbl'].every((_, i) => cov.has(1 + i))).toBe(true);
    expect(cov.has(4)).toBe(false); // ]
    expect(cov.has(5)).toBe(false); // (
    doc.destroy();
  });

  test('list markers and indentation are syntax', () => {
    const { doc, nodes } = docNodes((f) => {
      const list = new Y.XmlElement('bulletList');
      const li = new Y.XmlElement('listItem');
      li.insert(0, [el('paragraph', 'parent')]);
      const nested = new Y.XmlElement('bulletList');
      const nli = new Y.XmlElement('listItem'); nli.insert(0, [el('paragraph', 'child')]);
      nested.insert(0, [nli]); li.insert(1, [nested]); list.insert(0, [li]);
      f.insert(0, [list]);
    });
    const { markdown, sourceMap } = verify(nodes);
    expect(markdown).toBe('- parent\n  - child');
    const cov = coveredSet(sourceMap.runs);
    expect(cov.has(0)).toBe(false); // -
    expect(cov.has(1)).toBe(false); // space
    expect(markdown.slice(2, 8)).toBe('parent');
    for (let i = 2; i < 8; i++) expect(cov.has(i)).toBe(true);
    // nested indentation
    const childAt = markdown.indexOf('child');
    expect(cov.has(childAt - 1)).toBe(false); // space after nested '- '
    doc.destroy();
  });

  test('task list markers are syntax, checked/unchecked', () => {
    const { doc, nodes } = docNodes((f) => {
      const tl = new Y.XmlElement('taskList');
      const ti1 = new Y.XmlElement('taskItem'); ti1.setAttribute('checked', false);
      ti1.insert(0, [el('paragraph', 'todo')]);
      const ti2 = new Y.XmlElement('taskItem'); ti2.setAttribute('checked', true);
      ti2.insert(0, [el('paragraph', 'done')]);
      tl.insert(0, [ti1, ti2]);
      f.insert(0, [tl]);
    });
    const { markdown, sourceMap } = verify(nodes);
    expect(markdown).toBe('- [ ] todo\n- [x] done');
    const cov = coveredSet(sourceMap.runs);
    const todoAt = markdown.indexOf('todo');
    for (let i = 0; i < todoAt; i++) expect(cov.has(i)).toBe(false); // '- [ ] '
    doc.destroy();
  });

  test('code fence lines are syntax, body is text', () => {
    const { doc, nodes } = docNodes((f) => {
      const cb = el('codeBlock', 'const x=1;'); cb.setAttribute('language', 'js');
      f.insert(0, [cb]);
    });
    const { markdown, sourceMap } = verify(nodes);
    expect(markdown).toBe('```js\nconst x=1;\n```');
    const cov = coveredSet(sourceMap.runs);
    const bodyAt = markdown.indexOf('const');
    for (let i = 0; i < bodyAt; i++) expect(cov.has(i)).toBe(false);
    doc.destroy();
  });

  test('table pipes and separator row are syntax; escaped \\| splits runs', () => {
    const { doc, nodes } = docNodes((f) => {
      const table = new Y.XmlElement('table');
      const row = new Y.XmlElement('tableRow');
      const cell = new Y.XmlElement('tableCell');
      cell.insert(0, [el('paragraph', 'a|b')]); // pipe inside cell text
      row.insert(0, [cell]); table.insert(0, [row]);
      f.insert(0, [table]);
    });
    const { markdown, sourceMap } = verify(nodes);
    expect(markdown).toContain('a\\|b'); // pipe escaped
    // (c) the one text node "a|b" must map via >=2 runs (split around the '\')
    const cellNode = allTextNodes(nodes[0]).find((tn) => plainText(tn) === 'a|b');
    const cellRuns = sourceMap.runs.filter((r) => r.textNode === cellNode);
    expect(cellRuns.length).toBeGreaterThanOrEqual(2);
    // the escaping backslash is syntax
    const cov = coveredSet(sourceMap.runs);
    const bs = markdown.indexOf('a\\|b') + 1;
    expect(cov.has(bs)).toBe(false); // '\'
    expect(cov.has(bs + 1)).toBe(true); // '|' is text
    doc.destroy();
  });

  test('blockquote prefixes are syntax, quoted text is covered', () => {
    const { doc, nodes } = docNodes((f) => {
      const bq = new Y.XmlElement('blockquote');
      bq.insert(0, [el('paragraph', 'quoted')]);
      f.insert(0, [bq]);
    });
    const { markdown, sourceMap } = verify(nodes);
    expect(markdown).toBe('> quoted');
    const cov = coveredSet(sourceMap.runs);
    expect(cov.has(0)).toBe(false); // >
    expect(cov.has(1)).toBe(false); // space
    expect(markdown.slice(2)).toBe('quoted');
    doc.destroy();
  });

  test('image alt/src are syntax (attributes, no text node)', () => {
    const { doc, nodes } = docNodes((f) => {
      const img = new Y.XmlElement('image');
      img.setAttribute('src', '/api/x'); img.setAttribute('alt', 'Alt');
      f.insert(0, [el('paragraph', 'before'), img]);
    });
    const { markdown, sourceMap } = verify(nodes);
    const cov = coveredSet(sourceMap.runs);
    const imgAt = markdown.indexOf('![');
    // none of the image markdown is covered (alt/src come from attributes)
    for (let i = imgAt; i < markdown.length; i++) expect(cov.has(i)).toBe(false);
    doc.destroy();
  });

  test('multi-block document: blocks tile and include their syntax', () => {
    const { doc, nodes } = docNodes((f) => {
      const h = el('heading', 'H'); h.setAttribute('level', '1');
      f.insert(0, [h, el('paragraph', 'one'), el('paragraph', 'two'),
        new Y.XmlElement('horizontalRule')]);
    });
    const { markdown, sourceMap } = verify(nodes);
    // 4 top-level nodes → 4 block extents (hr renders '---')
    expect(sourceMap.blocks.length).toBe(4);
    // each block's mdStart..mdEnd substring is present in markdown at that spot
    for (const b of sourceMap.blocks) {
      expect(b.mdEnd).toBeGreaterThan(b.mdStart);
      expect(b.mdStart).toBeGreaterThanOrEqual(0);
      expect(b.mdEnd).toBeLessThanOrEqual(markdown.length);
    }
    doc.destroy();
  });

  test('portable flavor: degraded underline maps its text with a covered run', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => frag.insert(0, [el('paragraph', 'under', { underline: true })]));
    const nodes = frag.toArray();
    const { markdown, sourceMap } = toMarkdownWithSourceMap(nodes, { flavor: 'portable' });
    expect(markdown).toBe(toMarkdownNodes(nodes, { flavor: 'portable' }));
    expect(markdown).toBe('_under_'); // underline → italic delimiters in portable
    const at = markdown.indexOf('under');
    const cov = coveredSet(sourceMap.runs);
    for (let i = at; i < at + 5; i++) expect(cov.has(i)).toBe(true);
    expect(cov.has(0)).toBe(false); // _
    doc.destroy();
  });
});
