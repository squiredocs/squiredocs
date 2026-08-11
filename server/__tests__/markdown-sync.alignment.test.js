/**
 * Block-alignment pre-pass (feature 055) — the pure planner suite.
 *
 * Everything here runs on plain strings and detached Yjs nodes: no database, no
 * Redis, no live document. The pre-pass is a pure function of (baseline blocks,
 * pushed blocks), and that is exactly what makes its central promise testable
 * as an invariant rather than as a collection of happy paths — FR-002: no
 * character edit ever spans two baseline blocks or mixes two pushed blocks.
 *
 * `assertNoCrossBlockSplice` below is that invariant, asserted against whole
 * plans; the scenario tests each build a plan and hand it over. A scenario that
 * "passes" while splicing across a block boundary is not a passing scenario.
 */
const Y = require('yjs');
const { toMarkdownWithSourceMap } = require('../mcp/yjs/serialization');
const {
  blockSimilarity,
  alignBlocks,
  computeHunks,
  planPush,
  applyHunks,
  canonicalizePushed,
  canonicalizePushedWithBlocks,
  SIMILARITY_THRESHOLD,
  MAX_GAP_DP_CELLS,
} = require('../markdown-sync');

// ---- fixtures --------------------------------------------------------------
// Same builder style as markdown-sync.convergence.test.js, so a doc shape can
// move between the two suites unchanged.

function el(tag, text, attrs) {
  const e = new Y.XmlElement(tag);
  if (text !== undefined) {
    const t = new Y.XmlText();
    t.insert(0, text, attrs);
    e.insert(0, [t]);
  }
  return e;
}
function heading(level, text) {
  const h = el('heading', text);
  h.setAttribute('level', String(level));
  return h;
}
function listOf(items) {
  const list = new Y.XmlElement('bulletList');
  list.insert(0, items.map((txt) => {
    const li = new Y.XmlElement('listItem');
    li.insert(0, [el('paragraph', txt)]);
    return li;
  }));
  return list;
}
function codeBlock(text) {
  const c = new Y.XmlElement('codeBlock');
  const t = new Y.XmlText();
  t.insert(0, text);
  c.insert(0, [t]);
  return c;
}

/** A baseline document from a list of block nodes → { doc, frag, markdown, sourceMap }. */
function baseline(blocks) {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  doc.transact(() => frag.insert(0, blocks));
  const { markdown, sourceMap } = toMarkdownWithSourceMap(frag.toArray());
  return { doc, frag, markdown, sourceMap };
}

/** Plan a pushed BODY against a baseline built from `blocks`. */
function planFor(blocks, pushedBody) {
  const { doc, markdown, sourceMap } = baseline(blocks);
  const pushed = canonicalizePushedWithBlocks(pushedBody);
  const hunks = computeHunks(markdown, pushed.markdown, sourceMap.blocks, pushed.blocks);
  const plan = planPush(hunks, sourceMap, markdown);
  doc.destroy();
  return { plan, hunks, baselineMd: markdown, sourceMap, pushedMd: pushed.markdown };
}

/** Block strings of a source map / canonical string pair. */
function blockStrings(md, blocks) {
  return blocks.map((b) => md.slice(b.mdStart, b.mdEnd));
}

/** Plan a push and APPLY it to the baseline fragment → resulting canonical markdown. */
function replay(blocks, pushedBody) {
  const { doc, frag, markdown, sourceMap } = baseline(blocks);
  const pushed = canonicalizePushedWithBlocks(pushedBody);
  const hunks = computeHunks(markdown, pushed.markdown, sourceMap.blocks, pushed.blocks);
  const plan = planPush(hunks, sourceMap, markdown);
  const survivors = new Set(sourceMap.blocks.map((b) => b.blockNode));
  doc.transact(() => applyHunks(frag, plan, sourceMap, markdown));
  const resultMd = toMarkdownWithSourceMap(frag.toArray()).markdown;
  const kept = frag.toArray().filter((n) => survivors.has(n)).length;
  doc.destroy();
  return { plan, resultMd, pushedMd: pushed.markdown, keptNodes: kept, baseBlocks: sourceMap.blocks };
}

/**
 * Two same-length, sub-16KB strings whose character diff cannot finish within
 * MAX_EDIT_LENGTH. Built once: a genuine cap trip costs seconds by definition
 * (the diff has to do the work before it can give up), and two tests need one.
 */
let capPair = null;
function capTrippingPair() {
  if (!capPair) capPair = ['a'.repeat(5100), 'b'.repeat(5100)];
  return capPair;
}

/**
 * The FR-002 invariant (contract I1/I2), asserted over a whole plan.
 *
 * (a) Every character-level entry — text hunks, reconciliations, and any hunk
 *     the classifier itself routed to structural — stays inside ONE baseline
 *     block's extent.
 * (b) Every FORCED entry (the aligner's own whole-block ops) covers whole block
 *     extents exactly, or is a zero-width insertion at a block boundary.
 *
 * The two clauses are separate on purpose. A forced op is extent-aligned by
 * construction; a classifier-derived structural entry (a heading level change,
 * say) is a character range that merely touches syntax, so demanding extent
 * alignment of it would assert something 055 never claimed — and would pass
 * only by accident.
 */
function assertNoCrossBlockSplice(plan, baseBlocks) {
  const within = (start, end) => baseBlocks.some((b) => start >= b.mdStart && end <= b.mdEnd);
  const boundary = (pos) => pos === 0 || baseBlocks.some((b) => b.mdEnd === pos || b.mdStart === pos);

  for (const tb of plan.textBlocks) {
    for (const h of tb.hunks) {
      expect(within(h.oldStart, h.oldEnd)).toBe(true);
      // Segments are per-run slices of ONE block's text nodes.
      for (const seg of h.segments) expect(within(seg.mdStart, seg.mdEnd)).toBe(true);
    }
  }
  for (const rb of plan.reconcileBlocks) {
    expect(baseBlocks).toContain(rb.block);
  }
  for (const h of plan.structural) {
    if (h.forced) {
      if (h.blocks.length === 0) {
        expect(h.oldStart).toBe(h.oldEnd);
        expect(boundary(h.oldStart)).toBe(true);
      } else {
        expect(h.oldStart).toBe(h.blocks[0].mdStart);
        expect(h.oldEnd).toBe(h.blocks[h.blocks.length - 1].mdEnd);
      }
    } else {
      expect(within(h.oldStart, h.oldEnd) || (h.oldStart === h.oldEnd && boundary(h.oldStart))).toBe(true);
    }
  }
}

// ---------------------------------------------------------------------------
describe('pushed block extents (T004, research R1)', () => {
  test('extents tile the canonical string and agree with it byte for byte', () => {
    const body = '# Title\n\nFirst paragraph.\n\n- one\n- two\n\nLast paragraph.';
    const { markdown, blocks } = canonicalizePushedWithBlocks(body);
    expect(blocks.length).toBe(4);
    let cursor = 0;
    for (const b of blocks) {
      // Only the block separator may sit between two blocks.
      expect(markdown.slice(cursor, b.mdStart)).toMatch(/^\n*$/);
      expect(b.mdEnd).toBeGreaterThan(b.mdStart);
      cursor = b.mdEnd;
    }
    expect(cursor).toBe(markdown.length);
    expect(blockStrings(markdown, blocks)[0]).toBe('# Title');
  });

  test('byte-identical to canonicalizePushed for every shape', () => {
    const bodies = [
      '# Title\n\ntext',
      '- a\n- b\n\n> quote\n\n| a | b |\n| --- | --- |\n| 1 | 2 |',
      '```js\nconst a = 1;\n\nconst b = 2;\n```',
      'plain **bold** and _italic_ and [link](https://example.com)',
      '',
    ];
    for (const body of bodies) {
      expect(canonicalizePushedWithBlocks(body).markdown).toBe(canonicalizePushed(body));
    }
  });

  test('a code fence containing a blank line stays ONE block', () => {
    // The reason extents come from the serializer rather than a `\n\n` splitter:
    // this is the one construct whose canonical form contains a blank line.
    const { markdown, blocks } = canonicalizePushedWithBlocks('```js\nconst a = 1;\n\nconst b = 2;\n```');
    expect(markdown).toContain('\n\n');
    expect(blocks).toHaveLength(1);
    expect(markdown.slice(blocks[0].mdStart, blocks[0].mdEnd)).toBe(markdown);
  });

  test('empty pushed content yields an empty block list', () => {
    expect(canonicalizePushedWithBlocks('')).toEqual({ markdown: '', blocks: [] });
    expect(canonicalizePushedWithBlocks('   \n\n  ')).toEqual({ markdown: '', blocks: [] });
  });
});

// ---------------------------------------------------------------------------
describe('blockSimilarity (T005, research R3)', () => {
  test('identical strings score 1; the metric is symmetric and deterministic', () => {
    expect(blockSimilarity('hello world', 'hello world')).toBe(1);
    const a = 'The quick brown fox jumps over the lazy dog';
    const b = 'The quick brown cat jumps over the lazy dog';
    expect(blockSimilarity(a, b)).toBe(blockSimilarity(b, a));
    expect(blockSimilarity(a, b)).toBe(blockSimilarity(a, b));
  });

  test('exact Dice values on hand-computed pairs', () => {
    // "abcdef" vs "abcXef": common = a,b,c,e,f = 5 → 2*5/12
    expect(blockSimilarity('abcdef', 'abcXef')).toBeCloseTo(10 / 12, 10);
    // "abc" vs "abcdef": common = 3 → 2*3/9
    expect(blockSimilarity('abc', 'abcdef')).toBeCloseTo(6 / 9, 10);
  });

  test('an oversized side scores 0 without diffing (ladder step 2)', () => {
    const big = 'x'.repeat(16 * 1024 + 1);
    expect(blockSimilarity(big, `${big}!`)).toBe(0);
    expect(blockSimilarity(`${big}!`, big)).toBe(0);
    // one byte under the cap on both sides, and it scores normally again
    const ok = 'x'.repeat(16 * 1024);
    expect(blockSimilarity(ok, ok.slice(0, ok.length - 1))).toBeGreaterThan(0.9);
  });

  test('length-bound skip: too different in size to reach the threshold (step 3)', () => {
    const short = 'abc';
    const long = 'abc'.repeat(100);
    // 2*3/(3+300) is far under 0.5, so the ladder answers 0 without a diff.
    expect(blockSimilarity(short, long)).toBe(0);
  });

  test('a diff-cap trip scores 0 (step 4, RBD-055-6)', () => {
    const [a, b] = capTrippingPair();
    expect(a.length).toBe(b.length); // the length bound cannot short-circuit
    expect(2 * Math.min(a.length, b.length) / (a.length + b.length)).toBeGreaterThan(SIMILARITY_THRESHOLD);
    expect(a.length).toBeLessThan(16 * 1024); // nor can the input cap
    expect(blockSimilarity(a, b)).toBe(0);
  });

  test('metric determinism across repeated calls (FR-011)', () => {
    const pairs = [
      ['# Deployment', '# Rollout'],
      ['a paragraph about kittens', 'a paragraph about puppies'],
      ['', 'something'],
    ];
    for (const [a, b] of pairs) {
      const first = blockSimilarity(a, b);
      for (let i = 0; i < 5; i++) expect(blockSimilarity(a, b)).toBe(first);
    }
  });
});

// ---------------------------------------------------------------------------
describe('alignBlocks (T006/T007, research R2/R4)', () => {
  test('identical sequences are all anchors — no pairs, no residual runs', () => {
    const blocks = ['# A', 'body one', 'body two'];
    const al = alignBlocks(blocks, blocks.slice());
    expect(al.anchors).toEqual([
      { baseIdx: 0, pushedIdx: 0 }, { baseIdx: 1, pushedIdx: 1 }, { baseIdx: 2, pushedIdx: 2 },
    ]);
    expect(al.pairs).toEqual([]);
    expect(al.residualRuns).toEqual([]);
  });

  test('duplicate identical blocks align by sequence position (contract I10)', () => {
    // Three identical paragraphs followed by a distinct one; the THIRD copy is
    // edited. The block LCS anchors the first two copies and the tail, leaving
    // exactly one gap — so the edit pairs with, and lands on, the copy that was
    // actually edited rather than on whichever one a character diff reached
    // first.
    const base = ['same', 'same', 'same', 'tail'];
    const pushed = ['same', 'same', 'same edited', 'tail'];
    const al = alignBlocks(base, pushed);
    expect(al.pairs).toHaveLength(1);
    expect(al.pairs[0]).toMatchObject({ baseIdx: 2, pushedIdx: 2 });
    expect(al.residualRuns).toEqual([]);
  });

  test('ambiguous duplicates still align deterministically and in order', () => {
    // Three byte-identical paragraphs, one of them edited: which copy was
    // edited is genuinely unknowable, so the LCS is free to keep any two. What
    // it must not do is answer differently on two runs, cross, or splice — and
    // the applied document must still be exactly what was pushed.
    const base = ['same', 'same', 'same'];
    const pushed = ['same', 'same edited', 'same'];
    const first = JSON.stringify(alignBlocks(base, pushed), (k, v) => (k === 'parts' ? undefined : v));
    expect(JSON.stringify(alignBlocks(base, pushed), (k, v) => (k === 'parts' ? undefined : v))).toBe(first);

    const { plan, resultMd, pushedMd, keptNodes, baseBlocks } = replay(
      [el('paragraph', 'same'), el('paragraph', 'same'), el('paragraph', 'same')],
      'same\n\nsame edited\n\nsame'
    );
    expect(resultMd).toBe(pushedMd);
    expect(keptNodes).toBe(2); // two of the three originals keep their identity
    assertNoCrossBlockSplice(plan, baseBlocks);
  });

  test('pairing never crosses (order-preserving, RBD-055-2)', () => {
    // A gap where a greedy best-first matcher would cross: base[0] is most
    // similar to pushed[1] and base[1] to pushed[0], but a crossing match is
    // not allowed, so the DP takes the order-preserving pairing instead.
    const base = ['alpha alpha alpha alpha', 'bravo bravo bravo bravo'];
    const pushed = ['bravo bravo bravo bravX', 'alpha alpha alpha alphX'];
    const al = alignBlocks(base, pushed);
    let prevBase = -1;
    let prevPushed = -1;
    for (const p of al.pairs) {
      expect(p.baseIdx).toBeGreaterThan(prevBase);
      expect(p.pushedIdx).toBeGreaterThan(prevPushed);
      prevBase = p.baseIdx;
      prevPushed = p.pushedIdx;
    }
  });

  test('deterministic across repeated calls', () => {
    const base = ['one two three', 'four five six', 'seven eight nine', 'ten'];
    const pushed = ['one two THREE', 'brand new block', 'seven eight nine', 'ten eleven'];
    const first = JSON.stringify(alignBlocks(base, pushed), (k, v) => (k === 'parts' ? undefined : v));
    for (let i = 0; i < 3; i++) {
      expect(JSON.stringify(alignBlocks(base, pushed), (k, v) => (k === 'parts' ? undefined : v))).toBe(first);
    }
  });

  test('empty baseline → one all-insert run; empty pushed → one all-delete run', () => {
    const insert = alignBlocks([], ['a', 'b']);
    expect(insert.anchors).toEqual([]);
    expect(insert.pairs).toEqual([]);
    expect(insert.residualRuns).toEqual([{ baseIdxs: [], pushedIdxs: [0, 1], afterBaseIdx: -1 }]);

    const del = alignBlocks(['a', 'b'], []);
    expect(del.residualRuns).toEqual([{ baseIdxs: [0, 1], pushedIdxs: [], afterBaseIdx: -1 }]);
  });

  test('over MAX_GAP_DP_CELLS the gap degrades to positional pairing, still ordered', () => {
    // One gap big enough to exceed the cell cap: every block differs from its
    // counterpart, so nothing anchors and the whole document is one gap.
    const n = Math.ceil(Math.sqrt(MAX_GAP_DP_CELLS)) + 5;
    const base = Array.from({ length: n }, (_, i) => `block number ${i} original text here`);
    const pushed = Array.from({ length: n }, (_, i) => `block number ${i} original text HERE`);
    expect(n * n).toBeGreaterThan(MAX_GAP_DP_CELLS);
    const al = alignBlocks(base, pushed);
    expect(al.pairs.length).toBe(n);
    al.pairs.forEach((p, i) => {
      expect(p.baseIdx).toBe(i);
      expect(p.pushedIdx).toBe(i);
    });
    // and identical the second time
    expect(alignBlocks(base, pushed).pairs.map((p) => p.baseIdx)).toEqual(al.pairs.map((p) => p.baseIdx));
  });

  test('below-threshold candidates are never paired', () => {
    const al = alignBlocks(['the original sentence about deployment'], ['a completely different thing']);
    expect(al.pairs).toEqual([]);
    expect(al.residualRuns).toEqual([{ baseIdxs: [0], pushedIdxs: [0], afterBaseIdx: -1 }]);
    expect(blockSimilarity('the original sentence about deployment', 'a completely different thing'))
      .toBeLessThan(SIMILARITY_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
describe('forced whole-block ops (T008/T009, research R6)', () => {
  test('one insertion hunk per anchor, in pushed order', () => {
    const { plan, sourceMap } = planFor(
      [el('paragraph', 'first'), el('paragraph', 'last')],
      'first\n\ninserted one\n\ninserted two\n\nlast'
    );
    const insertions = plan.structural.filter((h) => h.blocks.length === 0);
    expect(insertions).toHaveLength(1);
    expect(insertions[0].newText).toBe('inserted one\n\ninserted two');
    expect(insertions[0].oldStart).toBe(insertions[0].oldEnd);
    assertNoCrossBlockSplice(plan, sourceMap.blocks);
  });

  test('an insertion whose anchor is replaced folds into that replacement', () => {
    // "second" is rewritten wholesale (below threshold) AND a new block follows
    // it. Emitting a separate insertion anchored on the replaced block would
    // send it to the end of the document at apply time.
    const { plan, sourceMap } = planFor(
      [el('paragraph', 'first'), el('paragraph', 'second'), el('paragraph', 'third')],
      'first\n\nzzzzz qqqqq wwwww\n\nbrand new block\n\nthird'
    );
    const insertions = plan.structural.filter((h) => (h.blocks || []).length === 0);
    expect(insertions).toHaveLength(0);
    const replace = plan.structural.find((h) => h.forced && h.blocks.length === 1);
    expect(replace.newText).toBe('zzzzz qqqqq wwwww\n\nbrand new block');
    assertNoCrossBlockSplice(plan, sourceMap.blocks);
  });

  test('a pure deletion is a forced replace with empty newText', () => {
    const { plan, sourceMap } = planFor(
      [el('paragraph', 'keep me'), el('paragraph', 'delete me'), el('paragraph', 'keep me too')],
      'keep me\n\nkeep me too'
    );
    const deletes = plan.structural.filter((h) => h.forced && h.newText === '');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].blocks).toHaveLength(1);
    expect(plan.textBlocks).toEqual([]);
    assertNoCrossBlockSplice(plan, sourceMap.blocks);
  });

  test('empty pushed document deletes every baseline block, extent-aligned', () => {
    const { plan, sourceMap } = planFor([el('paragraph', 'a'), el('paragraph', 'b')], '');
    expect(plan.structural).toHaveLength(1);
    expect(plan.structural[0].newText).toBe('');
    expect(plan.structural[0].blocks).toHaveLength(2);
    assertNoCrossBlockSplice(plan, sourceMap.blocks);
  });

  test('empty baseline: everything inserts at position 0', () => {
    const { doc, markdown, sourceMap } = baseline([]);
    const pushed = canonicalizePushedWithBlocks('brand new\n\nsecond block');
    const hunks = computeHunks(markdown, pushed.markdown, sourceMap.blocks, pushed.blocks);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 0, oldEnd: 0, forced: true, blocks: [] });
    expect(hunks[0].newText).toBe('brand new\n\nsecond block');
    doc.destroy();
  });

  test('an insertion at the head of the document anchors at offset 0', () => {
    const { plan, sourceMap } = planFor([el('paragraph', 'existing')], 'brand new\n\nexisting');
    const ins = plan.structural.filter((h) => (h.blocks || []).length === 0);
    expect(ins).toHaveLength(1);
    expect(ins[0]).toMatchObject({ oldStart: 0, oldEnd: 0 });
    assertNoCrossBlockSplice(plan, sourceMap.blocks);
  });

  test('mixed fixture shapes keep the invariant', () => {
    const blocks = [
      heading(1, 'Title'),
      el('paragraph', 'Intro paragraph with detail.'),
      listOf(['first item', 'second item']),
      codeBlock('const a = 1;'),
      el('paragraph', 'Closing thoughts here.'),
    ];
    const { plan, sourceMap } = planFor(blocks,
      '# Title\n\nIntro paragraph with more detail.\n\n- first item\n- second item\n- third item\n\n'
      + '```\nconst a = 2;\n```\n\nsomething else entirely, unrelated\n\ntrailing addition');
    assertNoCrossBlockSplice(plan, sourceMap.blocks);
  });
});

// ---------------------------------------------------------------------------
describe('US1 — edits land only in the blocks that were edited (FR-006, contract I8)', () => {
  /** Every baseline block the plan touches, by array index. */
  function touchedIndices(plan, baseBlocks) {
    const idxOf = new Map(baseBlocks.map((b, i) => [b, i]));
    const out = new Set();
    for (const tb of plan.textBlocks) out.add(idxOf.get(tb.block));
    for (const rb of plan.reconcileBlocks) out.add(idxOf.get(rb.block));
    for (const h of plan.structural) for (const b of h.blocks || []) out.add(idxOf.get(b));
    return [...out].sort((a, b) => a - b);
  }

  const decoyDoc = () => [
    heading(1, 'Deployment'),
    el('paragraph', 'How the service is deployed.'),
    heading(1, 'Deployment Notes'),
    el('paragraph', 'Notes about the deployment.'),
  ];

  test('the field-report regression: renaming "Deployment" never touches "Deployment Notes"', () => {
    const { plan, sourceMap, baselineMd } = planFor(decoyDoc(),
      '# Rollout\n\nHow the service is deployed.\n\n# Deployment Notes\n\nNotes about the deployment.');

    expect(touchedIndices(plan, sourceMap.blocks)).toEqual([0]);
    // The decoy heading appears in no plan list at all.
    const decoy = sourceMap.blocks[2];
    expect(plan.textBlocks.some((tb) => tb.block === decoy)).toBe(false);
    expect(plan.reconcileBlocks.some((rb) => rb.block === decoy)).toBe(false);
    expect(plan.structural.some((h) => (h.blocks || []).includes(decoy))).toBe(false);
    // Nothing the plan does reaches into the decoy's extent.
    for (const h of [...plan.structural, ...plan.textBlocks.flatMap((tb) => tb.hunks)]) {
      expect(h.oldStart >= decoy.mdEnd || h.oldEnd <= decoy.mdStart).toBe(true);
    }
    assertNoCrossBlockSplice(plan, sourceMap.blocks);
    expect(baselineMd).toContain('# Deployment Notes');
  });

  test('the same regression when the rename makes the decoy MORE similar', () => {
    // The nastiest shape for a character diff: the renamed heading now shares
    // its whole text with the decoy's prefix, so a whole-document diff has
    // every reason to anchor on the wrong one.
    const { plan, baseBlocks, resultMd, pushedMd } = replay(decoyDoc(),
      '# Deployment Rollout\n\nHow the service is deployed.\n\n# Deployment Notes\n\nNotes about the deployment.');
    expect(touchedIndices(plan, baseBlocks)).toEqual([0]);
    expect(resultMd).toBe(pushedMd);
    expect(resultMd).toContain('# Deployment Notes');
  });

  test('distant blocks stay independent in a 40-block document (US1 AS2)', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => el('paragraph', `Paragraph number ${i} with some body text.`));
    const pushedBody = blocks
      .map((_, i) => `Paragraph number ${i} with some body text.`)
      .map((s, i) => (i === 3 || i === 37 ? s.replace('some body text', 'some EDITED body text') : s))
      .join('\n\n');
    const { plan, sourceMap } = planFor(blocks, pushedBody);

    expect(touchedIndices(plan, sourceMap.blocks)).toEqual([3, 37]);
    expect(plan.structural).toEqual([]);
    assertNoCrossBlockSplice(plan, sourceMap.blocks);
  });
});

// ---------------------------------------------------------------------------
describe('US2 — rewritten blocks replace atomically (FR-005, contract I2/I5)', () => {
  /**
   * A pair of block strings whose Dice similarity straddles the threshold.
   * `shared` characters are common to both; each side gets `own` distinct ones.
   * sim = 2·shared / (2·shared + 2·own).
   */
  const pairWithSim = (shared, own) => [
    'a'.repeat(shared) + 'b'.repeat(own),
    'a'.repeat(shared) + 'c'.repeat(own),
  ];

  test('the threshold is inclusive: exactly 0.5 character-diffs (FR-003)', () => {
    const [a, b] = pairWithSim(10, 10); // 2*10/40 = 0.5 exactly
    expect(blockSimilarity(a, b)).toBeCloseTo(SIMILARITY_THRESHOLD, 12);
    const { plan, baseBlocks } = replay([el('paragraph', a)], b);
    expect(plan.structural).toEqual([]);
    expect(plan.textBlocks.length + plan.reconcileBlocks.length).toBe(1);
    assertNoCrossBlockSplice(plan, baseBlocks);
  });

  test('just below the threshold replaces atomically, with zero character ops', () => {
    const [a, b] = pairWithSim(10, 11); // 2*10/42 < 0.5
    expect(blockSimilarity(a, b)).toBeLessThan(SIMILARITY_THRESHOLD);
    const { plan, baseBlocks, resultMd } = replay([el('paragraph', a)], b);
    expect(plan.textBlocks).toEqual([]);
    expect(plan.reconcileBlocks).toEqual([]);
    expect(plan.structural).toHaveLength(1);
    expect(plan.structural[0].forced).toBe(true);
    expect(resultMd).toBe(b);
    assertNoCrossBlockSplice(plan, baseBlocks);
  });

  test('AS1: a wholesale rewrite is ONE replace and leaves its neighbours alone', () => {
    const { plan, baseBlocks, resultMd, keptNodes } = replay(
      [el('paragraph', 'Restart the queue workers.'),
        el('paragraph', 'Untouched middle.'),
        el('paragraph', 'Then page the on-call.')],
      'Drain connections, then flip the flag.\n\nUntouched middle.\n\nThen page the on-call.'
    );
    expect(plan.structural).toHaveLength(1);
    expect(plan.structural[0].blocks).toHaveLength(1);
    expect(keptNodes).toBe(2); // the two neighbours keep their identity
    expect(resultMd).toContain('Untouched middle.');
    assertNoCrossBlockSplice(plan, baseBlocks);
  });

  test('AS2/RBD-055-3: a move is a whole-block delete plus a whole-block insert', () => {
    const { plan, baseBlocks, resultMd } = replay(
      [el('paragraph', 'Alpha stays put here.'),
        el('paragraph', 'Bravo is on the move.'),
        el('paragraph', 'Charlie stays put too.')],
      'Alpha stays put here.\n\nCharlie stays put too.\n\nBravo is on the move.'
    );
    // No character edit morphs one block into another.
    expect(plan.textBlocks).toEqual([]);
    expect(plan.reconcileBlocks).toEqual([]);
    const deletes = plan.structural.filter((h) => h.forced && h.newText === '');
    const inserts = plan.structural.filter((h) => h.forced && h.blocks.length === 0);
    expect(deletes.length + inserts.length).toBe(plan.structural.length);
    expect(resultMd).toBe('Alpha stays put here.\n\nCharlie stays put too.\n\nBravo is on the move.');
    assertNoCrossBlockSplice(plan, baseBlocks);
  });

  test('RBD-055-7: a block SPLIT keeps the surviving fragment and inserts the rest', () => {
    const { plan, baseBlocks, resultMd, keptNodes } = replay(
      [el('paragraph', 'The first sentence carries most of the text. The second is new.')],
      'The first sentence carries most of the text.\n\nThe second is new.'
    );
    expect(keptNodes).toBe(1); // the paired half keeps its node
    expect(plan.structural.filter((h) => h.blocks.length === 0)).toHaveLength(1);
    expect(resultMd).toBe('The first sentence carries most of the text.\n\nThe second is new.');
    assertNoCrossBlockSplice(plan, baseBlocks);
  });

  test('RBD-055-7: a block MERGE pairs the closer half and deletes the leftover', () => {
    const { plan, baseBlocks, resultMd } = replay(
      [el('paragraph', 'The first sentence carries most of the text.'), el('paragraph', 'The second is new.')],
      'The first sentence carries most of the text. The second is new.'
    );
    expect(resultMd).toBe('The first sentence carries most of the text. The second is new.');
    // One of the two baseline blocks paired; the other was deleted whole.
    expect(plan.structural.some((h) => h.forced && h.newText === '')).toBe(true);
    assertNoCrossBlockSplice(plan, baseBlocks);
  });

  test('RBD-055-4: a heading level change pairs, then the CLASSIFIER declines it', () => {
    const { plan, baseBlocks, resultMd } = replay([heading(2, 'Deployment steps')], '### Deployment steps');
    // High similarity, so the aligner paired the blocks — the structural
    // outcome comes from reconcileBlockPlan refusing a level change, which is
    // pre-055 behavior the aligner deliberately leaves alone.
    expect(blockSimilarity('## Deployment steps', '### Deployment steps')).toBeGreaterThan(SIMILARITY_THRESHOLD);
    expect(plan.structural).toHaveLength(1);
    expect(plan.structural[0].forced).toBeUndefined();
    expect(resultMd).toBe('### Deployment steps');
    assertNoCrossBlockSplice(plan, baseBlocks);
  });

  test('RBD-055-4: a paragraph → list type change also goes structural via the classifier', () => {
    const { plan, baseBlocks, resultMd } = replay(
      [el('paragraph', 'Alpha'), el('paragraph', 'Bravo item text here')],
      'Alpha\n\n- Bravo item text here'
    );
    expect(plan.structural).toHaveLength(1);
    expect(plan.structural[0].forced).toBeUndefined();
    expect(resultMd).toBe('Alpha\n\n- Bravo item text here');
    assertNoCrossBlockSplice(plan, baseBlocks);
  });

  test('adjacent replaces merge without swallowing a matched block between them', () => {
    const { plan, baseBlocks, resultMd } = replay(
      [el('paragraph', 'zzzz zzzz zzzz'),
        el('paragraph', 'Middle block, only lightly edited.'),
        el('paragraph', 'wwww wwww wwww')],
      'qqqq qqqq qqqq\n\nMiddle block, only lightly edited!\n\nvvvv vvvv vvvv'
    );
    // The middle block character-diffs; the two around it replace atomically.
    expect(plan.textBlocks).toHaveLength(1);
    expect(plan.textBlocks[0].block).toBe(baseBlocks[1]);
    expect(plan.structural.filter((h) => h.forced)).toHaveLength(2);
    expect(resultMd).toBe('qqqq qqqq qqqq\n\nMiddle block, only lightly edited!\n\nvvvv vvvv vvvv');
    assertNoCrossBlockSplice(plan, baseBlocks);
  });

  test('a cap-tripping pair degrades alone; its siblings still character-diff (I7)', () => {
    // The bounded character diff cannot finish on this block. Whatever route
    // that takes internally, the OBSERVABLE outcome is fixed: that block alone
    // is replaced as a unit, the neighbour is still character-diffed, and no
    // whole-document fallback appears.
    const [big, bigRewritten] = capTrippingPair();
    const { plan, baseBlocks, resultMd } = replay(
      [el('paragraph', big), el('paragraph', 'A small neighbouring paragraph.')],
      `${bigRewritten}\n\nA small neighbouring paragraph, edited.`
    );
    expect(plan.structural).toHaveLength(1);
    expect(plan.structural[0].forced).toBe(true);
    expect(plan.structural[0].blocks).toEqual([baseBlocks[0]]);
    expect(plan.textBlocks.length + plan.reconcileBlocks.length).toBe(1);
    expect(resultMd).toBe(`${bigRewritten}\n\nA small neighbouring paragraph, edited.`);
    assertNoCrossBlockSplice(plan, baseBlocks);
  });
});

module.exports = { assertNoCrossBlockSplice };
