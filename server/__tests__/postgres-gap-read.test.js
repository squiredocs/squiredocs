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

    // Make any accidental retry obvious in elapsed time.
    process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '500,500';

    const start = Date.now();
    const ydoc = await persistence.getYDoc(docGuid);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(300); // no retry wait on the hot path
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
    const start = Date.now();
    const ydoc = await persistence.getYDoc(docGuid);
    expect(Date.now() - start).toBeLessThan(300);
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

    let start = Date.now();
    const emptyDoc = await persistence.getYDoc(emptyGuid);
    expect(Date.now() - start).toBeLessThan(300);
    expect(docText(emptyDoc)).toBe('');

    const singleGuid = newDocGuid();
    const [only] = buildUpdateChain(1);
    await insertRow(singleGuid, 9, only); // arbitrary clock, single row

    start = Date.now();
    const singleDoc = await persistence.getYDoc(singleGuid);
    expect(Date.now() - start).toBeLessThan(300);
    expect(docText(singleDoc)).toContain('para-0');
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

    const start = Date.now();
    const out = await persistence._fetchRowsWithGapRetry(client, SQL, [docGuid], `probe ${docGuid}`);
    expect(Date.now() - start).toBeLessThan(300);
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
    const start = Date.now();
    const out = await persistence._fetchRowsWithGapRetry(client, descSql, [docGuid], `desc ${docGuid}`, { descending: true });
    expect(Date.now() - start).toBeLessThan(300); // no false gap => no retry wait
    expect(out.gapped).toBe(false);
    expect(gapLogs()).toHaveLength(0);
  });
});
