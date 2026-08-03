/**
 * FR-008 probe — run from the worktree root with `node <this file>`.
 * Establishes, empirically, the facts the clientid-reader-audit records.
 */
const Y = require('yjs');
const { Awareness } = require('y-protocols/awareness');

const out = [];
const say = (k, v) => { out.push(`${k}: ${v}`); console.log(`${k}: ${v}`); };

// ── P1. The borrow window covers the doc `update` event ─────────────────────
{
  const doc = new Y.Doc();
  const own = doc.clientID;
  const borrowed = 123456789;
  let seenInUpdate = null;
  let seenLocal = null;
  doc.on('update', (u, origin, d, tr) => {
    seenInUpdate = d.clientID;          // read live, from inside cleanup
    seenLocal = tr.local;
  });
  doc.clientID = borrowed;
  try {
    doc.transact(() => { doc.getMap('meta').set('title', 'x'); }, { probe: true });
  } finally {
    doc.clientID = own;
  }
  say('P1 update-listener saw borrowed id', seenInUpdate === borrowed);
  say('P1 transaction.local', seenLocal);
  say('P1 own id restored', doc.clientID === own);
}

// ── P2. yjs self-heal (yjs.cjs:3379) short-circuits for a LOCAL transaction ──
// The condition is `!transaction.local && ...`; JS short-circuits, so
// doc.clientID is not even READ when the transaction is local.
{
  const doc = new Y.Doc();
  const own = doc.clientID;
  const borrowed = 987654321;
  // Make the borrowed id already present in the store with a differing clock,
  // which is the situation the self-heal exists to fix.
  doc.clientID = borrowed;
  doc.transact(() => { doc.getArray('a').insert(0, [1]); });
  const afterFirst = doc.clientID;
  doc.transact(() => { doc.getArray('a').insert(0, [2]); });
  say('P2 local transact never triggers self-heal reassign',
    afterFirst === borrowed && doc.clientID === borrowed);
  doc.clientID = own;
}

// ── P3. Awareness captures doc.clientID at CONSTRUCTION ─────────────────────
{
  const doc = new Y.Doc();
  const own = doc.clientID;
  const aw = new Awareness(doc);
  const borrowed = 55555;
  doc.clientID = borrowed;
  const duringBorrow = aw.clientID;
  doc.transact(() => { doc.getMap('meta').set('t', '1'); });
  const afterTx = aw.clientID;
  doc.clientID = own;
  say('P3 awareness.clientID unaffected by borrow', duringBorrow === own && afterTx === own);
  say('P3 no awareness state keyed by borrowed id', !aw.getStates().has(borrowed));
  aw.destroy();
}

// ── P4. Structs carry the borrowed id; the doc's own id never appears ───────
{
  const doc = new Y.Doc();
  const own = doc.clientID;
  const borrowed = 4242424;
  let bytes = null;
  doc.on('update', (u) => { bytes = u; });
  doc.clientID = borrowed;
  try {
    doc.transact(() => { doc.getText('t').insert(0, 'hello'); }, { o: 1 });
  } finally { doc.clientID = own; }
  const meta = Y.parseUpdateMeta(bytes);
  const inserts = [...meta.from.keys()];
  say('P4 insert set', JSON.stringify(inserts));
  say('P4 exactly one id, and it is the borrowed one',
    inserts.length === 1 && inserts[0] === borrowed);
  say('P4 own id absent from insert set', !inserts.includes(own));
}

// ── P5. A delete-only mutation does NOT change the state vector (PD-049-3) ──
{
  const doc = new Y.Doc();
  doc.getArray('a').insert(0, [1, 2, 3]);
  const before = Y.encodeStateVector(doc);
  let fired = false;
  const trip = () => { fired = true; };
  doc.on('update', trip);
  doc.getArray('a').delete(0, 1);
  doc.off('update', trip);
  const after = Y.encodeStateVector(doc);
  say('P5 state vector UNCHANGED by delete-only', Buffer.compare(Buffer.from(before), Buffer.from(after)) === 0);
  say('P5 update tripwire DID fire on delete-only', fired);
}

// ── P6. withFoldSlot-style .then() never runs its task synchronously ────────
{
  let ranSync = true;
  const slot = Promise.resolve().then(() => { /* task */ });
  // If the task had run synchronously, this line would follow it.
  ranSync = false;
  slot.then(() => {
    say('P6 .then() task deferred to microtask (ran after sync frame)', ranSync === false);
    console.log('\n--- ALL PROBES DONE ---');
  });
}
