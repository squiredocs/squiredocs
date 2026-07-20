/**
 * Tests for PostgresPersistence concurrent storeUpdate behavior.
 *
 * Verifies that when two users call storeUpdate simultaneously for the same
 * document, both updates are stored with distinct clock values and correct
 * attribution (no silently dropped writes).
 *
 * The race condition: two concurrent storeUpdate calls both read the same
 * MAX(clock), compute the same nextClock, and one INSERT silently wins while
 * the other is dropped by ON CONFLICT DO NOTHING. We force this interleaving
 * by monkey-patching _getCurrentUpdateClock to delay, ensuring both callers
 * read the same clock before either inserts.
 */
const crypto = require('crypto');
const Y = require('yjs');
const { createPool, createPersistence, createTestUser, cleanupTestUser } = require('./helpers/db');
const { ORIGIN_DB_LOAD, ORIGIN_RESTORE, createOrigin, parseOrigin } = require('../origin');
const { classifyByXml, extractXml } = require('../update-classifier');

describe('PostgresPersistence', () => {
  let pool;
  let persistence;
  const testDocGuid = crypto.randomUUID();
  let humanUserId;
  let agentUserId;

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();

    // Create real test users so the FK on user_id is satisfied
    humanUserId = await createTestUser(pool, `human-${testDocGuid}@test.com`);
    agentUserId = await createTestUser(pool, `agent-${testDocGuid}@test.com`);
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [testDocGuid]);
    await cleanupTestUser(pool, humanUserId);
    await cleanupTestUser(pool, agentUserId);
    await pool.end();
    await persistence.destroy();
  });

  describe('concurrent storeUpdate', () => {
    test('both updates are stored with distinct clocks and correct attribution', async () => {
      // Seed the document with an initial update so clock starts at 0
      const seedDoc = new Y.Doc();
      seedDoc.getText('content').insert(0, 'seed');
      const seedUpdate = Y.encodeStateAsUpdate(seedDoc);
      await persistence.storeUpdate(testDocGuid, seedUpdate, null, null);

      // Create two distinct Yjs updates
      const docA = new Y.Doc();
      Y.applyUpdate(docA, seedUpdate);
      docA.getText('content').insert(4, ' alpha');
      const updateA = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(seedDoc));

      const docB = new Y.Doc();
      Y.applyUpdate(docB, seedUpdate);
      docB.getText('content').insert(4, ' beta');
      const updateB = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(seedDoc));

      // Feature 023: the per-doc FIFO queue + advisory lock serialize these two
      // concurrent calls (the old barrier that forced a shared-MAX read would now
      // deadlock — serialization makes that interleaving impossible). Fire both
      // concurrently; the queue must still hand each a distinct clock with correct
      // attribution and never drop a write.
      const [clockA, clockB] = await Promise.all([
        persistence.storeUpdate(testDocGuid, updateA, humanUserId, null),
        persistence.storeUpdate(testDocGuid, updateB, agentUserId, 'Claude'),
      ]);

      // Both must get distinct clock values
      expect(clockA).not.toBe(clockB);

      // Both clocks must be > 0 (since seed was clock 0)
      expect(clockA).toBeGreaterThan(0);
      expect(clockB).toBeGreaterThan(0);

      // Verify the rows in the database
      const result = await pool.query(
        'SELECT clock, user_id, agent_name FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC',
        [testDocGuid],
      );

      // Should have 3 rows: seed + two concurrent updates
      expect(result.rows.length).toBe(3);

      // Find the human and agent rows (order may vary)
      const humanRow = result.rows.find((r) => r.user_id === humanUserId);
      const agentRow = result.rows.find((r) => r.user_id === agentUserId);

      expect(humanRow).toBeDefined();
      expect(agentRow).toBeDefined();

      // Attribution must be correct
      expect(humanRow.agent_name).toBeNull();
      expect(agentRow.agent_name).toBe('Claude');

      // Clocks must be distinct
      expect(humanRow.clock).not.toBe(agentRow.clock);
    });
  });

  // Feature 023 US1 (T004/T006, G1): clock order = causal order by construction.
  describe('023 write serialization — clock order is causal order (US1)', () => {
    const orderDocGuid = () => `20040000-${crypto.randomUUID().slice(9)}`;

    test('T004: 50+ fire-and-forget updates persist in strict production order (zero inversions)', async () => {
      const docGuid = orderDocGuid();
      try {
        // One editing stream: each update appends the next paragraph, so the
        // rows must land in exactly the production order. Issue WITHOUT awaiting
        // each (fire-and-forget, many in flight) — the queue must serialize them.
        const doc = new Y.Doc();
        const frag = doc.getXmlFragment('default');
        const N = 60;
        const promises = [];
        for (let i = 0; i < N; i++) {
          const sv = Y.encodeStateVector(doc);
          doc.transact(() => {
            const el = new Y.XmlElement('paragraph');
            const t = new Y.XmlText();
            t.insert(0, `p-${i}`);
            el.insert(0, [t]);
            frag.push([el]);
          });
          promises.push(persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(doc, sv), humanUserId, null));
        }
        const clocks = await Promise.all(promises);

        // Assigned clocks strictly follow production order — zero inversions.
        for (let i = 1; i < clocks.length; i++) {
          expect(clocks[i]).toBeGreaterThan(clocks[i - 1]);
        }

        // Replaying the persisted log reproduces the full production content in order.
        const replayed = await persistence.getYDoc(docGuid);
        const xml = replayed.getXmlFragment('default').toString();
        for (let i = 0; i < N; i++) expect(xml).toContain(`p-${i}`);
        // The rows themselves are contiguous and ordered.
        const rows = await pool.query('SELECT clock FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC', [docGuid]);
        expect(rows.rows).toHaveLength(N);
        for (let i = 1; i < rows.rows.length; i++) {
          expect(Number(rows.rows[i].clock)).toBe(Number(rows.rows[i - 1].clock) + 1);
        }
      } finally {
        await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
      }
    });

    test('T004: a mid-stream transient failure retries in place without inverting clocks', async () => {
      const docGuid = orderDocGuid();
      const realCritical = persistence._storeUpdateCritical.bind(persistence);
      let failed = false;
      try {
        const doc = new Y.Doc();
        const frag = doc.getXmlFragment('default');
        const updates = [];
        for (let i = 0; i < 6; i++) {
          const sv = Y.encodeStateVector(doc);
          doc.transact(() => {
            const el = new Y.XmlElement('paragraph');
            const t = new Y.XmlText();
            t.insert(0, `q-${i}`);
            el.insert(0, [t]);
            frag.push([el]);
          });
          updates.push(Y.encodeStateAsUpdate(doc, sv));
        }

        // Make the 3rd update's FIRST critical-section attempt throw once (a
        // transient failure). The in-slot retry must succeed on the next attempt
        // and keep the update in its production position — no later update slips ahead.
        persistence._storeUpdateCritical = async function (client, guid, update, ...rest) {
          if (guid === docGuid && !failed && Buffer.from(update).equals(Buffer.from(updates[2]))) {
            failed = true;
            // ownTxn path opens a transaction before this; simulate a transient
            // error after BEGIN by rolling back so the client stays usable.
            await client.query('ROLLBACK').catch(() => {});
            throw new Error('transient boom');
          }
          return realCritical(client, guid, update, ...rest);
        };

        const clocks = await Promise.all(updates.map((u) => persistence.storeUpdate(docGuid, u, humanUserId, null)));
        expect(failed).toBe(true);
        for (let i = 1; i < clocks.length; i++) {
          expect(clocks[i]).toBeGreaterThan(clocks[i - 1]);
        }
        const xml = (await persistence.getYDoc(docGuid)).getXmlFragment('default').toString();
        for (let i = 0; i < 6; i++) expect(xml).toContain(`q-${i}`);
      } finally {
        persistence._storeUpdateCritical = realCritical;
        await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
      }
    });

    test('T006: a terminally poisoned slot rejects to the caller but later updates persist in order', async () => {
      const docGuid = orderDocGuid();
      const realCritical = persistence._storeUpdateCritical.bind(persistence);
      try {
        const doc = new Y.Doc();
        const frag = doc.getXmlFragment('default');
        const updates = [];
        for (let i = 0; i < 4; i++) {
          const sv = Y.encodeStateVector(doc);
          doc.transact(() => {
            const el = new Y.XmlElement('paragraph');
            const t = new Y.XmlText();
            t.insert(0, `r-${i}`);
            el.insert(0, [t]);
            frag.push([el]);
          });
          updates.push(Y.encodeStateAsUpdate(doc, sv));
        }

        // Update index 1 fails on EVERY attempt (terminal). Its caller promise
        // must reject (bindState maps this to the CRITICAL notifier path); the
        // updates queued behind it must still persist, in order (D-9/FR-004).
        persistence._storeUpdateCritical = async function (client, guid, update, ...rest) {
          if (guid === docGuid && Buffer.from(update).equals(Buffer.from(updates[1]))) {
            await client.query('ROLLBACK').catch(() => {});
            throw new Error('poisoned update (terminal)');
          }
          return realCritical(client, guid, update, ...rest);
        };

        const results = await Promise.allSettled(updates.map((u) => persistence.storeUpdate(docGuid, u, humanUserId, null)));
        expect(results[1].status).toBe('rejected'); // poisoned slot surfaced to caller
        expect(results[0].status).toBe('fulfilled');
        expect(results[2].status).toBe('fulfilled');
        expect(results[3].status).toBe('fulfilled');
        // Survivors keep strict production order among themselves.
        expect(results[2].value).toBeGreaterThan(results[0].value);
        expect(results[3].value).toBeGreaterThan(results[2].value);

        // The poisoned update is simply absent — the queue is not wedged.
        const rows = await pool.query('SELECT clock FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC', [docGuid]);
        expect(rows.rows.length).toBe(3);
      } finally {
        persistence._storeUpdateCritical = realCritical;
        await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
      }
    });

    test('G1: two PostgresPersistence instances over one DB — reconnect ordering + unserialized-peer race', async () => {
      const docGuid = orderDocGuid();
      // A second "instance" is just a second PostgresPersistence over the same DB
      // (the 016 test pattern). Each has its OWN in-process queue; the advisory
      // lock is the only thing serializing them cross-instance.
      const instanceB = createPersistence();
      try {
        // Reconnect case: a client produces updates on instance A, then (after A's
        // writes settle) reconnects to instance B and continues the same stream.
        const doc = new Y.Doc();
        const frag = doc.getXmlFragment('default');
        const mk = (label) => {
          const sv = Y.encodeStateVector(doc);
          doc.transact(() => {
            const el = new Y.XmlElement('paragraph');
            const t = new Y.XmlText();
            t.insert(0, label);
            el.insert(0, [t]);
            frag.push([el]);
          });
          return Y.encodeStateAsUpdate(doc, sv);
        };
        const aClocks = await Promise.all([mk('a0'), mk('a1'), mk('a2')].map((u) => persistence.storeUpdate(docGuid, u, humanUserId, null)));
        const bClocks = await Promise.all([mk('b0'), mk('b1')].map((u) => instanceB.storeUpdate(docGuid, u, humanUserId, null)));
        // Reconnected (causally-later) writes on B get strictly higher clocks.
        expect(Math.min(...bClocks)).toBeGreaterThan(Math.max(...aClocks));

        // Unserialized-peer race (D-8 rollout window simulation): both instances
        // write concurrently. The advisory lock + ON CONFLICT backstop must yield
        // distinct clocks and lose no write.
        const raceA = [mk('x0'), mk('x1'), mk('x2')].map((u) => persistence.storeUpdate(docGuid, u, humanUserId, null));
        const raceB = [mk('y0'), mk('y1'), mk('y2')].map((u) => instanceB.storeUpdate(docGuid, u, agentUserId, 'Claude'));
        const raced = await Promise.all([...raceA, ...raceB]);
        expect(new Set(raced).size).toBe(raced.length); // all distinct — no dropped/duplicated clock

        const rows = await pool.query('SELECT clock FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC', [docGuid]);
        // 3 (A) + 2 (B) + 6 (race) = 11 rows, contiguous (no gaps, no collisions).
        expect(rows.rows).toHaveLength(11);
        for (let i = 1; i < rows.rows.length; i++) {
          expect(Number(rows.rows[i].clock)).toBe(Number(rows.rows[i - 1].clock) + 1);
        }
      } finally {
        await instanceB.destroy();
        await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
      }
    });
  });

  // F7: getVersionById / updateVersionName / deleteNamedVersion are doc-scoped
  // in SQL (AND doc_id = $n), so a versionId from another document can never be
  // read, renamed, or deleted through a different docGuid — the 019 cross-doc
  // leak class is impossible below the call regardless of caller checks.
  describe('doc-scoped named-version primitives (F7)', () => {
    const docA = crypto.randomUUID();
    const docB = crypto.randomUUID();
    let versionAId;

    beforeAll(async () => {
      const created = await persistence.createNamedVersion(docA, 0, 0, 'A checkpoint', humanUserId);
      versionAId = created.id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM document_versions WHERE doc_id IN ($1, $2)', [docA, docB]);
    });

    test('getVersionById returns the version for its own doc, null for a foreign doc', async () => {
      expect(await persistence.getVersionById(versionAId, docA)).not.toBeNull();
      expect(await persistence.getVersionById(versionAId, docB)).toBeNull();
    });

    test('updateVersionName is a no-op across docs (foreign docGuid renames nothing)', async () => {
      const foreign = await persistence.updateVersionName(versionAId, 'Hijacked', docB);
      expect(foreign).toBeUndefined();
      // Name unchanged when read through the owning doc.
      const still = await persistence.getVersionById(versionAId, docA);
      expect(still.name).toBe('A checkpoint');

      // Same-doc rename works.
      const ok = await persistence.updateVersionName(versionAId, 'Renamed', docA);
      expect(ok.name).toBe('Renamed');
    });

    test('deleteNamedVersion is a no-op across docs, deletes for the owning doc', async () => {
      expect(await persistence.deleteNamedVersion(versionAId, docB)).toBe(false);
      // Still present.
      expect(await persistence.getVersionById(versionAId, docA)).not.toBeNull();
      // Owning doc deletes it.
      expect(await persistence.deleteNamedVersion(versionAId, docA)).toBe(true);
      expect(await persistence.getVersionById(versionAId, docA)).toBeNull();
    });
  });

  // Feature 023 US4 (T017): write-time meaningful classification.
  describe('023 write-time meaningful classification (US4)', () => {
    const para = (text) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, text);
      p.insert(0, [t]);
      return p;
    };

    const makeUpdate = (fn) => {
      const doc = new Y.Doc();
      const payloads = [];
      doc.on('update', (u) => payloads.push(u));
      doc.transact(() => fn(doc.getXmlFragment('default')));
      doc.destroy();
      return payloads[0];
    };

    test('storeUpdate persists meaningful true / false / null verbatim', async () => {
      const docGuid = crypto.randomUUID();
      try {
        const cTrue = await persistence.storeUpdate(docGuid, makeUpdate((f) => f.insert(0, [para('a')])), humanUserId, null, null, null, { meaningful: true });
        const cFalse = await persistence.storeUpdate(docGuid, makeUpdate((f) => f.insert(0, [para('b')])), humanUserId, null, null, null, { meaningful: false });
        const cNullExplicit = await persistence.storeUpdate(docGuid, makeUpdate((f) => f.insert(0, [para('c')])), humanUserId, null, null, null, { meaningful: null });
        const cNullDefault = await persistence.storeUpdate(docGuid, makeUpdate((f) => f.insert(0, [para('d')])), humanUserId, null); // no options => null

        const { rows } = await pool.query(
          'SELECT clock, meaningful FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC', [docGuid]
        );
        const byClock = Object.fromEntries(rows.map((r) => [Number(r.clock), r.meaningful]));
        expect(byClock[cTrue]).toBe(true);
        expect(byClock[cFalse]).toBe(false);
        expect(byClock[cNullExplicit]).toBeNull();
        expect(byClock[cNullDefault]).toBeNull();
      } finally {
        await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
      }
    });

    // U1 (the one path that can hide a real edit): the classification baseline
    // MUST refresh on EVERY origin (incl. the sentinel restore/redis/inverse
    // updates that don't persist here), else an edit that returns the content to
    // the stale baseline is misclassified as noise. This drives a Y.Doc listener
    // that mirrors the bindState listener (index.js T023) exactly.
    test('U1: a post-restore edit matching the pre-restore baseline is classified meaningful', async () => {
      const docGuid = crypto.randomUUID();
      const ydoc = new Y.Doc();
      const frag = ydoc.getXmlFragment('default');
      let lastClassifiedXml; // starts undefined, like a fresh ydoc
      const writes = [];

      ydoc.on('update', (update, origin) => {
        // --- mirror of the bindState listener (T023 / U1) ---
        let nextXml;
        try { nextXml = extractXml(ydoc); } catch { nextXml = undefined; }
        const prevXml = lastClassifiedXml;
        if (nextXml !== undefined) lastClassifiedXml = nextXml; // refresh on EVERY origin
        const parsed = parseOrigin(origin);
        if (!parsed) return; // sentinel (db-load / restore): baseline refreshed, no persist
        let meaningful = null;
        if (typeof prevXml === 'string' && nextXml !== undefined) meaningful = classifyByXml(prevXml, nextXml);
        writes.push(persistence.storeUpdate(docGuid, update, parsed.userId, parsed.agentName, null, null, { meaningful }));
        // ----------------------------------------------------
      });

      try {
        // 1. db-load establishes baseline '' (empty). Mirror bindState's explicit
        // post-load init (index.js T023) — an empty-state applyUpdate fires no
        // update event, so the baseline is set explicitly.
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(new Y.Doc()), ORIGIN_DB_LOAD);
        lastClassifiedXml = extractXml(ydoc);
        // 2. user edit -> content "Alpha" (persisted, meaningful '' -> Alpha = true).
        ydoc.transact(() => { frag.delete(0, frag.length); frag.insert(0, [para('Alpha')]); }, createOrigin(humanUserId));
        // 3. RESTORE -> content "Beta" via the sentinel (refreshes baseline to Beta; no persist here).
        ydoc.transact(() => { frag.delete(0, frag.length); frag.insert(0, [para('Beta')]); }, ORIGIN_RESTORE);
        // 4. user edit -> content back to "Alpha" (equals the stale pre-restore baseline).
        ydoc.transact(() => { frag.delete(0, frag.length); frag.insert(0, [para('Alpha')]); }, createOrigin(humanUserId));

        const clocks = await Promise.all(writes);
        expect(clocks).toHaveLength(2); // steps 2 and 4 persisted; step 3 (restore sentinel) did not

        const { rows } = await pool.query(
          'SELECT clock, meaningful FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC', [docGuid]
        );
        // Both edits are meaningful; step 4 in particular is NOT hidden as noise
        // despite returning content to the pre-restore baseline (the U1 fix).
        expect(rows.map((r) => r.meaningful)).toEqual([true, true]);
      } finally {
        ydoc.destroy();
        await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
      }
    });
  });

  // Feature 023 US3 (T026): named versions are pure labels — no snapshot, no replay.
  describe('023 replay-only named versions (US3)', () => {
    test('createNamedVersion stores a label only: no content snapshot, no log replay', async () => {
      const docGuid = crypto.randomUUID();
      // Seed one update so a log exists.
      const seedDoc = new Y.Doc();
      seedDoc.getText('content').insert(0, 'seed');
      await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(seedDoc), humanUserId, null);

      const replaySpy = jest.spyOn(persistence, 'getYDocAtClock');
      try {
        const v = await persistence.createNamedVersion(docGuid, 0, 0, 'checkpoint', humanUserId);
        expect(v.name).toBe('checkpoint');
        expect(v.clock_start).toBe(0);
        expect(v.clock_end).toBe(0);
        // No content column (dropped by migration 1799100000000) and no replay
        // performed to build a snapshot.
        expect(v).not.toHaveProperty('snapshot_data');
        expect(replaySpy).not.toHaveBeenCalled();

        // The stored row carries only label fields.
        const { rows } = await pool.query('SELECT * FROM document_versions WHERE id = $1', [v.id]);
        expect(rows[0]).not.toHaveProperty('snapshot_data');
        expect(rows[0].name).toBe('checkpoint');
      } finally {
        replaySpy.mockRestore();
        await pool.query('DELETE FROM document_versions WHERE doc_id = $1', [docGuid]);
        await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
      }
    });
  });

  // Feature 023 US6 (T039): document birth works with the yjs_state_vectors
  // table dropped — no writer references it anymore.
  describe('023 document birth without yjs_state_vectors (US6)', () => {
    test('the yjs_state_vectors table is gone (migration 1799200000000)', async () => {
      const { rows } = await pool.query("SELECT to_regclass('public.yjs_state_vectors') AS t");
      expect(rows[0].t).toBeNull();
    });

    test('first update of a new doc persists, and clearDocument works, with no state-vector write', async () => {
      const docGuid = crypto.randomUUID();
      try {
        const seedDoc = new Y.Doc();
        seedDoc.getText('content').insert(0, 'birth');
        const clock = await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(seedDoc), humanUserId, null);
        expect(clock).toBe(0); // first row, no state-vector side-write required

        const count = await pool.query('SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
        expect(count.rows[0].n).toBe(1);

        // clearDocument no longer touches the dropped table.
        await persistence.clearDocument(docGuid);
        const after = await pool.query('SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
        expect(after.rows[0].n).toBe(0);
      } finally {
        await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
      }
    });
  });
});
