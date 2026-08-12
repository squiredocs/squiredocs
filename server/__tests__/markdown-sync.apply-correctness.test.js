/**
 * Sync apply correctness + honest receipts — the committed regression corpus
 * (feature 056, FR-013/014/015; contracts/apply-invariants.md I1–I7).
 *
 * This suite is the DURABLE form of the four repro seeds committed under
 * `specs/056-sync-apply-correctness/repro/`. The seeds stay checked in
 * unchanged as the executable record of the investigation; the scenario tables
 * below re-encode them as assertions that run in CI. DB-free and
 * parallel-safe (Constitution II) — everything happens in an in-memory Y.Doc.
 *
 * ===========================================================================
 * T001 — RED BASELINE, recorded against the pinned pre-fix engine
 * ===========================================================================
 * Measured on branch point 1458fdeb (verified: no commit touches
 * `server/markdown-sync.js` between the seed commit 416824a8 and 1458fdeb, so
 * these counts are the engine state the seeds were authored against).
 *
 *   repro1 — 0 failing scenarios (L1–L7, B1–B5 all PASS).
 *     This family does NOT reproduce a defect and never did at the pinned
 *     engine: it is the CONTROL. Its value is as a pin on the load-bearing
 *     left-preference insertion branch (FR-003, RBD-056-5) — ordinary link and
 *     bold edits must keep converging after the mark-inheritance change.
 *     `quickstart.md` §1 claims "failing scenarios in every family"; that prose
 *     overstates repro1 and is recorded in `clarifications-needed.md`.
 *
 *   repro2 — 5 push1 FAILs of 15 scenarios: U2, U3, U4, D2, MB1.
 *     Bug B (fold-together): each has one structural hunk plus a text-lane
 *     hunk in the SAME block; the structural rebuild claims the block, apply
 *     skips the text hunk, and that edit is silently dropped.
 *
 *   repro3 — 2 STUCK (P1 comma after link, P2 word after link); P3 wrong on
 *     push1 but converges on push2; P4 converges on push1; S1 REPRODUCED
 *     ("repair sync reports noop/success while doc still != pushed file").
 *     Bug A (mark inheritance) + the receipt lie.
 *
 *   repro4 — 3 non-converging cases: F7 (with a RAW LINK SYNTAX LEAK), F8, F10.
 *     Additionally F3 converged only after 3 pushes and F9 after 2 (push1
 *     misapplied in both). Bug C (unbalanced brackets on the plain-text lane).
 *
 * Post-fix, every family must print zero failures / zero STUCK / zero leaks.
 * ===========================================================================
 */
const Y = require('yjs');
const { toMarkdownNodes, toMarkdownWithSourceMap } = require('../mcp/yjs/serialization');
const {
  canonicalizePushedWithBlocks,
  computeHunks,
  planPush,
  applyHunks,
  buildChangeReport,
} = require('../markdown-sync');

// ---------------------------------------------------------------------------
// Replay harness — the repro seeds' `pushOnce` shape (research R7), which is
// also the shape `applySyncPush` runs between its baseline fork and its store.
// ---------------------------------------------------------------------------

/**
 * One sync push against the fragment's CURRENT state.
 *
 * The baseline is re-derived from the fragment on every call, which is exactly
 * what a client does when it re-exports before pushing — so calling this twice
 * in a row IS the repair-push shape (FR-014), not a replay of a stale plan.
 */
function pushOnce(frag, pushedMd, flavor = 'squire') {
  const nodes = frag.toArray();
  const { markdown: baselineMd, sourceMap } = toMarkdownWithSourceMap(nodes, { flavor });
  const { markdown: pushedCanon, blocks: pushedBlocks } = canonicalizePushedWithBlocks(pushedMd, { flavor });
  const hunks = computeHunks(baselineMd, pushedCanon, sourceMap.blocks, pushedBlocks);
  const plan = planPush(hunks, sourceMap, baselineMd);
  let ops;
  frag.doc.transact(() => { ops = applyHunks(frag, plan, sourceMap, baselineMd, { flavor }); });
  // Built AFTER apply and filtered by outcomes, mirroring `applySyncPush`
  // post-056 (research R4). Report inputs are baseline-side and immutable.
  const blocksChanged = buildChangeReport(plan, sourceMap, baselineMd, ops.outcomes);
  return {
    baselineMd,
    pushedCanon,
    hunks,
    plan,
    ops,
    blocksChanged,
    resultMd: toMarkdownNodes(frag.toArray(), { flavor }),
    // The receipt-level honesty field, computed the way `applySyncPush` does
    // (research R5): the post-apply serialization vs the pushed canonical form.
    converged: toMarkdownNodes(frag.toArray(), { flavor }) === pushedCanon,
  };
}

/**
 * A repair push: re-export the document as a fresh baseline and push the
 * desired markdown once. Returns the push result (FR-014 asserts `.converged`).
 */
function repairPush(frag, desiredMd, flavor = 'squire') {
  return pushOnce(frag, desiredMd, flavor);
}

// ---------------------------------------------------------------------------
// Document builders (the seeds' fixtures)
// ---------------------------------------------------------------------------

const RB = 'https://example.com/rb';

function mkDoc(builder) {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  doc.transact(() => builder(frag));
  return { doc, frag };
}

/** `Check the [runbook](RB) before deploying.` — one paragraph, one link run. */
function linkedParagraph(tail = ' before deploying.') {
  return mkDoc((frag) => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, tail);
    t.insert(0, 'runbook', { link: { href: RB } });
    t.insert(0, 'Check the ');
    p.insert(0, [t]);
    frag.insert(0, [p]);
  });
}

/** `Check the **runbook** before deploying.` */
function boldParagraph() {
  return mkDoc((frag) => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, ' before deploying.');
    t.insert(0, 'runbook', { bold: true });
    t.insert(0, 'Check the ');
    p.insert(0, [t]);
    frag.insert(0, [p]);
  });
}

/** Heading + plain para + the link para + outro para. */
function multiBlockLinked() {
  return mkDoc((frag) => {
    const h = new Y.XmlElement('heading');
    h.setAttribute('level', '2');
    const ht = new Y.XmlText(); ht.insert(0, 'Deploy guide'); h.insert(0, [ht]);
    const p1 = new Y.XmlElement('paragraph');
    const t1 = new Y.XmlText(); t1.insert(0, 'Intro paragraph with plain text.'); p1.insert(0, [t1]);
    const p2 = new Y.XmlElement('paragraph');
    const t2 = new Y.XmlText();
    t2.insert(0, ' before deploying.');
    t2.insert(0, 'runbook', { link: { href: RB } });
    t2.insert(0, 'Check the ');
    p2.insert(0, [t2]);
    const p3 = new Y.XmlElement('paragraph');
    const t3 = new Y.XmlText(); t3.insert(0, 'Outro text here.'); p3.insert(0, [t3]);
    frag.insert(0, [h, p1, p2, p3]);
  });
}

/** Parameterized single-paragraph link fixture (repro4's `linkPara`). */
function linkPara(pre, linkText, url, post) {
  return mkDoc((frag) => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, post);
    t.insert(0, linkText, { link: { href: url } });
    t.insert(0, pre);
    p.insert(0, [t]);
    frag.insert(0, [p]);
  });
}

// ---------------------------------------------------------------------------
// Raw-syntax leak matcher (repro4, SC-004/FR-006)
// ---------------------------------------------------------------------------

/**
 * True when markdown carries raw link syntax as literal text: strip every
 * well-formed `[text](url)` first, then look for what is left over — an
 * escaped bracket the serializer emitted because a literal `[` survived, or a
 * bare `](` the engine spliced in.
 */
function hasRawSyntaxLeak(md) {
  return /\\\[|\\\]|\]\(/.test(md.replace(/\[[^\]]*\]\([^)]*\)/g, ''));
}

/** Jest-friendly assertion bundle for one converging push. */
function expectConverged(r, label) {
  expect(`${label}: ${r.resultMd}`).toBe(`${label}: ${r.pushedCanon}`);
  expect(r.converged).toBe(true);
  expect(hasRawSyntaxLeak(r.resultMd)).toBe(false);
}

// ---------------------------------------------------------------------------
describe('056 harness self-check', () => {
  test('pushOnce round-trips an untouched document as a no-change push', () => {
    const { doc, frag } = linkedParagraph();
    const base = toMarkdownNodes(frag.toArray());
    const r = pushOnce(frag, base);
    expect(r.hunks).toHaveLength(0);
    expect(r.resultMd).toBe(base);
    expect(r.converged).toBe(true);
    doc.destroy();
  });

  test('leak matcher flags raw syntax but not well-formed links', () => {
    expect(hasRawSyntaxLeak(`Check the [runbook](${RB}) before deploying.`)).toBe(false);
    expect(hasRawSyntaxLeak('Check the runbook]([https://x](https://x)) here.')).toBe(true);
    expect(hasRawSyntaxLeak('A literal \\[sic\\] bracket.')).toBe(true);
  });

  test('builders produce the fixtures the corpus is written against', () => {
    const a = linkedParagraph();
    expect(toMarkdownNodes(a.frag.toArray())).toBe(`Check the [runbook](${RB}) before deploying.`);
    a.doc.destroy();
    const b = boldParagraph();
    expect(toMarkdownNodes(b.frag.toArray())).toBe('Check the **runbook** before deploying.');
    b.doc.destroy();
    const c = multiBlockLinked();
    expect(toMarkdownNodes(c.frag.toArray())).toBe(
      `## Deploy guide\n\nIntro paragraph with plain text.\n\nCheck the [runbook](${RB}) before deploying.\n\nOutro text here.`
    );
    c.doc.destroy();
    const d = linkPara('Check the ', 'runbook', RB, ' before deploying.');
    expect(toMarkdownNodes(d.frag.toArray())).toBe(`Check the [runbook](${RB}) before deploying.`);
    d.doc.destroy();
  });
});
