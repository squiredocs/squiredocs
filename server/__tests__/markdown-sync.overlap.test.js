/**
 * Overlap-flag detection (feature 004, T012/T013, US2 / SC-006). Overlaps are
 * strictly advisory (FR-012): computed after application, never gate it.
 */
const Y = require('yjs');
const { toMarkdownWithSourceMap, toMarkdownNodes } = require('../mcp/yjs/serialization');
const {
  detectOverlaps,
  canonicalizePushed,
  computeHunks,
  planPush,
} = require('../markdown-sync');

function el(tag, text) {
  const e = new Y.XmlElement(tag);
  if (text !== undefined) { const t = new Y.XmlText(); t.insert(0, text); e.insert(0, [t]); }
  return e;
}
function mkDoc(build) {
  const d = new Y.Doc();
  const f = d.getXmlFragment('default');
  d.transact(() => build(f));
  return d;
}

/**
 * Detect overlaps for: a baseline doc, a "current" live doc (concurrent
 * doc-side edits), and a pushed body. Returns the flags.
 */
async function overlaps(baselineDoc, currentDoc, pushedBody) {
  const nodes = baselineDoc.get('default', Y.XmlFragment).toArray();
  const { markdown: canonicalMd, sourceMap } = toMarkdownWithSourceMap(nodes);
  const baselineSV = Y.encodeStateVector(baselineDoc);
  const plan = planPush(computeHunks(canonicalMd, canonicalizePushed(pushedBody)), sourceMap, canonicalMd);
  const before = toMarkdownNodes(currentDoc.get('default', Y.XmlFragment).toArray());
  const flags = await detectOverlaps({}, 'doc', {
    baselineSV, canonicalMd, sourceMap, plan, getSharedDoc: () => currentDoc, flavor: 'squire',
  });
  // purity: detection never mutates the current doc (flags never alter application)
  expect(toMarkdownNodes(currentDoc.get('default', Y.XmlFragment).toArray())).toBe(before);
  return flags;
}

describe('overlap detection (T013, US2)', () => {
  test('disjoint blocks: doc edits A, push edits B → no overlaps', async () => {
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    const cur = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha edited'), el('paragraph', 'Bravo')]));
    expect(await overlaps(base, cur, 'Alpha\n\nBravo push')).toEqual([]);
    base.destroy(); cur.destroy();
  });

  test('same block edited both sides → flagged (docSide edited, pushSide text)', async () => {
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    const cur = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo doc')]));
    const flags = await overlaps(base, cur, 'Alpha\n\nBravo push');
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ blockType: 'paragraph', docSide: 'edited', pushSide: 'text' });
    expect(flags[0].excerpt).toContain('Bravo');
    base.destroy(); cur.destroy();
  });

  test('clock-equal push (current === baseline) → fast path, zero overlaps', async () => {
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    // same doc as current → identical state vector → fast path
    expect(await overlaps(base, base, 'Alpha\n\nBravo push')).toEqual([]);
    base.destroy();
  });

  test('structural push replace vs concurrent intra-block edit → pushSide structural', async () => {
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    const cur = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo doc')]));
    // push converts Bravo paragraph → list item
    const flags = await overlaps(base, cur, 'Alpha\n\n- Bravo');
    expect(flags).toHaveLength(1);
    expect(flags[0].pushSide).toBe('structural');
    expect(flags[0].docSide).toBe('edited');
    base.destroy(); cur.destroy();
  });

  test('block delete vs edit-inside → pushSide deleted', async () => {
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    const cur = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo doc')]));
    const flags = await overlaps(base, cur, 'Alpha'); // deletes Bravo
    expect(flags).toHaveLength(1);
    expect(flags[0].pushSide).toBe('deleted');
    base.destroy(); cur.destroy();
  });

  test('doc-side deleted block that push edits → docSide deleted', async () => {
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    const cur = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha')])); // doc deleted Bravo
    const flags = await overlaps(base, cur, 'Alpha\n\nBravo push');
    expect(flags).toHaveLength(1);
    expect(flags[0].docSide).toBe('deleted');
    expect(flags[0].pushSide).toBe('text');
    base.destroy(); cur.destroy();
  });
});
