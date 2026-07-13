/**
 * Order-independence & idempotent retries (feature 004, T014, US2 / SC-004,
 * FR-011/D5). A push's CRDT update merges with concurrent live edits the same
 * way regardless of arrival order, and a retried identical push is deduped.
 * Also asserts the protocol has no conflict-based rejection / retry / CAS path.
 */
const fs = require('fs');
const path = require('path');
const Y = require('yjs');
const { toMarkdown, toMarkdownWithSourceMap } = require('../mcp/yjs/serialization');
const { extractXml } = require('../yjs-utils');
const {
  canonicalizePushed, computeHunks, planPush, applyHunks, syntheticClientId, sha256,
} = require('../markdown-sync');

function el(tag, text) {
  const e = new Y.XmlElement(tag);
  if (text !== undefined) { const t = new Y.XmlText(); t.insert(0, text); e.insert(0, [t]); }
  return e;
}
function baselineOf(build) {
  const d = new Y.Doc();
  d.transact(() => build(d.getXmlFragment('default')));
  const update = Y.encodeStateAsUpdate(d);
  const sv = Y.encodeStateVector(d);
  d.destroy();
  return { update, sv };
}
/** Produce a pushUpdate for editing a baseline to `pushedBody` (mirrors applySyncPush replay). */
function makePushUpdate(baseline, pushedBody) {
  const fork = new Y.Doc();
  Y.applyUpdate(fork, baseline.update);
  const frag = fork.getXmlFragment('default');
  const { markdown, sourceMap } = toMarkdownWithSourceMap(frag.toArray());
  const canon = canonicalizePushed(pushedBody);
  fork.clientID = syntheticClientId('doc', 0, sha256(canon));
  const plan = planPush(computeHunks(markdown, canon), sourceMap, markdown);
  fork.transact(() => applyHunks(frag, plan, sourceMap, markdown));
  const u = Y.encodeStateAsUpdate(fork, baseline.sv);
  fork.destroy();
  return u;
}
/** A concurrent live edit encoded relative to the baseline. */
function makeConcurrent(baseline, editFn) {
  const live = new Y.Doc();
  Y.applyUpdate(live, baseline.update);
  live.transact(() => editFn(live.getXmlFragment('default')));
  const u = Y.encodeStateAsUpdate(live, baseline.sv);
  live.destroy();
  return u;
}
function apply(baseline, updates) {
  const d = new Y.Doc();
  Y.applyUpdate(d, baseline.update);
  for (const u of updates) Y.applyUpdate(d, u);
  return d;
}
function stateOf(d) {
  return { md: toMarkdown(d.get('default', Y.XmlFragment)), xml: extractXml(d) };
}

describe('order-independence (T014, SC-004)', () => {
  test('pushUpdate merges with a concurrent disjoint edit regardless of order', () => {
    const base = baselineOf((f) => f.insert(0, [el('paragraph', 'Alpha'), el('paragraph', 'Bravo')]));
    const push = makePushUpdate(base, 'Alpha\n\nBravo edited'); // edits block B
    const concurrent = makeConcurrent(base, (f) => f.get(0).get(0).insert(5, ' live')); // edits block A

    const before = apply(base, [push, concurrent]);
    const after = apply(base, [concurrent, push]);
    expect(stateOf(before)).toEqual(stateOf(after));
    // both edit streams present
    expect(stateOf(before).md).toContain('Bravo edited');
    expect(stateOf(before).md).toContain('Alpha live');
    before.destroy(); after.destroy();
  });

  test('interleaving with multiple concurrent updates is order-independent', () => {
    const base = baselineOf((f) =>
      f.insert(0, [el('paragraph', 'One'), el('paragraph', 'Two'), el('paragraph', 'Three')]));
    const push = makePushUpdate(base, 'One\n\nTwo\n\nThree pushed');
    const c1 = makeConcurrent(base, (f) => f.get(0).get(0).insert(3, '!'));
    const c2 = makeConcurrent(base, (f) => f.get(1).get(0).insert(3, '?'));

    const orders = [[push, c1, c2], [c1, push, c2], [c1, c2, push], [c2, c1, push]];
    const states = orders.map((o) => stateOf(apply(base, o)));
    for (const s of states) expect(s).toEqual(states[0]);
  });

  test('idempotent retry: applying an identical pushUpdate twice does not double content (D5)', () => {
    const base = baselineOf((f) => f.insert(0, [el('paragraph', 'Hello world')]));
    const push = makePushUpdate(base, 'Hello brave world');
    const once = apply(base, [push]);
    const twice = apply(base, [push, push]); // retried delivery
    expect(stateOf(once)).toEqual(stateOf(twice));
    // exactly one occurrence of the inserted word — no doubled blocks/content
    expect(stateOf(twice).md.match(/brave/g).length).toBe(1);
    once.destroy(); twice.destroy();
  });

  test('two identical pushes from the same baseline are byte-identical (retry dedup)', () => {
    const base = baselineOf((f) => f.insert(0, [el('paragraph', 'Hello world')]));
    const a = Buffer.from(makePushUpdate(base, 'Hello there')).toString('hex');
    const b = Buffer.from(makePushUpdate(base, 'Hello there')).toString('hex');
    expect(a).toBe(b);
  });

  test('no conflict-based rejection / retry / compare-and-set in the protocol', () => {
    const engine = fs.readFileSync(path.join(__dirname, '..', 'markdown-sync.js'), 'utf8');
    const route = fs.readFileSync(path.join(__dirname, '..', 'api', 'docs-import.js'), 'utf8');
    // no compare-and-set / conflict-retry anywhere in the sync engine
    expect(/compareAndSet|compare-and-set/i.test(engine)).toBe(false);
    // the ONLY 409 anywhere (engine or route) is the docGuid IDENTITY mismatch,
    // never an edit conflict — the protocol has no conflict-based rejection.
    for (const src of [engine, route]) {
      for (const line of src.split('\n')) {
        if (/\b409\b/.test(line)) expect(line).toMatch(/sync_doc_mismatch/);
      }
    }
  });
});
