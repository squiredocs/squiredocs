/**
 * Feature 023 US4 T018 — backfill-meaningful-classification (FR-017, D-3, R5).
 *
 * DB-backed, serial only. Verifies the backfill classifies exactly like the
 * write path (shared classifyByXml replay), writes NULL rows only (idempotent,
 * resumable), and skips a still-gapped document rather than freezing a torn read.
 */
const { randomUUID } = require('crypto');
const Y = require('yjs');
const { createPool, createPersistence } = require('./helpers/db');
const { classifyByXml, extractXml } = require('../update-classifier');
const { classifyRows, writeClassifications, backfill } = require('../scripts/backfill-meaningful-classification');

describe('backfill-meaningful-classification (023 T018)', () => {
  let pool, persistence;
  const docGuids = [];

  const newDocGuid = () => { const g = randomUUID(); docGuids.push(g); return g; };

  beforeAll(() => {
    pool = createPool();
    persistence = createPersistence();
  });

  afterAll(async () => {
    for (const g of docGuids) await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [g]);
    await persistence.destroy();
    await pool.end();
  });

  // Build a chain where each update appends a paragraph; returns { updates, expected }.
  function buildChain(count) {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    const updates = [];
    for (let i = 0; i < count; i++) {
      const sv = Y.encodeStateVector(doc);
      doc.transact(() => {
        const el = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, `c-${i}`);
        el.insert(0, [t]);
        frag.push([el]);
      });
      updates.push(Y.encodeStateAsUpdate(doc, sv));
    }
    doc.destroy();
    return updates;
  }

  async function seedNull(docGuid, updates, startClock = 0) {
    for (let i = 0; i < updates.length; i++) {
      await pool.query(
        'INSERT INTO yjs_updates (doc_guid, clock, update_data, meaningful) VALUES ($1, $2, $3, NULL)',
        [docGuid, startClock + i, Buffer.from(updates[i])]
      );
    }
  }

  test('classifyRows matches an independent replay with classifyByXml', () => {
    const updates = buildChain(4);
    const rows = updates.map((u, i) => ({ clock: i, update_data: Buffer.from(u) }));
    const classified = classifyRows(rows);

    const replay = new Y.Doc();
    let prev = extractXml(replay);
    const expected = updates.map((u) => {
      Y.applyUpdate(replay, u);
      const next = extractXml(replay);
      const m = classifyByXml(prev, next);
      prev = next;
      return m;
    });
    replay.destroy();
    expect(classified.map((c) => c.meaningful)).toEqual(expected);
    // Each append changes XML => all meaningful.
    expect(classified.every((c) => c.meaningful === true)).toBe(true);
  });

  test('end-to-end backfill classifies a NULL document; rerun is a no-op (idempotent)', async () => {
    const docGuid = newDocGuid();
    await seedNull(docGuid, buildChain(3));

    await backfill({ pool, persistence });
    const after = await pool.query('SELECT meaningful FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock', [docGuid]);
    expect(after.rows.map((r) => r.meaningful)).toEqual([true, true, true]);
    expect(after.rows.every((r) => r.meaningful !== null)).toBe(true);

    // Rerun writes nothing to this doc (NULL-only selection + guard).
    const written = await writeClassifications(pool, docGuid, [
      { clock: 0, meaningful: false }, { clock: 1, meaningful: false }, { clock: 2, meaningful: false },
    ]);
    expect(written).toBe(0); // all already non-NULL => never overwritten
    const still = await pool.query('SELECT meaningful FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock', [docGuid]);
    expect(still.rows.map((r) => r.meaningful)).toEqual([true, true, true]);
  });

  test('writeClassifications only touches NULL rows (never overwrites a set flag)', async () => {
    const docGuid = newDocGuid();
    const updates = buildChain(3);
    // Seed clock 0 already classified false (as if written by the write path), 1 & 2 NULL.
    await pool.query('INSERT INTO yjs_updates (doc_guid, clock, update_data, meaningful) VALUES ($1, 0, $2, false)', [docGuid, Buffer.from(updates[0])]);
    await pool.query('INSERT INTO yjs_updates (doc_guid, clock, update_data, meaningful) VALUES ($1, 1, $2, NULL)', [docGuid, Buffer.from(updates[1])]);
    await pool.query('INSERT INTO yjs_updates (doc_guid, clock, update_data, meaningful) VALUES ($1, 2, $2, NULL)', [docGuid, Buffer.from(updates[2])]);

    const written = await writeClassifications(pool, docGuid, [
      { clock: 0, meaningful: true }, { clock: 1, meaningful: true }, { clock: 2, meaningful: true },
    ]);
    expect(written).toBe(2); // only the two NULL rows
    const rows = await pool.query('SELECT clock, meaningful FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock', [docGuid]);
    expect(rows.rows.map((r) => r.meaningful)).toEqual([false, true, true]); // clock 0 preserved
  });

  test('a still-gapped document is skipped (log warns), rows stay NULL', async () => {
    const docGuid = newDocGuid();
    const updates = buildChain(4);
    // Insert clocks 0, 1, 3 — clock 2 is missing (a permanent gap for this run).
    await seedNull(docGuid, [updates[0], updates[1]], 0);
    await pool.query('INSERT INTO yjs_updates (doc_guid, clock, update_data, meaningful) VALUES ($1, 3, $2, NULL)', [docGuid, Buffer.from(updates[3])]);

    process.env.COLLAB_READ_GAP_RETRIES = '1';
    process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS = '10';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await backfill({ pool, persistence });
      expect(result.skippedGapped).toBeGreaterThanOrEqual(1);
      const rows = await pool.query('SELECT meaningful FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
      expect(rows.rows.every((r) => r.meaningful === null)).toBe(true); // never classified from a torn read
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes(docGuid))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      delete process.env.COLLAB_READ_GAP_RETRIES;
      delete process.env.COLLAB_READ_GAP_RETRY_DELAYS_MS;
    }
  });
});
