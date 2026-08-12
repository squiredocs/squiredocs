/* Mark-inheritance trap at link boundary + repair-loop convergence + stale-baseline noop. */
const Y = require('/local-dev/node_modules/yjs');
const { toMarkdownNodes, toMarkdownWithSourceMap } = require('/local-dev/server/mcp/yjs/serialization');
const {
  canonicalizePushedWithBlocks,
  computeHunks, planPush, applyHunks, buildChangeReport, syntheticClientId, sha256,
} = require('/local-dev/server/markdown-sync');

function pushOnce(frag, pushedMd, flavor = 'squire') {
  const nodes = frag.toArray();
  const { markdown: baselineMd, sourceMap } = toMarkdownWithSourceMap(nodes, { flavor });
  const { markdown: pushedCanon, blocks: pushedBlocks } = canonicalizePushedWithBlocks(pushedMd, { flavor });
  const hunks = computeHunks(baselineMd, pushedCanon, sourceMap.blocks, pushedBlocks);
  const plan = planPush(hunks, sourceMap, baselineMd);
  const blocksChanged = buildChangeReport(plan, sourceMap, baselineMd);
  let ops;
  frag.doc.transact(() => { ops = applyHunks(frag, plan, sourceMap, baselineMd, { flavor }); });
  return { baselineMd, pushedCanon, hunks, plan, ops, blocksChanged, resultMd: toMarkdownNodes(frag.toArray()) };
}

function linkedParagraph(tail = ' before deploying.') {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, tail);
    t.insert(0, 'runbook', { link: { href: 'https://example.com/rb' } });
    t.insert(0, 'Check the ');
    p.insert(0, [t]);
    frag.insert(0, [p]);
  });
  return { doc, frag };
}
function boldParagraph() {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, ' before deploying.');
    t.insert(0, 'runbook', { bold: true });
    t.insert(0, 'Check the ');
    p.insert(0, [t]);
    frag.insert(0, [p]);
  });
  return { doc, frag };
}

function repairLoop(name, mk, mutate, maxPush = 5) {
  const { doc, frag } = mk();
  const base = toMarkdownNodes(frag.toArray());
  const pushed = typeof mutate === 'function' ? mutate(base) : mutate;
  console.log(`\n=== ${name} ===`);
  console.log('baseline:', JSON.stringify(base));
  console.log('pushed:  ', JSON.stringify(pushed));
  let prev = base;
  for (let i = 1; i <= maxPush; i++) {
    const r = pushOnce(frag, pushed);
    const ok = r.resultMd === r.pushedCanon;
    console.log(`push${i}: ${ok ? 'CONVERGED' : 'WRONG'}; changed=${r.resultMd !== prev}; ops=${JSON.stringify(r.ops)}; blocksChanged=${r.blocksChanged.length}`);
    console.log('  result:', JSON.stringify(r.resultMd));
    if (!ok && r.resultMd === prev) {
      console.log('  *** STUCK: doc unchanged, would loop forever (each repair sync reports ops but applies nothing effective) ***');
      console.log('  hunks:', JSON.stringify(r.hunks.map(h => ({ oldStart: h.oldStart, oldEnd: h.oldEnd, newText: h.newText, forced: !!h.forced }))));
      console.log('  blocksChanged:', JSON.stringify(r.blocksChanged));
      break;
    }
    prev = r.resultMd;
    if (ok) break;
  }
  doc.destroy();
}

// --- The comma / boundary-insertion trap: insert text right AFTER the closing mark boundary
repairLoop('P1 comma right after link', linkedParagraph,
  (b) => b.replace(') before', '), before'));
repairLoop('P2 word inserted right after link (no leading space)', linkedParagraph,
  'Check the [runbook](https://example.com/rb)s before deploying.');
repairLoop('P3 comma right after bold', boldParagraph,
  (b) => b.replace('** before', '**, before'));
repairLoop('P4 insert word right before link text start', linkedParagraph,
  'Check the my[runbook](https://example.com/rb) before deploying.');

// --- Stale-baseline repair: full applySyncPush-shaped emulation with pinned clientID +
//     pushIsAlreadyApplied snapshot check (no DB: baseline = captured update bytes).
function emulateSyncPush(liveDoc, baselineUpdate, body, docGuid = 'doc-g', baselineClock = 7) {
  const fork = new Y.Doc();
  Y.applyUpdate(fork, baselineUpdate);
  const fragment = fork.get('default', Y.XmlFragment);
  const baselineSV = Y.encodeStateVector(fork);
  const { markdown: canonicalMd, sourceMap } = toMarkdownWithSourceMap(fragment.toArray(), { flavor: 'squire' });
  const { markdown: pushedMd, blocks: pushedBlocks } = canonicalizePushedWithBlocks(body, { flavor: 'squire' });
  if (pushedMd === canonicalMd) { fork.destroy(); return { noop: true, reason: 'canonical-equal' }; }
  fork.clientID = syntheticClientId(docGuid, baselineClock, sha256(pushedMd));
  const hunks = computeHunks(canonicalMd, pushedMd, sourceMap.blocks, pushedBlocks);
  const plan = planPush(hunks, sourceMap, canonicalMd);
  const blocksChanged = buildChangeReport(plan, sourceMap, canonicalMd);
  let operations;
  fork.transact(() => { operations = applyHunks(fragment, plan, sourceMap, canonicalMd, { flavor: 'squire' }); });
  const pushUpdate = Y.encodeStateAsUpdate(fork, baselineSV);
  fork.destroy();
  // pushIsAlreadyApplied
  const probe = new Y.Doc({ gc: false });
  Y.applyUpdate(probe, Y.encodeStateAsUpdate(liveDoc));
  const before = Y.snapshot(probe);
  Y.applyUpdate(probe, pushUpdate);
  const after = Y.snapshot(probe);
  const already = Y.equalSnapshots(before, after);
  probe.destroy();
  if (already) return { noop: true, reason: 'already-applied', operations, blocksChanged };
  Y.applyUpdate(liveDoc, pushUpdate);
  return { noop: false, operations, blocksChanged };
}

console.log('\n=== S1 stale-baseline repair after partial misapply (U2 shape) ===');
{
  const { doc, frag } = linkedParagraph();
  const baselineUpdate = Y.encodeStateAsUpdate(doc);
  const desired = 'Consult the [runbook](https://example.com/rb2) before deploying.';
  const r1 = emulateSyncPush(doc, baselineUpdate, desired);
  console.log('push1 receipt: noop=%s ops=%s blocksChanged=%s', r1.noop, JSON.stringify(r1.operations), JSON.stringify(r1.blocksChanged));
  console.log('doc after push1:', JSON.stringify(toMarkdownNodes(frag.toArray())));
  // agent re-runs the same file (frontmatter still carries baseline clock 7)
  const r2 = emulateSyncPush(doc, baselineUpdate, desired);
  console.log('push2 (same file, same baseline) receipt: noop=%s reason=%s ops=%s blocksChanged=%d',
    r2.noop, r2.reason, JSON.stringify(r2.operations), (r2.blocksChanged || []).length);
  console.log('doc after push2:', JSON.stringify(toMarkdownNodes(frag.toArray())));
  const stillWrong = toMarkdownNodes(frag.toArray()) !== desired;
  console.log(stillWrong && r2.noop
    ? '*** REPRODUCED: repair sync reports noop/success while doc still != pushed file ***'
    : 'not reproduced');
  doc.destroy();
}
process.exit(0);
