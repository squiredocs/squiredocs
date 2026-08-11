/**
 * Overlap-flag detection (feature 004, T012/T013, US2 / SC-006). Overlaps are
 * strictly advisory (FR-012): computed after application, never gate it.
 */
const Y = require('yjs');
const { toMarkdownWithSourceMap, toMarkdownNodes } = require('../mcp/yjs/serialization');
const {
  detectOverlaps,
  canonicalizePushedWithBlocks,
  computeHunks,
  planPush,
  buildChangeReport,
  pushTouchedBlocks,
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
  const pushed = canonicalizePushedWithBlocks(pushedBody);
  const plan = planPush(
    computeHunks(canonicalMd, pushed.markdown, sourceMap.blocks, pushed.blocks), sourceMap, canonicalMd);
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

// ===========================================================================
// Feature 054, US2 (T027-T029) — the per-block change report.
//
// `blocksChanged` is what removes the re-export-and-grep verification round
// trip: the receipt itself names every block the push changed and what it did
// to each.
// ===========================================================================

describe('buildChangeReport (054, US2/FR-009)', () => {
  /** Plan `pushedBody` against `baselineDoc` and return the change report. */
  function report(baselineDoc, pushedBody) {
    const nodes = baselineDoc.get('default', Y.XmlFragment).toArray();
    const { markdown: baselineMd, sourceMap } = toMarkdownWithSourceMap(nodes);
    const pushed = canonicalizePushedWithBlocks(pushedBody);
    const plan = planPush(
      computeHunks(baselineMd, pushed.markdown, sourceMap.blocks, pushed.blocks), sourceMap, baselineMd);
    return { entries: buildChangeReport(plan, sourceMap, baselineMd), plan, sourceMap, baselineMd };
  }

  test('AS-1: two edited paragraphs yield two text entries with the right blocks', () => {
    const base = mkDoc((f) => f.insert(0, [
      el('paragraph', 'Alpha original'),
      el('paragraph', 'Bravo untouched'),
      el('paragraph', 'Charlie original'),
    ]));
    // The pushed text APPENDS to each edited paragraph. Under the 055 block
    // aligner, "Alpha original" → "Alpha CHANGED" shares only "Alpha " — a
    // 0.44 Dice score, which is a wholesale rewrite by the ratified threshold
    // and therefore an atomic replace, not a character edit (ledger gap #2:
    // the frequency of atomic replacement rises, the semantics do not change).
    // What this test is about is the report's shape for character edits, so
    // the fixture is an edit that is one; every assertion below is untouched.
    const { entries } = report(base, 'Alpha original CHANGED\n\nBravo untouched\n\nCharlie original CHANGED');

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.op)).toEqual(['text', 'text']);
    expect(entries.map((e) => e.blockType)).toEqual(['paragraph', 'paragraph']);
    // Ordered by block position, and the untouched block is absent.
    expect(entries[0].blockIndex).toBeLessThan(entries[1].blockIndex);
    expect(entries[0].excerpt).toBe('Alpha original');
    expect(entries[1].excerpt).toBe('Charlie original');
    expect(entries.some((e) => e.excerpt.includes('Bravo'))).toBe(false);
    // Excerpts describe the BASELINE block, not the pushed replacement — the
    // reader is being told which block moved, not what it became.
    expect(entries[0].excerpt).not.toContain('CHANGED');
    base.destroy();
  });

  test('AS-2: a structural replace, a whole-block delete, and an insertion', () => {
    // Paragraph → list item: a block replaced as a unit, not spliced.
    const replaceDoc = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    const replaced = report(replaceDoc, 'Alpha\n\n- Bravo').entries;
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ op: 'structural', blockType: 'paragraph', excerpt: 'Bravo' });
    expect(replaced[0].position).toBeUndefined(); // not an insertion
    replaceDoc.destroy();

    // Whole-block delete: still structural, still named.
    const deleteDoc = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    const deleted = report(deleteDoc, 'Alpha').entries;
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ op: 'structural', excerpt: 'Bravo' });
    deleteDoc.destroy();

    // Boundary insertion: anchored on the preceding block, with a position,
    // because an inserted block has no baseline index of its own.
    const insertDoc = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    const inserted = report(insertDoc, 'Alpha\n\nBravo\n\nCharlie new').entries;
    const insertion = inserted.find((e) => e.position !== undefined);
    expect(insertion).toMatchObject({ op: 'structural', position: 'after' });
    expect(insertion.excerpt).toContain('Charlie new');
    // The anchor is a real baseline block index.
    expect(typeof insertion.blockIndex).toBe('number');
    expect(insertion.blockIndex).toBeGreaterThanOrEqual(0);
    insertDoc.destroy();
  });

  test('AS-2: an insertion at the document head reports position "start"', () => {
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    const entries = report(base, 'Zero new\n\nAlpha\n\nBravo').entries;
    const insertion = entries.find((e) => e.position !== undefined);
    expect(insertion).toBeTruthy();
    expect(insertion.position).toBe('start');
    expect(insertion.blockIndex).toBe(0);
    // It sorts first — nothing in the report precedes a document-head insert.
    expect(entries[0]).toBe(insertion);
    base.destroy();
  });

  test('AS-3: a reconciled block is op "reconcile" while pushSide stays "text"', () => {
    // Inline mark syntax in the new text forces whole-inline reconciliation
    // rather than a plain character splice.
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo plain here')]));
    const { entries, plan, sourceMap } = report(base, 'Alpha\n\nBravo **bold** here');

    expect(plan.reconcileBlocks.length).toBe(1);
    const reconciled = entries.find((e) => e.excerpt.includes('Bravo'));
    expect(reconciled.op).toBe('reconcile');

    // The deliberate asymmetry (research R4): the SAME block, in the same push,
    // is 'text' to the overlap contract. `pushTouchedBlocks` conflates reconcile
    // and text on purpose, and 054 did not disturb it.
    const touched = pushTouchedBlocks(plan, sourceMap.blocks);
    const arrayIdx = sourceMap.blocks.findIndex((b) => b.blockIndex === reconciled.blockIndex);
    expect(touched.get(arrayIdx)).toBe('text');
    base.destroy();
  });

  test('a block replaced wholesale is reported once, not twice', () => {
    // Regression guard: `applyHunks` skips in-block edits landing inside a
    // structurally replaced block, so the report must not describe that block
    // under two different ops.
    const base = mkDoc((f) => f.insert(0, [
      el('paragraph', 'Alpha'), el('paragraph', 'Bravo'), el('paragraph', 'Charlie'),
    ]));
    const { entries } = report(base, 'Alpha\n\n- Bravo\n- extra\n\nCharlie');
    const byIndex = new Map();
    for (const e of entries) {
      if (e.position) continue; // insertions legitimately share an anchor index
      expect(byIndex.has(e.blockIndex)).toBe(false);
      byIndex.set(e.blockIndex, e.op);
    }
    base.destroy();
  });

  test('a push that changes nothing produces an empty report', () => {
    const base = mkDoc((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    expect(report(base, 'Alpha\n\nBravo').entries).toEqual([]);
    base.destroy();
  });

  test('excerpts use the same 120-char shape as the overlap flags', () => {
    const long = 'w'.repeat(200);
    const base = mkDoc((f) => f.insert(0, [el('paragraph', long)]));
    const { entries } = report(base, `${long} CHANGED`);
    expect(entries).toHaveLength(1);
    expect(entries[0].excerpt).toBe(`${'w'.repeat(120)}…`);
    base.destroy();
  });
});
