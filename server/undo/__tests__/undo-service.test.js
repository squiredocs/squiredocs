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
const { toMarkdown } = require('../../mcp/yjs/serialization');
// Namespace import on purpose: the service calls diffUtils.computeChatDiff via
// the module namespace, so spyOn-based failure injection (T005) works.
const diffUtils = require('../../mcp/diff-utils');

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

  // ------------------------------------------------------------------ M2 ----

  describe('M2: undo during the editRangePending window', () => {
    /**
     * Append a fresh identity row on top of the current log — the pre-record
     * state of a modify whose durability wait is still running.
     */
    async function appendPendingEditRow(docGuid, text, interval = "'0 seconds'") {
      const doc = await persistence.getYDoc(docGuid);
      const payloads = [];
      doc.on('update', (u) => payloads.push(u));
      const frag = doc.get('default', Y.XmlFragment);
      doc.transact(() => {
        const t = frag.get(0).get(0);
        t.insert(t.length, ` ${text}`);
      });
      doc.destroy();
      expect(payloads.length).toBe(1);
      const { rows } = await pool.query(
        'SELECT COALESCE(MAX(clock), -1) + 1 AS next FROM yjs_updates WHERE doc_guid = $1',
        [docGuid]
      );
      const clock = Number(rows[0].next);
      await pool.query(
        `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name, created_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval ${interval})`,
        [docGuid, clock, Buffer.from(payloads[0]), userId, AGENT]
      );
      return clock;
    }

    test('refuses honestly while the newest edit\'s rows are unrecorded — the OLDER edit stays untouched', async () => {
      const docGuid = randomUUID();
      await seedDocWithAgentEdit(docGuid); // recorded edit A (aged)
      // Edit B's row just landed; its agent_edits record does not exist yet.
      await appendPendingEditRow(docGuid, 'B-PENDING');

      const res = await undoService.performUndo(identity(docGuid), {
        persistence, getSharedDoc: () => null,
      });
      expect(res.success).toBe(true);
      expect(res.undone).toBe(false);
      expect(res.message).toMatch(/still being recorded/i);

      // A was NOT undone: record still active, nothing appended, text intact.
      const rec = await pool.query('SELECT state FROM agent_edits WHERE doc_guid = $1', [docGuid]);
      expect(rec.rows).toHaveLength(1);
      expect(rec.rows[0].state).toBe('active');
      expect(await dbText(docGuid)).toBe('<paragraph>Original text. AGENT-EDIT B-PENDING</paragraph>');
    });

    test('once the newest edit IS recorded, undo proceeds and targets it (not the older one)', async () => {
      const docGuid = randomUUID();
      await seedDocWithAgentEdit(docGuid);
      const clock = await appendPendingEditRow(docGuid, 'B-RECORDED');
      await editRecords.recordEdit(persistence, {
        docGuid, userId, agentName: AGENT, clockStart: clock, clockEnd: clock, clocks: [clock],
      });

      const res = await undoService.performUndo(identity(docGuid), {
        persistence, getSharedDoc: () => null,
      });
      expect(res.undone).toBe(true);
      expect(await dbText(docGuid)).toBe('<paragraph>Original text. AGENT-EDIT</paragraph>');
    });

    test('unrecorded rows OLDER than the background wait bound never wedge undo', async () => {
      const docGuid = randomUUID();
      await seedDocWithAgentEdit(docGuid);
      // An anomaly: an identity row that was never recorded and never will be
      // (background recording failed) — aged past the wait bound.
      await appendPendingEditRow(docGuid, 'B-ORPHANED', "'5 minutes'");

      const res = await undoService.performUndo(identity(docGuid), {
        persistence, getSharedDoc: () => null,
      });
      expect(res.undone).toBe(true); // undoes A; the orphan is invisible to undo
      expect(await dbText(docGuid)).toBe('<paragraph>Original text. B-ORPHANED</paragraph>');
    });
  });

  // ----------------------------------------------------------- feature 020 ----

  describe('020: diff attach on success results', () => {
    const DIFF_KEYS = ['lines', 'hunkStarts', 'formatAnnotations', 'truncatedByServer'];

    /** toMarkdown of a one-paragraph doc with the given text. */
    function mdOfPara(text) {
      const doc = new Y.Doc();
      const frag = doc.get('default', Y.XmlFragment);
      doc.transact(() => frag.insert(0, [para(text)]));
      const md = toMarkdown(frag);
      doc.destroy();
      return md;
    }

    /** Aged, recorded FORMAT-ONLY agent edit (bold over existing human text). */
    async function seedDocWithFormatOnlyEdit(docGuid) {
      const doc = new Y.Doc();
      const payloads = [];
      doc.on('update', (u) => payloads.push(u));
      const frag = doc.get('default', Y.XmlFragment);
      doc.transact(() => frag.insert(0, [para('Original text.')]));
      doc.transact(() => frag.get(0).get(0).format(0, 8, { bold: true }));
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

    /** Aged, recorded agent edit inserting enough content to blow MAX_DIFF_CHARS. */
    async function seedDocWithHugeAgentEdit(docGuid) {
      const doc = new Y.Doc();
      const payloads = [];
      doc.on('update', (u) => payloads.push(u));
      const frag = doc.get('default', Y.XmlFragment);
      doc.transact(() => frag.insert(0, [para('Base paragraph.')]));
      doc.transact(() => {
        const paras = [];
        for (let i = 0; i < 300; i++) {
          paras.push(para(`Huge agent paragraph ${i} ` + 'x'.repeat(180)));
        }
        frag.insert(1, paras);
      });
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

    /** A fresh unrecorded identity row on top of the log (M2 pending seed). */
    async function appendPendingRow(docGuid) {
      const doc = await persistence.getYDoc(docGuid);
      const payloads = [];
      doc.on('update', (u) => payloads.push(u));
      const frag = doc.get('default', Y.XmlFragment);
      doc.transact(() => {
        const t = frag.get(0).get(0);
        t.insert(t.length, ' PENDING');
      });
      doc.destroy();
      const { rows } = await pool.query(
        'SELECT COALESCE(MAX(clock), -1) + 1 AS next FROM yjs_updates WHERE doc_guid = $1',
        [docGuid]
      );
      await pool.query(
        `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name, created_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [docGuid, Number(rows[0].next), Buffer.from(payloads[0]), userId, AGENT]
      );
    }

    test('successful undo carries diff deep-equal to computeChatDiff over the revert bracket (C1/C2/C5)', async () => {
      const docGuid = randomUUID();
      await seedDocWithAgentEdit(docGuid);

      const res = await undoService.performUndo(identity(docGuid), {
        persistence, getSharedDoc: () => null,
      });
      expect(res.undone).toBe(true);
      expect(res.success).toBe(true);
      expect(typeof res.message).toBe('string');
      expect(typeof res.clock).toBe('number');

      const expected = diffUtils.computeChatDiff(
        mdOfPara('Original text. AGENT-EDIT'),
        mdOfPara('Original text.')
      );
      expect(res.diff).toEqual(expected);
      // Modify parity shape: only the contract's members, non-empty lines.
      expect(Object.keys(res.diff).every((k) => DIFF_KEYS.includes(k))).toBe(true);
      expect(res.diff.lines.length).toBeGreaterThan(0);
    });

    test('successful redo carries the re-application diff the same way', async () => {
      const docGuid = randomUUID();
      await seedDocWithAgentEdit(docGuid);
      const deps = { persistence, getSharedDoc: () => null };

      const undoRes = await undoService.performUndo(identity(docGuid), deps);
      expect(undoRes.undone).toBe(true);

      const res = await undoService.performRedo(identity(docGuid), deps);
      expect(res.redone).toBe(true);

      const expected = diffUtils.computeChatDiff(
        mdOfPara('Original text.'),
        mdOfPara('Original text. AGENT-EDIT')
      );
      expect(res.diff).toEqual(expected);
      expect(Object.keys(res.diff).every((k) => DIFF_KEYS.includes(k))).toBe(true);
      expect(res.diff.lines.length).toBeGreaterThan(0);
    });

    test('honest-empty family carries NO diff key and keeps exact 016 result values (FR-003/FR-004)', async () => {
      // Variant 1: nothing recorded (empty doc, no legacy rows either).
      const emptyGuid = randomUUID();
      const nothing = await undoService.performUndo(identity(emptyGuid), {
        persistence, getSharedDoc: () => null,
      });
      expect('diff' in nothing).toBe(false);
      expect(nothing).toEqual({
        success: true,
        undone: false,
        message: 'Nothing to undo: no recorded edit by you in this document.',
        clock: 0,
      });

      // Variant 2: pending-recording refusal (M2 seed — fresh unrecorded row).
      const pendingGuid = randomUUID();
      await seedDocWithAgentEdit(pendingGuid);
      await appendPendingRow(pendingGuid);
      const pending = await undoService.performUndo(identity(pendingGuid), {
        persistence, getSharedDoc: () => null,
      });
      expect('diff' in pending).toBe(false);
      expect(pending).toEqual({
        success: true,
        undone: false,
        message: 'Nothing undone: your latest edit is still being recorded — retry shortly.',
        clock: 2,
      });

      // Variant 3: concurrent loser (M3/H1 pattern — the claim CAS loses).
      const loserGuid = randomUUID();
      await seedDocWithAgentEdit(loserGuid);
      const claimSpy = jest.spyOn(editRecords, 'finalizeClaim')
        .mockResolvedValue({ claimed: false, clock: null });
      try {
        const loser = await undoService.performUndo(identity(loserGuid), {
          persistence, getSharedDoc: () => null,
        });
        expect('diff' in loser).toBe(false);
        expect(loser).toEqual({
          success: true,
          undone: false,
          message: 'This edit was already undone by a concurrent request.',
          clock: 1,
        });
      } finally {
        claimSpy.mockRestore();
      }
    });

    test('formatting-only revert yields a diff with formatAnnotations — not dropped by the non-empty guard (RBD-4)', async () => {
      const docGuid = randomUUID();
      await seedDocWithFormatOnlyEdit(docGuid);

      const res = await undoService.performUndo(identity(docGuid), {
        persistence, getSharedDoc: () => null,
      });
      expect(res.undone).toBe(true);
      expect(res.diff).toBeDefined();
      expect(res.diff.lines.length).toBeGreaterThan(0);
      // The shared post-processing annotates the -/+ pair as format-only.
      expect(res.diff.formatAnnotations).toBeDefined();
      expect(Object.keys(res.diff.formatAnnotations).length).toBeGreaterThan(0);
      expect(await dbText(docGuid)).toBe('<paragraph>Original text.</paragraph>');
    });

    test('best-effort: computeChatDiff failure leaves the revert standing sans diff (FR-006, RBD-3)', async () => {
      const docGuid = randomUUID();
      await seedDocWithAgentEdit(docGuid);

      const diffSpy = jest.spyOn(diffUtils, 'computeChatDiff').mockImplementation(() => {
        throw new Error('diff computation boom');
      });
      try {
        const res = await undoService.performUndo(identity(docGuid), {
          persistence, getSharedDoc: () => null,
        });
        expect(res.undone).toBe(true);
        expect('diff' in res).toBe(false);
        // The inverse was actually applied AND stored durably.
        expect(await dbText(docGuid)).toBe('<paragraph>Original text.</paragraph>');
        const { rows } = await pool.query(
          'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 AND clock = $2',
          [docGuid, res.clock]
        );
        expect(rows).toHaveLength(1);
      } finally {
        diffSpy.mockRestore();
      }
    });

    test('truncation: an over-limit revert diff is bounded and flagged; the revert completes (FR-005, SC-006)', async () => {
      const docGuid = randomUUID();
      await seedDocWithHugeAgentEdit(docGuid);

      const res = await undoService.performUndo(identity(docGuid), {
        persistence, getSharedDoc: () => null,
      });
      expect(res.undone).toBe(true);
      expect(res.diff).toBeDefined();
      expect(res.diff.truncatedByServer).toBe(true);
      expect(res.diff.lines.length).toBeLessThanOrEqual(200);
      // The document state is actually reverted regardless of diff size.
      expect(await dbText(docGuid)).toBe('<paragraph>Base paragraph.</paragraph>');
    });
  });
});
