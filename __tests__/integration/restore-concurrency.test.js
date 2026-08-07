/**
 * US4 — restore under concurrency (feature 043, FR-005).
 *
 * Restore is the "get my content back" promise, and the conditions users
 * actually reach for it under are the ones nothing guarded: someone else typing
 * at the same moment, or two people restoring at once. This suite drives
 * feature 041's LIVE-DOC restore path (FR-011) — a real WebSocket connection is
 * held open throughout, so `getSharedDoc` finds the document loaded and the
 * restore transacts on the live doc rather than falling back to the durable-log
 * path.
 *
 * ── ASSERTION DISCIPLINE (ledger D2) ────────────────────────────────────────
 * INVARIANTS ONLY. Nothing here may name a race winner. A restore and a
 * concurrent edit have no defined order, so "the edit wins" and "the restore
 * wins" are both legitimate outcomes and an assertion that picks one is a flake
 * factory. What must hold under EVERY interleaving:
 *
 *   - the durable log is append-only: every participant's row survives, with
 *     its own attribution, whoever else was writing at the time;
 *   - the restore lands: the target version's content is present afterwards
 *     (a later concurrent edit may ADD to it, never remove it);
 *   - two concurrent restores serialize: the document equals the output of ONE
 *     of them, never an interleaved hybrid;
 *   - version history reads end to end over the resulting log without error.
 *
 * These hold regardless of ordering, which is why T046 runs the pair five times.
 */
const {
  startCollabServer,
  createHumanIdentity,
  cleanupTestUser,
  cleanupDoc,
  waitFor,
  documents,
  appendParagraph,
  Y,
  crypto,
} = require('./helpers/collab-harness');

const versionHistory = require('../../server/version-history');
const { docs: yDocRegistry } = require('y-websocket/bin/utils');

/** The non-creating live-doc peek, as production supplies it (041 FR-013). */
const getSharedDoc = (docGuid) => yDocRegistry.get(`s/${docGuid}`) || null;

describe('US4: restore under concurrency', () => {
  let harness;
  let owner;
  let other;
  const createdGuids = [];

  beforeAll(async () => {
    harness = await startCollabServer();
    owner = await createHumanIdentity(harness.pool, `043-restorer-${crypto.randomUUID()}@test.local`);
    other = await createHumanIdentity(harness.pool, `043-coeditor-${crypto.randomUUID()}@test.local`);
  }, 30000);

  afterAll(async () => {
    await cleanupDoc(harness.pool, createdGuids);
    await cleanupTestUser(harness.pool, owner.userId);
    await cleanupTestUser(harness.pool, other.userId);
    await harness.close();
  }, 30000);

  /**
   * A document with THREE distinct versions in its log, plus a live editor
   * connection held open so the live-doc restore path is the one under test.
   *
   * The rows are aged apart in the database afterwards: version grouping is
   * time-based (5 minutes of inactivity), and edits made milliseconds apart
   * would otherwise collapse into a single version, leaving nothing distinct to
   * restore TO. Only `created_at` is touched — the content, clocks and identity
   * are whatever the real socket produced.
   */
  async function buildFixture() {
    const docGuid = crypto.randomUUID();
    createdGuids.push(docGuid);
    await documents.createDocument(docGuid, owner.userId, 'US4 restore concurrency');
    await documents.setRole(docGuid, owner.userId, 'editor', owner.userId);
    await documents.setRole(docGuid, other.userId, 'editor', other.userId);

    const client = await harness.connect(docGuid, owner.token);
    const clientDoc = new Y.Doc();

    for (const text of ['ALPHA first', 'BETA second', 'GAMMA third']) {
      const before = (await harness.rowsFor(docGuid)).length;
      client.sendUpdate(appendParagraph(clientDoc, text));
      await waitFor(async () => (await harness.rowsFor(docGuid)).length > before, {
        label: `fixture edit "${text}" persisted`,
      });
    }

    // Age the rows apart so grouping yields three versions.
    const rows = await harness.rowsFor(docGuid);
    for (let i = 0; i < rows.length; i += 1) {
      const minutesAgo = (rows.length - i) * 30;
      await harness.pool.query(
        `UPDATE yjs_updates SET created_at = NOW() - ($1 || ' minutes')::interval
         WHERE doc_guid = $2 AND clock = $3`,
        [minutesAgo, docGuid, rows[i].clock]
      );
    }

    const timeline = await versionHistory.getVersionTimeline(harness.persistence, docGuid);
    return { docGuid, client, clientDoc, timeline };
  }

  /**
   * Is this `storeUpdate` call the RESTORE's own durable write?
   *
   * Both restore and the bindState persistence listener call the same method.
   * The listener always passes `viaSync` in its options object (feature 038);
   * restore passes `{ meaningful: true }` and nothing else. That is the cheapest
   * honest discriminator, and it is asserted rather than assumed by the
   * store-then-broadcast ordering test below.
   */
  const isRestoreStore = (args) => {
    const opts = args[6];
    return !!opts && opts.meaningful === true && !('viaSync' in opts);
  };

  /** C7: no row this suite produces goes unchecked. */
  function assertEveryRowAttributed(rows) {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.user_id).not.toBeNull();
      expect([owner.userId, other.userId]).toContain(row.user_id);
      // Every principal here is a browser session, so no row may carry an
      // agent name — a restore attributed to an agent is the 040 regression.
      expect(row.agent_name).toBeNull();
    }
  }

  test('acceptance 1/3 — a restore and a concurrent live edit: both survive the log, the restore lands', async () => {
    const { docGuid, client, clientDoc, timeline } = await buildFixture();
    expect(timeline.versions.length).toBeGreaterThanOrEqual(2);

    const target = timeline.versions[0]; // the oldest version — ALPHA only
    const otherClient = await harness.connect(docGuid, other.token);

    try {
      // The bytes are produced on the OWNER's replica and sent over the
      // CO-EDITOR's connection. That is deliberate and sound for what is under
      // test: attribution comes from the connection (`ws.userId`), never from
      // the update's embedded Yjs clientID, so the row lands under the
      // co-editor exactly as a real second browser's would. What it does not
      // reproduce is a genuinely divergent replica — a real co-editor has its
      // own clientID and its own state vector. No assertion here depends on
      // that; if one ever does, give this client its own Y.Doc.
      const concurrentUpdate = appendParagraph(clientDoc, 'CONCURRENT edit by the co-editor');

      // Genuine overlap: the restore is in flight when the edit frame is sent.
      const restorePromise = versionHistory.restoreVersion(
        harness.persistence, docGuid, target.id, owner.userId, { getSharedDoc }
      );
      otherClient.sendUpdate(concurrentUpdate);
      const result = await restorePromise;

      expect(result.success).toBe(true);
      await waitFor(async () => {
        const rows = await harness.rowsFor(docGuid);
        return rows.some((r) => r.user_id === other.userId);
      }, { label: 'the concurrent edit persisted' });
      await Promise.allSettled([...harness.pendingWrites]);

      const rows = await harness.rowsFor(docGuid);

      // INVARIANT: the append-only log kept the concurrent edit, under its OWN
      // author, even though a restore was running across it.
      const concurrentRows = rows.filter((r) => r.user_id === other.userId);
      expect(concurrentRows.length).toBeGreaterThanOrEqual(1);

      // INVARIANT: the restore row exists and is attributed to the RESTORER.
      const restoreRow = rows.find((r) => r.clock === result.newClock);
      expect(restoreRow).toBeDefined();
      expect(restoreRow.user_id).toBe(owner.userId);
      expect(restoreRow.agent_name).toBeNull();

      // INVARIANT: the restore landed. The target's content is present. A
      // concurrent edit that arrived after it may have ADDED to the document —
      // that is a legitimate outcome and is deliberately not asserted either way.
      expect(harness.serverXml(docGuid)).toContain('ALPHA first');

      // INVARIANT: the resulting log reads end to end.
      const after = await versionHistory.getVersionTimeline(harness.persistence, docGuid);
      expect(after.versions.length).toBeGreaterThan(0);

      assertEveryRowAttributed(rows);
    } finally {
      await otherClient.close();
      await client.close();
    }
  }, 40000);

  test('acceptance 2/3 — two concurrent restores serialize: the document is one of them, never a hybrid', async () => {
    const { docGuid, client, timeline } = await buildFixture();
    expect(timeline.versions.length).toBeGreaterThanOrEqual(2);

    const first = timeline.versions[0];
    const second = timeline.versions[1];

    try {
      // Both restores issued without awaiting between them.
      const [resultA, resultB] = await Promise.all([
        versionHistory.restoreVersion(harness.persistence, docGuid, first.id, owner.userId, { getSharedDoc }),
        versionHistory.restoreVersion(harness.persistence, docGuid, second.id, other.userId, { getSharedDoc }),
      ]);

      expect(resultA.success).toBe(true);
      expect(resultB.success).toBe(true);
      await Promise.allSettled([...harness.pendingWrites]);

      // INVARIANT: both restore rows exist and are INDIVIDUALLY attributed.
      const rows = await harness.rowsFor(docGuid);
      const rowA = rows.find((r) => r.clock === resultA.newClock);
      const rowB = rows.find((r) => r.clock === resultB.newClock);
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();
      expect(rowA.user_id).toBe(owner.userId);
      expect(rowB.user_id).toBe(other.userId);
      expect(rowA.clock).not.toBe(rowB.clock);

      // INVARIANT: the document equals the output of ONE of the two restores.
      // Restoring to the first version yields ALPHA alone; to the second, ALPHA
      // and BETA. A hybrid — BETA without ALPHA, or GAMMA surviving either —
      // would mean the two transactions interleaved.
      const xml = harness.serverXml(docGuid);
      const restoredToFirst = xml.includes('ALPHA first') && !xml.includes('BETA second');
      const restoredToSecond = xml.includes('ALPHA first') && xml.includes('BETA second');
      expect(restoredToFirst || restoredToSecond).toBe(true);
      expect(xml).not.toContain('GAMMA third');

      // INVARIANT: version history reads end to end over the resulting log.
      const after = await versionHistory.getVersionTimeline(harness.persistence, docGuid);
      expect(after.versions.length).toBeGreaterThan(0);
      expect(after.totalEdits).toBeGreaterThan(0);

      assertEveryRowAttributed(rows);
    } finally {
      await client.close();
    }
  }, 40000);


  // ── Feature 048 (RBD-048-2): the two accepted consequences of store-then-apply
  //
  // Restore used to transact on the live document and broadcast before the
  // durable write. It now computes on a throwaway doc, commits, and only then
  // broadcasts. Both consequences below were accepted with the design rather
  // than fixed, so they are pinned here — if either ever changes, that is a
  // decision someone has to make again, not a silent drift.

  test('048 AS3 — an edit landing during the store await MERGES with the restore; neither is lost', async () => {
    const { docGuid, client, clientDoc, timeline } = await buildFixture();
    const target = timeline.versions[0]; // ALPHA only
    const otherClient = await harness.connect(docGuid, other.token);

    // Hold the store open so the concurrent edit is guaranteed to land inside
    // the await, rather than hoping the scheduler cooperates.
    const realStore = harness.persistence.storeUpdate.bind(harness.persistence);
    let releaseStore;
    let announceGateEntered;
    const storeReached = new Promise((resolve) => { releaseStore = resolve; });
    const gateEntered = new Promise((resolve) => { announceGateEntered = resolve; });
    let gatedOnce = false;
    const spy = jest.spyOn(harness.persistence, 'storeUpdate').mockImplementation(
      async (...args) => {
        // Gate ONLY the restore's own write. The bindState listener persists
        // every normal edit through this same method and passes `viaSync` in its
        // options; restore passes `{ meaningful: true }` alone. Gating both would
        // deadlock the very edit this test needs to land.
        if (!gatedOnce && isRestoreStore(args)) {
          gatedOnce = true;
          announceGateEntered();
          await storeReached;
        }
        return realStore(...args);
      }
    );

    try {
      const restorePromise = versionHistory.restoreVersion(
        harness.persistence, docGuid, target.id, owner.userId, { getSharedDoc }
      );

      // Wait until the restore is INSIDE its durable write before typing. The
      // restore computes its delta before it stores, so an edit sent earlier
      // could be part of the seed and get replaced — a legitimate outcome, but
      // a different one. This is specifically the store-await window.
      await gateEntered;

      otherClient.sendUpdate(appendParagraph(clientDoc, 'DURING the store await'));
      await waitFor(async () => {
        const rows = await harness.rowsFor(docGuid);
        return rows.some((r) => r.user_id === other.userId);
      }, { label: 'the concurrent edit persisted while the store was open' });

      releaseStore();
      const result = await restorePromise;
      expect(result.success).toBe(true);
      await Promise.allSettled([...harness.pendingWrites]);

      // NEITHER is lost. The restore row is durable under the restorer...
      const rows = await harness.rowsFor(docGuid);
      const restoreRow = rows.find((r) => r.clock === result.newClock);
      expect(restoreRow).toBeDefined();
      expect(restoreRow.user_id).toBe(owner.userId);

      // ...the co-editor's row is durable under the co-editor...
      expect(rows.filter((r) => r.user_id === other.userId).length).toBeGreaterThanOrEqual(1);

      // ...and the live document carries BOTH, which is the merge: the restore
      // did not replace an edit it never saw. This is the semantic the durable
      // path and every cross-pod restore always had; it is simply uniform now.
      const xml = harness.serverXml(docGuid);
      expect(xml).toContain('ALPHA first');
      expect(xml).toContain('DURING the store await');

      assertEveryRowAttributed(rows);
    } finally {
      spy.mockRestore();
      await otherClient.close();
      await client.close();
    }
  }, 40000);

  test('048 AS4 — the restore is durable BEFORE it is broadcast, so losing the broadcast loses nothing', async () => {
    const { docGuid, client, timeline } = await buildFixture();
    const target = timeline.versions[0]; // ALPHA only

    // The crash window is "after commit, before broadcast". Rather than kill the
    // process, observe the ordering directly and then prove the durable row
    // stands on its own — which is exactly what a restarted pod would find.
    const liveDoc = getSharedDoc(docGuid);
    let broadcasts = 0;
    const watchBroadcast = () => { broadcasts += 1; };
    liveDoc.on('update', watchBroadcast);

    let broadcastsWhenStoreResolved = null;
    const realStore = harness.persistence.storeUpdate.bind(harness.persistence);
    const spy = jest.spyOn(harness.persistence, 'storeUpdate').mockImplementation(
      async (...args) => {
        const clock = await realStore(...args);
        if (isRestoreStore(args) && broadcastsWhenStoreResolved === null) {
          broadcastsWhenStoreResolved = broadcasts;
        }
        return clock;
      }
    );

    try {
      const result = await versionHistory.restoreVersion(
        harness.persistence, docGuid, target.id, owner.userId, { getSharedDoc }
      );
      expect(result.success).toBe(true);
      await Promise.allSettled([...harness.pendingWrites]);

      // ORDERING: the durable write completed with the broadcast still to come.
      // Everything after this point is recoverable; a crash here loses only the
      // notification, never the content.
      expect(broadcastsWhenStoreResolved).toBe(0);
      expect(broadcasts).toBeGreaterThan(0); // it did eventually broadcast

      // The row is durable and attributed.
      const rows = await harness.rowsFor(docGuid);
      const restoreRow = rows.find((r) => r.clock === result.newClock);
      expect(restoreRow).toBeDefined();
      expect(restoreRow.user_id).toBe(owner.userId);

      // REPLAY: rebuilding from the log alone — what a restarted pod does —
      // yields the restored content, with no help from the broadcast.
      const rebuilt = await harness.persistence.getYDoc(docGuid);
      const rebuiltXml = rebuilt.get('default', Y.XmlFragment).toString();
      rebuilt.destroy();
      expect(rebuiltXml).toContain('ALPHA first');
      expect(rebuiltXml).not.toContain('GAMMA third');

      assertEveryRowAttributed(rows);
    } finally {
      spy.mockRestore();
      liveDoc.off('update', watchBroadcast);
      await client.close();
    }
  }, 40000);

  test('D8 — a human web-UI restore writes NO agent_edits row and is not an undo target', async () => {
    // Asserted as an ABSENCE on purpose: the pre-040-cut behavior recorded
    // human restores under the chat-assistant identity, which mislabelled a
    // person's restore as the assistant's edit. If that revives, this fails.
    // See design/collaboration-core.md (2026-08-02 amendment) and
    // specs/040-restore-undo-attribution/ (US1/US6 CUT).
    const { docGuid, client, timeline } = await buildFixture();

    try {
      const before = await harness.pool.query(
        'SELECT COUNT(*)::int AS n FROM agent_edits WHERE doc_guid = $1', [docGuid]
      );

      const result = await versionHistory.restoreVersion(
        harness.persistence, docGuid, timeline.versions[0].id, owner.userId, { getSharedDoc }
      );
      expect(result.success).toBe(true);
      await Promise.allSettled([...harness.pendingWrites]);

      const after = await harness.pool.query(
        'SELECT COUNT(*)::int AS n FROM agent_edits WHERE doc_guid = $1', [docGuid]
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);

      // ...while the restore itself IS in the durable log, attributed to the
      // human who performed it. History shows who did it; it is simply not
      // undoable, and is reverted by restoring again.
      const rows = await harness.rowsFor(docGuid);
      const restoreRow = rows.find((r) => r.clock === result.newClock);
      expect(restoreRow).toBeDefined();
      expect(restoreRow.user_id).toBe(owner.userId);
      expect(restoreRow.agent_name).toBeNull();

      assertEveryRowAttributed(rows);
    } finally {
      await client.close();
    }
  }, 40000);
});
