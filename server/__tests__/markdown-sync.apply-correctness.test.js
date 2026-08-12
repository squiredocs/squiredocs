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
  classifyRange,
  computeHunks,
  planPush,
  applyHunks,
  buildChangeReport,
  syntheticClientId,
  sha256,
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

/**
 * Assertion bundle for one converging push: the document matches the pushed
 * file, the receipt-level `converged` says so, no raw syntax leaked, and
 * nothing was skipped.
 *
 * The `skipped` check rides here on purpose (SC-003). It makes every scenario
 * in the corpus a witness that the dead-man switch stays at zero on healthy
 * paths, rather than that being asserted in a handful of places.
 */
function expectConverged(r, label) {
  expect(`${label}: ${r.resultMd}`).toBe(`${label}: ${r.pushedCanon}`);
  expect(r.converged).toBe(true);
  expect(hasRawSyntaxLeak(r.resultMd)).toBe(false);
  expect(`${label} skipped: ${r.ops.skipped}`).toBe(`${label} skipped: 0`);
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

// ===========================================================================
// User Story 1 — edits next to formatting apply exactly as written
// ===========================================================================

const BASE_LINK = `Check the [runbook](${RB}) before deploying.`;
const BASE_BOLD = 'Check the **runbook** before deploying.';

/**
 * repro1 — link and bold shapes (L1–L7, B1–B5). This family already converged
 * on the pre-fix engine (T001 baseline: 0 failures) and is the CONTROL: it
 * pins that recording marks at plan time leaves ordinary editing alone, in
 * particular the left-preference branch typing depends on (FR-003, RBD-056-5).
 */
const REPRO1_SCENARIOS = [
  ['L1 word swap before link', linkedParagraph, BASE_LINK.replace('Check', 'Consult')],
  ['L2 edit link display text', linkedParagraph, BASE_LINK.replace('runbook', 'playbook')],
  ['L3 append char to link text (adjacent to "](")', linkedParagraph, BASE_LINK.replace('runbook]', 'runbooks]')],
  ['L4 edit immediately after closing paren', linkedParagraph, BASE_LINK.replace(' before', ' prior to')],
  ['L5 multi-edit before+after link', linkedParagraph, BASE_LINK.replace('Check', 'Consult').replace('deploying', 'shipping')],
  ['L6 multi-edit incl link text', linkedParagraph, BASE_LINK.replace('Check', 'Consult').replace('runbook]', 'playbook]')],
  ['L7 edit text right before "["', linkedParagraph, BASE_LINK.replace('the [', 'that [')],
  ['B1 word swap before bold', boldParagraph, BASE_BOLD.replace('Check', 'Consult')],
  ['B2 edit bold text', boldParagraph, BASE_BOLD.replace('runbook', 'playbook')],
  ['B3 append char to bold text', boldParagraph, BASE_BOLD.replace('runbook*', 'runbooks*')],
  ['B4 edit after bold', boldParagraph, BASE_BOLD.replace(' before', ' prior to')],
  ['B5 multi-edit before+after bold', boldParagraph, BASE_BOLD.replace('Check', 'Consult').replace('deploying', 'shipping')],
];

/**
 * repro3 P1–P4 — the boundary-insertion table. P1/P2 are the durable field
 * failure: apply probed the character at `at - 1` (the last char of the link
 * text) and dressed the inserted comma in the link's mark, so the re-export
 * moved the comma INSIDE the link and every repair push re-made the same edit
 * forever.
 */
const REPRO3_SCENARIOS = [
  ['P1 comma right after link', linkedParagraph, BASE_LINK.replace(') before', '), before')],
  ['P2 word right after link, no space', linkedParagraph, `Check the [runbook](${RB})s before deploying.`],
  ['P3 comma right after bold', boldParagraph, BASE_BOLD.replace('** before', '**, before')],
  ['P4 word right before link text start', linkedParagraph, `Check the my[runbook](${RB}) before deploying.`],
];

describe('US1 corpus — first-push convergence (FR-013, SC-001)', () => {
  test.each(REPRO1_SCENARIOS)('repro1 %s', (name, mk, pushed) => {
    const { doc, frag } = mk();
    expectConverged(pushOnce(frag, pushed), name);
    doc.destroy();
  });

  test.each(REPRO3_SCENARIOS)('repro3 %s', (name, mk, pushed) => {
    const { doc, frag } = mk();
    expectConverged(pushOnce(frag, pushed), name);
    doc.destroy();
  });

  test('P1 leaves the comma OUTSIDE the link mark in the CRDT, not just in the export', () => {
    const { doc, frag } = linkedParagraph();
    pushOnce(frag, BASE_LINK.replace(') before', '), before'));
    const textNode = frag.toArray()[0].toArray()[0];
    const linked = textNode.toDelta()
      .filter((op) => op.attributes && op.attributes.link)
      .map((op) => op.insert)
      .join('');
    expect(linked).toBe('runbook');
    doc.destroy();
  });
});

// ---------------------------------------------------------------------------
// T004 — the classifier records the resolved run's marks (I1)
// ---------------------------------------------------------------------------

/** Source map + markdown for a built fixture. */
function mapOf(frag, flavor = 'squire') {
  return toMarkdownWithSourceMap(frag.toArray(), { flavor });
}

describe('classifyRange records the resolved run marks (I1, FR-001/002/003)', () => {
  test('inside-run insertion carries that run\'s marks', () => {
    const { doc, frag } = linkedParagraph();
    const { sourceMap } = mapOf(frag);
    // md offset 13 is inside the "runbook" link run [11,18).
    const cls = classifyRange(sourceMap, 13, 13);
    expect(cls.kind).toBe('text');
    expect(cls.segments[0].attrs).toEqual({ link: { href: RB } });
    doc.destroy();
  });

  test('left rule at a styled span\'s END keeps the span (FR-003, order unchanged)', () => {
    const { doc, frag } = linkedParagraph();
    const { sourceMap } = mapOf(frag);
    // md offset 18 is the link run's mdEnd — typing there continues the link.
    const cls = classifyRange(sourceMap, 18, 18);
    expect(cls.kind).toBe('text');
    expect(cls.segments[0].attrs).toEqual({ link: { href: RB } });
    doc.destroy();
  });

  test('left rule at a bold span\'s END keeps the bold', () => {
    const { doc, frag } = boldParagraph();
    const { sourceMap } = mapOf(frag);
    const cls = classifyRange(sourceMap, 19, 19); // the bold run is [12,19)
    expect(cls.kind).toBe('text');
    expect(cls.segments[0].attrs).toEqual({ bold: true });
    doc.destroy();
  });

  test('following rule at a CLOSING-syntax boundary takes the following (plain) run (FR-002)', () => {
    const { doc, frag } = linkedParagraph();
    const { sourceMap } = mapOf(frag);
    // md offset 43 is the first char after ")" — the trailing plain run's start,
    // and no run ends there. This is the comma-after-link case.
    const cls = classifyRange(sourceMap, 43, 43);
    expect(cls.kind).toBe('text');
    expect(cls.segments[0].attrs).toEqual({});
    doc.destroy();
  });

  test('insertion before an OPENING "[" takes the left (plain) run, never the link', () => {
    const { doc, frag } = linkedParagraph();
    const { sourceMap } = mapOf(frag);
    const cls = classifyRange(sourceMap, 10, 10); // "Check the " ends at 10; "[" is at 10
    expect(cls.kind).toBe('text');
    expect(cls.segments[0].attrs).toEqual({});
    doc.destroy();
  });

  test('insertion before an OPENING "**" takes the left (plain) run, never the bold', () => {
    const { doc, frag } = boldParagraph();
    const { sourceMap } = mapOf(frag);
    const cls = classifyRange(sourceMap, 10, 10);
    expect(cls.kind).toBe('text');
    expect(cls.segments[0].attrs).toEqual({});
    doc.destroy();
  });

  /**
   * Adjacent mapped runs with NO syntax between them (two text nodes in one
   * block). The spec's edge-case prose says the left-preference rule resolves
   * this; the frozen resolution order actually resolves it one rule EARLIER —
   * `findRun` matches `mdStart <= o < mdEnd`, so the shared offset is *inside*
   * the following run and rule 1 claims it before rule 2 is consulted.
   *
   * Pinned as-is: RBD-056-5 freezes the order, and for this shape the outcome
   * is unobservable in marks anyway — two runs that serialize adjacently with
   * no delimiter between them carry the same marks, because differing marks
   * are exactly what produces a delimiter. The discrepancy is recorded in
   * clarifications-needed.md as spec prose to correct, not behavior to change.
   */
  test('adjacent mapped runs with no syntax between: the inside rule resolves first', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    let a; let b;
    doc.transact(() => {
      const p = new Y.XmlElement('paragraph');
      a = new Y.XmlText(); a.insert(0, 'abc');
      b = new Y.XmlText(); b.insert(0, 'def');
      p.insert(0, [a, b]);
      frag.insert(0, [p]);
    });
    const { markdown, sourceMap } = mapOf(frag);
    expect(markdown).toBe('abcdef');
    // Offset 3 is BOTH the first run's mdEnd and the second run's mdStart.
    const cls = classifyRange(sourceMap, 3, 3);
    expect(cls.kind).toBe('text');
    expect(cls.segments[0].textNode).toBe(b);
    expect(cls.segments[0].textOff).toBe(0);
    expect(cls.segments[0].attrs).toEqual({});
    // The left rule still owns a boundary the inside rule cannot claim: the
    // very end of the last run, where no following run starts.
    const end = classifyRange(sourceMap, 6, 6);
    expect(end.segments[0].textNode).toBe(b);
    expect(end.segments[0].textOff).toBe(3);
    doc.destroy();
  });

  test('a block that STARTS with a marked run classifies structural, not "following"', () => {
    const { doc, frag } = mkDoc((f) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, ' is the guide.');
      t.insert(0, 'runbook', { link: { href: RB } });
      p.insert(0, [t]);
      f.insert(0, [p]);
    });
    const { markdown, sourceMap } = mapOf(frag);
    expect(markdown.startsWith('[runbook]')).toBe(true);
    // Offset 0 sits on the opening "[" — no run contains it, none ends there.
    expect(classifyRange(sourceMap, 0, 0).kind).toBe('structural');
    doc.destroy();
  });

  test('insertion inside link syntax (the URL) is structural', () => {
    const { doc, frag } = linkedParagraph();
    const { sourceMap } = mapOf(frag);
    expect(classifyRange(sourceMap, 25, 25).kind).toBe('structural');
    doc.destroy();
  });

  test('insertion in an inter-block separator is structural', () => {
    const { doc, frag } = mkDoc((f) => {
      const para = (s) => {
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText(); t.insert(0, s); p.insert(0, [t]);
        return p;
      };
      f.insert(0, [para('aaa'), para('bbb')]);
    });
    const { markdown, sourceMap } = mapOf(frag);
    expect(markdown).toBe('aaa\n\nbbb');
    expect(classifyRange(sourceMap, 4, 4).kind).toBe('structural');
    doc.destroy();
  });

  test('a replacement records the FIRST replaced character\'s run marks', () => {
    const { doc, frag } = linkedParagraph();
    const { sourceMap } = mapOf(frag);
    // Replacing the link display text [11,18) → the link run's marks.
    expect(classifyRange(sourceMap, 11, 18).segments[0].attrs).toEqual({ link: { href: RB } });
    // Replacing "the" inside the leading plain run → plain.
    expect(classifyRange(sourceMap, 6, 9).segments[0].attrs).toEqual({});
    doc.destroy();
  });
});

// ===========================================================================
// User Story 2 — no edit in a pushed file is silently dropped
// ===========================================================================

/**
 * repro2 — mixed structural/text edits in one block (U/D/M/A/C/W/MB). The
 * five that failed pre-fix (U2, U3, U4, D2, MB1) are all the same shape: one
 * hunk lands in link SYNTAX (structural) and another lands in the same
 * block's TEXT, the structural rebuild claims the block, and apply skips the
 * text hunk it can no longer place. That edit was silently dropped.
 */
const REPRO2_SCENARIOS = [
  ['U1 change URL only', linkedParagraph, (b) => b.replace('/rb', '/rb2')],
  ['U2 URL edit + word swap same para', linkedParagraph, (b) => b.replace('Check', 'Consult').replace('/rb', '/rb2')],
  ['U3 URL + display text edit', linkedParagraph, (b) => b.replace('runbook]', 'playbook]').replace('/rb', '/rb2')],
  ['U4 URL edit + bold a word', linkedParagraph, (b) => b.replace('deploying', '**shipping**').replace('/rb', '/rb2')],
  ['D1 unwrap link to plain text', linkedParagraph, (b) => b.replace(`[runbook](${RB})`, 'runbook')],
  ['D2 unwrap link + word swap', linkedParagraph, (b) => b.replace(`[runbook](${RB})`, 'runbook').replace('Check', 'Consult')],
  ['M1 move link within sentence', linkedParagraph, () => `Before deploying, check the [runbook](${RB}).`],
  ['A1 add second link', linkedParagraph, (b) => b.replace('deploying.', 'deploying per the [SOP](https://example.com/sop).')],
  ['C1 edits hugging "[" on both sides', linkedParagraph, (b) => b.replace('the [runbook]', 'thy [Runbook]')],
  ['C2 edits hugging "](" both sides', linkedParagraph, (b) => b.replace('runbook](https', 'runbooks](http0s').replace('http0s', 'https')],
  ['C3 url tail + following text', linkedParagraph, (b) => b.replace('/rb) before', '/rb2) after')],
  ['W1 rewrite around kept link', linkedParagraph, () => `Always read the [runbook](${RB}) first.`],
  ['MB1 URL edit + word swap (multi-block)', multiBlockLinked, (b) => b.replace('Check', 'Consult').replace('/rb', '/rb2')],
  ['MB2 unwrap link + edits in other blocks', multiBlockLinked, (b) => b.replace(`[runbook](${RB})`, 'runbook').replace('Intro', 'Introduction').replace('Outro', 'Closing')],
  ['MB3 move link paragraph + edit it', multiBlockLinked, (b) => b.replace(
    `Check the [runbook](${RB}) before deploying.\n\nOutro text here.`,
    `Outro text here.\n\nCheck the [playbook](${RB}) before deploying.`)],
];

/**
 * repro4 — the link fuzz table. F7 leaked raw `](` into the document as
 * literal text: a lone `[` insertion has no inline-mark syntax by the old
 * test, so it rode the plain-text lane and spliced a bracket into a block
 * whose remaining markdown then no longer parsed as a link.
 */
const REPRO4_SCENARIOS = [
  ['F1 linkify word, same url', (b) => b.replace('deploying', `[deploying](${RB})`)],
  ['F2 linkify word, new url', (b) => b.replace('deploying', '[deploying](https://example.com/dep)')],
  ['F3 move link to other word', (b) => b.replace(`[runbook](${RB})`, 'runbook').replace('deploying', `[deploying](${RB})`)],
  ['F4 url edit + comma after link', (b) => b.replace('/rb)', '/rb2),')],
  ['F5 parenthetical after link', (b) => b.replace(') before', ') (updated) before')],
  ['F6 bracketed note after link', (b) => b.replace(') before', ') [sic] before')],
  ['F7 pull preceding word into link', (b) => b.replace(`the [runbook](${RB})`, `[the runbook](${RB})`)],
  ['F8 push word out of link', (b) => b.replace(`[runbook](${RB}) before`, `[run](${RB})book before`)],
  ['F9 replace link + outside edit', (b) => b.replace(`[runbook](${RB})`, '[handbook](https://example.com/hb)').replace('Check', 'Read')],
  ['F10 comma after link + word swap', (b) => b.replace(') before', '), before').replace('Check', 'Consult')],
];

describe('US2 corpus — first-push convergence and no raw-syntax leaks (FR-013, SC-001/004)', () => {
  test.each(REPRO2_SCENARIOS)('repro2 %s', (name, mk, mutate) => {
    const { doc, frag } = mk();
    const pushed = mutate(toMarkdownNodes(frag.toArray()));
    expectConverged(pushOnce(frag, pushed), name);
    doc.destroy();
  });

  test.each(REPRO4_SCENARIOS)('repro4 %s', (name, mutate) => {
    const { doc, frag } = linkPara('Check the ', 'runbook', RB, ' before deploying.');
    const pushed = mutate(toMarkdownNodes(frag.toArray()));
    expectConverged(pushOnce(frag, pushed), name);
    doc.destroy();
  });
});

// ---------------------------------------------------------------------------
// T009 — planner invariants: lane exclusivity (I2) and brackets (I3)
// ---------------------------------------------------------------------------

/** Plan a hand-built hunk list against a fixture, bypassing the aligner. */
function planOf(frag, hunks, flavor = 'squire') {
  const { markdown, sourceMap } = mapOf(frag, flavor);
  return { markdown, sourceMap, plan: planPush(hunks, sourceMap, markdown) };
}

/** Every block a plan mentions, per lane. */
function lanesOf(plan) {
  return {
    text: plan.textBlocks.map((tb) => tb.block),
    reconcile: plan.reconcileBlocks.map((rb) => rb.block),
    structural: plan.structural.flatMap((h) => h.blocks || []),
  };
}

describe('planPush lane exclusivity — a block\'s hunks travel together (I2, FR-004)', () => {
  test('a structural URL hunk folds the same block\'s text hunk (the U2 shape)', () => {
    const { doc, frag } = linkedParagraph();
    const { markdown, sourceMap } = mapOf(frag);
    const urlEnd = markdown.indexOf('/rb') + 3;
    const plan = planPush([
      { oldStart: 1, oldEnd: 5, newText: 'onsult' },                  // "Check" → "Consult" (text)
      { oldStart: urlEnd, oldEnd: urlEnd, newText: '2' },             // inside the URL (structural)
    ], sourceMap, markdown);
    const lanes = lanesOf(plan);
    const block = sourceMap.blocks[0];
    expect(lanes.text).not.toContain(block);
    expect(lanes.reconcile).not.toContain(block);
    expect(plan.structural).toHaveLength(2);
    expect(plan.structural.every((h) => (h.blocks || []).includes(block))).toBe(true);
    // Folded hunks count as structural work, never as text work (RBD-056-7).
    expect(plan.plannedCounts).toEqual({ textHunks: 0, structuralHunks: 2 });
    doc.destroy();
  });

  test('a MULTI-block structural claim folds every claimed block\'s text group', () => {
    const { doc, frag } = multiBlockLinked();
    const { markdown, sourceMap } = mapOf(frag);
    const p1 = sourceMap.blocks[1];
    const p2 = sourceMap.blocks[2];
    // A range spanning p1's tail, the separator, and p2's head → structural
    // over both blocks; plus one text hunk inside each of them.
    const plan = planPush([
      { oldStart: markdown.indexOf('Intro'), oldEnd: markdown.indexOf('Intro') + 5, newText: 'Start' },
      { oldStart: p1.mdEnd - 1, oldEnd: p2.mdStart + 5, newText: 'MERGED' },
      { oldStart: markdown.indexOf('deploying'), oldEnd: markdown.indexOf('deploying') + 9, newText: 'shipping' },
    ], sourceMap, markdown);
    const lanes = lanesOf(plan);
    expect(lanes.text).toEqual([]);
    expect(lanes.reconcile).toEqual([]);
    expect(plan.structural).toHaveLength(3);
    expect(lanes.structural).toContain(p1);
    expect(lanes.structural).toContain(p2);
    doc.destroy();
  });

  test('a forced (055) hunk does not fold another block\'s group', () => {
    const { doc, frag } = multiBlockLinked();
    const { markdown, sourceMap } = mapOf(frag);
    const p1 = sourceMap.blocks[1];
    const p3 = sourceMap.blocks[3];
    const plan = planPush([
      { oldStart: p1.mdStart, oldEnd: p1.mdEnd, newText: 'A wholly rewritten intro.', forced: true, blocks: [p1] },
      { oldStart: markdown.indexOf('Outro'), oldEnd: markdown.indexOf('Outro') + 5, newText: 'Closing' },
    ], sourceMap, markdown);
    const lanes = lanesOf(plan);
    expect(lanes.text).toEqual([p3]);            // p3's edit is untouched by the forced claim
    expect(plan.structural).toHaveLength(1);
    expect(plan.structural[0].forced).toBe(true);
    doc.destroy();
  });

  test('a forced hunk is never joined by the same block\'s char hunks (FR-016)', () => {
    // Impossible by 055 construction (a block is either aligner-forced or
    // char-diffed). If it ever happened, the forced hunk must still stand
    // alone — apply's replaced-block guard counts the leftover as a skip
    // rather than composing two rebuilds of one block.
    const { doc, frag } = multiBlockLinked();
    const { markdown, sourceMap } = mapOf(frag);
    const p1 = sourceMap.blocks[1];
    const plan = planPush([
      { oldStart: p1.mdStart, oldEnd: p1.mdEnd, newText: 'A wholly rewritten intro.', forced: true, blocks: [p1] },
      { oldStart: markdown.indexOf('Intro'), oldEnd: markdown.indexOf('Intro') + 5, newText: 'Start' },
    ], sourceMap, markdown);
    expect(plan.structural).toHaveLength(1);
    expect(plan.structural[0].forced).toBe(true);
    expect(plan.textBlocks.map((tb) => tb.block)).toEqual([p1]);
    doc.destroy();
  });

  test('an edge-block insertion claims nothing and folds nothing', () => {
    // A whole new paragraph inserted at p3's leading edge inserts AROUND p3,
    // preserving its CRDT identity — so it is emitted with `blocks: []` and
    // must not drag any other block's group into the structural lane.
    const { doc, frag } = multiBlockLinked();
    const { markdown, sourceMap } = mapOf(frag);
    const p1 = sourceMap.blocks[1];
    const p3 = sourceMap.blocks[3];
    const plan = planPush([
      { oldStart: markdown.indexOf('Intro'), oldEnd: markdown.indexOf('Intro') + 5, newText: 'Start' },
      { oldStart: p3.mdStart, oldEnd: p3.mdStart, newText: 'A brand new paragraph.\n\n' },
    ], sourceMap, markdown);
    expect(plan.structural).toHaveLength(1);
    expect(plan.structural[0].blocks).toEqual([]);      // claims nothing
    expect(plan.textBlocks.map((tb) => tb.block)).toEqual([p1]);
    doc.destroy();
  });
});

describe('unbalanced brackets are mark syntax (I3, FR-005/006)', () => {
  test('a lone "[" insertion never rides the plain-text lane', () => {
    const { doc, frag } = linkedParagraph();
    const { markdown, plan } = planOf(frag, [
      { oldStart: 6, oldEnd: 6, newText: '[' },
    ]);
    expect(markdown.startsWith('Check the')).toBe(true);
    expect(plan.textBlocks).toHaveLength(0);
    doc.destroy();
  });

  test('a lone "]" insertion never rides the plain-text lane', () => {
    const { doc, frag } = linkedParagraph();
    const { plan } = planOf(frag, [{ oldStart: 6, oldEnd: 6, newText: ']' }]);
    expect(plan.textBlocks).toHaveLength(0);
    doc.destroy();
  });

  test('a DELETION whose replaced slice holds a bracket never rides the plain lane', () => {
    const { doc, frag } = mkDoc((f) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'A note [sic] in the middle.');
      p.insert(0, [t]);
      f.insert(0, [p]);
    });
    const { markdown, sourceMap } = mapOf(frag);
    expect(markdown).toBe('A note [sic] in the middle.');
    // Delete "[sic] " — the new text is plain, the deleted text is not.
    const at = markdown.indexOf('[sic] ');
    const plan = planPush(
      [{ oldStart: at, oldEnd: at + '[sic] '.length, newText: '' }], sourceMap, markdown);
    expect(plan.textBlocks).toHaveLength(0);
    doc.destroy();
  });

  test('a bracketed note routes through a reparse lane and stays literal text', () => {
    const { doc, frag } = linkPara('Check the ', 'runbook', RB, ' before deploying.');
    const base = toMarkdownNodes(frag.toArray());
    const r = pushOnce(frag, base.replace(') before', ') [sic] before'));
    expectConverged(r, 'bracketed note');
    expect(r.plan.textBlocks).toHaveLength(0);
    // The brackets survive as characters, not as a link.
    const delta = frag.toArray()[0].toArray()[0].toDelta();
    expect(delta.map((op) => op.insert).join('')).toContain('[sic]');
    expect(delta.filter((op) => op.attributes && op.attributes.link).map((op) => op.insert).join('')).toBe('runbook');
    doc.destroy();
  });
});

// ===========================================================================
// User Story 3 — receipts report what happened, not what was planned
// ===========================================================================

/** Apply a hand-built plan inside a transaction and return the apply result. */
function applyPlan(frag, plan, sourceMap, baselineMd, flavor = 'squire') {
  let ops;
  frag.doc.transact(() => { ops = applyHunks(frag, plan, sourceMap, baselineMd, { flavor }); });
  return ops;
}

/** An empty plan shell a test can fill one lane of. */
function emptyPlan(over = {}) {
  return {
    textBlocks: [], reconcileBlocks: [], structural: [],
    counts: { textHunks: 0, structuralHunks: 0 },
    ...over,
  };
}

/** Every outcome across every lane. */
function allOutcomes(ops) {
  return [
    ...ops.outcomes.reconciled,
    ...ops.outcomes.textBlocks,
    ...ops.outcomes.replacements,
    ...ops.outcomes.insertions,
  ];
}

describe('applyHunks returns an apply result (I4, FR-007)', () => {
  test('a healthy text-lane push counts the work it did, and skips nothing', () => {
    const { doc, frag } = linkedParagraph();
    const r = pushOnce(frag, BASE_LINK.replace('Check', 'Consult').replace('deploying', 'shipping'));
    expect(r.ops.skipped).toBe(0);
    expect(r.ops.textHunks).toBe(2);
    expect(r.ops.structuralHunks).toBe(0);
    expect(allOutcomes(r.ops).every((o) => o.applied)).toBe(true);
    doc.destroy();
  });

  test('a RECONCILE-lane push counts its hunks as textHunks (054 meaning, FR-011)', () => {
    const { doc, frag } = mkDoc((f) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText(); t.insert(0, 'Check the runbook before deploying.'); p.insert(0, [t]);
      f.insert(0, [p]);
    });
    const r = pushOnce(frag, 'Check the runbook before **shipping**.');
    expectConverged(r, 'reconcile lane');
    expect(r.plan.reconcileBlocks).toHaveLength(1);
    expect(r.plan.textBlocks).toHaveLength(0);
    // The reconcile entry carries the group's hunk count through to apply.
    const planned = r.plan.reconcileBlocks[0].hunkCount;
    expect(planned).toBeGreaterThan(0);
    expect(r.ops.textHunks).toBe(planned);
    expect(r.ops.structuralHunks).toBe(0);
    expect(r.ops.skipped).toBe(0);
    expect(r.blocksChanged).toEqual([expect.objectContaining({ op: 'reconcile' })]);
    doc.destroy();
  });

  test('an UNRESOLVABLE block node is a counted skip, and leaves the report', () => {
    const { doc, frag } = multiBlockLinked();
    const { markdown, sourceMap } = mapOf(frag);
    const p1 = sourceMap.blocks[1];
    const p3 = sourceMap.blocks[3];
    // One structural group over p1, one ordinary text group over p3.
    const plan = planPush([
      { oldStart: p1.mdStart, oldEnd: p1.mdEnd, newText: '## Promoted to a heading' },
      { oldStart: markdown.indexOf('Outro'), oldEnd: markdown.indexOf('Outro') + 5, newText: 'Closing' },
    ], sourceMap, markdown);
    expect(plan.structural.length).toBeGreaterThan(0);
    expect(plan.textBlocks).toHaveLength(1);
    // Doctor the document: detach ONLY p1, so its group cannot resolve while
    // every other lane still can.
    doc.transact(() => { frag.delete(1, 1); });

    const ops = applyPlan(frag, plan, sourceMap, markdown);
    expect(ops.skipped).toBeGreaterThan(0);
    expect(ops.outcomes.replacements.every((o) => o.applied === false)).toBe(true);
    expect(ops.outcomes.textBlocks).toEqual([{ blockNode: p3.blockNode, applied: true }]);
    expect(ops.textHunks).toBe(1);
    expect(ops.structuralHunks).toBe(0);

    const report = buildChangeReport(plan, sourceMap, markdown, ops.outcomes);
    expect(report.map((e) => e.op)).toEqual(['text']);
    expect(report.some((e) => e.blockIndex === p1.blockIndex)).toBe(false);
    // Without outcomes the report is still the plan view (the DB-free harness
    // and the committed repro seeds call it with three arguments).
    expect(buildChangeReport(plan, sourceMap, markdown).length).toBeGreaterThan(report.length);
    doc.destroy();
  });

  test('an insertion whose markdown parses to zero nodes is a counted skip', () => {
    const { doc, frag } = multiBlockLinked();
    const { markdown, sourceMap } = mapOf(frag);
    const p1 = sourceMap.blocks[1];
    const plan = emptyPlan({
      structural: [{ oldStart: p1.mdEnd, oldEnd: p1.mdEnd, newText: '   \n\n', blocks: [] }],
    });
    const before = toMarkdownNodes(frag.toArray());
    const ops = applyPlan(frag, plan, sourceMap, markdown);
    expect(ops.skipped).toBe(1);
    expect(ops.structuralHunks).toBe(0);
    expect(ops.outcomes.insertions).toEqual([{ afterBlock: p1, applied: false }]);
    expect(toMarkdownNodes(frag.toArray())).toBe(before);
    expect(buildChangeReport(plan, sourceMap, markdown, ops.outcomes)).toEqual([]);
    doc.destroy();
  });

  test('a REPLACEMENT rebuilding to zero nodes is a deletion, not a skip', () => {
    const { doc, frag } = multiBlockLinked();
    const { markdown, sourceMap } = mapOf(frag);
    const p1 = sourceMap.blocks[1];
    const plan = emptyPlan({
      structural: [{ oldStart: p1.mdStart, oldEnd: p1.mdEnd, newText: '', blocks: [p1] }],
    });
    const ops = applyPlan(frag, plan, sourceMap, markdown);
    expect(ops.skipped).toBe(0);
    expect(ops.structuralHunks).toBe(1);
    expect(ops.outcomes.replacements).toEqual([{ first: 1, last: 1, applied: true }]);
    expect(toMarkdownNodes(frag.toArray())).not.toContain('Intro paragraph');
    doc.destroy();
  });

  test('a FOLDED block reports once as structural, with its hunks in structuralHunks', () => {
    const { doc, frag } = linkedParagraph();
    const r = pushOnce(frag, BASE_LINK.replace('Check', 'Consult').replace('/rb', '/rb2'));
    expectConverged(r, 'U2 folded');
    expect(r.ops.textHunks).toBe(0);
    expect(r.ops.structuralHunks).toBe(2);
    expect(r.ops.skipped).toBe(0);
    expect(r.blocksChanged).toEqual([expect.objectContaining({ op: 'structural', blockIndex: 0 })]);
    doc.destroy();
  });
});

// ---------------------------------------------------------------------------
// applySyncPush-shaped emulation (repro3's `emulateSyncPush`): the fork, the
// pinned synthetic clientID, the already-applied probe, and the receipt
// assembly — without a database. This is where the noop branches are driven.
// ---------------------------------------------------------------------------

const ZERO_OPS = { textHunks: 0, structuralHunks: 0, skipped: 0 };

function emulateSyncPush(liveDoc, baselineUpdate, body, opts = {}) {
  const { docGuid = 'doc-g', baselineClock = 7, flavor = 'squire', doctorPlan = null } = opts;
  const fork = new Y.Doc();
  Y.applyUpdate(fork, baselineUpdate);
  const fragment = fork.get('default', Y.XmlFragment);
  const baselineSV = Y.encodeStateVector(fork);
  const { markdown: canonicalMd, sourceMap } = toMarkdownWithSourceMap(fragment.toArray(), { flavor });
  const { markdown: pushedMd, blocks: pushedBlocks } = canonicalizePushedWithBlocks(body, { flavor });

  // Branch 1: canonical-equal noop — nothing to apply, converged by definition.
  if (pushedMd === canonicalMd) {
    fork.destroy();
    return { noop: true, reason: 'canonical-equal', converged: true, operations: { ...ZERO_OPS }, blocksChanged: [] };
  }

  fork.clientID = syntheticClientId(docGuid, baselineClock, sha256(pushedMd));
  const hunks = computeHunks(canonicalMd, pushedMd, sourceMap.blocks, pushedBlocks);
  let plan = planPush(hunks, sourceMap, canonicalMd);
  if (doctorPlan) plan = doctorPlan(plan);
  let ops;
  fork.transact(() => { ops = applyHunks(fragment, plan, sourceMap, canonicalMd, { flavor }); });
  const converged = toMarkdownNodes(fragment.toArray(), { flavor }) === pushedMd;
  const operations = { textHunks: ops.textHunks, structuralHunks: ops.structuralHunks, skipped: ops.skipped };
  const blocksChanged = buildChangeReport(plan, sourceMap, canonicalMd, ops.outcomes);
  const pushUpdate = Y.encodeStateAsUpdate(fork, baselineSV);
  fork.destroy();

  // The idempotency probe: does this update add anything the live doc lacks?
  const probe = new Y.Doc({ gc: false });
  Y.applyUpdate(probe, Y.encodeStateAsUpdate(liveDoc));
  const before = Y.snapshot(probe);
  Y.applyUpdate(probe, pushUpdate);
  const after = Y.snapshot(probe);
  const already = Y.equalSnapshots(before, after);
  probe.destroy();

  // Branch 2: already-applied noop — zero counts, and the honest `converged`.
  if (already) {
    return { noop: true, reason: 'already-applied', converged, operations: { ...ZERO_OPS }, blocksChanged: [] };
  }
  Y.applyUpdate(liveDoc, pushUpdate);
  return { noop: false, converged, operations, blocksChanged };
}

// ===========================================================================
// User Story 4 — a repair push always works
// ===========================================================================

describe('repair convergence from any reachable state (FR-014, SC-002)', () => {
  const everyScenario = [
    ...REPRO1_SCENARIOS.map(([n, mk, pushed]) => [n, mk, () => pushed]),
    ...REPRO3_SCENARIOS.map(([n, mk, pushed]) => [n, mk, () => pushed]),
    ...REPRO2_SCENARIOS,
    ...REPRO4_SCENARIOS.map(([n, mutate]) => [
      n, () => linkPara('Check the ', 'runbook', RB, ' before deploying.'), mutate,
    ]),
  ];

  test.each(everyScenario)('%s: a second push against a fresh re-export converges', (name, mk, mutate) => {
    const { doc, frag } = mk();
    const pushed = mutate(toMarkdownNodes(frag.toArray()));
    pushOnce(frag, pushed);
    // pushOnce re-derives the baseline from the document every time, so this
    // IS "re-export, then push the desired content once".
    const repair = repairPush(frag, pushed);
    expectConverged(repair, `${name} repair`);
    expect(repair.ops.skipped).toBe(0);
    doc.destroy();
  });

  test('a doc corrupted the pre-056 way (comma INSIDE the link) repairs in one push', () => {
    // Exactly what the old engine left behind for repro3 P1, and what no
    // number of repair pushes could undo.
    const { doc, frag } = mkDoc((f) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, ' before deploying.');
      t.insert(0, 'runbook,', { link: { href: RB } });
      t.insert(0, 'Check the ');
      p.insert(0, [t]);
      f.insert(0, [p]);
    });
    expect(toMarkdownNodes(frag.toArray())).toBe(`Check the [runbook,](${RB}) before deploying.`);
    const desired = `Check the [runbook](${RB}), before deploying.`;
    expectConverged(repairPush(frag, desired), 'comma-inside-link repair');
    doc.destroy();
  });

  test('a doc holding repro2-U2\'s partial apply repairs in one push', () => {
    // URL changed, word swap dropped — the shape the fold-together rule ends.
    const { doc, frag } = mkDoc((f) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, ' before deploying.');
      t.insert(0, 'runbook', { link: { href: 'https://example.com/rb2' } });
      t.insert(0, 'Check the ');
      p.insert(0, [t]);
      f.insert(0, [p]);
    });
    const desired = 'Consult the [runbook](https://example.com/rb2) before deploying.';
    expectConverged(repairPush(frag, desired), 'U2 partial-apply repair');
    doc.destroy();
  });
});

describe('no-progress pushes are impossible to misread (FR-014, FR-017)', () => {
  test('a push that applies nothing reports noop with converged:false', () => {
    // The backstop branch the route cannot reach once the engine is correct
    // (analysis finding U1): a plan doctored to apply nothing produces an
    // update the live document already subsumes, so the idempotency
    // short-circuit fires — and `noop: true` alone would call that success.
    const { doc, frag } = linkedParagraph();
    const baselineUpdate = Y.encodeStateAsUpdate(doc);
    const desired = `Check the [runbook](${RB}), before deploying.`;

    const r = emulateSyncPush(doc, baselineUpdate, desired, {
      doctorPlan: () => ({ textBlocks: [], reconcileBlocks: [], structural: [], counts: { textHunks: 0, structuralHunks: 0 } }),
    });

    expect(r.noop).toBe(true);
    expect(r.reason).toBe('already-applied');
    expect(r.converged).toBe(false);          // the alarm
    expect(r.operations).toEqual(ZERO_OPS);   // zero effect, honestly reported
    expect(r.blocksChanged).toEqual([]);
    expect(toMarkdownNodes(frag.toArray())).not.toBe(desired);
    doc.destroy();
  });

  test('repro3 S1: the repair loop now converges, and the second push says so', () => {
    const { doc, frag } = linkedParagraph();
    const baselineUpdate = Y.encodeStateAsUpdate(doc);
    const desired = 'Consult the [runbook](https://example.com/rb2) before deploying.';

    const first = emulateSyncPush(doc, baselineUpdate, desired);
    expect(first.noop).toBe(false);
    expect(first.converged).toBe(true);
    expect(first.operations.skipped).toBe(0);
    expect(toMarkdownNodes(frag.toArray())).toBe(desired);

    // The agent re-runs the same file against the same stale baseline. It is
    // still a noop — but now a noop that certifies the document matches.
    const second = emulateSyncPush(doc, baselineUpdate, desired);
    expect(second).toMatchObject({ noop: true, reason: 'already-applied', converged: true });
    doc.destroy();
  });

  test.each(['squire', 'portable'])('round-trip import(export(doc)) is a converged noop — %s flavor', (flavor) => {
    const { doc, frag } = multiBlockLinked();
    const baselineUpdate = Y.encodeStateAsUpdate(doc);
    const exported = toMarkdownNodes(frag.toArray(), { flavor });
    const r = emulateSyncPush(doc, baselineUpdate, exported, { flavor });
    expect(r).toMatchObject({ noop: true, reason: 'canonical-equal', converged: true });
    expect(r.operations).toEqual(ZERO_OPS);
    expect(r.blocksChanged).toEqual([]);
    doc.destroy();
  });
});
