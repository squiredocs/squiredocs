/**
 * Feature 039 US4 (SC-003) — the two inline-diff surfaces agree about which
 * words changed.
 *
 * Feature 022 ratified SC-003 ("the chat diff and the version-history diff
 * highlight the same words for the same change"). It regressed because the two
 * surfaces stopped sharing a *region unit*: version history segments the WHOLE
 * replace region in one call, while chat segmented row PAIRS positionally
 * (`Math.min(delCount, addCount)`), so a region whose rows shifted produced
 * different — and often much noisier — emphasis, and surplus rows got none at
 * all. 039 gives both surfaces one shared per-region segmentation
 * (`computeLineWordSegments`).
 *
 * ── Scoping note (039 analyze finding A1) ────────────────────────────────────
 * The two surfaces do NOT segment the same bytes in general. Chat segments
 * hard-break-stripped, span-stripped MARKDOWN rows (`**bold**` syntax still
 * present); version history segments POST-PARSE plain text
 * (`plainTextOf(markdownToPm(...))`). Byte-equal changed-character ranges are
 * therefore not achievable across arbitrary input, and asserting them would be
 * asserting a falsehood.
 *
 * So the parity corpus below is deliberately scoped to plain-prose regions with
 * no inline markdown syntax and no hard breaks — precisely the inputs where the
 * two pipelines' segmentation inputs genuinely coincide. Outside that corpus we
 * assert *algorithmic* parity instead: same helper, same region unit, same
 * whole-region fallback. Together those two claims are SC-003.
 */

const { postProcessDiffLines } = require('../mcp/diff-postprocess');
const { applyWordMarks } = require('../diff/apply-word-marks');
const { MAX_SIDE_CHARS } = require('../../shared/diff/word-diff');

// ---------------------------------------------------------------------------
// Range extraction — the common currency. The surfaces' native output shapes
// legitimately differ (keyed Segment[] vs. ProseMirror JSON), so we reduce both
// to the same thing: per row, the ordered list of row-relative [start, end)
// character ranges that are marked as changed.
// ---------------------------------------------------------------------------

/** Chat: Segment[] for one row → ordered changed ranges. */
function rangesFromSegments(segments) {
  const ranges = [];
  let cursor = 0;
  for (const seg of segments || []) {
    if (seg.changed && seg.text.length > 0) ranges.push([cursor, cursor + seg.text.length]);
    cursor += seg.text.length;
  }
  return ranges;
}

/**
 * Version history: one refined PM block → ordered changed ranges, relative to
 * that block's own text. `strongMark` is diffDeleteWord / diffInsertWord.
 */
function rangesFromBlock(block, strongMark) {
  const ranges = [];
  let cursor = 0;
  const walk = (node) => {
    if (!node || !Array.isArray(node.content)) return;
    for (const child of node.content) {
      if (child.type === 'text') {
        const len = child.text.length;
        if ((child.marks || []).some((m) => m.type === strongMark)) {
          ranges.push([cursor, cursor + len]);
        }
        cursor += len;
      } else {
        walk(child);
      }
    }
  };
  walk(block);
  // Coalesce ranges that abut — a block's text may be split across several
  // nodes for reasons unrelated to the diff (e.g. formatting marks).
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && last[1] === r[0]) last[1] = r[1];
    else merged.push([...r]);
  }
  return merged;
}

/**
 * Drive the CHAT pipeline over one replace region and return the per-row
 * changed ranges for each side.
 */
function chatRanges(beforeRows, afterRows) {
  const lines = [...beforeRows.map((r) => '-' + r), ...afterRows.map((r) => '+' + r)];
  const out = postProcessDiffLines(lines, []);
  const segs = out.inlineSegments || {};
  return {
    before: beforeRows.map((_, k) => rangesFromSegments(segs[k])),
    after: afterRows.map((_, k) => rangesFromSegments(segs[beforeRows.length + k])),
    raw: out,
  };
}

/**
 * Drive the VERSION-HISTORY pipeline over the same region. Rows are joined with
 * a blank line so each row parses to its own top-level block — which is what
 * makes `plainTextOf` produce `rows.join('\n')`, byte-identical to what the
 * chat surface feeds `computeLineWordSegments`. That byte-identity is the whole
 * basis of the comparison.
 */
function historyRanges(beforeRows, afterRows) {
  const removedMd = beforeRows.join('\n\n') + '\n';
  const addedMd = afterRows.join('\n\n') + '\n';
  const blocks = applyWordMarks(removedMd, addedMd);
  const before = blocks.slice(0, beforeRows.length);
  const after = blocks.slice(beforeRows.length);
  return {
    before: before.map((b) => rangesFromBlock(b, 'diffDeleteWord')),
    after: after.map((b) => rangesFromBlock(b, 'diffInsertWord')),
    raw: blocks,
  };
}

// ---------------------------------------------------------------------------

describe('SC-003 — chat and version history agree about which words changed', () => {
  // The scoped parity corpus: plain prose, no inline markdown syntax, no hard
  // breaks. See the scoping note at the top of this file.
  const corpus = [
    {
      name: 'PAR-1a: one word changed on each of two rows',
      before: ['The quick brown fox', 'jumps over the lazy dog'],
      after: ['The slow brown fox', 'jumps over the lazy cat'],
    },
    {
      name: 'PAR-1b: a row inserted at the top of an otherwise unchanged block',
      before: ['alpha line', 'beta line'],
      after: ['brand new line', 'alpha line', 'beta line'],
    },
    {
      name: 'PAR-1c: more removed rows than added (surplus on the before side)',
      before: ['one two three', 'four five six', 'seven eight nine'],
      after: ['one two THREE'],
    },
    {
      name: 'PAR-1d: more added rows than removed (surplus on the after side)',
      before: ['alpha beta gamma'],
      after: ['alpha beta GAMMA', 'delta epsilon zeta', 'eta theta iota'],
    },
    {
      name: 'PAR-1e: multi-byte UTF-8 prose',
      before: ['añejo café señor', 'naïve résumé façade'],
      after: ['añejo café SEÑOR', 'naïve résumé façade'],
    },
  ];

  for (const { name, before, after } of corpus) {
    test(name, () => {
      const chat = chatRanges(before, after);
      const history = historyRanges(before, after);

      // Row-for-row, per side, the changed-character ranges are identical.
      expect(chat.before).toEqual(history.before);
      expect(chat.after).toEqual(history.after);

      // And every row on both sides is accounted for — no surplus row is
      // silently skipped by either surface (FR-009 / LS-5).
      expect(chat.before).toHaveLength(before.length);
      expect(chat.after).toHaveLength(after.length);
      expect(history.before).toHaveLength(before.length);
      expect(history.after).toHaveLength(after.length);
    });
  }

  test('PAR-1f: unchanged rows in the region carry NO emphasis on either surface', () => {
    const before = ['alpha line', 'beta line', 'gamma line'];
    const after = ['brand new line', 'alpha line', 'beta line', 'gamma line'];

    const chat = chatRanges(before, after);
    const history = historyRanges(before, after);

    expect(chat.before).toEqual(history.before);
    expect(chat.after).toEqual(history.after);
    // Nothing was removed, so no before-side row carries emphasis at all.
    expect(chat.before.flat()).toEqual([]);
    // On the after side only the genuinely new row is emphasised; the three
    // shifted-but-identical rows stay clean. (Pre-039 the chat surface paired
    // row 0↔0, 1↔1, 2↔2 positionally and lit up all of them.)
    expect(chat.after.slice(1).flat()).toEqual([]);
    expect(chat.after[0].length).toBeGreaterThan(0);
  });

  // PAR-2 — guardrails trip identically, for the WHOLE region, on both surfaces.
  test('PAR-2: an oversized region falls back for the WHOLE region on both surfaces', () => {
    const filler = 'alpha beta gamma delta '.repeat(Math.ceil(MAX_SIDE_CHARS / 23) + 1);
    const before = [filler, 'small tail row'];
    const after = [filler.replace('alpha', 'omega'), 'small tail ROW'];

    const chat = chatRanges(before, after);
    const history = historyRanges(before, after);

    // Chat: no inlineSegments for ANY row of the region — including the small
    // trailing row, which pre-039 would still have been segmented as its own
    // pair. This is one of the four approved visible changes (SC-008).
    expect(chat.before.flat()).toEqual([]);
    expect(chat.after.flat()).toEqual([]);

    // Version history: line-level marks only, no strong word marks anywhere.
    expect(history.before.flat()).toEqual([]);
    expect(history.after.flat()).toEqual([]);

    // Both surfaces agree, which is the actual claim.
    expect(chat.before).toEqual(history.before);
    expect(chat.after).toEqual(history.after);
  });

  // Algorithmic parity — the claim that covers the inputs the byte-level corpus
  // above deliberately excludes (A1).
  test('both surfaces segment ONE region per replace block, not one per row pair', () => {
    const wordDiff = require('../../shared/diff/word-diff');
    const before = ['one two three', 'four five six', 'seven eight nine'];
    const after = ['one two THREE', 'four five SIX', 'seven eight NINE'];

    // Chat goes through the line-aware wrapper...
    const lineSpy = jest.spyOn(wordDiff, 'computeLineWordSegments');
    chatRanges(before, after);
    expect(lineSpy).toHaveBeenCalledTimes(1);
    // ...over ALL rows of the region at once (not min(3,3) separate pairs).
    expect(lineSpy.mock.calls[0][0]).toHaveLength(3);
    expect(lineSpy.mock.calls[0][1]).toHaveLength(3);
    lineSpy.mockRestore();

    // ...and version history goes straight to the region segmenter, once.
    const wordSpy = jest.spyOn(wordDiff, 'computeWordSegments');
    historyRanges(before, after);
    expect(wordSpy).toHaveBeenCalledTimes(1);
    wordSpy.mockRestore();

    // The wrapper is a re-split of exactly one `computeWordSegments` result, so
    // "one wrapper call" and "one segmenter call" are the same region unit.
    // (Pinned directly by the LS-* suite in shared/diff/__tests__/word-diff.test.js.)
  });
});

// ===========================================================================
// Feature 043 US6 (FR-008, SC-005) — end-to-end, from ONE shared document
// ===========================================================================

/**
 * Everything above feeds hand-built diff rows into each surface's
 * POST-PROCESSING half. That is genuinely useful — it is where 039's shared
 * segmentation lives — but it bypasses each pipeline's upstream half entirely:
 * the markdown serialization, the line diff, the region detection. A regression
 * introduced there would not fail a single assertion above.
 *
 * So this block starts from a real collaborative document — a pair of `Y.Doc`s,
 * the actual input the product diffs — and drives BOTH COMPLETE production
 * pipelines end to end:
 *
 *   version history: `new DiffService(...).computeMarkdownDiff(before, after, report)`
 *   chat:            `computeChatDiff(toMarkdown(before), toMarkdown(after))`
 *
 * Both surfaces provably start from the same bytes, because `computeChatDiff`
 * is fed exactly the serialization `computeMarkdownDiff` performs internally.
 * The range-extraction helpers above are reused as the comparison currency
 * (FR-008 permits this explicitly), so the two halves of this file measure the
 * same thing.
 *
 * No database and no Redis: `DiffService.computeMarkdownDiff` is pure given the
 * fixture, and `computeChatDiff` is pure outright. This suite therefore runs
 * fast and cannot orphan rows (FR-010 is vacuous for it).
 */

const Y = require('yjs');
const { markdownToPm } = require('../../shared/markdown');
const { pmJsonToNodes } = require('../mcp/yjs/pm-json-to-nodes');
const { toMarkdown } = require('../mcp/yjs/serialization');
const { computeChatDiff } = require('../mcp/diff-utils');
const DiffService = require('../diff-service');

/** The shared fixture builder: markdown in, a real Y.Doc out. */
function docFromMarkdown(md) {
  const doc = new Y.Doc();
  const fragment = doc.get('default', Y.XmlFragment);
  doc.transact(() => {
    fragment.insert(0, pmJsonToNodes(markdownToPm(md, null)));
  });
  return doc;
}

/** Plain text of one ProseMirror block, for reporting which row a range is on. */
function textOfBlock(block) {
  let out = '';
  const walk = (node) => {
    if (!node || !Array.isArray(node.content)) return;
    for (const child of node.content) {
      if (child.type === 'text') out += child.text;
      else walk(child);
    }
  };
  walk(block);
  return out;
}

/**
 * Run BOTH complete pipelines over one before/after markdown pair and reduce
 * each to `{ del: [{text, ranges}], ins: [{text, ranges}] }`.
 *
 * The serialization round-trip is deliberate and load-bearing: `serialized`
 * reports what `toMarkdown` actually produced, which is not always what was
 * fed in (markdown has more than one spelling for the same document — `*x*`
 * serializes back as `_x_`). Asserting against the round-tripped form is what
 * keeps these pins about the DIFF rather than about the serializer.
 */
function bothPipelines(beforeMd, afterMd) {
  const before = docFromMarkdown(beforeMd);
  const after = docFromMarkdown(afterMd);
  const serializedBefore = toMarkdown(before.get('default', Y.XmlFragment));
  const serializedAfter = toMarkdown(after.get('default', Y.XmlFragment));

  // ── chat: the full pipeline, from the same bytes ──────────────────────────
  const chatOut = computeChatDiff(serializedBefore, serializedAfter);
  const segs = chatOut.inlineSegments || {};
  const chat = { del: [], ins: [] };
  chatOut.lines.forEach((line, i) => {
    if (line.startsWith('-')) chat.del.push({ text: line.slice(1), ranges: rangesFromSegments(segs[i]) });
    else if (line.startsWith('+')) chat.ins.push({ text: line.slice(1), ranges: rangesFromSegments(segs[i]) });
  });

  // ── version history: the full pipeline, from the same document ────────────
  const service = new DiffService({
    getUpdateRowsUpTo: async () => ({ rows: [], gapped: false }),
  });
  const pmDoc = service.computeMarkdownDiff(before, after, { timedOut: false });
  const history = { del: [], ins: [], context: [] };
  for (const block of pmDoc.content || []) {
    const blob = JSON.stringify(block);
    const entry = { text: textOfBlock(block) };
    if (blob.includes('diffDelete')) {
      history.del.push({ ...entry, ranges: rangesFromBlock(block, 'diffDeleteWord') });
    } else if (blob.includes('diffInsert')) {
      history.ins.push({ ...entry, ranges: rangesFromBlock(block, 'diffInsertWord') });
    } else {
      // Blocks carrying NEITHER change mark: unchanged context that history
      // keeps in its document. Tracked separately so a divergence in how much
      // context each surface emits is visible rather than silently filtered.
      history.context.push(entry);
    }
  }

  before.destroy();
  after.destroy();
  return { chat, history, chatLines: chatOut.lines, serializedBefore, serializedAfter };
}

describe('043 US6 — both COMPLETE pipelines, driven from one shared Y.Doc fixture', () => {
  // ── FR-008 acceptance scenario 1: parity on the contractual corpus ────────

  const parityCorpus = [
    {
      name: 'E2E-1: one word replaced in a single paragraph',
      before: 'The quick brown fox\n',
      after: 'The slow brown fox\n',
    },
    {
      name: 'E2E-2: a word changed on each of two paragraphs',
      before: 'The quick brown fox\n\njumps over the lazy dog\n',
      after: 'The slow brown fox\n\njumps over the lazy cat\n',
    },
    {
      name: 'E2E-3: multi-byte UTF-8 prose',
      before: 'anejo café señor here\n',
      after: 'anejo café SEÑOR here\n',
    },
    {
      name: 'E2E-4: a literal asterisk that survives the round-trip unescaped',
      before: 'Use 2 * 3 here\n',
      after: 'Use 4 * 3 here\n',
    },
  ];

  for (const c of parityCorpus) {
    test(`${c.name}: the two full pipelines mark the same words`, () => {
      const { chat, history } = bothPipelines(c.before, c.after);

      // Both surfaces saw the same change, and neither dropped a row.
      expect(chat.del.length).toBeGreaterThan(0);
      expect(chat.del.map((r) => r.text)).toEqual(history.del.map((r) => r.text));
      expect(chat.ins.map((r) => r.text)).toEqual(history.ins.map((r) => r.text));

      // ...and agree about WHICH characters of each row changed. This is the
      // 022 SC-003 contract, now asserted through both upstream halves.
      expect(chat.del.map((r) => r.ranges)).toEqual(history.del.map((r) => r.ranges));
      expect(chat.ins.map((r) => r.ranges)).toEqual(history.ins.map((r) => r.ranges));

      // Emphasis is non-empty: a pipeline that marked nothing would otherwise
      // "agree" with one that also marked nothing.
      expect(chat.del.some((r) => r.ranges.length > 0)).toBe(true);
      expect(chat.ins.some((r) => r.ranges.length > 0)).toBe(true);
    });
  }

  // ── FR-014 characterization: the ACCEPTED divergence, pinned ──────────────

  /**
   * ⚠️ CHARACTERIZATION TESTS — ACCEPTED DIVERGENCE (feature 039, finding A1) ⚠️
   *
   * The pins below assert output that the two surfaces DISAGREE about. That
   * disagreement is a ratified decision, not a bug:
   *
   *   chat            segments hard-break-stripped, span-stripped MARKDOWN rows,
   *                   so `**` and `_` and backticks are part of the text it
   *                   measures — which is correct for chat, because chat SHOWS
   *                   the reader that markdown.
   *   version history segments POST-PARSE plain text, so the same syntax is
   *                   gone before measurement — which is correct for history,
   *                   because history shows the reader rendered prose.
   *
   * Byte-equal ranges across arbitrary input are therefore not achievable, and
   * asserting them would be asserting a falsehood. Parity is contractual ONLY
   * on the plain-prose corpus above.
   *
   * WHAT TO DO WHEN ONE OF THESE FAILS: do not update the pin to match the new
   * output. A change here means one pipeline's treatment of markdown syntax
   * moved, which is a product decision — ratify it (and then update the pin
   * deliberately, with the decision recorded) or fix the regression. Silently
   * re-pinning converts a ratified decision back into an accident, which is the
   * exact drift this feature exists to prevent.
   *
   * SC-005 requires at least three pinned cases; there are four.
   */
  describe('accepted divergence on markdown-syntax regions (039 A1) — ratify-or-fix', () => {
    test('DIV-1 bold syntax: chat measures around the asterisks, history after them', () => {
      const { chat, history, serializedBefore } = bothPipelines(
        'The **quick** brown fox\n',
        'The **slow** brown fox\n'
      );

      expect(serializedBefore).toBe('The **quick** brown fox');

      // Chat: the row still contains `**`, so the changed word starts at 6.
      expect(chat.del).toEqual([{ text: 'The **quick** brown fox', ranges: [[6, 11]] }]);
      expect(chat.ins).toEqual([{ text: 'The **slow** brown fox', ranges: [[6, 10]] }]);

      // History: the syntax is parsed away, so the same word starts at 4.
      expect(history.del).toEqual([{ text: 'The quick brown fox', ranges: [[4, 9]] }]);
      expect(history.ins).toEqual([{ text: 'The slow brown fox', ranges: [[4, 8]] }]);

      // Both still emphasise exactly one word — the divergence is the OFFSET,
      // not the decision about what changed.
      expect(chat.del[0].ranges).toHaveLength(1);
      expect(history.del[0].ranges).toHaveLength(1);
    });

    test('DIV-2 emphasis syntax: chat includes the underscores in the changed span', () => {
      const { chat, history, serializedBefore } = bothPipelines(
        'An *urgent* memo here\n',
        'An *routine* memo here\n'
      );

      // Note the round-trip: `*x*` serializes back as `_x_`. The pin is about
      // the diff, so it asserts the form the pipelines actually received.
      expect(serializedBefore).toBe('An _urgent_ memo here');

      // Chat's changed span SWALLOWS the delimiters (3..11 covers `_urgent_`),
      // because to a markdown reader the delimiters moved too.
      expect(chat.del).toEqual([{ text: 'An _urgent_ memo here', ranges: [[3, 11]] }]);
      expect(chat.ins).toEqual([{ text: 'An _routine_ memo here', ranges: [[3, 12]] }]);

      // History marks the word alone.
      expect(history.del).toEqual([{ text: 'An urgent memo here', ranges: [[3, 9]] }]);
      expect(history.ins).toEqual([{ text: 'An routine memo here', ranges: [[3, 10]] }]);
    });

    test('DIV-3 inline code: the backticks shift chat one column right', () => {
      const { chat, history } = bothPipelines('call `foo()` now\n', 'call `bar()` now\n');

      expect(chat.del).toEqual([{ text: 'call `foo()` now', ranges: [[6, 9]] }]);
      expect(chat.ins).toEqual([{ text: 'call `bar()` now', ranges: [[6, 9]] }]);

      expect(history.del).toEqual([{ text: 'call foo() now', ranges: [[5, 8]] }]);
      expect(history.ins).toEqual([{ text: 'call bar() now', ranges: [[5, 8]] }]);

      // Same width, different origin: the offset is exactly the backtick.
      expect(chat.del[0].ranges[0][1] - chat.del[0].ranges[0][0])
        .toBe(history.del[0].ranges[0][1] - history.del[0].ranges[0][0]);
    });

    test('DIV-4 hard breaks: the marked words agree, but history keeps the joined sibling as context', () => {
      const { chat, history, chatLines } = bothPipelines(
        'first line\\\nsecond line\n',
        'first line\\\nsecond LINE\n'
      );

      // The EMPHASIS agrees here — a hard break does not shift the columns the
      // way inline syntax does, because the marker is stripped from both sides
      // before segmentation (028 FR-004).
      expect(chat.del).toEqual([{ text: 'second line', ranges: [[7, 11]] }]);
      expect(chat.ins).toEqual([{ text: 'second LINE', ranges: [[7, 11]] }]);
      expect(history.del).toEqual([{ text: 'second line', ranges: [[7, 11]] }]);
      expect(history.ins).toEqual([{ text: 'second LINE', ranges: [[7, 11]] }]);

      // The divergence is STRUCTURAL rather than positional: the hard break
      // joins two lines into one paragraph, and history's document keeps the
      // unchanged half as its own context block, carrying the trailing `\`
      // that chat's line list never emits at all. Two surfaces, two answers to
      // "what is a row" — accepted for the same A1 reason.
      expect(history.context).toEqual([{ text: 'first line\\' }]);

      // Chat DOES carry the same half, as a patch CONTEXT line (leading space)
      // rather than as a document block — and it has STRIPPED the trailing `\`
      // hard-break marker that history's block still carries in its text
      // (028 FR-004 strips the marker from both serializations before the line
      // diff, so every chat consumer sees cleaned text).
      expect(chatLines).toEqual([' first line', '-second line', '+second LINE']);

      // The same unchanged content, spelled two ways. This inequality IS the
      // pin: if it ever becomes an equality, one surface changed its treatment
      // of hard breaks and that is a decision to ratify, not a pin to update.
      const chatContext = chatLines.filter((l) => l.startsWith(' ')).map((l) => l.slice(1));
      expect(chatContext).toEqual(['first line']);
      expect(history.context.map((c) => c.text)).toEqual(['first line\\']);
      expect(chatContext).not.toEqual(history.context.map((c) => c.text));
    });
  });

  // ── FR-008's other half: the fixture really is shared ─────────────────────

  test('E2E-5: both surfaces are provably fed the same bytes', () => {
    // If this ever stops holding, every parity assertion above becomes
    // meaningless — they would be comparing two different inputs.
    const before = docFromMarkdown('alpha beta gamma\n');
    const after = docFromMarkdown('alpha BETA gamma\n');

    const beforeMd = toMarkdown(before.get('default', Y.XmlFragment));
    const afterMd = toMarkdown(after.get('default', Y.XmlFragment));

    expect(beforeMd).toBe('alpha beta gamma');
    expect(afterMd).toBe('alpha BETA gamma');

    // computeMarkdownDiff performs exactly this serialization internally, so
    // handing the same strings to computeChatDiff is the shared-input proof.
    const service = new DiffService({ getUpdateRowsUpTo: async () => ({ rows: [], gapped: false }) });
    const pmDoc = service.computeMarkdownDiff(before, after, { timedOut: false });
    const historyText = (pmDoc.content || []).map(textOfBlock);
    const chatText = computeChatDiff(beforeMd, afterMd).lines
      .filter((l) => l.startsWith('-') || l.startsWith('+'))
      .map((l) => l.slice(1));

    expect(historyText).toEqual(chatText);

    before.destroy();
    after.destroy();
  });
});
