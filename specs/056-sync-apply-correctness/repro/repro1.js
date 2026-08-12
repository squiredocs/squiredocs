/* Scenario 1: zero-concurrency link-paragraph edits, replay harness (no DB). */
const Y = require('/local-dev/node_modules/yjs');
const { toMarkdownNodes, toMarkdownWithSourceMap } = require('/local-dev/server/mcp/yjs/serialization');
const {
  canonicalizePushedWithBlocks,
  computeHunks,
  planPush,
  applyHunks,
  buildChangeReport,
} = require('/local-dev/server/markdown-sync');

function replay(frag, pushedMd, opts = {}) {
  const flavor = opts.flavor || 'squire';
  const nodes = frag.toArray();
  const { markdown: baselineMd, sourceMap } = toMarkdownWithSourceMap(nodes, { flavor });
  const { markdown: pushedCanon, blocks: pushedBlocks } = canonicalizePushedWithBlocks(pushedMd, { flavor });
  const hunks = computeHunks(baselineMd, pushedCanon, sourceMap.blocks, pushedBlocks);
  const plan = planPush(hunks, sourceMap, baselineMd);
  const blocksChanged = buildChangeReport(plan, sourceMap, baselineMd);
  let ops;
  frag.doc.transact(() => { ops = applyHunks(frag, plan, sourceMap, baselineMd, { flavor }); });
  return {
    baselineMd, pushedCanon, hunks, plan, ops, blocksChanged,
    resultMd: toMarkdownNodes(frag.toArray()),
  };
}

function linkedParagraph() {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, ' before deploying.');
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

function scenario(name, mk, pushed) {
  const { doc, frag } = mk();
  const r = replay(frag, pushed);
  const pass = r.resultMd === r.pushedCanon;
  console.log(`\n=== ${name} — ${pass ? 'PASS' : 'FAIL'} ===`);
  console.log('baseline:', JSON.stringify(r.baselineMd));
  console.log('pushed:  ', JSON.stringify(r.pushedCanon));
  console.log('result:  ', JSON.stringify(r.resultMd));
  if (!pass) {
    console.log('hunks:', JSON.stringify(r.hunks, (k, v) => (k === 'blocks' ? undefined : v)));
    console.log('plan: textBlocks=%d reconcile=%d structural=%d',
      r.plan.textBlocks.length, r.plan.reconcileBlocks.length, r.plan.structural.length);
    for (const tb of r.plan.textBlocks) console.log('  textBlock hunks:', JSON.stringify(tb.hunks.map(h => ({ oldStart: h.oldStart, oldEnd: h.oldEnd, newText: h.newText }))));
    for (const s of r.plan.structural) console.log('  structural:', JSON.stringify({ oldStart: s.oldStart, oldEnd: s.oldEnd, newText: s.newText, forced: !!s.forced, nBlocks: (s.blocks||[]).length }));
    console.log('blocksChanged:', JSON.stringify(r.blocksChanged));
    console.log('ops:', JSON.stringify(r.ops));
  }
  doc.destroy();
  return pass;
}

const BASE = 'Check the [runbook](https://example.com/rb) before deploying.';
const BOLD = 'Check the **runbook** before deploying.';

let fails = 0;
// link shape
fails += !scenario('L1 word swap before link', linkedParagraph, BASE.replace('Check', 'Consult'));
fails += !scenario('L2 edit link display text', linkedParagraph, BASE.replace('runbook', 'playbook'));
fails += !scenario('L3 append char to link text (adjacent to ]( )', linkedParagraph, BASE.replace('runbook]', 'runbooks]'));
fails += !scenario('L4 edit immediately after closing paren', linkedParagraph, BASE.replace(' before', ' prior to'));
fails += !scenario('L5 multi-edit before+after link', linkedParagraph, BASE.replace('Check', 'Consult').replace('deploying', 'shipping'));
fails += !scenario('L6 multi-edit incl link text', linkedParagraph, BASE.replace('Check', 'Consult').replace('runbook]', 'playbook]'));
fails += !scenario('L7 edit text right before [', linkedParagraph, BASE.replace('the [', 'that ['));
// bold shape
fails += !scenario('B1 word swap before bold', boldParagraph, BOLD.replace('Check', 'Consult'));
fails += !scenario('B2 edit bold text', boldParagraph, BOLD.replace('runbook', 'playbook'));
fails += !scenario('B3 append char to bold text', boldParagraph, BOLD.replace('runbook*', 'runbooks*'));
fails += !scenario('B4 edit after bold', boldParagraph, BOLD.replace(' before', ' prior to'));
fails += !scenario('B5 multi-edit before+after bold', boldParagraph, BOLD.replace('Check', 'Consult').replace('deploying', 'shipping'));
console.log(`\n${fails} failing scenario(s)`);
