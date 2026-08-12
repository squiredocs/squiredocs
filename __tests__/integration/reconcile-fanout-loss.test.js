/**
 * Feature 057 US2 — a pod that misses fan-out converges without waiting for
 * eviction (FR-005..008, FR-013, contracts/reconciliation.md).
 *
 * THE DEFECT: a pod learns about other pods' edits ONLY through Redis fan-out,
 * and nothing ever checked afterwards. One dropped message and the two copies
 * disagreed until the document was evicted — which on a busy document never
 * happens.
 *
 * HARNESS (research R9 — reuse, don't invent): the `receiveOn` second-pod
 * pattern from server/__tests__/live-fanout.test.js, which applies published
 * buffers under ORIGIN_REDIS, over REAL persistence (052 per-worker isolation).
 * Suppressing fan-out is simply not delivering the buffer — exactly what a
 * dropped message, a subscriber reconnect, or the bind-to-subscribe window
 * looks like from the receiving pod's point of view.
 */
const Y = require('yjs');
const {
  createPool,
  createPersistence,
  cleanupDocRows,
} = require('../../server/__tests__/helpers/db');
const { ORIGIN_REDIS, parseOrigin } = require('../../server/origin');
const telemetryMetrics = require('../../server/telemetry/metrics');
const {
  reconcileDoc,
  reconcileIfBound,
  runReconcileTick,
  reconcileAllBoundDocs,
} = require('../../server/collab-reconcile');

describe('057 US2 — reconciliation after lost fan-out', () => {
  let pool;
  let persistence;
  const docGuids = [];

  const newDocGuid = () => {
    const guid = `20571000-${String(docGuids.length).padStart(4, '0')}-4000-8000-${Date.now()
      .toString(16)
      .padStart(12, '0')
      .slice(-12)}`;
    docGuids.push(guid);
    return guid;
  };

  const text = (ydoc) => ydoc.getXmlFragment('default').toString();

  /**
   * One pod's copy of a document: a Y.Doc plus the y-websocket-shaped registry
   * entry the reconciler walks, and a record of everything it would publish.
   */
  function makePod(docGuid) {
    const ydoc = new Y.Doc();
    ydoc._bindComplete = true;
    ydoc._verifiedClock = -1;
    const docs = new Map([[`s/${docGuid}`, ydoc]]);
    const published = [];
    const persistedOrigins = [];
    ydoc.on('update', (update, origin) => {
      if (parseOrigin(origin)) persistedOrigins.push(origin);
      // Anything the pod would put on the wire, mirroring shouldPublishToRedis.
      if (origin !== ORIGIN_REDIS && parseOrigin(origin) !== null) published.push(update);
    });
    return { docGuid, ydoc, docs, published, persistedOrigins };
  }

  /** Deliver a published buffer to another pod, as Redis fan-out would. */
  const deliver = (pod, update) => Y.applyUpdate(pod.ydoc, update, ORIGIN_REDIS);

  /**
   * An edit made on `pod` and COMMITTED to the durable log, returning the bytes
   * fan-out would carry. Whether they are delivered is the test's choice.
   */
  async function editAndCommit(pod, label) {
    const before = Y.encodeStateVector(pod.ydoc);
    pod.ydoc.transact(() => {
      const el = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, label);
      el.insert(0, [t]);
      pod.ydoc.getXmlFragment('default').push([el]);
    });
    const update = Y.encodeStateAsUpdate(pod.ydoc, before);
    await persistence.storeUpdate(pod.docGuid, update);
    // The writer integrated its own edit and it is now durable, so its verified
    // clock legitimately advances — this is the pod that has everything.
    const { maxClock } = await persistence.getClockRange(pod.docGuid);
    pod.ydoc._verifiedClock = maxClock;
    return update;
  }

  beforeAll(() => {
    pool = createPool();
    persistence = createPersistence();
  });

  afterAll(async () => {
    await cleanupDocRows(pool, docGuids);
    await pool.end();
    await persistence.destroy?.();
  });

  test('a missed fan-out message is repaired within ONE reconcile tick', async () => {
    const docGuid = newDocGuid();
    const podA = makePod(docGuid);
    const podB = makePod(docGuid);

    // Both pods start level.
    const first = await editAndCommit(podA, 'shared-start');
    deliver(podB, first);
    podB.ydoc._verifiedClock = podA.ydoc._verifiedClock;

    // A commits an edit; B never receives the message.
    await editAndCommit(podA, 'A-only-edit');
    expect(text(podB.ydoc)).not.toContain('A-only-edit');

    const summary = await runReconcileTick({ docs: podB.docs, persistence });

    expect(summary.behind).toBe(1);
    expect(summary.repaired).toBe(1);
    expect(text(podB.ydoc)).toContain('A-only-edit');

    // Convergence is judged against the log, which is the only reference.
    const rebuilt = await persistence.getYDoc(docGuid);
    expect(text(podB.ydoc)).toBe(text(rebuilt));
  });

  test('the repaired pod writes NOTHING back to the log', async () => {
    const docGuid = newDocGuid();
    const podA = makePod(docGuid);
    const podB = makePod(docGuid);
    deliver(podB, await editAndCommit(podA, 'base'));
    podB.ydoc._verifiedClock = podA.ydoc._verifiedClock;

    await editAndCommit(podA, 'missed');
    const rowsBefore = Number((await pool.query(
      'SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]
    )).rows[0].n);

    await runReconcileTick({ docs: podB.docs, persistence });

    expect(podB.persistedOrigins).toEqual([]); // nothing persistable was produced
    expect(podB.published).toEqual([]);        // nothing rebroadcast
    const rowsAfter = Number((await pool.query(
      'SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]
    )).rows[0].n);
    expect(rowsAfter).toBe(rowsBefore);
  });

  test('a subscriber RECONNECT reconciles every bound doc, covering the blind window', async () => {
    const docGuidA = newDocGuid();
    const docGuidB = newDocGuid();
    const writerA = makePod(docGuidA);
    const writerB = makePod(docGuidB);

    // The reconnecting pod holds both documents and missed messages on both.
    const listener = makePod(docGuidA);
    deliver(listener, await editAndCommit(writerA, 'a-base'));
    listener.ydoc._verifiedClock = writerA.ydoc._verifiedClock;

    const listenerDocB = new Y.Doc();
    listenerDocB._bindComplete = true;
    deliver({ ydoc: listenerDocB }, await editAndCommit(writerB, 'b-base'));
    listenerDocB._verifiedClock = writerB.ydoc._verifiedClock;
    listener.docs.set(`s/${docGuidB}`, listenerDocB);

    // The blind window: edits on BOTH documents while the subscriber was away.
    await editAndCommit(writerA, 'a-missed-while-away');
    await editAndCommit(writerB, 'b-missed-while-away');

    const summary = await reconcileAllBoundDocs({ docs: listener.docs, persistence });

    expect(summary.checked).toBe(2);
    expect(summary.repaired).toBe(2);
    expect(text(listener.ydoc)).toContain('a-missed-while-away');
    expect(text(listenerDocB)).toContain('b-missed-while-away');
  });

  test('OVER-APPLY is idempotent: a healthy pod reconciles to no change at all', async () => {
    const docGuid = newDocGuid();
    const podA = makePod(docGuid);
    const podB = makePod(docGuid);

    deliver(podB, await editAndCommit(podA, 'one'));
    deliver(podB, await editAndCommit(podA, 'two'));
    // B has every byte via fan-out but has verified nothing beyond the start —
    // the exact shape research R2 accepts, since messages carry no clock.
    const contentBefore = text(podB.ydoc);

    const updatesSeen = [];
    podB.ydoc.on('update', (u) => updatesSeen.push(u));

    const repairSpy = jest.spyOn(telemetryMetrics, 'recordReconcileRepair');
    try {
      const first = await runReconcileTick({ docs: podB.docs, persistence });
      const second = await runReconcileTick({ docs: podB.docs, persistence });

      expect(text(podB.ydoc)).toBe(contentBefore);   // content untouched
      expect(updatesSeen).toEqual([]);               // no spurious updates
      expect(first.repaired).toBe(0);                // bookkeeping, not repair
      expect(second.repaired).toBe(0);
      expect(repairSpy).not.toHaveBeenCalled();
      expect(podB.persistedOrigins).toEqual([]);
    } finally {
      repairSpy.mockRestore();
    }
  });

  test('reconciliation heals with Redis entirely absent (FR-013 fail-open)', async () => {
    const docGuid = newDocGuid();
    const writer = makePod(docGuid);
    // No bus at all: this pod has NO delivery mechanism, only Postgres.
    const isolated = makePod(docGuid);

    await editAndCommit(writer, 'written-with-no-pubsub');
    expect(text(isolated.ydoc)).not.toContain('written-with-no-pubsub');

    const summary = await runReconcileTick({ docs: isolated.docs, persistence });

    expect(summary.repaired).toBe(1);
    expect(text(isolated.ydoc)).toContain('written-with-no-pubsub');
  });

  test('BOTH pods behind heal independently, each against Postgres and never against the peer', async () => {
    const docGuid = newDocGuid();
    const writer = makePod(docGuid);
    const podA = makePod(docGuid);
    const podB = makePod(docGuid);

    const base = await editAndCommit(writer, 'base');
    deliver(podA, base);
    deliver(podB, base);
    podA.ydoc._verifiedClock = writer.ydoc._verifiedClock;
    podB.ydoc._verifiedClock = writer.ydoc._verifiedClock;

    // Two further commits; A misses the second, B misses both.
    const second = await editAndCommit(writer, 'second');
    deliver(podA, second);
    podA.ydoc._verifiedClock = writer.ydoc._verifiedClock;
    await editAndCommit(writer, 'third');

    expect(text(podA.ydoc)).not.toContain('third');
    expect(text(podB.ydoc)).not.toContain('second');

    await runReconcileTick({ docs: podA.docs, persistence });
    await runReconcileTick({ docs: podB.docs, persistence });

    const rebuilt = await persistence.getYDoc(docGuid);
    expect(text(podA.ydoc)).toBe(text(rebuilt));
    expect(text(podB.ydoc)).toBe(text(rebuilt));
  });

  test('a repair concurrent with a live local edit keeps both sides', async () => {
    const docGuid = newDocGuid();
    const writer = makePod(docGuid);
    const local = makePod(docGuid);
    deliver(local, await editAndCommit(writer, 'shared'));
    local.ydoc._verifiedClock = writer.ydoc._verifiedClock;

    await editAndCommit(writer, 'remote-missed');

    // A local edit that has NOT been committed yet, in flight during the repair.
    local.ydoc.transact(() => {
      const el = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'local-in-flight');
      el.insert(0, [t]);
      local.ydoc.getXmlFragment('default').push([el]);
    });

    await reconcileDoc(docGuid, local.ydoc, { persistence, docs: local.docs });

    expect(text(local.ydoc)).toContain('remote-missed');   // repaired
    expect(text(local.ydoc)).toContain('local-in-flight'); // and not clobbered
  });

  test('collab.reconcile.repairs counts genuine repairs only', async () => {
    const docGuid = newDocGuid();
    const writer = makePod(docGuid);
    const behind = makePod(docGuid);

    await editAndCommit(writer, 'first');
    await editAndCommit(writer, 'second');

    const repairSpy = jest.spyOn(telemetryMetrics, 'recordReconcileRepair');
    try {
      await runReconcileTick({ docs: behind.docs, persistence }); // genuinely behind
      expect(repairSpy).toHaveBeenCalledTimes(1);

      await runReconcileTick({ docs: behind.docs, persistence }); // already current
      await runReconcileTick({ docs: behind.docs, persistence });
      expect(repairSpy).toHaveBeenCalledTimes(1);
    } finally {
      repairSpy.mockRestore();
    }
  });

  test('a doc whose bind was refused is skipped by the tick, not repaired back to life', async () => {
    const docGuid = newDocGuid();
    const writer = makePod(docGuid);
    const refused = makePod(docGuid);
    refused.ydoc._bindFailed = true;

    await editAndCommit(writer, 'content-after-refusal');

    const summary = await runReconcileTick({ docs: refused.docs, persistence });

    expect(summary.checked).toBe(0);
    expect(text(refused.ydoc)).not.toContain('content-after-refusal');
  });

  test('a doc still mid-bind is skipped until its bind completes', async () => {
    const docGuid = newDocGuid();
    const writer = makePod(docGuid);
    const midBind = makePod(docGuid);
    delete midBind.ydoc._bindComplete;

    await editAndCommit(writer, 'during-bind');

    expect((await runReconcileTick({ docs: midBind.docs, persistence })).checked).toBe(0);

    midBind.ydoc._bindComplete = true;
    expect((await runReconcileTick({ docs: midBind.docs, persistence })).repaired).toBe(1);
    expect(text(midBind.ydoc)).toContain('during-bind');
  });

  // ── The POST-SUBSCRIBE trigger, same rule ────────────────────────────────
  // The tick is not the only path that reaches a doc. server/index.js chains a
  // pass onto subscribeToDocument, and THAT one resolves on the Redis SUBSCRIBE
  // ack — milliseconds — while the bind's DB load runs for tens to hundreds. So
  // unlike the tick, it fires mid-bind on the FIRST load of every document
  // whenever Redis is enabled, which is the common case rather than a corner.

  test('the post-subscribe pass is skipped mid-bind, and fetches nothing', async () => {
    const docGuid = newDocGuid();
    const writer = makePod(docGuid);
    const midBind = makePod(docGuid);
    delete midBind.ydoc._bindComplete;
    delete midBind.ydoc._verifiedClock; // mid-bind: nothing proven yet

    await editAndCommit(writer, 'committed-during-bind');

    // Any query at all is the defect: with no verified clock, reconcileDoc takes
    // the head-of-history branch and pulls the ENTIRE log with bytes — beside
    // the bind's own load of the same rows.
    const fetchSpy = jest.spyOn(persistence, 'getUpdatesInRange');
    try {
      const out = await reconcileIfBound(docGuid, midBind.ydoc, { persistence, docs: midBind.docs });

      expect(out.status).toBe('skipped-mid-bind');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(midBind.ydoc._verifiedClock).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }

    // Once the bind completes, the same call reconciles normally — the guard
    // defers the work, it does not drop it.
    midBind.ydoc._bindComplete = true;
    midBind.ydoc._verifiedClock = -1;
    const after = await reconcileIfBound(docGuid, midBind.ydoc, { persistence, docs: midBind.docs });
    expect(after.repaired).toBe(true);
    expect(text(midBind.ydoc)).toContain('committed-during-bind');
  });

  test('a refused bind is still refused through the post-subscribe guard', async () => {
    const docGuid = newDocGuid();
    const writer = makePod(docGuid);
    const refused = makePod(docGuid);
    refused.ydoc._bindFailed = true;

    await editAndCommit(writer, 'after-refusal');

    const out = await reconcileIfBound(docGuid, refused.ydoc, { persistence, docs: refused.docs });

    expect(out.status).toBe('skipped-bind-failed');
    expect(text(refused.ydoc)).not.toContain('after-refusal');
  });
});
