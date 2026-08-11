/**
 * Convergence property test (feature 004, T015, FIRST-CLASS — FR-017/SC-002,
 * research R9). A push produces the SAME final document state as a real offline
 * Yjs collaborator making the same edits against the same baseline and
 * reconnecting — including with concurrent live edits and the clock-equal case.
 *
 * Each edit is expressed as direct Yjs ops so it can be applied two ways:
 *   (a) offline client — apply to a fork at the baseline, encode as an update;
 *   (b) push path — apply to a scratch doc, serialize to markdown, replay
 *       through markdown-sync.
 * Equality is asserted on canonical markdown + extractXml (structure + marks);
 * clientIDs differ between the two worlds by construction, so STATE — not
 * bytes — is the claim. Seed-fixed generation ⇒ deterministic CI.
 */
const Y = require('yjs');
const { toMarkdown, toMarkdownWithSourceMap } = require('../mcp/yjs/serialization');
const { extractXml } = require('../yjs-utils');
const {
  canonicalizePushedWithBlocks, computeHunks, planPush, applyHunks, syntheticClientId, sha256,
} = require('../markdown-sync');

// ---- builders --------------------------------------------------------------
function el(tag, text, attrs) {
  const e = new Y.XmlElement(tag);
  if (text !== undefined) { const t = new Y.XmlText(); t.insert(0, text, attrs); e.insert(0, [t]); }
  return e;
}
function listOf(items) {
  const list = new Y.XmlElement('bulletList');
  list.insert(0, items.map((txt) => { const li = new Y.XmlElement('listItem'); li.insert(0, [el('paragraph', txt)]); return li; }));
  return list;
}
function taskOf(items) {
  const tl = new Y.XmlElement('taskList');
  tl.insert(0, items.map(([checked, txt]) => {
    const ti = new Y.XmlElement('taskItem'); ti.setAttribute('checked', checked);
    ti.insert(0, [el('paragraph', txt)]); return ti;
  }));
  return tl;
}
function tableOf(rows) {
  const table = new Y.XmlElement('table');
  table.insert(0, rows.map((cells) => {
    const row = new Y.XmlElement('tableRow');
    row.insert(0, cells.map((c) => { const cell = new Y.XmlElement('tableCell'); cell.insert(0, [el('paragraph', c)]); return cell; }));
    return row;
  }));
  return table;
}

function baselineFrom(blocks) {
  const d = new Y.Doc();
  d.transact(() => d.getXmlFragment('default').insert(0, blocks()));
  const update = Y.encodeStateAsUpdate(d);
  const sv = Y.encodeStateVector(d);
  d.destroy();
  return { update, sv };
}
function clone(baseline) {
  const d = new Y.Doc();
  Y.applyUpdate(d, baseline.update);
  return d;
}
function makePushUpdate(baseline, pushedBody) {
  const fork = clone(baseline);
  const frag = fork.getXmlFragment('default');
  const { markdown, sourceMap } = toMarkdownWithSourceMap(frag.toArray());
  const { markdown: canon, blocks: pushedBlocks } = canonicalizePushedWithBlocks(pushedBody);
  fork.clientID = syntheticClientId('doc', 0, sha256(canon));
  const plan = planPush(
    computeHunks(markdown, canon, sourceMap.blocks, pushedBlocks), sourceMap, markdown);
  fork.transact(() => applyHunks(frag, plan, sourceMap, markdown));
  const u = Y.encodeStateAsUpdate(fork, baseline.sv);
  fork.destroy();
  return u;
}
function applyAll(baseline, updates) {
  const d = clone(baseline);
  for (const u of updates) if (u) Y.applyUpdate(d, u);
  return d;
}
function stateOf(d) {
  return { md: toMarkdown(d.get('default', Y.XmlFragment)), xml: extractXml(d) };
}
function paraIndices(frag) {
  const out = [];
  frag.toArray().forEach((n, i) => { if (n.nodeName === 'paragraph') out.push(i); });
  return out;
}

/**
 * Assert push ≡ offline-client for a baseline, an editFn (direct Yjs ops), and
 * an optional concurrent editFn (disjoint block).
 */
function assertConverges(baseline, editFn, concurrentFn) {
  // (a) offline client
  const client = clone(baseline);
  client.transact(() => editFn(client.getXmlFragment('default')));
  const clientUpdate = Y.encodeStateAsUpdate(client, baseline.sv);
  client.destroy();

  // (b) push path
  const scratch = clone(baseline);
  scratch.transact(() => editFn(scratch.getXmlFragment('default')));
  const pushedBody = toMarkdown(scratch.get('default', Y.XmlFragment));
  scratch.destroy();
  const pushUpdate = makePushUpdate(baseline, pushedBody);

  // concurrent live edit (disjoint), applied identically in both worlds
  let concurrentUpdate = null;
  if (concurrentFn) {
    const live = clone(baseline);
    live.transact(() => concurrentFn(live.getXmlFragment('default')));
    concurrentUpdate = Y.encodeStateAsUpdate(live, baseline.sv);
    live.destroy();
  }

  const worldA = applyAll(baseline, [concurrentUpdate, clientUpdate]);
  const worldB = applyAll(baseline, [concurrentUpdate, pushUpdate]);
  const a = stateOf(worldA);
  const b = stateOf(worldB);
  worldA.destroy(); worldB.destroy();
  expect(b.xml).toBe(a.xml);
  expect(b.md).toBe(a.md);
}

// ---- seed-fixed generator --------------------------------------------------
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

describe('convergence: push ≡ offline Yjs client (T015, SC-002)', () => {
  // Explicit acceptance-scenario shapes (US1/US2).
  test('US1: single-sentence text edit converges', () => {
    const base = baselineFrom(() => [el('paragraph', 'Retries use exponential backoff here'), el('paragraph', 'keep')]);
    assertConverges(base, (f) => { const t = f.get(0).get(0); t.delete(11, 19); t.insert(11, 'fixed 5s intervals'); });
  });
  test('US1: heading+paragraph inserted between blocks converges', () => {
    const base = baselineFrom(() => [el('heading', 'A'), el('paragraph', 'tail')]);
    assertConverges(base, (f) => f.insert(1, [(() => { const h = el('heading', 'New'); h.setAttribute('level', '2'); return h; })(), el('paragraph', 'more')]));
  });
  test('US2: disjoint concurrent edit — both survive, converges', () => {
    const base = baselineFrom(() => [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]);
    assertConverges(base,
      (f) => { const t = f.get(1).get(0); t.insert(t.length, ' pushed'); },
      (f) => { const t = f.get(0).get(0); t.insert(t.length, ' live'); });
  });
  test('clock-equal degenerate: no concurrent edit converges', () => {
    const base = baselineFrom(() => [el('paragraph', 'only')]);
    assertConverges(base, (f) => { const t = f.get(0).get(0); t.insert(4, ' one'); }, null);
  });
  test('task lists, tables, nested lists survive an unrelated paragraph edit', () => {
    const base = baselineFrom(() => [
      el('paragraph', 'intro'),
      taskOf([[false, 'todo'], [true, 'done']]),
      tableOf([['h1', 'h2'], ['a', 'b']]),
      listOf(['one', 'two']),
      el('paragraph', 'outro'),
    ]);
    assertConverges(base, (f) => { const t = f.get(0).get(0); t.insert(t.length, ' EDITED'); });
    assertConverges(base, (f) => { const t = f.get(4).get(0); t.delete(0, 2); });
  });
  test('mark toggle (bold) on a word converges', () => {
    const base = baselineFrom(() => [el('paragraph', 'make this bold word')]);
    assertConverges(base, (f) => f.get(0).get(0).format(10, 4, { bold: true }));
  });

  // Randomized corpus (seed-fixed).
  const rand = rng(0xC0FFEE);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const baselineFactories = [
    () => [el('heading', 'Doc'), el('paragraph', 'first paragraph text'), el('paragraph', 'second paragraph text')],
    () => [el('paragraph', 'aaa bbb ccc'), listOf(['one', 'two', 'three']), el('paragraph', 'zzz yyy xxx')],
    () => [el('paragraph', 'lead in'), taskOf([[false, 'alpha'], [false, 'beta']]), el('paragraph', 'trailer here')],
    () => [el('paragraph', 'p one two'), tableOf([['x', 'y'], ['1', '2']]), el('paragraph', 'q three four')],
    () => [el('paragraph', 'alpha bravo'), el('paragraph', 'charlie delta'), el('paragraph', 'echo foxtrot')],
  ];
  const edits = [
    (f, bi) => { const t = f.get(bi).get(0); t.insert(Math.min(3, t.length), 'INS '); },
    (f, bi) => { const t = f.get(bi).get(0); if (t.length > 4) t.delete(0, 4); },
    (f, bi) => { const t = f.get(bi).get(0); t.format(0, Math.min(3, t.length), { bold: true }); },
    (f) => { f.insert(f.length, [el('paragraph', 'appended tail block')]); },
    (f, bi) => { const t = f.get(bi).get(0); t.insert(t.length, ' suffix words'); },
  ];

  for (let i = 0; i < 40; i++) {
    test(`randomized case #${i}`, () => {
      const base = baselineFrom(pick(baselineFactories));
      // discover plain-paragraph indices from a scratch clone
      const probe = clone(base);
      const pIdx = paraIndices(probe.get('default', Y.XmlFragment));
      probe.destroy();
      const editBi = pick(pIdx);
      const edit = pick(edits);
      // concurrent edit on a DIFFERENT paragraph (disjoint), or none
      const others = pIdx.filter((x) => x !== editBi);
      const withConcurrent = rand() < 0.6 && others.length > 0;
      const cBi = withConcurrent ? pick(others) : null;
      const concurrentFn = withConcurrent
        ? (f) => { const t = f.get(cBi).get(0); t.insert(t.length, ' C'); }
        : null;
      assertConverges(base, (f) => edit(f, editBi), concurrentFn);
    });
  }
});
