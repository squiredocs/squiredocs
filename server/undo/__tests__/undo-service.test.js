/**
 * undo-service behaviors pinned by the post-merge review of feature 016:
 *
 *  - H1: a committed inverse must reach OTHER instances even when this pod's
 *    shared doc was created outside the WS connection handler (no redis update
 *    handler attached) — applyToLiveDoc publishes explicitly, and only then.
 *  - M1: undoing a recorded edit whose [start,end] range spans interleaved
 *    same-identity rows from ANOTHER call must invert exactly the recorded
 *    clock SET, never the spanning range.
 *  - M2: an undo arriving while the identity's newest edit is still being
 *    recorded (the editRangePending window) must refuse honestly instead of
 *    silently undoing an OLDER edit.
 *
 * DB-backed, serial only (shared collab_test_db).
 */
const { randomUUID } = require('crypto');
const Y = require('yjs');
const { createPool, createPersistence, createTestUser, cleanupTestUser } = require('../../__tests__/helpers/db');
const editRecords = require('../edit-records');
const undoService = require('../undo-service');

const AGENT = 'Squire Docs Assistant';

function para(text) {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  return p;
}

describe('undo-service (post-merge review pins)', () => {
  let pool, persistence, userId;

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    userId = await createTestUser(pool, `undo-service-016-${Date.now()}@test.com`);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM agent_edits WHERE user_id = $1', [userId]);
    await cleanupTestUser(pool, userId);
    await persistence.destroy();
    await pool.end();
  });

  const identity = (docGuid) => ({ docGuid, userId, agentName: AGENT });

  /**
   * Fabricate a log: clock 0 human base paragraph, clock 1 an agent edit —
   * rows aged (older than any freshness window) and the agent edit recorded.
   */
  async function seedDocWithAgentEdit(docGuid) {
    const doc = new Y.Doc();
    const payloads = [];
    doc.on('update', (u) => payloads.push(u));
    const frag = doc.get('default', Y.XmlFragment);
    doc.transact(() => frag.insert(0, [para('Original text.')]));
    doc.transact(() => frag.get(0).get(0).insert(14, ' AGENT-EDIT'));
    doc.destroy();
    expect(payloads.length).toBe(2);
    await pool.query(
      `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name, created_at)
       VALUES ($1, 0, $2, NULL, NULL, now() - interval '1 hour'),
              ($1, 1, $3, $4, $5, now() - interval '30 minutes')`,
      [docGuid, Buffer.from(payloads[0]), Buffer.from(payloads[1]), userId, AGENT]
    );
    await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: AGENT, clockStart: 1, clockEnd: 1, clocks: [1],
    });
  }

  async function dbText(docGuid) {
    const doc = await persistence.getYDoc(docGuid);
    const text = doc.get('default', Y.XmlFragment).toString();
    doc.destroy();
    return text;
  }

  // ------------------------------------------------------------------ H1 ----

  describe('H1: inverse fan-out from a connection-less pod', () => {
    function mockPubSub(enabled = true) {
      return { isEnabled: () => enabled, publishUpdate: jest.fn() };
    }

    test('shared doc WITHOUT a redis update handler: the committed inverse is published exactly once', async () => {
      const docGuid = randomUUID();
      await seedDocWithAgentEdit(docGuid);

      // A doc obtained via getSharedDoc on the undo path: loaded, but no WS
      // connection ever attached redis handlers to it.
      const liveDoc = await persistence.getYDoc(docGuid);
      const pubSub = mockPubSub();
      try {
        const res = await undoService.performUndo(identity(docGuid), {
          persistence, getSharedDoc: () => liveDoc, redisPubSub: pubSub,
        });
        expect(res.undone).toBe(true);

        expect(pubSub.publishUpdate).toHaveBeenCalledTimes(1);
        const [publishedGuid, publishedUpdate] = pubSub.publishUpdate.mock.calls[0];
        expect(publishedGuid).toBe(docGuid);

        // The published bytes are exactly the stored inverse row.
        const { rows } = await pool.query(
          'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 AND clock = $2',
          [docGuid, res.clock]
        );
        expect(Buffer.compare(Buffer.from(publishedUpdate), rows[0].update_data)).toBe(0);
      } finally {
        liveDoc.destroy();
      }
    });

    test('shared doc WITH a live redis update handler: no explicit second publish (the handler already fans out)', async () => {
      const docGuid = randomUUID();
      await seedDocWithAgentEdit(docGuid);

      const liveDoc = await persistence.getYDoc(docGuid);
      // Simulate the WS connection handler's wiring: ORIGIN_INVERSE_APPLY is
      // NOT on the handler's origin skip-list, so the apply itself publishes.
      liveDoc._redisUpdateHandler = () => {};
      const pubSub = mockPubSub();
      try {
        const res = await undoService.performUndo(identity(docGuid), {
          persistence, getSharedDoc: () => liveDoc, redisPubSub: pubSub,
        });
        expect(res.undone).toBe(true);
        expect(pubSub.publishUpdate).not.toHaveBeenCalled();
      } finally {
        liveDoc.destroy();
      }
    });

    test('no shared doc at all (restart posture): the inverse is still published for other pods', async () => {
      const docGuid = randomUUID();
      await seedDocWithAgentEdit(docGuid);

      const pubSub = mockPubSub();
      const res = await undoService.performUndo(identity(docGuid), {
        persistence, getSharedDoc: () => null, redisPubSub: pubSub,
      });
      expect(res.undone).toBe(true);
      expect(pubSub.publishUpdate).toHaveBeenCalledTimes(1);
    });

    test('redis disabled: no publish attempted, undo still succeeds', async () => {
      const docGuid = randomUUID();
      await seedDocWithAgentEdit(docGuid);

      const pubSub = mockPubSub(false);
      const res = await undoService.performUndo(identity(docGuid), {
        persistence, getSharedDoc: () => null, redisPubSub: pubSub,
      });
      expect(res.undone).toBe(true);
      expect(pubSub.publishUpdate).not.toHaveBeenCalled();
      expect(await dbText(docGuid)).toBe('<paragraph>Original text.</paragraph>');
    });

    test('redo fans out the same way', async () => {
      const docGuid = randomUUID();
      await seedDocWithAgentEdit(docGuid);

      const undoRes = await undoService.performUndo(identity(docGuid), {
        persistence, getSharedDoc: () => null, redisPubSub: mockPubSub(),
      });
      expect(undoRes.undone).toBe(true);

      const pubSub = mockPubSub();
      const redoRes = await undoService.performRedo(identity(docGuid), {
        persistence, getSharedDoc: () => null, redisPubSub: pubSub,
      });
      expect(redoRes.redone).toBe(true);
      expect(pubSub.publishUpdate).toHaveBeenCalledTimes(1);
      expect(await dbText(docGuid)).toBe('<paragraph>Original text. AGENT-EDIT</paragraph>');
    });
  });

  // ------------------------------------------------------------------ M1 ----

  describe('M1: exact clock-set targeting through the recorded chain', () => {
    test('undoing a call whose recorded range spans another call\'s interleaved rows leaves that call intact', async () => {
      // Two same-identity modify calls interleave: B rows at clocks 1 and 3,
      // A rows at clocks 2 and 4 — each call's [min,max] range spans a row of
      // the other. The recorded clock SETS keep the undos surgical.
      const docGuid = randomUUID();
      const doc = new Y.Doc();
      const payloads = [];
      doc.on('update', (u) => payloads.push(u));
      const frag = doc.get('default', Y.XmlFragment);
      doc.transact(() => frag.insert(0, [para('Base.')]));
      for (const label of [' B1', ' A1', ' B2', ' A2']) {
        doc.transact(() => {
          const t = frag.get(0).get(0);
          t.insert(t.length, label);
        });
      }
      doc.destroy();
      expect(payloads.length).toBe(5);
      for (let clock = 0; clock < payloads.length; clock++) {
        await pool.query(
          `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name, created_at)
           VALUES ($1, $2, $3, $4, $5, now() - interval '30 minutes')`,
          [docGuid, clock, Buffer.from(payloads[clock]),
            clock === 0 ? null : userId, clock === 0 ? null : AGENT]
        );
      }
      await editRecords.recordEdit(persistence, {
        docGuid, userId, agentName: AGENT, clockStart: 1, clockEnd: 3, clocks: [1, 3],
      });
      await editRecords.recordEdit(persistence, {
        docGuid, userId, agentName: AGENT, clockStart: 2, clockEnd: 4, clocks: [2, 4],
      });
      expect(await dbText(docGuid)).toBe('<paragraph>Base. B1 A1 B2 A2</paragraph>');

      const deps = { persistence, getSharedDoc: () => null };
      // LIFO: call A (edit_clock_start 2) first — B's rows 1 and 3 survive.
      const undoA = await undoService.performUndo(identity(docGuid), deps);
      expect(undoA.undone).toBe(true);
      expect(await dbText(docGuid)).toBe('<paragraph>Base. B1 B2</paragraph>');

      // Then call B — back to the base paragraph.
      const undoB = await undoService.performUndo(identity(docGuid), deps);
      expect(undoB.undone).toBe(true);
      expect(await dbText(docGuid)).toBe('<paragraph>Base.</paragraph>');
    });
  });
});
