/**
 * Feature 057 T006 — reconcileDoc (contracts/reconciliation.md).
 *
 * The claims under test are the ones that make repair SAFE rather than merely
 * effective: it applies and never rebuilds, what it applies is never persisted
 * or rebroadcast, over-applying is free, and a pass racing eviction is a silent
 * no-op. Real database (052 per-worker isolation) because the fetch shape and
 * the clock semantics are the point.
 */
const Y = require('yjs');
const { createPool, createPersistence, cleanupDocRows } = require('./helpers/db');
const { ORIGIN_DB_LOAD, parseOrigin, shouldPublishToRedis } = require('../origin');
const telemetryMetrics = require('../telemetry/metrics');
const {
  reconcileDoc,
  runReconcileTick,
  boundDocs,
  readIntervalMs,
  startPeriodicCheck,
  stopPeriodicCheck,
  DEFAULT_INTERVAL_MS,
} = require('../collab-reconcile');

describe('057 reconcileDoc', () => {
  let pool;
  let persistence;
  const docGuids = [];

  const newDocGuid = () => {
    const guid = `20570000-${String(docGuids.length).padStart(4, '0')}-4000-8000-${Date.now()
      .toString(16)
      .padStart(12, '0')
      .slice(-12)}`;
    docGuids.push(guid);
    return guid;
  };

  /** Sequential incremental updates from one client; update i appends `para-i`. */
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

  const insertRow = (docGuid, clock, update) =>
    pool.query('INSERT INTO yjs_updates (doc_guid, clock, update_data) VALUES ($1, $2, $3)',
      [docGuid, clock, Buffer.from(update)]);

  const rowCount = async (docGuid) =>
    Number((await pool.query('SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid])).rows[0].n);

  const text = (ydoc) => ydoc.getXmlFragment('default').toString();

  /** A live doc holding updates [0..n) with its verified clock set honestly. */
  function liveDoc(updates, n) {
    const doc = new Y.Doc();
    for (let i = 0; i < n; i++) Y.applyUpdate(doc, updates[i]);
    doc._verifiedClock = n - 1;
    doc._bindComplete = true;
    return doc;
  }

  beforeAll(() => {
    pool = createPool();
    persistence = createPersistence();
  });

  afterAll(async () => {
    await cleanupDocRows(pool, docGuids);
    await pool.end();
    await persistence.close?.();
  });

  test('applies the rows the live copy is missing and advances the verified clock', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(5);
    for (let i = 0; i < 5; i++) await insertRow(docGuid, i, updates[i]);

    const doc = liveDoc(updates, 2); // missed clocks 2,3,4
    expect(text(doc)).not.toContain('para-4');

    const out = await reconcileDoc(docGuid, doc, { persistence });

    expect(out.status).toBe('repaired');
    expect(out.applied).toBe(3);
    expect(out.repaired).toBe(true);
    expect(out.verifiedClock).toBe(4);
    expect(doc._verifiedClock).toBe(4);
    expect(text(doc)).toContain('para-4');
  });

  test('converges to the same content the log rebuilds', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(6);
    for (let i = 0; i < 6; i++) await insertRow(docGuid, i, updates[i]);

    const doc = liveDoc(updates, 1);
    await reconcileDoc(docGuid, doc, { persistence });

    const rebuilt = await persistence.getYDoc(docGuid);
    expect(text(doc)).toBe(text(rebuilt));
  });

  test('APPLY-ONLY: the repair never persists and never rebroadcasts', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(4);
    for (let i = 0; i < 4; i++) await insertRow(docGuid, i, updates[i]);
    const before = await rowCount(docGuid);

    const doc = liveDoc(updates, 1);
    const origins = [];
    doc.on('update', (_u, origin) => origins.push(origin));

    await reconcileDoc(docGuid, doc, { persistence });

    // ONE coherent update event, not a burst mid-repair.
    expect(origins).toHaveLength(1);
    expect(origins[0]).toBe(ORIGIN_DB_LOAD);
    // The two predicates the rest of the system gates on.
    expect(parseOrigin(origins[0])).toBeNull();        // never persisted
    expect(shouldPublishToRedis(origins[0])).toBe(false); // never rebroadcast
    // And no rows appeared: content from the log did not go back into the log.
    expect(await rowCount(docGuid)).toBe(before);
  });

  test('IDEMPOTENT: a second pass changes no content, applies nothing, counts no repair', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(4);
    for (let i = 0; i < 4; i++) await insertRow(docGuid, i, updates[i]);

    const doc = liveDoc(updates, 1);
    await reconcileDoc(docGuid, doc, { persistence });
    const settled = text(doc);
    const rowsAfterFirst = await rowCount(docGuid);

    const updatesSeen = [];
    doc.on('update', (u) => updatesSeen.push(u));

    const second = await reconcileDoc(docGuid, doc, { persistence });
    const third = await reconcileDoc(docGuid, doc, { persistence });

    expect(second.status).toBe('current');
    expect(second.applied).toBe(0);
    expect(second.repaired).toBe(false);
    expect(third.applied).toBe(0);
    expect(updatesSeen).toHaveLength(0); // no spurious updates
    expect(text(doc)).toBe(settled);
    expect(await rowCount(docGuid)).toBe(rowsAfterFirst);
  });

  test('over-applying rows the doc ALREADY has is verified, not repaired', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(4);
    for (let i = 0; i < 4; i++) await insertRow(docGuid, i, updates[i]);

    // The fan-out-worked shape: content is current, bookkeeping is behind.
    const doc = new Y.Doc();
    for (let i = 0; i < 4; i++) Y.applyUpdate(doc, updates[i]);
    doc._verifiedClock = 0; // only clock 0 was ever verified

    const repairSpy = jest.spyOn(telemetryMetrics, 'recordReconcileRepair');
    try {
      const out = await reconcileDoc(docGuid, doc, { persistence });
      expect(out.status).toBe('verified');
      expect(out.applied).toBe(0);
      expect(out.repaired).toBe(false);
      expect(out.verifiedClock).toBe(3); // bookkeeping caught up
      expect(repairSpy).not.toHaveBeenCalled(); // activity is not divergence
    } finally {
      repairSpy.mockRestore();
    }
  });

  test('a genuine repair increments collab.reconcile.repairs exactly once', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(3);
    for (let i = 0; i < 3; i++) await insertRow(docGuid, i, updates[i]);

    const repairSpy = jest.spyOn(telemetryMetrics, 'recordReconcileRepair');
    try {
      await reconcileDoc(docGuid, liveDoc(updates, 1), { persistence });
      expect(repairSpy).toHaveBeenCalledTimes(1);
    } finally {
      repairSpy.mockRestore();
    }
  });

  test('an UNDEFINED verified clock verifies from the whole log', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(4);
    for (let i = 0; i < 4; i++) await insertRow(docGuid, i, updates[i]);

    // A fresh agent-session doc: nothing verified, and NOT clock 0.
    const doc = new Y.Doc();
    expect(doc._verifiedClock).toBeUndefined();

    const out = await reconcileDoc(docGuid, doc, { persistence });

    expect(out.verifiedClock).toBe(3);
    expect(text(doc)).toContain('para-3');
  });

  test('a document with no durable rows is current, not an error', async () => {
    const docGuid = newDocGuid();
    const doc = new Y.Doc();
    doc._verifiedClock = -1;

    const out = await reconcileDoc(docGuid, doc, { persistence });

    expect(out.status).toBe('current');
    expect(out.applied).toBe(0);
  });

  describe('eviction race', () => {
    test('a doc REPLACED in the registry is a silent no-op', async () => {
      const docGuid = newDocGuid();
      const updates = buildUpdateChain(3);
      for (let i = 0; i < 3; i++) await insertRow(docGuid, i, updates[i]);

      const stale = liveDoc(updates, 1);
      const replacement = liveDoc(updates, 3);
      const docs = new Map([[`s/${docGuid}`, replacement]]);

      const out = await reconcileDoc(docGuid, stale, { persistence, docs });

      expect(out.status).toBe('skipped-evicted');
      expect(text(stale)).not.toContain('para-2'); // untouched
      expect(docs.get(`s/${docGuid}`)).toBe(replacement); // never re-inserted
    });

    test('a doc evicted DURING the fetch is not written into', async () => {
      const docGuid = newDocGuid();
      const updates = buildUpdateChain(3);
      for (let i = 0; i < 3; i++) await insertRow(docGuid, i, updates[i]);

      const doc = liveDoc(updates, 1);
      const docs = new Map([[`s/${docGuid}`, doc]]);

      // Evict mid-flight, exactly as refuseBind would while a pass is in flight.
      const realFetch = persistence.getUpdatesInRange.bind(persistence);
      persistence.getUpdatesInRange = async (...args) => {
        const rows = await realFetch(...args);
        docs.set(`s/${docGuid}`, new Y.Doc()); // replaced by a later bind
        return rows;
      };
      try {
        const out = await reconcileDoc(docGuid, doc, { persistence, docs });
        expect(out.status).toBe('skipped-evicted');
        expect(text(doc)).not.toContain('para-2');
      } finally {
        persistence.getUpdatesInRange = realFetch;
      }
    });

    test('a doc whose bind was REFUSED is never repaired back into existence', async () => {
      const docGuid = newDocGuid();
      const updates = buildUpdateChain(3);
      for (let i = 0; i < 3; i++) await insertRow(docGuid, i, updates[i]);

      const doc = liveDoc(updates, 1);
      doc._bindFailed = true;

      const out = await reconcileDoc(docGuid, doc, { persistence });

      expect(out.status).toBe('skipped-bind-failed');
      expect(text(doc)).not.toContain('para-2');
    });

    test('a destroyed doc fails the pass without throwing into the trigger', async () => {
      const docGuid = newDocGuid();
      const updates = buildUpdateChain(3);
      for (let i = 0; i < 3; i++) await insertRow(docGuid, i, updates[i]);

      const doc = liveDoc(updates, 1);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // A fetch that throws stands in for any failure a racing teardown causes.
        const realFetch = persistence.getUpdatesInRange.bind(persistence);
        persistence.getUpdatesInRange = async () => { throw new Error('doc destroyed'); };
        try {
          await expect(reconcileDoc(docGuid, doc, { persistence })).resolves.toMatchObject({
            status: 'error',
            applied: 0,
          });
        } finally {
          persistence.getUpdatesInRange = realFetch;
        }
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('a missing target or persistence is a no-op, never a throw', async () => {
      await expect(reconcileDoc('x', null, { persistence })).resolves.toMatchObject({ status: 'skipped-no-target' });
      await expect(reconcileDoc('x', new Y.Doc(), {})).resolves.toMatchObject({ status: 'skipped-no-target' });
    });
  });

  test('a known-current newestClock short-circuits WITHOUT fetching rows', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(3);
    for (let i = 0; i < 3; i++) await insertRow(docGuid, i, updates[i]);

    const doc = liveDoc(updates, 3); // verified 2
    const fetchSpy = jest.spyOn(persistence, 'getUpdatesInRange');
    try {
      const out = await reconcileDoc(docGuid, doc, { persistence, newestClock: 2 });
      expect(out.status).toBe('current');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/**
 * The periodic check. Its COST is as much the contract as its effect: a
 * consistency mechanism that scales with the number of bound documents would be
 * paid for on every pod, every period, forever — so SC-005 fixes the
 * steady-state price at one batched query and nothing else.
 */
describe('057 runReconcileTick', () => {
  let pool;
  let persistence;
  const docGuids = [];

  const newDocGuid = () => {
    const guid = `20572000-${String(docGuids.length).padStart(4, '0')}-4000-8000-${Date.now()
      .toString(16)
      .padStart(12, '0')
      .slice(-12)}`;
    docGuids.push(guid);
    return guid;
  };

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

  const insertRow = (docGuid, clock, update) =>
    pool.query('INSERT INTO yjs_updates (doc_guid, clock, update_data) VALUES ($1, $2, $3)',
      [docGuid, clock, Buffer.from(update)]);

  /** A bound registry doc holding updates [0..n) with an honest verified clock. */
  function boundDoc(updates, n) {
    const doc = new Y.Doc();
    for (let i = 0; i < n; i++) Y.applyUpdate(doc, updates[i]);
    doc._verifiedClock = n - 1;
    doc._bindComplete = true;
    return doc;
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

  test('SC-005: a no-divergence tick issues ONE batched query and ZERO row fetches', async () => {
    const docs = new Map();
    for (let d = 0; d < 5; d++) {
      const docGuid = newDocGuid();
      const updates = buildUpdateChain(4);
      for (let i = 0; i < 4; i++) await insertRow(docGuid, i, updates[i]);
      docs.set(`s/${docGuid}`, boundDoc(updates, 4)); // fully current
    }

    const batchSpy = jest.spyOn(persistence, 'getNewestClocks');
    const rowSpy = jest.spyOn(persistence, 'getUpdatesInRange');
    try {
      const summary = await runReconcileTick({ docs, persistence });

      expect(summary.checked).toBe(5);
      expect(summary.behind).toBe(0);
      expect(batchSpy).toHaveBeenCalledTimes(1);   // one query for all five docs
      expect(rowSpy).not.toHaveBeenCalled();       // and no per-document fetch
    } finally {
      batchSpy.mockRestore();
      rowSpy.mockRestore();
    }
  });

  test('only the documents actually behind pay for a row fetch', async () => {
    const docs = new Map();
    const currentGuid = newDocGuid();
    const behindGuid = newDocGuid();
    for (const guid of [currentGuid, behindGuid]) {
      const updates = buildUpdateChain(4);
      for (let i = 0; i < 4; i++) await insertRow(guid, i, updates[i]);
      docs.set(`s/${guid}`, boundDoc(updates, guid === currentGuid ? 4 : 2));
    }

    const rowSpy = jest.spyOn(persistence, 'getUpdatesInRange');
    try {
      const summary = await runReconcileTick({ docs, persistence });

      expect(summary.checked).toBe(2);
      expect(summary.behind).toBe(1);
      expect(rowSpy).toHaveBeenCalledTimes(1);
      expect(rowSpy.mock.calls[0][0]).toBe(behindGuid);
    } finally {
      rowSpy.mockRestore();
    }
  });

  test('an empty registry does no work at all', async () => {
    const batchSpy = jest.spyOn(persistence, 'getNewestClocks');
    try {
      expect(await runReconcileTick({ docs: new Map(), persistence }))
        .toEqual({ checked: 0, behind: 0, repaired: 0 });
      expect(batchSpy).not.toHaveBeenCalled();
    } finally {
      batchSpy.mockRestore();
    }
  });

  test('documents with no durable rows are skipped, not reconciled toward nothing', async () => {
    const docs = new Map();
    const emptyGuid = newDocGuid();
    const doc = new Y.Doc();
    doc._bindComplete = true;
    doc._verifiedClock = -1;
    docs.set(`s/${emptyGuid}`, doc);

    const rowSpy = jest.spyOn(persistence, 'getUpdatesInRange');
    try {
      const summary = await runReconcileTick({ docs, persistence });
      expect(summary.checked).toBe(1);
      expect(summary.behind).toBe(0);
      expect(rowSpy).not.toHaveBeenCalled();
    } finally {
      rowSpy.mockRestore();
    }
  });

  test('a failing batch probe degrades to a no-op instead of throwing', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(3);
    for (let i = 0; i < 3; i++) await insertRow(docGuid, i, updates[i]);
    const docs = new Map([[`s/${docGuid}`, boundDoc(updates, 1)]]);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const batchSpy = jest.spyOn(persistence, 'getNewestClocks')
      .mockRejectedValue(new Error('database unavailable'));
    try {
      await expect(runReconcileTick({ docs, persistence })).resolves.toMatchObject({ repaired: 0 });
    } finally {
      batchSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('one document failing does not abandon the rest of the tick', async () => {
    const docs = new Map();
    const guids = [];
    for (let d = 0; d < 3; d++) {
      const docGuid = newDocGuid();
      guids.push(docGuid);
      const updates = buildUpdateChain(3);
      for (let i = 0; i < 3; i++) await insertRow(docGuid, i, updates[i]);
      docs.set(`s/${docGuid}`, boundDoc(updates, 1)); // all behind
    }

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const realFetch = persistence.getUpdatesInRange.bind(persistence);
    jest.spyOn(persistence, 'getUpdatesInRange').mockImplementation((guid, ...rest) => {
      if (guid === guids[0]) return Promise.reject(new Error('transient'));
      return realFetch(guid, ...rest);
    });
    try {
      const summary = await runReconcileTick({ docs, persistence });
      expect(summary.behind).toBe(3);
      expect(summary.repaired).toBe(2); // the other two still healed
    } finally {
      jest.restoreAllMocks();
      warnSpy.mockRestore();
    }
  });

  test('no persistence is a no-op', async () => {
    expect(await runReconcileTick({})).toEqual({ checked: 0, behind: 0, repaired: 0 });
  });

  describe('periodic lifecycle', () => {
    afterEach(() => {
      stopPeriodicCheck();
      delete process.env.COLLAB_RECONCILE_INTERVAL_MS;
      jest.useRealTimers();
    });

    test('start ticks at the configured interval and stop clears it', async () => {
      jest.useFakeTimers();
      process.env.COLLAB_RECONCILE_INTERVAL_MS = '5000';

      let ticks = 0;
      const countingPersistence = {
        getNewestClocks: async () => { ticks += 1; return new Map(); },
      };
      const docs = new Map([['s/probe', Object.assign(new Y.Doc(), { _bindComplete: true })]]);
      // The tick body is async, so the pass lands a microtask after the timer.
      const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

      const handle = startPeriodicCheck({ docs, persistence: countingPersistence });
      expect(handle).toBeTruthy();
      expect(jest.getTimerCount()).toBe(1);

      jest.advanceTimersByTime(4999);
      await settle();
      expect(ticks).toBe(0);           // not before the period elapses
      jest.advanceTimersByTime(1);
      await settle();
      expect(ticks).toBe(1);

      stopPeriodicCheck();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(50000);
      await settle();
      expect(ticks).toBe(1);           // stopped means stopped
    });

    test('starting twice does not stack timers', () => {
      jest.useFakeTimers();
      const first = startPeriodicCheck({ docs: new Map(), persistence });
      const second = startPeriodicCheck({ docs: new Map(), persistence });
      expect(second).toBe(first);
      expect(jest.getTimerCount()).toBe(1);
    });

    test('stop is idempotent and safe when never started', () => {
      expect(() => stopPeriodicCheck()).not.toThrow();
      expect(() => stopPeriodicCheck()).not.toThrow();
    });

    test('without persistence nothing is scheduled', () => {
      jest.useFakeTimers();
      expect(startPeriodicCheck({ docs: new Map() })).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    });

    test('the timer is unref\'d so it never holds a drain open', () => {
      jest.useRealTimers();
      const handle = startPeriodicCheck({ docs: new Map(), persistence });
      // An unref'd timer reports itself as not keeping the loop alive.
      expect(typeof handle.hasRef === 'function' ? handle.hasRef() : false).toBe(false);
    });

    test('a slow pass skips the next tick rather than stacking passes', async () => {
      jest.useFakeTimers();
      process.env.COLLAB_RECONCILE_INTERVAL_MS = '1000';

      let inFlight = 0;
      let maxConcurrent = 0;
      let release;
      const gate = new Promise((r) => { release = r; });
      const slowPersistence = {
        getNewestClocks: async () => {
          inFlight += 1;
          maxConcurrent = Math.max(maxConcurrent, inFlight);
          await gate;
          inFlight -= 1;
          return new Map();
        },
      };
      const docs = new Map([['s/x', Object.assign(new Y.Doc(), { _bindComplete: true })]]);

      startPeriodicCheck({ docs, persistence: slowPersistence });
      jest.advanceTimersByTime(5000); // five periods while one pass is stuck
      await Promise.resolve();

      expect(maxConcurrent).toBe(1);
      release();
      await Promise.resolve();
    });
  });
});

describe('057 reconcile helpers', () => {
  test('boundDocs selects only fully-bound, non-refused documents', () => {
    const bound = Object.assign(new Y.Doc(), { _bindComplete: true });
    const midBind = new Y.Doc();
    const refused = Object.assign(new Y.Doc(), { _bindComplete: true, _bindFailed: true });

    const docs = new Map([
      ['s/aaaa', bound],
      ['s/bbbb', midBind],
      ['s/cccc', refused],
    ]);

    expect(boundDocs(docs)).toEqual([{ docGuid: 'aaaa', ydoc: bound }]);
    expect(boundDocs(null)).toEqual([]);
  });

  describe('readIntervalMs', () => {
    afterEach(() => { delete process.env.COLLAB_RECONCILE_INTERVAL_MS; });

    test('defaults to 30s', () => {
      expect(readIntervalMs()).toBe(DEFAULT_INTERVAL_MS);
      expect(DEFAULT_INTERVAL_MS).toBe(30000);
    });

    test('honours a valid override', () => {
      process.env.COLLAB_RECONCILE_INTERVAL_MS = '5000';
      expect(readIntervalMs()).toBe(5000);
    });

    test('a typo falls back to the default instead of producing setInterval(NaN)', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (const bad of ['abc', '0', '-1', 'NaN']) {
          process.env.COLLAB_RECONCILE_INTERVAL_MS = bad;
          expect(readIntervalMs()).toBe(DEFAULT_INTERVAL_MS);
        }
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
