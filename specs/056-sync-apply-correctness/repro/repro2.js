/* Harder shapes + chained repair-push convergence + receipt honesty. */
const Y = require('/local-dev/node_modules/yjs');
const { toMarkdownNodes, toMarkdownWithSourceMap } = require('/local-dev/server/mcp/yjs/serialization');
const {
  canonicalizePushedWithBlocks,
  computeHunks,
  planPush,
  applyHunks,
  buildChangeReport,
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

function multiBlockLinked() {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  doc.transact(() => {
    const h = new Y.XmlElement('heading'); h.setAttribute('level', '2');
    const ht = new Y.XmlText(); ht.insert(0, 'Deploy guide'); h.insert(0, [ht]);
    const p1 = new Y.XmlElement('paragraph');
    const t1 = new Y.XmlText(); t1.insert(0, 'Intro paragraph with plain text.'); p1.insert(0, [t1]);
    const p2 = new Y.XmlElement('paragraph');
    const t2 = new Y.XmlText();
    t2.insert(0, ' before deploying.');
    t2.insert(0, 'runbook', { link: { href: 'https://example.com/rb' } });
    t2.insert(0, 'Check the ');
    p2.insert(0, [t2]);
    const p3 = new Y.XmlElement('paragraph');
    const t3 = new Y.XmlText(); t3.insert(0, 'Outro text here.'); p3.insert(0, [t3]);
    frag.insert(0, [h, p1, p2, p3]);
  });
  return { doc, frag };
}

let fails = 0;
function scenario(name, mk, mutate, { repair = true } = {}) {
  const { doc, frag } = mk();
  const base = toMarkdownNodes(frag.toArray());
  const pushed = mutate(base);
  const r1 = pushOnce(frag, pushed);
  const p1ok = r1.resultMd === r1.pushedCanon;
  console.log(`\n=== ${name} — push1 ${p1ok ? 'PASS' : 'FAIL'} ===`);
  if (!p1ok) {
    fails++;
    console.log('baseline:', JSON.stringify(r1.baselineMd));
    console.log('pushed:  ', JSON.stringify(r1.pushedCanon));
    console.log('result:  ', JSON.stringify(r1.resultMd));
    console.log('hunks:', JSON.stringify(r1.hunks.map(h => ({ oldStart: h.oldStart, oldEnd: h.oldEnd, newText: h.newText, forced: !!h.forced }))));
    console.log('plan: text=%d rec=%d struct=%d', r1.plan.textBlocks.length, r1.plan.reconcileBlocks.length, r1.plan.structural.length);
    console.log('blocksChanged:', JSON.stringify(r1.blocksChanged));
    if (repair) {
      // repair loop: push the SAME desired markdown against fresh re-export, up to 3x
      let prev = r1.resultMd;
      for (let i = 2; i <= 4; i++) {
        const r = pushOnce(frag, pushed);
        const ok = r.resultMd === r.pushedCanon;
        const applied = r.resultMd !== prev;
        console.log(`  repair push${i}: ${ok ? 'CONVERGED' : 'STILL WRONG'}; appliedAnything=${applied}; ops=${JSON.stringify(r.ops)}; blocksChanged=${r.blocksChanged.length}`);
        console.log('    result:', JSON.stringify(r.resultMd));
        if (!ok && !applied && r.blocksChanged.length > 0) {
          console.log('    *** RECEIPT LIE: blocksChanged reported but nothing applied ***');
          console.log('    blocksChanged:', JSON.stringify(r.blocksChanged));
        }
        prev = r.resultMd;
        if (ok) break;
      }
    }
  }
  doc.destroy();
}

const rb = 'https://example.com/rb';

// URL-only edit (range entirely in syntax)
scenario('U1 change URL only', linkedParagraph, (b) => b.replace('/rb', '/rb2'));
// URL edit + text edit elsewhere in same paragraph (mixed classification trap)
scenario('U2 URL edit + word swap same para', linkedParagraph, (b) => b.replace('Check', 'Consult').replace('/rb', '/rb2'));
// URL edit + link text edit
scenario('U3 URL + display text edit', linkedParagraph, (b) => b.replace('runbook]', 'playbook]').replace('/rb', '/rb2'));
// URL edit + bold added elsewhere (reconcile+structural mix)
scenario('U4 URL edit + bold a word', linkedParagraph, (b) => b.replace('deploying', '**shipping**').replace('/rb', '/rb2'));
// delete the link entirely (unwrap to plain text)
scenario('D1 unwrap link to plain text', linkedParagraph, (b) => b.replace(`[runbook](${rb})`, 'runbook'));
// delete link + edit elsewhere
scenario('D2 unwrap link + word swap', linkedParagraph, (b) => b.replace(`[runbook](${rb})`, 'runbook').replace('Check', 'Consult'));
// move the link to another spot in the sentence
scenario('M1 move link within sentence', linkedParagraph, () => `Before deploying, check the [runbook](${rb}).`);
// add a second link
scenario('A1 add second link', linkedParagraph, (b) => b.replace('deploying.', `deploying per the [SOP](https://example.com/sop).`));
// coalescing trap: edits 1-2 chars on both sides of '['
scenario('C1 edits hugging [ on both sides', linkedParagraph, (b) => b.replace('the [runbook]', 'thy [Runbook]'));
// coalescing trap: edits hugging ]( on both sides (link text end + url start)
scenario('C2 edits hugging ]( both sides', linkedParagraph, (b) => b.replace('runbook](https', 'runbooks](http0s').replace('http0s', 'https'));
// edit hugging closing paren both sides: url end + text after
scenario('C3 url tail + following text', linkedParagraph, (b) => b.replace('/rb) before', '/rb2) after'));
// wholesale sentence rewrite keeping the link
scenario('W1 rewrite around kept link', linkedParagraph, () => `Always read the [runbook](${rb}) first.`);
// multi-block: same traps inside a larger doc
scenario('MB1 URL edit + word swap (multi-block)', multiBlockLinked, (b) => b.replace('Check', 'Consult').replace('/rb', '/rb2'));
scenario('MB2 unwrap link + edits in other blocks', multiBlockLinked, (b) => b.replace(`[runbook](${rb})`, 'runbook').replace('Intro', 'Introduction').replace('Outro', 'Closing'));
scenario('MB3 move link paragraph + edit it', multiBlockLinked, (b) => {
  // swap p2 and p3 order and tweak link text
  return b.replace('Check the [runbook](https://example.com/rb) before deploying.\n\nOutro text here.',
    'Outro text here.\n\nCheck the [playbook](https://example.com/rb) before deploying.');
});

console.log(`\n${fails} failing scenario(s)`);
process.exit(fails ? 1 : 0);
