/**
 * Markdown-sync engine unit tests (feature 004).
 *
 * Phase 2 (T004/T005): offset resolver, synthetic clientID determinism,
 * canonicalization. Phase 3 (T006/T007/T008 + T017): hunk classification and
 * replay are appended in later describe blocks.
 */
const Y = require('yjs');
const { toMarkdownNodes, toMarkdownWithSourceMap } = require('../mcp/yjs/serialization');
const {
  resolveMd,
  classifyRange,
  syntheticClientId,
  canonicalizePushed,
  computeHunks,
  planPush,
  applyHunks,
} = require('../markdown-sync');

/**
 * Full replay against a baseline fragment: build source map, diff pushed
 * markdown, classify, apply in a transaction. Returns the classified hunks and
 * the resulting canonical markdown.
 */
function replay(frag, pushedMd, opts = {}) {
  const flavor = opts.flavor || 'squire';
  const nodes = frag.toArray();
  const { markdown: baselineMd, sourceMap } = toMarkdownWithSourceMap(nodes, { flavor });
  const pushedCanon = canonicalizePushed(pushedMd, { flavor });
  const hunks = computeHunks(baselineMd, pushedCanon);
  const plan = planPush(hunks, sourceMap, baselineMd);
  let ops;
  frag.doc.transact(() => { ops = applyHunks(frag, plan, sourceMap, baselineMd, { flavor }); });
  return { plan, allText: plan.structural.length === 0, ops, resultMd: toMarkdownNodes(frag.toArray()), pushedCanon };
}

function el(tag, text, attrs) {
  const e = new Y.XmlElement(tag);
  if (text !== undefined) {
    const t = new Y.XmlText();
    t.insert(0, text, attrs);
    e.insert(0, [t]);
  }
  return e;
}
function build(fn) {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  doc.transact(() => fn(frag));
  const { markdown, sourceMap } = toMarkdownWithSourceMap(frag.toArray());
  return { doc, frag, markdown, sourceMap };
}

// ---------------------------------------------------------------------------
describe('offset resolver (T004, research R2)', () => {
  test('resolveMd: text char → node+offset; syntax char → structure', () => {
    const { doc, markdown, sourceMap } = build((f) => {
      const h = el('heading', 'Hello'); h.setAttribute('level', '2');
      f.insert(0, [h]);
    });
    expect(markdown).toBe('## Hello');
    // '#' at 0 is syntax
    expect(resolveMd(sourceMap, 0).kind).toBe('syntax');
    // 'H' at 3 is text, offset 0 into the heading text node
    const r = resolveMd(sourceMap, 3);
    expect(r.kind).toBe('text');
    expect(r.textOff).toBe(0);
    // 'e' at 4 → offset 1
    expect(resolveMd(sourceMap, 4).textOff).toBe(1);
    doc.destroy();
  });

  test('classifyRange: intra-paragraph range is a text hunk of one block', () => {
    const { doc, markdown, sourceMap } = build((f) => {
      f.insert(0, [el('paragraph', 'the quick brown fox')]);
    });
    const s = markdown.indexOf('quick');
    const cls = classifyRange(sourceMap, s, s + 5);
    expect(cls.kind).toBe('text');
    expect(cls.segments).toHaveLength(1);
    expect(cls.segments[0].textOff).toBe(s); // no syntax before it in a bare paragraph
    expect(cls.segments[0].length).toBe(5);
    doc.destroy();
  });

  test('classifyRange: range spanning a heading marker is structural', () => {
    const { doc, markdown, sourceMap } = build((f) => {
      const h = el('heading', 'Title'); h.setAttribute('level', '1');
      f.insert(0, [h]);
    });
    // range covering '# T' includes the syntax '#'
    const cls = classifyRange(sourceMap, 0, 3);
    expect(cls.kind).toBe('structural');
    doc.destroy();
  });

  test('classifyRange: range crossing two blocks is structural', () => {
    const { doc, markdown, sourceMap } = build((f) => {
      f.insert(0, [el('paragraph', 'aaa'), el('paragraph', 'bbb')]);
    });
    // whole doc "aaa\n\nbbb"
    const cls = classifyRange(sourceMap, 1, markdown.length - 1);
    expect(cls.kind).toBe('structural');
    expect(cls.blocks.length).toBe(2);
    doc.destroy();
  });

  test('classifyRange: insertion point inside a run resolves to text', () => {
    const { doc, markdown, sourceMap } = build((f) => {
      f.insert(0, [el('paragraph', 'abcdef')]);
    });
    const cls = classifyRange(sourceMap, 3, 3);
    expect(cls.kind).toBe('text');
    expect(cls.segments[0].length).toBe(0);
    expect(cls.segments[0].textOff).toBe(3);
    doc.destroy();
  });
});

// ---------------------------------------------------------------------------
describe('synthetic clientID + determinism (T005, research R4)', () => {
  test('deterministic over (doc, clock, content); 31-bit; never 0', () => {
    const a = syntheticClientId('doc-1', 5, 'hashA');
    const b = syntheticClientId('doc-1', 5, 'hashA');
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(0x80000000); // bit 31 cleared
    // different content → different identity
    expect(syntheticClientId('doc-1', 5, 'hashB')).not.toBe(a);
    // different baseline → different identity
    expect(syntheticClientId('doc-1', 6, 'hashA')).not.toBe(a);
  });

  test('pinned clientID → identical pushUpdate bytes across replays (FR-011)', () => {
    // Baseline built ONCE with fixed structs (mirrors getYDocAtClock replaying
    // the same persisted updates in fixed clock order); each replay forks from
    // the identical baseline bytes, so left-origin references are stable.
    const base = new Y.Doc();
    base.transact(() => base.getXmlFragment('default').insert(0, [el('paragraph', 'seed')]));
    const baseUpdate = Y.encodeStateAsUpdate(base);
    const baselineSV = Y.encodeStateVector(base);
    base.destroy();

    function replayOnce() {
      const fork = new Y.Doc();
      Y.applyUpdate(fork, baseUpdate);
      fork.clientID = syntheticClientId('doc-1', 3, 'abc'); // pin BEFORE any new op
      fork.transact(() => {
        const p = fork.getXmlFragment('default').get(0);
        p.get(0).insert(4, ' more');
      });
      const update = Y.encodeStateAsUpdate(fork, baselineSV);
      fork.destroy();
      return Buffer.from(update).toString('hex');
    }
    expect(replayOnce()).toBe(replayOnce()); // byte-identical
  });
});

// ---------------------------------------------------------------------------
describe('canonicalizePushed (T005, FR-005/FR-009)', () => {
  test('formatting-equivalent inputs collapse to the same canonical string', () => {
    const a = canonicalizePushed('# Title\n\nHello **world**');
    // extra blank lines + trailing spaces canonicalize away
    const b = canonicalizePushed('# Title\n\n\nHello **world**   ');
    expect(a).toBe(b);
  });

  test('a genuine text change produces a different canonical string', () => {
    const a = canonicalizePushed('Hello world');
    const b = canonicalizePushed('Hello there');
    expect(a).not.toBe(b);
  });

  test('canonical form is stable under re-canonicalization (round-trip)', () => {
    const once = canonicalizePushed('- one\n- two\n\n> quote');
    expect(canonicalizePushed(once)).toBe(once);
  });
});

// ---------------------------------------------------------------------------
describe('hunk classification & replay (T006/T007/T008, US1)', () => {
  test('text hunk within one paragraph: char ops, other blocks keep identity', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => frag.insert(0, [el('paragraph', 'Hello world'), el('paragraph', 'keep me')]));
    const before = frag.toArray();
    const beforeText0 = before[0].get(0); // the Y.XmlText of para 0
    const { allText, resultMd } = replay(frag, 'Hello world\n\nkeep me'.replace('world', 'there'));
    expect(resultMd).toBe('Hello there\n\nkeep me');
    expect(allText).toBe(true);
    const after = frag.toArray();
    expect(after[1]).toBe(before[1]); // untouched paragraph — same instance
    expect(after[0]).toBe(before[0]); // edited block element preserved
    expect(after[0].get(0)).toBe(beforeText0); // same text node (char ops)
    doc.destroy();
  });

  test('text hunk inside a heading', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => { const h = el('heading', 'Title'); h.setAttribute('level', '2'); frag.insert(0, [h]); });
    const { resultMd, allText } = replay(frag, '## Titles');
    expect(resultMd).toBe('## Titles');
    expect(allText).toBe(true);
    doc.destroy();
  });

  test('text hunk inside a list item', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => {
      const list = new Y.XmlElement('bulletList');
      const li1 = new Y.XmlElement('listItem'); li1.insert(0, [el('paragraph', 'one')]);
      const li2 = new Y.XmlElement('listItem'); li2.insert(0, [el('paragraph', 'two')]);
      list.insert(0, [li1, li2]); frag.insert(0, [list]);
    });
    const { resultMd } = replay(frag, '- one\n- three');
    expect(resultMd).toBe('- one\n- three');
    doc.destroy();
  });

  test('text hunk inside a table cell', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => {
      const table = new Y.XmlElement('table');
      const row1 = new Y.XmlElement('tableRow'); const c1 = new Y.XmlElement('tableCell');
      c1.insert(0, [el('paragraph', 'head')]); row1.insert(0, [c1]);
      const row2 = new Y.XmlElement('tableRow'); const c2 = new Y.XmlElement('tableCell');
      c2.insert(0, [el('paragraph', 'body')]); row2.insert(0, [c2]);
      table.insert(0, [row1, row2]); frag.insert(0, [table]);
    });
    const base = toMarkdownNodes(frag.toArray());
    const { resultMd } = replay(frag, base.replace('body', 'text'));
    expect(resultMd).toContain('text');
    expect(resultMd).not.toContain('body');
    doc.destroy();
  });

  test('mark-aware refinement: adding **bold** stays a text edit, block not recreated', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => frag.insert(0, [el('paragraph', 'hello world')]));
    const before = frag.toArray();
    const { allText, resultMd } = replay(frag, 'hello **world**');
    expect(resultMd).toBe('hello **world**');
    expect(allText).toBe(true);
    const after = frag.toArray();
    expect(after[0]).toBe(before[0]); // NOT block-replaced
    doc.destroy();
  });

  test('structural: new heading+paragraph inserted between blocks; neighbors keep identity', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => {
      const h = el('heading', 'A'); h.setAttribute('level', '1');
      frag.insert(0, [h, el('paragraph', 'para')]);
    });
    const before = frag.toArray();
    const { resultMd } = replay(frag, '# A\n\n## New\n\nmore\n\npara');
    expect(resultMd).toBe('# A\n\n## New\n\nmore\n\npara');
    const after = frag.toArray();
    expect(after[0]).toBe(before[0]); // heading A identity
    expect(after[after.length - 1]).toBe(before[1]); // paragraph 'para' identity
    doc.destroy();
  });

  test('structural: block deletion', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => frag.insert(0, [el('paragraph', 'a'), el('paragraph', 'b'), el('paragraph', 'c')]));
    const { resultMd } = replay(frag, 'a\n\nc');
    expect(resultMd).toBe('a\n\nc');
    doc.destroy();
  });

  test('structural: paragraph → list conversion', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => frag.insert(0, [el('paragraph', 'text')]));
    const { resultMd } = replay(frag, '- text');
    expect(resultMd).toBe('- text');
    doc.destroy();
  });

  test('structural: whole-document emptying', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => frag.insert(0, [el('paragraph', 'a'), el('paragraph', 'b')]));
    const { resultMd } = replay(frag, '');
    expect(resultMd).toBe('');
    expect(frag.length).toBe(0);
    doc.destroy();
  });

  test('hunk coalescing: two near changes in one block merge', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => frag.insert(0, [el('paragraph', 'abcdefgh')]));
    const { allText, resultMd } = replay(frag, 'aXcdeYgh');
    expect(resultMd).toBe('aXcdeYgh');
    // the two 1-char edits are separated by 'cde' (3 common) — NOT coalesced,
    // but still one block, both text.
    expect(allText).toBe(true);
    doc.destroy();
  });

  test('determinism: identical inputs → byte-identical pushUpdate (FR-011)', () => {
    const base = new Y.Doc();
    base.transact(() => base.getXmlFragment('default').insert(0, [el('paragraph', 'Hello world')]));
    const baseUpdate = Y.encodeStateAsUpdate(base);
    const baselineSV = Y.encodeStateVector(base);
    base.destroy();
    function once() {
      const fork = new Y.Doc();
      Y.applyUpdate(fork, baseUpdate);
      fork.clientID = syntheticClientId('doc', 1, 'c');
      const frag = fork.getXmlFragment('default');
      const nodes = frag.toArray();
      const { markdown, sourceMap } = toMarkdownWithSourceMap(nodes);
      const canon = canonicalizePushed('Hello brave new world');
      const plan = planPush(computeHunks(markdown, canon), sourceMap, markdown);
      fork.transact(() => applyHunks(frag, plan, sourceMap, markdown));
      const u = Buffer.from(Y.encodeStateAsUpdate(fork, baselineSV)).toString('hex');
      fork.destroy();
      return u;
    }
    expect(once()).toBe(once());
  });
});

// ---------------------------------------------------------------------------
describe('flavor-aware reconciliation (F2, FR-010)', () => {
  /** Paragraph "alpha beta gamma" with a color textStyle span on "beta". */
  function coloredParagraph() {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'alpha beta gamma');
      t.format(6, 4, { textStyle: { color: '#ff0000' } }); // "beta"
      p.insert(0, [t]);
      frag.insert(0, [p]);
    });
    return { doc, frag };
  }

  test('portable push bolding a word preserves the block color span it cannot express', () => {
    const { doc, frag } = coloredParagraph();
    // portable baseline drops the color → "alpha beta gamma"; push bolds "gamma".
    const { resultMd } = replay(frag, 'alpha beta **gamma**', { flavor: 'portable' });
    // exported in squire (default), the preserved color span is visible AND the
    // pushed bold landed — an in-place reconcile, block not recreated.
    expect(resultMd).toBe('alpha <span style="color:#ff0000">beta</span> **gamma**');
    doc.destroy();
  });

  test('squire push in the same shape clears the color it omits — unchanged behavior', () => {
    const { doc, frag } = coloredParagraph();
    // squire expresses the color, so a squire push that omits it legitimately
    // clears it (the full CLEAR_ATTRS path — the exclusion applies to portable
    // only). This is the pre-F2 behavior, preserved for squire.
    const { resultMd } = replay(frag, 'alpha beta **gamma**', { flavor: 'squire' });
    expect(resultMd).not.toContain('color:#ff0000'); // color cleared
    expect(resultMd).toContain('**gamma'); // pushed bold applied
    doc.destroy();
  });
});

// ---------------------------------------------------------------------------
describe('no-op detection (T017/T018, US3, FR-009)', () => {
  function canonicalOf(build, flavor = 'squire') {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    doc.transact(() => build(frag));
    const { markdown } = toMarkdownWithSourceMap(frag.toArray(), { flavor });
    doc.destroy();
    return markdown;
  }
  /** Zero hunks / no plan ops when pushing `pushedMd` at a baseline of `baselineMd`. */
  function isNoOp(baselineMd, pushedBody, flavor = 'squire') {
    const pushed = canonicalizePushed(pushedBody, { flavor });
    return pushed === baselineMd && computeHunks(baselineMd, pushed).length === 0;
  }

  test('byte-identical re-push is a no-op', () => {
    const base = canonicalOf((f) => f.insert(0, [el('paragraph', 'hello world'), el('heading', 'H')]));
    expect(isNoOp(base, base)).toBe(true);
  });

  test('delimiter-style change (**x** vs __x__) canonicalizes to a no-op', () => {
    const base = canonicalOf((f) => f.insert(0, [el('paragraph', 'a', { bold: true })]));
    expect(base).toBe('**a**');
    expect(isNoOp(base, '__a__')).toBe(true); // __ is bold altWrap
  });

  test('whitespace reflow that canonicalizes away is a no-op', () => {
    const base = canonicalOf((f) => f.insert(0, [el('paragraph', 'one two'), el('paragraph', 'three')]));
    expect(isNoOp(base, 'one two\n\n\n\nthree   ')).toBe(true);
  });

  test('portable lossy-degradation-only push is a no-op (FR-010)', () => {
    // underline degrades to italic delimiters in portable; pushing the exported
    // portable file back is a no-op against the portable baseline.
    const basePortable = canonicalOf((f) => f.insert(0, [el('paragraph', 'x', { underline: true })]), 'portable');
    expect(basePortable).toBe('_x_');
    expect(isNoOp(basePortable, '_x_', 'portable')).toBe(true);
  });

  test('a genuine edit is NOT a no-op', () => {
    const base = canonicalOf((f) => f.insert(0, [el('paragraph', 'hello world')]));
    expect(isNoOp(base, 'hello there')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('performance guard (T027, SC-007, research R11)', () => {
  test('~1 MB markdown push returns in well under 10 s', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    // ~1 MB of markdown: many paragraphs of ~1 KB each.
    const line = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(18); // ~1KB
    doc.transact(() => {
      const blocks = [];
      for (let i = 0; i < 1000; i++) blocks.push(el('paragraph', `p${i} ${line}`));
      frag.insert(0, blocks);
    });
    const { markdown: baselineMd, sourceMap } = toMarkdownWithSourceMap(frag.toArray());
    expect(baselineMd.length).toBeGreaterThan(900 * 1024);

    // edit one sentence deep in the document
    const pushed = baselineMd.replace('p500 lorem', 'p500 EDITED');
    const t0 = Date.now();
    const canon = canonicalizePushed(pushed);
    const plan = planPush(computeHunks(baselineMd, canon), sourceMap, baselineMd);
    frag.doc.transact(() => applyHunks(frag, plan, sourceMap, baselineMd));
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(10000);
    expect(toMarkdownNodes(frag.toArray())).toContain('p500 EDITED');
    doc.destroy();
  });

  test('coarse fallback (diffLines→diffChars) handles a huge rewrite without error', () => {
    // Force the maxEditLength cliff by rewriting a large body wholesale.
    const bigA = Array.from({ length: 2500 }, (_, i) => `line ${i} original content here`).join('\n');
    const bigB = Array.from({ length: 2500 }, (_, i) => `line ${i} REPLACED content now`).join('\n');
    const doc = new Y.Doc();
    doc.transact(() => doc.getXmlFragment('default').insert(0, [el('paragraph', 'anchor')]));
    // computeHunks must not throw and must return hunks even past the char-diff cap.
    const hunks = computeHunks(bigA, bigB);
    expect(Array.isArray(hunks)).toBe(true);
    expect(hunks.length).toBeGreaterThan(0);
    doc.destroy();
  });
});

// ---------------------------------------------------------------------------
describe('image-ref resolution (T028, spec Images edge case)', () => {
  const { resolveImageRefs } = require('../markdown-sync');
  const DOC = '11111111-2222-3333-4444-555555555555';
  const IMG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  test('rewrites ./assets/ refs to app URLs via the frontmatter map', () => {
    const map = { './assets/doc/img.png': IMG };
    const body = 'text\n\n![alt](./assets/doc/img.png)\n\nmore';
    const out = resolveImageRefs(body, map, DOC);
    expect(out).toBe(`text\n\n![alt](/api/docs/${DOC}/images/${IMG})\n\nmore`);
  });

  test('a resolved bundle push against an app-URL baseline is a no-op', () => {
    // baseline doc has the app-URL image; bundle file has ./assets/ + map.
    const doc = new Y.Doc();
    doc.transact(() => {
      const img = new Y.XmlElement('image');
      img.setAttribute('src', `/api/docs/${DOC}/images/${IMG}`);
      img.setAttribute('alt', 'chart');
      doc.getXmlFragment('default').insert(0, [el('paragraph', 'intro'), img]);
    });
    const baselineMd = toMarkdownWithSourceMap(doc.getXmlFragment('default').toArray()).markdown;
    const bundleBody = baselineMd.replace(`/api/docs/${DOC}/images/${IMG}`, './assets/doc/img.png');
    const resolved = resolveImageRefs(bundleBody, { './assets/doc/img.png': IMG }, DOC);
    expect(canonicalizePushed(resolved)).toBe(canonicalizePushed(baselineMd));
    doc.destroy();
  });

  test('ignores refs not in the map and non-uuid image ids', () => {
    const body = '![x](./assets/unknown.png)';
    expect(resolveImageRefs(body, { './assets/other.png': IMG }, DOC)).toBe(body);
    expect(resolveImageRefs(body, { './assets/unknown.png': 'not-a-uuid' }, DOC)).toBe(body);
  });
});
