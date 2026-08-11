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

// ===========================================================================
// Feature 054, T006 — the widened excerpt (RBD-054-6 as amended).
//
// One helper serves BOTH block lists on a receipt, so widening it to 120 chars
// deliberately widens `overlaps[].excerpt` too. These tests pin the cap and the
// truncation marker so a later "tidy-up" cannot quietly narrow either list.
// ===========================================================================

describe('block excerpts (054, T006)', () => {
  /** A paragraph whose text is `n` characters of predictable filler. */
  const filler = (n) => 'w'.repeat(n);

  test('a short block is carried whole, with no ellipsis', async () => {
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    const cur = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo doc')]));
    const flags = await overlaps(base, cur, 'Alpha\n\nBravo push');
    expect(flags[0].excerpt).toBe('Bravo');
    expect(flags[0].excerpt).not.toContain('…');
    base.destroy(); cur.destroy();
  });

  test('a long block truncates at 120 chars and gains an ellipsis', async () => {
    // 200 chars of filler: comfortably past the cap, and single-token so the
    // markdown round trip cannot reflow it.
    const long = filler(200);
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', long)]));
    const cur = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', `${long} doc`)]));
    const flags = await overlaps(base, cur, `Alpha\n\n${long} push`);
    expect(flags).toHaveLength(1);
    expect(flags[0].excerpt).toBe(`${filler(120)}…`);
    // 120 visible characters + the one-character marker.
    expect(flags[0].excerpt).toHaveLength(121);
    base.destroy(); cur.destroy();
  });

  test('a block exactly at the cap is NOT marked as truncated', async () => {
    const exact = filler(120);
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', exact)]));
    const cur = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', `${exact} doc`)]));
    const flags = await overlaps(base, cur, `Alpha\n\n${exact} push`);
    expect(flags[0].excerpt).toBe(exact);
    expect(flags[0].excerpt).not.toContain('…');
    base.destroy(); cur.destroy();
  });

  test('whitespace stays collapsed to a single line', async () => {
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo   spaced\ttext')]));
    const cur = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo doc')]));
    const flags = await overlaps(base, cur, 'Alpha\n\nBravo push');
    expect(flags[0].excerpt).toBe('Bravo spaced text');
    expect(flags[0].excerpt).not.toMatch(/\s\s|\n/);
    base.destroy(); cur.destroy();
  });
});
