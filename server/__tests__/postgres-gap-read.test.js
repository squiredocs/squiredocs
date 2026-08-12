/**
 * Feature 021 US3 — gap-tolerant getYDoc (FR-013..016, RBD-5, SC-005).
 *
 * getYDoc is the single choke point for every log-rebuild reader (history,
 * diffs, exports, MCP read, bindState). A read racing a mid-commit row can
 * see clocks {…k, k+2…} and integrate nothing causally after the gap
 * (observed 2026-07-18: a headings-only skeleton read). The fix: detect
 * non-contiguity within the fetched rows, retry the FULL fetch briefly
 * (env-tunable), then serve as-is with an observable log line.
 *
 * Written FIRST (tests-first): RED against the current gap-blind getYDoc.
 * Timing is driven via the env knobs, never wall-clock defaults.
 */
const Y = require('yjs');
const { createPool, createPersistence } = require('./helpers/db');

describe('021 gap-tolerant getYDoc', () => {
  let pool;
  let persistence;
  const docGuids = [];
  let warnSpy;

  const newDocGuid = () => {
    const guid = `20000000-${String(docGuids.length).padStart(4, '0')}-4000-8000-${Date.now()
      .toString(16)
      .padStart(12, '0')
      .slice(-12)}`;
    docGuids.push(guid);
    return guid;
  };

  /**
   * Build sequential incremental updates from one Y.Doc: update i appends
   * paragraph "para-i". Same client => causally chained: an update after a
   * withheld one cannot integrate until the missing one arrives.
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

  async function insertRow(docGuid, clock, update) {
    await pool.query(
      'INSERT INTO yjs_updates (doc_guid, clock, update_data) VALUES ($1, $2, $3)',
      [docGuid, clock, Buffer.from(update)]
    );
  }

  /**
   * Feature 043 US8 (FR-011, ledger D4) — assert the behavior, not the clock.
   *
   * This suite used to prove "no retry wait happened" with wall-clock bounds
   * (a sub-300ms bound on `Date.now() - start`) after setting a long retry
   * delay. That is a proxy, and a bad one: on a loaded CI runner a 300ms budget
   * fails for reasons that have nothing to do with retries, so the guard turns
   * into noise and gets ignored — and a flaky guard is worse than none.
   *
   * The proxied fact is directly observable. `_fetchRowsWithGapRetry` is the one
   * choke point every log-rebuild reader funnels through, and it RETURNS its
   * retry count. Tests that call it directly just assert `retries`. Tests that
   * go through a public reader (`getYDoc`) wrap the call in this probe, which
   * reports the highest retry count any inner fetch performed. Zero retries is
   * the actual claim; it is now asserted rather than inferred from elapsed time.
   *
   * @param {() => Promise<T>} fn
   * @returns {Promise<{value: T, retries: number}>} highest retries observed
   */
  async function withRetryProbe(fn) {
    let retries = 0;
    // Capture the real method BEFORE replacing it, so the wrapper delegates to
    // the production implementation and not back into itself.
    const real = persistence._fetchRowsWithGapRetry;
    persistence._fetchRowsWithGapRetry = async function (...args) {
      const out = await real.apply(this, args);
      retries = Math.max(retries, out.retries || 0);
      return out;
    };
    try {
      const value = await fn();
      return { value, retries };
    } finally {
      persistence._fetchRowsWithGapRetry = real;
    }
  }

  const docText = (ydoc) => ydoc.getXmlFragment('default').toString();

  const gapLogs = () =>
    warnSpy.mock.calls.filter((c) => String(c[0]).includes('served with clock gap'));

  beforeAll(() => {
    pool = createPool();
    persistence = createPersistence();
  });

  afterAll(async () => {
    for (const guid of docGuids) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [guid]);
    }
    await pool.end();
  });

  beforeEach(() => {
    // Small, deterministic retry budget for every test (RBD-5 env knobs).
    process.env.COLLAB_READ_GAP_RETRIES = '2';
    process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '40,80';
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.COLLAB_READ_GAP_RETRIES;
    delete process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS;
    warnSpy.mockRestore();
  });

  test('(a) gap heals within the retry window: complete document returned', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(4);
    await insertRow(docGuid, 0, updates[0]);
    await insertRow(docGuid, 1, updates[1]);
    await insertRow(docGuid, 3, updates[3]); // clock 2 withheld (mid-commit race)

    // Release the missing row during the retry window (~40ms in).
    const release = setTimeout(() => {
      insertRow(docGuid, 2, updates[2]).catch(() => {});
    }, 20);

    const ydoc = await persistence.getYDoc(docGuid);
    clearTimeout(release);

    const text = docText(ydoc);
    expect(text).toContain('para-0');
    expect(text).toContain('para-1');
    expect(text).toContain('para-2');
    expect(text).toContain('para-3'); // causally after the healed gap
    expect(gapLogs()).toHaveLength(0); // healed => no gapped-serve line
  });

  test('(b) gap persists past the window: served as-is within the budget, logged', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(4);
    await insertRow(docGuid, 0, updates[0]);
    await insertRow(docGuid, 1, updates[1]);
    await insertRow(docGuid, 3, updates[3]); // clock 2 never arrives

    const start = Date.now();
    const ydoc = await persistence.getYDoc(docGuid);
    const elapsed = Date.now() - start;

    // No hang, no throw: bounded by the configured budget (40+80ms + slack).
    expect(elapsed).toBeLessThan(1000);
    // Served from the rows at hand: content after the gap is not integrated.
    const text = docText(ydoc);
    expect(text).toContain('para-0');
    expect(text).toContain('para-1');
    expect(text).not.toContain('para-3');

    // FR-015: the gapped serve is observable.
    const logs = gapLogs();
    expect(logs).toHaveLength(1);
    const line = String(logs[0][0]);
    expect(line).toContain(docGuid);
    expect(line).toContain('retries=2');
    expect(line).toContain('firstGapAfterClock=1');
  });

  test('(c) gap-free rows: zero retries, zero waits, result unchanged', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(3);
    for (let i = 0; i < 3; i++) await insertRow(docGuid, i, updates[i]);

    // A long delay is still configured, so a retry would be unmistakable — but
    // the claim is asserted directly rather than inferred from elapsed time.
    process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '500,500';

    const { value: ydoc, retries } = await withRetryProbe(() => persistence.getYDoc(docGuid));

    expect(retries).toBe(0); // no retry wait on the hot path
    const text = docText(ydoc);
    expect(text).toContain('para-0');
    expect(text).toContain('para-2');
    expect(gapLogs()).toHaveLength(0);
  });

  test('(d) head-of-history: contiguous rows starting at clock 5 are not a gap', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(3);
    // Contiguity is judged WITHIN the fetched rows — first clock value is free.
    await insertRow(docGuid, 5, updates[0]);
    await insertRow(docGuid, 6, updates[1]);
    await insertRow(docGuid, 7, updates[2]);

    process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '500,500';
    const { value: ydoc, retries } = await withRetryProbe(() => persistence.getYDoc(docGuid));
    expect(retries).toBe(0); // a free first clock is not a gap, so nothing retries
    expect(docText(ydoc)).toContain('para-2');
    expect(gapLogs()).toHaveLength(0);
  });

  test('(e) multiple gaps: one shared (non-compounding) retry budget', async () => {
    const docGuid = newDocGuid();
    const updates = buildUpdateChain(6);
    await insertRow(docGuid, 0, updates[0]);
    await insertRow(docGuid, 2, updates[2]); // gap after 0
    await insertRow(docGuid, 4, updates[4]); // gap after 2

    const start = Date.now();
    const ydoc = await persistence.getYDoc(docGuid);
    const elapsed = Date.now() - start;

    // Budget is 40+80ms regardless of gap count (never compounds per-gap).
    expect(elapsed).toBeLessThan(1000);
    expect(docText(ydoc)).toContain('para-0');
    expect(gapLogs()).toHaveLength(1);
  });

  test('(f) empty and single-row reads: zero added behavior', async () => {
    const emptyGuid = newDocGuid();
    process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '500,500';

    const empty = await withRetryProbe(() => persistence.getYDoc(emptyGuid));
    expect(empty.retries).toBe(0); // zero rows is complete, not gapped
    expect(docText(empty.value)).toBe('');

    const singleGuid = newDocGuid();
    const [only] = buildUpdateChain(1);
    await insertRow(singleGuid, 9, only); // arbitrary clock, single row

    const single = await withRetryProbe(() => persistence.getYDoc(singleGuid));
    expect(single.retries).toBe(0); // one row cannot be non-contiguous
    expect(docText(single.value)).toContain('para-0');
    expect(gapLogs()).toHaveLength(0);
  });
});

/**
 * Feature 023 T003 — the extracted `_fetchRowsWithGapRetry` choke point
 * (FR-007/008/010). Every yjs_updates log-rebuild reader funnels through it;
 * these lock its contract directly: return shape, per-reader label in the warn
 * line, the SHARED (021) retry budget, and zero-overhead gap-free path.
 */
describe('023 _fetchRowsWithGapRetry choke point', () => {
  let pool;
  let persistence;
  let client;
  const docGuids = [];
  let warnSpy;

  const newDocGuid = () => {
    const guid = `20030000-${String(docGuids.length).padStart(4, '0')}-4000-8000-${Date.now()
      .toString(16)
      .padStart(12, '0')
      .slice(-12)}`;
    docGuids.push(guid);
    return guid;
  };

  const insertRow = (docGuid, clock) =>
    pool.query(
      'INSERT INTO yjs_updates (doc_guid, clock, update_data) VALUES ($1, $2, $3)',
      [docGuid, clock, Buffer.from(new Uint8Array([clock & 0xff]))]
    );

  const SQL = 'SELECT clock, update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC';
  const gapLogs = () =>
    warnSpy.mock.calls.filter((c) => String(c[0]).includes('served with clock gap'));

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    for (const guid of docGuids) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [guid]);
    }
    await pool.end();
  });

  beforeEach(() => {
    process.env.COLLAB_READ_GAP_RETRIES = '2';
    process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '40,80';
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.COLLAB_READ_GAP_RETRIES;
    delete process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS;
    warnSpy.mockRestore();
  });

  test('returns { rows, gapped, retries } — gap-free', async () => {
    const docGuid = newDocGuid();
    for (let i = 0; i < 3; i++) await insertRow(docGuid, i);

    const out = await persistence._fetchRowsWithGapRetry(client, SQL, [docGuid], `probe ${docGuid}`);
    expect(out).toEqual({ rows: expect.any(Array), gapped: false, retries: 0 });
    expect(out.rows).toHaveLength(3);
    expect(gapLogs()).toHaveLength(0);
  });

  test('gap-free hot path: zero retries, no wait', async () => {
    const docGuid = newDocGuid();
    for (let i = 0; i < 3; i++) await insertRow(docGuid, i);
    process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '500,500';

    // `retries` is returned; the elapsed-time proxy that used to stand here said
    // strictly less than the assertion below already does.
    const out = await persistence._fetchRowsWithGapRetry(client, SQL, [docGuid], `probe ${docGuid}`);
    expect(out.gapped).toBe(false);
    expect(out.retries).toBe(0);
  });

  test('still-gapped: returns gapped=true, exhausts the SHARED budget, warns with the label', async () => {
    const docGuid = newDocGuid();
    await insertRow(docGuid, 0);
    await insertRow(docGuid, 1);
    await insertRow(docGuid, 3); // clock 2 never arrives

    const out = await persistence._fetchRowsWithGapRetry(client, SQL, [docGuid], `myReader ${docGuid}`);
    expect(out.gapped).toBe(true);
    expect(out.retries).toBe(2); // COLLAB_READ_GAP_RETRIES, shared 021 knob
    expect(out.rows).toHaveLength(3);

    const logs = gapLogs();
    expect(logs).toHaveLength(1);
    const line = String(logs[0][0]);
    expect(line).toContain('myReader'); // per-reader label surfaces
    expect(line).toContain(docGuid);
    expect(line).toContain('retries=2');
    expect(line).toContain('firstGapAfterClock=1');
  });

  test('descending option: contiguity judged on the ascending view', async () => {
    const docGuid = newDocGuid();
    for (let c = 5; c < 8; c++) await insertRow(docGuid, c); // contiguous 5,6,7
    process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '500,500';

    const descSql = 'SELECT clock, update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock DESC';
    const out = await persistence._fetchRowsWithGapRetry(client, descSql, [docGuid], `desc ${docGuid}`, { descending: true });
    expect(out.gapped).toBe(false);
    expect(out.retries).toBe(0); // no false gap => no retry wait
    expect(gapLogs()).toHaveLength(0);
  });
});

/**
 * Feature 023 T009 (FR-007/008/010, SC-002): the OTHER log-rebuild readers now
 * funnel through the choke point too — getYDocAtClock (serving-only) and the
 * _queryUpdatesWithUsers family (getUpdatesWithUsers / getUpdatesInRange /
 * getRecentUpdatesWithUsers). Each detects a gap, retries within the SHARED
 * budget, serves the healed read, and surfaces the gap (warn line + `gapped`).
 */
describe('023 gap tolerance across every reader', () => {
  let pool;
  let persistence;
  const docGuids = [];
  let warnSpy;

  const newDocGuid = () => {
    const guid = `20090000-${String(docGuids.length).padStart(4, '0')}-4000-8000-${Date.now()
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
        t.insert(0, `seg-${i}`);
        el.insert(0, [t]);
        frag.push([el]);
      });
      updates.push(Y.encodeStateAsUpdate(doc, sv));
    }
    return updates;
  }

  const insertRow = (docGuid, clock, update) =>
    pool.query('INSERT INTO yjs_updates (doc_guid, clock, update_data) VALUES ($1, $2, $3)', [docGuid, clock, Buffer.from(update)]);

  const gapLogs = () => warnSpy.mock.calls.filter((c) => String(c[0]).includes('served with clock gap'));

  beforeAll(() => {
    pool = createPool();
    persistence = createPersistence();
  });

  afterAll(async () => {
    for (const guid of docGuids) await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [guid]);
    await pool.end();
  });

  beforeEach(() => {
    process.env.COLLAB_READ_GAP_RETRIES = '2';
    process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '40,80';
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.COLLAB_READ_GAP_RETRIES;
    delete process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS;
    warnSpy.mockRestore();
  });

  test('getYDocAtClock: still-gapped serves as-is + warns with its label', async () => {
    const docGuid = newDocGuid();
    const u = buildUpdateChain(4);
    await insertRow(docGuid, 0, u[0]);
    await insertRow(docGuid, 1, u[1]);
    await insertRow(docGuid, 3, u[3]); // clock 2 never arrives

    const ydoc = await persistence.getYDocAtClock(docGuid, 3);
    const text = ydoc.getXmlFragment('default').toString();
    expect(text).toContain('seg-0');
    expect(text).toContain('seg-1');
    expect(text).not.toContain('seg-3'); // causally after the gap, not integrated
    const logs = gapLogs();
    expect(logs).toHaveLength(1);
    expect(String(logs[0][0])).toContain('getYDocAtClock');
  });

  test('getYDocAtClock: gap healing within the window returns the complete slice', async () => {
    const docGuid = newDocGuid();
    const u = buildUpdateChain(4);
    await insertRow(docGuid, 0, u[0]);
    await insertRow(docGuid, 1, u[1]);
    await insertRow(docGuid, 3, u[3]);
    setTimeout(() => insertRow(docGuid, 2, u[2]).catch(() => {}), 20);

    const ydoc = await persistence.getYDocAtClock(docGuid, 3);
    const text = ydoc.getXmlFragment('default').toString();
    expect(text).toContain('seg-2');
    expect(text).toContain('seg-3');
    expect(gapLogs()).toHaveLength(0);
  });

  test('getUpdatesInRange({ withGap }): surfaces gapped=true on a torn range', async () => {
    const docGuid = newDocGuid();
    const u = buildUpdateChain(4);
    await insertRow(docGuid, 0, u[0]);
    await insertRow(docGuid, 1, u[1]);
    await insertRow(docGuid, 3, u[3]);

    const gappedOut = await persistence.getUpdatesInRange(docGuid, 0, 100, { withGap: true });
    expect(gappedOut.gapped).toBe(true);
    expect(gappedOut.updates.length).toBe(3);
    // Default (no withGap) keeps the plain array shape.
    const plain = await persistence.getUpdatesInRange(docGuid, 0, 100);
    expect(Array.isArray(plain)).toBe(true);
    expect(plain.length).toBe(3);
    expect(gapLogs().length).toBeGreaterThanOrEqual(1);
    expect(String(gapLogs()[0][0])).toContain('_queryUpdatesWithUsers');
  });

  test('getUpdatesWithUsers / getRecentUpdatesWithUsers: gap-free returns an ordered array', async () => {
    const docGuid = newDocGuid();
    const u = buildUpdateChain(3);
    for (let i = 0; i < 3; i++) await insertRow(docGuid, i, u[i]);

    const all = await persistence.getUpdatesWithUsers(docGuid);
    expect(Array.isArray(all)).toBe(true);
    expect(all.map((r) => r.clock)).toEqual([0, 1, 2]);
    const recent = await persistence.getRecentUpdatesWithUsers(docGuid, 2);
    expect(recent.map((r) => r.clock)).toEqual([1, 2]); // ascending after reverse
    expect(gapLogs()).toHaveLength(0);
  });

  // =========================================================================
  // Feature 039 US1 — read COMPLETENESS (RC-1..RC-8).
  //
  // `_findFirstGap` judges contiguity only BETWEEN the rows it fetched, so a
  // read that simply stopped short of the newest version looks perfectly
  // gap-free. That is the torn read that froze wrong diffs into the cache for a
  // full hour (audit finding F7). `expectedTailClock` is the opt-in that says
  // "this read must actually REACH clock N".
  //
  // Contract: specs/039-diff-cache-integrity/contracts/read-completeness.md
  // =========================================================================
  describe('039 read completeness — expectedTailClock', () => {
    const MAX_CLOCK = 2147483647; // the backfill's "whole log" sentinel

    /** Count queries issued by one call, by wrapping the pool's connect(). */
    async function countQueries(fn) {
      const realConnect = persistence.pool.connect.bind(persistence.pool);
      let queries = 0;
      persistence.pool.connect = async (...args) => {
        const client = await realConnect(...args);
        const realQuery = client.query.bind(client);
        client.query = (...qargs) => { queries += 1; return realQuery(...qargs); };
        return client;
      };
      try {
        const value = await fn();
        return { value, queries };
      } finally {
        persistence.pool.connect = realConnect;
      }
    }

    test('RC-1/RC-2: a short tail is retried, then served as incomplete with a reason-tagged warn', async () => {
      const docGuid = newDocGuid();
      const u = buildUpdateChain(4);
      // Rows 0..2 are contiguous — gap-free by the old test — but clock 3, the
      // version actually being asked for, never commits.
      for (let i = 0; i < 3; i++) await insertRow(docGuid, i, u[i]);

      const { value: res, queries } = await countQueries(() =>
        persistence.getUpdateRowsUpTo(docGuid, 3, { expectedTailClock: 3 })
      );

      expect(res.gapped).toBe(true);            // incomplete, though gap-free
      expect(res.rows.map((r) => Number(r.clock))).toEqual([0, 1, 2]);
      expect(queries).toBe(3);                  // initial + 2 retries (budget)

      const logs = gapLogs();
      expect(logs).toHaveLength(1);
      const line = String(logs[0][0]);
      expect(line).toContain('reason=short-tail');   // G3: the two causes are distinguishable
      expect(line).toContain('retries=2');
      expect(line).toContain('expectedTailClock=3');
      expect(line).toContain('lastClock=2');
    });

    test('RC-3: the missing tail row arriving during the retry window heals the read', async () => {
      const docGuid = newDocGuid();
      const u = buildUpdateChain(4);
      for (let i = 0; i < 3; i++) await insertRow(docGuid, i, u[i]);
      const release = setTimeout(() => { insertRow(docGuid, 3, u[3]).catch(() => {}); }, 20);

      const res = await persistence.getUpdateRowsUpTo(docGuid, 3, { expectedTailClock: 3 });
      clearTimeout(release);

      expect(res.gapped).toBe(false);
      expect(res.rows.map((r) => Number(r.clock))).toEqual([0, 1, 2, 3]);
      expect(gapLogs()).toHaveLength(0);
    });

    test('RC-4: zero rows WITH expectedTailClock >= 0 is incomplete and retried', async () => {
      const docGuid = newDocGuid(); // nothing inserted

      const { value: res, queries } = await countQueries(() =>
        persistence.getUpdateRowsUpTo(docGuid, 0, { expectedTailClock: 0 })
      );

      expect(res.gapped).toBe(true);
      expect(res.rows).toHaveLength(0);
      expect(queries).toBe(3);
      expect(String(gapLogs()[0][0])).toContain('reason=short-tail');
    });

    test('RC-5: zero rows WITHOUT the option is a legitimate empty document — complete, no retry', async () => {
      const docGuid = newDocGuid();
      process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '500,500'; // any retry would be obvious

      const { value: res, queries } = await countQueries(() =>
        persistence.getUpdateRowsUpTo(docGuid, 100)
      );

      expect(res.gapped).toBe(false);
      expect(res.rows).toHaveLength(0);
      // One query IS "no retry": every retry re-runs the full fetch, so the
      // query count is a stronger statement than the elapsed-time bound that
      // used to sit here, and it does not care how loaded the runner is.
      expect(queries).toBe(1);
      expect(gapLogs()).toHaveLength(0);
    });

    test('RC-6: omitting the option reproduces pre-039 behavior on gapped, gap-free and empty inputs', async () => {
      // (a) genuinely gapped — still detected, still retried, still gapped
      const gappedGuid = newDocGuid();
      const u = buildUpdateChain(4);
      await insertRow(gappedGuid, 0, u[0]);
      await insertRow(gappedGuid, 1, u[1]);
      await insertRow(gappedGuid, 3, u[3]); // clock 2 missing
      const gappedRes = await countQueries(() => persistence.getUpdateRowsUpTo(gappedGuid, 100));
      expect(gappedRes.value.gapped).toBe(true);
      expect(gappedRes.queries).toBe(3);
      expect(String(gapLogs()[0][0])).toContain('reason=gap');
      // Without the option there is no tail detail in the line at all.
      expect(String(gapLogs()[0][0])).not.toContain('expectedTailClock');

      warnSpy.mockClear();

      // (b) gap-free — one query, no warn, even though it stops well short of
      // the requested clock. This is the behavior the backfill depends on.
      const cleanGuid = newDocGuid();
      const u2 = buildUpdateChain(3);
      for (let i = 0; i < 3; i++) await insertRow(cleanGuid, i, u2[i]);
      const cleanRes = await countQueries(() => persistence.getUpdateRowsUpTo(cleanGuid, 100));
      expect(cleanRes.value.gapped).toBe(false);
      expect(cleanRes.queries).toBe(1);
      expect(gapLogs()).toHaveLength(0);
    });

    // RC-7 — the FR-002 / hazard #1 guard. The single most important negative
    // requirement in the contract.
    test('RC-7: the backfill\'s MAX_CLOCK call issues exactly ONE query and zero retry delays', async () => {
      const docGuid = newDocGuid();
      const u = buildUpdateChain(3);
      for (let i = 0; i < 3; i++) await insertRow(docGuid, i, u[i]);
      // Make any accidental retry impossible to miss.
      process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '500,500';

      const { value: res, queries } = await countQueries(() =>
        persistence.getUpdateRowsUpTo(docGuid, MAX_CLOCK)
      );

      // If expectedTailClock were ever DERIVED from `clock`, this read would be
      // permanently "incomplete" (last clock 2 < 2147483647): full retry budget
      // burned on EVERY document in the backfill, plus a false warning each.
      // The query count is the direct evidence of that — one fetch, no retries.
      expect(queries).toBe(1);
      expect(res.gapped).toBe(false);
      expect(gapLogs()).toHaveLength(0);
    });

    test('RC-8: the descending path evaluates the tail on the ascending view', async () => {
      const docGuid = newDocGuid();
      const u = buildUpdateChain(3);
      for (let i = 0; i < 3; i++) await insertRow(docGuid, i, u[i]);
      const client = await persistence.pool.connect();
      try {
        // DESC-ordered SQL: rows arrive [2,1,0], so the TAIL is the LAST element
        // of the reversed (ascending) view, not of result.rows.
        const short = await persistence._fetchRowsWithGapRetry(
          client,
          'SELECT clock, update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock DESC',
          [docGuid],
          'desc-test',
          { descending: true, expectedTailClock: 5 }
        );
        expect(short.gapped).toBe(true);       // newest is 2, needed 5
        expect(Number(short.rows[0].clock)).toBe(2); // still DESC as the caller asked

        warnSpy.mockClear();

        const ok = await persistence._fetchRowsWithGapRetry(
          client,
          'SELECT clock, update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock DESC',
          [docGuid],
          'desc-test',
          { descending: true, expectedTailClock: 2 }
        );
        expect(ok.gapped).toBe(false);         // newest IS 2 — complete
        expect(gapLogs()).toHaveLength(0);
      } finally {
        client.release();
      }
    });

    // 039 U3 — a currentClock that never commits (bogus or deleted version id)
    // pays the retry budget on every request, forever, uncached. That is the
    // intended self-healing posture, but the cost must stay BOUNDED by the one
    // shared budget rather than compounding.
    test('U3: a never-committing tail costs the shared budget and no more', async () => {
      const docGuid = newDocGuid();
      const u = buildUpdateChain(3);
      for (let i = 0; i < 3; i++) await insertRow(docGuid, i, u[i]);
      process.env.COLLAB_READ_GAP_RETRIES = '2';
      process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '40,80';

      const start = Date.now();
      const { value: res, queries } = await countQueries(() =>
        persistence.getUpdateRowsUpTo(docGuid, 999, { expectedTailClock: 999 })
      );
      const elapsed = Date.now() - start;

      expect(res.gapped).toBe(true);
      expect(queries).toBe(3);                 // 1 + maxRetries, never more
      expect(elapsed).toBeLessThan(1000);      // 40+80ms + slack, bounded
      // And the spike is visible in production logs.
      expect(String(gapLogs()[0][0])).toContain('reason=short-tail');

      // A second identical request pays the same bounded cost — it does not
      // compound, and nothing was cached to make it cheaper either.
      warnSpy.mockClear();
      const again = await countQueries(() =>
        persistence.getUpdateRowsUpTo(docGuid, 999, { expectedTailClock: 999 })
      );
      expect(again.queries).toBe(3);
    });

    test('an interior gap AND a short tail together report both in the reason', async () => {
      const docGuid = newDocGuid();
      const u = buildUpdateChain(5);
      await insertRow(docGuid, 0, u[0]);
      await insertRow(docGuid, 2, u[2]); // interior gap after 0
      // clock 4 (the requested version) never arrives → also short

      const res = await persistence.getUpdateRowsUpTo(docGuid, 4, { expectedTailClock: 4 });
      expect(res.gapped).toBe(true);
      expect(String(gapLogs()[0][0])).toContain('reason=gap+short-tail');
    });

    // ── Feature 041 (FR-012) ────────────────────────────────────────────────
    // getYDocAtClock is the OTHER stored-artifact reader (restore's target read)
    // and had no tail-completeness option at all, so a read that stopped short
    // of the requested version looked complete and restore's fail-closed
    // guarantee had a hole.
    describe('041 FR-012: getYDocAtClock gains expectedTailClock', () => {
      test('a short tail reports gapped even though the rows present are gap-free', async () => {
        const docGuid = newDocGuid();
        const u = buildUpdateChain(4);
        for (let i = 0; i < 3; i++) await insertRow(docGuid, i, u[i]);

        const res = await persistence.getYDocAtClock(docGuid, 3, { withGap: true, expectedTailClock: 3 });

        expect(res.gapped).toBe(true);
        expect(String(gapLogs()[0][0])).toContain('reason=short-tail');
        expect(String(gapLogs()[0][0])).toContain('getYDocAtClock');
      });

      test('the same read WITHOUT the option still reports complete (serving paths unchanged)', async () => {
        const docGuid = newDocGuid();
        const u = buildUpdateChain(4);
        for (let i = 0; i < 3; i++) await insertRow(docGuid, i, u[i]);

        const res = await persistence.getYDocAtClock(docGuid, 3, { withGap: true });

        expect(res.gapped).toBe(false);
        expect(gapLogs()).toHaveLength(0);
      });

      test('a complete read with the option reports complete', async () => {
        const docGuid = newDocGuid();
        const u = buildUpdateChain(4);
        for (let i = 0; i < 4; i++) await insertRow(docGuid, i, u[i]);

        const res = await persistence.getYDocAtClock(docGuid, 3, { withGap: true, expectedTailClock: 3 });

        expect(res.gapped).toBe(false);
        expect(gapLogs()).toHaveLength(0);
      });
    });

    // ── Feature 057 (FR-003) ────────────────────────────────────────────────
    // getYDoc is the BIND-time reader, and it was the last log-rebuild reader
    // with no tail-completeness option. Without it a bind whose fetch stopped
    // short of the committed tail looked complete, and the binder memoized the
    // truncated document as the trusted live copy for the life of the pod —
    // the defect this feature closes.
    describe('057 FR-003: getYDoc gains expectedTailClock', () => {
      test('a short tail reports gapped even though the rows present are gap-free', async () => {
        const docGuid = newDocGuid();
        const u = buildUpdateChain(4);
        for (let i = 0; i < 3; i++) await insertRow(docGuid, i, u[i]);

        const res = await persistence.getYDoc(docGuid, { withGap: true, expectedTailClock: 3 });

        expect(res.gapped).toBe(true);
        expect(String(gapLogs()[0][0])).toContain('reason=short-tail');
        expect(String(gapLogs()[0][0])).toContain('getYDoc');
        expect(String(gapLogs()[0][0])).toContain('expectedTailClock=3');
      });

      test('an interior gap past the budget reports gapped with the gap reason', async () => {
        const docGuid = newDocGuid();
        const u = buildUpdateChain(4);
        await insertRow(docGuid, 0, u[0]);
        await insertRow(docGuid, 1, u[1]);
        await insertRow(docGuid, 3, u[3]); // clock 2 never arrives

        const res = await persistence.getYDoc(docGuid, { withGap: true, expectedTailClock: 3 });

        expect(res.gapped).toBe(true);
        // The tail IS reached (row 3 is present), so the sole cause is the gap.
        expect(String(gapLogs()[0][0])).toContain('reason=gap');
        expect(String(gapLogs()[0][0])).not.toContain('reason=gap+short-tail');
      });

      test('the missing tail row arriving during the retry window heals the load', async () => {
        const docGuid = newDocGuid();
        const u = buildUpdateChain(4);
        for (let i = 0; i < 3; i++) await insertRow(docGuid, i, u[i]);
        const release = setTimeout(() => { insertRow(docGuid, 3, u[3]).catch(() => {}); }, 20);

        const res = await persistence.getYDoc(docGuid, { withGap: true, expectedTailClock: 3 });
        clearTimeout(release);

        expect(res.gapped).toBe(false);
        expect(res.ydoc.getXmlFragment('default').toString()).toContain('seg-3');
        expect(gapLogs()).toHaveLength(0);
      });

      test('the same short read WITHOUT the option still reports complete (G2: existing callers byte-identical)', async () => {
        const docGuid = newDocGuid();
        const u = buildUpdateChain(4);
        for (let i = 0; i < 3; i++) await insertRow(docGuid, i, u[i]);

        const { value: res, queries } = await countQueries(() =>
          persistence.getYDoc(docGuid, { withGap: true })
        );

        expect(res.gapped).toBe(false);
        expect(queries).toBe(1);       // no retry budget spent for an unasked question
        expect(gapLogs()).toHaveLength(0);
      });

      test('an empty document with expectedTailClock null is complete, not short', async () => {
        const docGuid = newDocGuid();

        // `null` is what a caller passes when getClockRange found no rows at all
        // (US3 scenario 4): there is no tail to reach, so an empty load is a
        // legitimate empty document rather than an incomplete read.
        const res = await persistence.getYDoc(docGuid, { withGap: true, expectedTailClock: null });

        expect(res.gapped).toBe(false);
        expect(gapLogs()).toHaveLength(0);
      });
    });

    // ── Feature 057 (FR-006): the reconciler's batched newest-clock probe ────
    describe('057 FR-006: getNewestClocks', () => {
      test('returns MAX(clock) per guid in ONE query', async () => {
        const a = newDocGuid();
        const b = newDocGuid();
        const u = buildUpdateChain(3);
        for (let i = 0; i < 3; i++) await insertRow(a, i, u[i]);
        await insertRow(b, 0, u[0]);
        await insertRow(b, 1, u[1]);

        let queries = 0;
        const realQuery = persistence.pool.query.bind(persistence.pool);
        persistence.pool.query = (...args) => { queries += 1; return realQuery(...args); };
        let result;
        try {
          result = await persistence.getNewestClocks([a, b]);
        } finally {
          persistence.pool.query = realQuery;
        }

        expect(result.get(a)).toBe(2);
        expect(result.get(b)).toBe(1);
        expect(queries).toBe(1); // SC-005: one batch, not one per document
      });

      test('empty input returns an empty Map WITHOUT querying', async () => {
        const realQuery = persistence.pool.query.bind(persistence.pool);
        let queries = 0;
        persistence.pool.query = (...args) => { queries += 1; return realQuery(...args); };
        try {
          expect(await persistence.getNewestClocks([])).toEqual(new Map());
          expect(await persistence.getNewestClocks(undefined)).toEqual(new Map());
          expect(await persistence.getNewestClocks(null)).toEqual(new Map());
        } finally {
          persistence.pool.query = realQuery;
        }
        expect(queries).toBe(0);
      });

      test('a document with no rows is ABSENT from the result, not present with null', async () => {
        const withRows = newDocGuid();
        const withoutRows = newDocGuid();
        const u = buildUpdateChain(1);
        await insertRow(withRows, 0, u[0]);

        const result = await persistence.getNewestClocks([withRows, withoutRows]);

        expect(result.get(withRows)).toBe(0);
        expect(result.has(withoutRows)).toBe(false); // nothing to reconcile toward
        expect(result.size).toBe(1);
      });

      test('a non-contiguous log still reports the true MAX', async () => {
        const docGuid = newDocGuid();
        const u = buildUpdateChain(4);
        await insertRow(docGuid, 0, u[0]);
        await insertRow(docGuid, 3, u[3]); // clock 1,2 missing

        // Deliberately NOT gap-checked: this probe answers "how far has the log
        // got", which is a question about the log, not about a rebuild.
        expect((await persistence.getNewestClocks([docGuid])).get(docGuid)).toBe(3);
      });
    });
  });
});
