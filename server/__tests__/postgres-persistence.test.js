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
    await pool.query('DELETE FROM yjs_state_vectors WHERE doc_guid = $1', [testDocGuid]);
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

      // Force the race: monkey-patch _getCurrentUpdateClock so both callers
      // read MAX(clock) before either one inserts. We use a barrier that waits
      // until both reads have completed before letting either call proceed.
      const original = persistence._getCurrentUpdateClock.bind(persistence);
      let readCount = 0;
      let resolveBarrier;
      const barrier = new Promise((r) => { resolveBarrier = r; });

      persistence._getCurrentUpdateClock = async function (...args) {
        const result = await original(...args);
        readCount++;
        if (readCount >= 2) {
          // Both reads done — release the barrier
          resolveBarrier();
        }
        // Both callers wait here until the second read finishes
        await barrier;
        return result;
      };

      // Fire both storeUpdate calls concurrently
      const [clockA, clockB] = await Promise.all([
        persistence.storeUpdate(testDocGuid, updateA, humanUserId, null),
        persistence.storeUpdate(testDocGuid, updateB, agentUserId, 'Claude'),
      ]);

      // Restore the original method
      persistence._getCurrentUpdateClock = original;

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
});
