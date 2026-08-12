/**
 * Feature 057 T004 — verified-clock helpers (data-model invariant).
 *
 * The claim under test is the one the whole feature rests on: `_verifiedClock`
 * is advanced only over rows the document PROVABLY integrated, contiguously,
 * and never walks backwards. No database here — these are pure Yjs/state-vector
 * mechanics.
 */
const Y = require('yjs');
const {
  dominates,
  rowsCovered,
  advanceVerifiedClock,
  rowBytes,
} = require('../verified-clock');

/**
 * A chain of causally-dependent updates from ONE client, plus a doc that has
 * integrated none of them. Update i appends `para-i`; each is encoded against
 * the state vector before it, so it is a true incremental row exactly as
 * storeUpdate persists.
 */
function buildUpdateChain(count) {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  const updates = [];
  for (let i = 0; i < count; i++) {
    const sv = Y.encodeStateVector(doc);
    doc.transact(() => {
      const el = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, `para-${i}`);
      el.insert(0, [t]);
      frag.push([el]);
    });
    updates.push(Y.encodeStateAsUpdate(doc, sv));
  }
  return updates;
}

/** Rows in the shape `getUpdatesInRange({ includeData: true })` returns. */
const asRows = (updates, startClock = 0) =>
  updates.map((updateData, i) => ({ clock: startClock + i, updateData }));

/** A doc with updates [0..n) of the chain applied. */
function docWith(updates, n) {
  const doc = new Y.Doc();
  for (let i = 0; i < n; i++) Y.applyUpdate(doc, updates[i]);
  return doc;
}

describe('dominates', () => {
  test('a doc dominates its own state vector and everything below it', () => {
    const updates = buildUpdateChain(3);
    const doc = docWith(updates, 3);
    const behind = docWith(updates, 1);

    expect(dominates(Y.encodeStateVector(doc), Y.encodeStateVector(doc))).toBe(true);
    expect(dominates(Y.encodeStateVector(doc), Y.encodeStateVector(behind))).toBe(true);
    expect(dominates(Y.encodeStateVector(behind), Y.encodeStateVector(doc))).toBe(false);
  });

  test('an empty vector is dominated by everything and dominates only empties', () => {
    const updates = buildUpdateChain(2);
    const doc = docWith(updates, 2);
    const empty = Y.encodeStateVector(new Y.Doc());

    expect(dominates(Y.encodeStateVector(doc), empty)).toBe(true);
    expect(dominates(empty, empty)).toBe(true);
    expect(dominates(empty, Y.encodeStateVector(doc))).toBe(false);
  });

  test('clients present in B but absent from A count as clock 0 in A', () => {
    // Two independent docs = two clientIDs, neither containing the other.
    const a = new Y.Doc();
    a.getXmlFragment('default').push([new Y.XmlElement('paragraph')]);
    const b = new Y.Doc();
    b.getXmlFragment('default').push([new Y.XmlElement('paragraph')]);

    expect(dominates(Y.encodeStateVector(a), Y.encodeStateVector(b))).toBe(false);
    expect(dominates(Y.encodeStateVector(b), Y.encodeStateVector(a))).toBe(false);

    // Merge b into a and a now covers both.
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(dominates(Y.encodeStateVector(a), Y.encodeStateVector(b))).toBe(true);
  });

  test('accepts Maps as well as encoded buffers', () => {
    const updates = buildUpdateChain(2);
    const doc = docWith(updates, 2);
    const asMap = Y.decodeStateVector(Y.encodeStateVector(doc));

    expect(dominates(asMap, Y.encodeStateVector(doc))).toBe(true);
    expect(dominates(Y.encodeStateVector(doc), asMap)).toBe(true);
  });
});

describe('rowsCovered', () => {
  test('reports exactly the rows the doc has integrated', () => {
    const updates = buildUpdateChain(5);
    const doc = docWith(updates, 3); // rows 0,1,2 integrated; 3,4 not

    expect(rowsCovered(doc, asRows(updates))).toEqual([true, true, true, false, false]);
  });

  test('a fully current doc covers every row', () => {
    const updates = buildUpdateChain(4);
    expect(rowsCovered(docWith(updates, 4), asRows(updates))).toEqual([true, true, true, true]);
  });

  test('an empty row list returns an empty array and touches nothing', () => {
    expect(rowsCovered(new Y.Doc(), [])).toEqual([]);
    expect(rowsCovered(new Y.Doc(), undefined)).toEqual([]);
  });

  test('fails CLOSED on rows with no bytes — never advances on an assumption', () => {
    const updates = buildUpdateChain(2);
    const doc = docWith(updates, 2); // has everything

    // A row fetched WITHOUT includeData proves nothing, even though the doc in
    // fact holds that content.
    expect(rowsCovered(doc, [{ clock: 0 }])).toEqual([false]);
    expect(rowsCovered(doc, [{ clock: 0, updateData: null }])).toEqual([false]);
    expect(rowsCovered(doc, [{ clock: 0, updateData: new Uint8Array(0) }])).toEqual([false]);
  });

  test('fails CLOSED on undecodable bytes rather than throwing', () => {
    const doc = docWith(buildUpdateChain(1), 1);
    expect(rowsCovered(doc, [{ clock: 0, updateData: new Uint8Array([9, 9, 9, 9, 9]) }])).toEqual([false]);
  });

  test('accepts the raw pg column shape (update_data) as well as updateData', () => {
    const updates = buildUpdateChain(2);
    const doc = docWith(updates, 2);
    const raw = updates.map((u, i) => ({ clock: i, update_data: Buffer.from(u) }));

    expect(rowsCovered(doc, raw)).toEqual([true, true]);
    expect(rowBytes(raw[0])).toBeInstanceOf(Uint8Array);
  });
});

describe('advanceVerifiedClock', () => {
  test('advances to the tail when every row is covered', () => {
    const updates = buildUpdateChain(4);
    const doc = docWith(updates, 4);
    doc._verifiedClock = -1; // the empty-bind anchor: nothing verified, but anchored at 0

    expect(advanceVerifiedClock(doc, asRows(updates))).toBe(3);
    expect(doc._verifiedClock).toBe(3);
  });

  test('stops at the first UNCOVERED row — the divergence itself', () => {
    const updates = buildUpdateChain(5);
    const doc = docWith(updates, 3); // integrated 0,1,2 only
    doc._verifiedClock = -1;

    expect(advanceVerifiedClock(doc, asRows(updates))).toBe(2);
    expect(doc._verifiedClock).toBe(2);
  });

  test('stops at an INTERIOR CLOCK HOLE even when the later rows are covered', () => {
    // The field-report shape: content {1, 5–9}. Rows in the hole may exist and
    // simply be invisible to this snapshot, so nothing above it can be claimed.
    const updates = buildUpdateChain(3);
    const doc = docWith(updates, 3); // holds ALL the content
    doc._verifiedClock = 0;

    const rows = [
      { clock: 1, updateData: updates[1] },
      { clock: 5, updateData: updates[2] }, // clocks 2,3,4 absent from the fetch
    ];

    expect(advanceVerifiedClock(doc, rows)).toBe(1);
    expect(doc._verifiedClock).toBe(1);
  });

  test('a DELETE-ONLY row is not verified until the deletion is integrated', () => {
    // Regression for the mechanism note in verified-clock.js: a delete-only row
    // writes no structs, so a write-set-only check would call it integrated on a
    // pod that still shows the deleted paragraph.
    const updates = buildUpdateChain(3);
    const author = docWith(updates, 3);
    const svBefore = Y.encodeStateVector(author);
    author.transact(() => { author.getXmlFragment('default').delete(0, 1); });
    const deleteRow = Y.encodeStateAsUpdate(author, svBefore);

    const missedIt = docWith(updates, 3);
    missedIt._verifiedClock = 1;
    const rows = [{ clock: 2, updateData: updates[2] }, { clock: 3, updateData: deleteRow }];

    expect(rowsCovered(missedIt, rows)).toEqual([true, false]);
    expect(advanceVerifiedClock(missedIt, rows)).toBe(2); // stops AT the delete

    // Integrate it, and the same row verifies. The re-fetch starts just above
    // the clock now verified, exactly as reconcileDoc re-fetches (verified, ∞].
    Y.applyUpdate(missedIt, deleteRow);
    expect(rowsCovered(missedIt, rows)).toEqual([true, true]);
    expect(advanceVerifiedClock(missedIt, rows.slice(1))).toBe(3);
  });

  test('a row from ANOTHER client is not verified until applied', () => {
    const updates = buildUpdateChain(2);
    const peer = docWith(updates, 2);
    const svBefore = Y.encodeStateVector(peer);
    peer.transact(() => {
      const el = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'from-a-second-client');
      el.insert(0, [t]);
      peer.getXmlFragment('default').push([el]);
    });
    const peerRow = Y.encodeStateAsUpdate(peer, svBefore);

    const local = docWith(updates, 2);
    local._verifiedClock = 1;
    const rows = [{ clock: 2, updateData: peerRow }];

    expect(rowsCovered(local, rows)).toEqual([false]);
    expect(advanceVerifiedClock(local, rows)).toBe(1);

    Y.applyUpdate(local, peerRow);
    expect(advanceVerifiedClock(local, rows)).toBe(2);
  });

  test('undefined _verifiedClock is UNVERIFIED, not clock 0', () => {
    const updates = buildUpdateChain(3);
    const doc = new Y.Doc(); // integrated nothing

    expect(doc._verifiedClock).toBeUndefined();
    expect(advanceVerifiedClock(doc, asRows(updates))).toBeUndefined();
    expect(doc._verifiedClock).toBeUndefined();
  });

  test('from unverified, a full-log fetch verifies from the log head (history above 0)', () => {
    const updates = buildUpdateChain(3);
    const doc = docWith(updates, 3);

    // A log whose history begins at clock 5 — legitimate, not a gap.
    const rows = asRows(updates, 5);
    expect(advanceVerifiedClock(doc, rows)).toBe(7);
    expect(doc._verifiedClock).toBe(7);
  });

  test('MONOTONE: a stale fetch never walks the clock backwards', () => {
    const updates = buildUpdateChain(5);
    const doc = docWith(updates, 5);
    doc._verifiedClock = 4;

    // A late-arriving fetch covering only the early rows.
    expect(advanceVerifiedClock(doc, asRows(updates.slice(0, 2)))).toBe(4);
    expect(doc._verifiedClock).toBe(4);
  });

  test('an empty row set leaves the clock exactly where it was', () => {
    const doc = new Y.Doc();
    doc._verifiedClock = 7;
    expect(advanceVerifiedClock(doc, [])).toBe(7);
    expect(doc._verifiedClock).toBe(7);

    const fresh = new Y.Doc();
    expect(advanceVerifiedClock(fresh, [])).toBeUndefined();
    expect(fresh._verifiedClock).toBeUndefined();
  });

  test('a run that does not start at verified+1 advances nothing', () => {
    const updates = buildUpdateChain(4);
    const doc = docWith(updates, 4);
    doc._verifiedClock = 0;

    // Rows start at 2 — clock 1 is unaccounted for.
    expect(advanceVerifiedClock(doc, asRows(updates.slice(2), 2))).toBe(0);
    expect(doc._verifiedClock).toBe(0);
  });

  test('explicit `from` overrides the default anchor', () => {
    const updates = buildUpdateChain(3);
    const doc = docWith(updates, 3);
    doc._verifiedClock = 0;

    const rows = asRows(updates.slice(1), 2); // clocks 2,3
    expect(advanceVerifiedClock(doc, rows, { from: 2 })).toBe(3);
    expect(doc._verifiedClock).toBe(3);
  });

  test('idempotent: re-running over the same rows changes nothing', () => {
    const updates = buildUpdateChain(3);
    const doc = docWith(updates, 3);
    doc._verifiedClock = -1;

    expect(advanceVerifiedClock(doc, asRows(updates))).toBe(2);
    expect(advanceVerifiedClock(doc, asRows(updates))).toBe(2);
    expect(advanceVerifiedClock(doc, asRows(updates))).toBe(2);
  });

  test('rows without bytes stop the walk (fail closed end-to-end)', () => {
    const updates = buildUpdateChain(3);
    const doc = docWith(updates, 3);
    doc._verifiedClock = -1;

    const rows = [
      { clock: 0, updateData: updates[0] },
      { clock: 1 },                          // fetched without includeData
      { clock: 2, updateData: updates[2] },
    ];

    expect(advanceVerifiedClock(doc, rows)).toBe(0);
  });
});
