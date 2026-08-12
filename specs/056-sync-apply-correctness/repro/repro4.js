/* Fuzz: link-bearing paragraph edits; detect non-convergence and ]( leaks. */
const Y = require('/local-dev/node_modules/yjs');
const { toMarkdownNodes, toMarkdownWithSourceMap } = require('/local-dev/server/mcp/yjs/serialization');
const {
  canonicalizePushedWithBlocks, computeHunks, planPush, applyHunks,
} = require('/local-dev/server/markdown-sync');

function pushOnce(frag, pushedMd) {
  const nodes = frag.toArray();
  const { markdown: baselineMd, sourceMap } = toMarkdownWithSourceMap(nodes, { flavor: 'squire' });
  const { markdown: pushedCanon, blocks: pushedBlocks } = canonicalizePushedWithBlocks(pushedMd, { flavor: 'squire' });
  const hunks = computeHunks(baselineMd, pushedCanon, sourceMap.blocks, pushedBlocks);
  const plan = planPush(hunks, sourceMap, baselineMd);
  frag.doc.transact(() => { applyHunks(frag, plan, sourceMap, baselineMd, { flavor: 'squire' }); });
  return { baselineMd, pushedCanon, hunks, plan, resultMd: toMarkdownNodes(frag.toArray()) };
}

function mkDoc(builder) {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  doc.transact(() => builder(frag));
  return { doc, frag };
}
function linkPara(frag, pre, linkText, url, post) {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, post);
  t.insert(0, linkText, { link: { href: url } });
  t.insert(0, pre);
  p.insert(0, [t]);
  frag.insert(0, [p]);
}

const URL1 = 'https://example.com/rb';
const cases = [
  // convert a plain word to a link (same URL as existing link)
  ['F1 linkify word, same url', (b) => b.replace('deploying', `[deploying](${URL1})`)],
  // convert a plain word to a link (different URL)
  ['F2 linkify word, new url', (b) => b.replace('deploying', '[deploying](https://example.com/dep)')],
  // swap which word is linked
  ['F3 move link to other word', (b) => b
    .replace(`[runbook](${URL1})`, 'runbook')
    .replace('deploying', `[deploying](${URL1})`)],
  // change url AND add punctuation after link
  ['F4 url edit + comma after link', (b) => b.replace('/rb)', '/rb2),')],
  // parenthetical right after the link
  ['F5 parenthetical after link', (b) => b.replace(') before', ') (updated) before')],
  // insert text containing brackets after link
  ['F6 bracketed note after link', (b) => b.replace(') before', ') [sic] before')],
  // extend the link text leftward (word joins the link)
  ['F7 pull preceding word into link', (b) => b.replace(`the [runbook](${URL1})`, `[the runbook](${URL1})`)],
  // shrink the link text (word leaves the link to the right)
  ['F8 push word out of link', (b) => b.replace(`[runbook](${URL1}) before`, `[run](${URL1})book before`)],
  // replace link wholesale with different text+url plus outside edit
  ['F9 replace link + outside edit', (b) => b
    .replace(`[runbook](${URL1})`, '[handbook](https://example.com/hb)')
    .replace('Check', 'Read')],
  // double edit: punctuation after link + word swap before
  ['F10 comma after link + word swap', (b) => b.replace(') before', '), before').replace('Check', 'Consult')],
];

let fails = 0;
for (const [name, mutate] of cases) {
  const { doc, frag } = mkDoc((f) => linkPara(f, 'Check the ', 'runbook', URL1, ' before deploying.'));
  const base = toMarkdownNodes(frag.toArray());
  const pushed = mutate(base);
  const results = [];
  let converged = false;
  let prev = base;
  for (let i = 1; i <= 4; i++) {
    const r = pushOnce(frag, pushed);
    results.push(r);
    if (r.resultMd === r.pushedCanon) { converged = true; break; }
    if (r.resultMd === prev) break; // stuck
    prev = r.resultMd;
  }
  const last = results[results.length - 1];
  if (!converged) {
    fails++;
    console.log(`\n=== ${name} — FAIL after ${results.length} push(es) ===`);
    console.log('baseline:', JSON.stringify(base));
    console.log('pushed:  ', JSON.stringify(last.pushedCanon));
    results.forEach((r, i) => console.log(`  push${i + 1} result:`, JSON.stringify(r.resultMd)));
    const leak = /\\\[|\\\]|\]\(/.test(last.resultMd.replace(/\[[^\]]*\]\([^)]*\)/g, ''));
    if (leak) console.log('  *** RAW LINK SYNTAX LEAKED INTO TEXT ***');
    console.log('  last hunks:', JSON.stringify(last.hunks.map(h => ({ oldStart: h.oldStart, oldEnd: h.oldEnd, newText: h.newText, forced: !!h.forced }))));
    console.log('  last plan: text=%d rec=%d struct=%d', last.plan.textBlocks.length, last.plan.reconcileBlocks.length, last.plan.structural.length);
  } else if (results.length > 1) {
    console.log(`\n--- ${name}: converged but took ${results.length} pushes (push1 misapplied) ---`);
    results.forEach((r, i) => console.log(`  push${i + 1} result:`, JSON.stringify(r.resultMd)));
  } else {
    console.log(`${name}: PASS (1 push)`);
  }
  doc.destroy();
}
console.log(`\n${fails} non-converging case(s)`);
process.exit(0);
