/**
 * Feature 040 — a restore is genuinely undoable, at the endpoint contract.
 *
 * This is the headline defect's regression fence. Before 040 a web-UI restore
 * wrote the acting identity into `yjs_updates` but the `''` sentinel into
 * `agent_edits`, so the two stores disagreed and NO undo surface could ever
 * find the record. FR-001 records both under one identity — the chat-assistant
 * identity acting for the requesting user — which is what makes the restore
 * reachable by that identity's undo/redo.
 *
 * Real Postgres, serial only (one database). Covers:
 *   US1  T013/T014  restore → undo → redo round trip, byte-exact; LIFO order
 *   US2  T017/T018  the MCP agent path is unregressed, and identity-scoped
 *   US6  T046       the reported target clock is stable across an undo↔redo
 *                   cycle (proves D14's field choice)
 *   US6  T048       the guard changes what is OFFERED, never what the endpoint
 *                   DOES
 *   US6  T052       FR-019/D17: with the client guard bypassed, the server
 *                   refuses to mislabel (SC-013)
 */
const { randomUUID } = require('crypto');
const Y = require('yjs');
const { createPool, createPersistence, createTestUser, cleanupTestUser } = require('./helpers/db');
const { restoreVersion } = require('../version-history');
const undoService = require('../undo/undo-service');
const editRecords = require('../undo/edit-records');
const { toMarkdown } = require('../mcp/yjs/serialization');
const { CHAT_AGENT_NAME } = require('../agent-identity');
const { applyRevertedFlag } = require('../undo/reverted-flag');

// A real MCP agent token's identity — genuinely distinct from the chat
// assistant, so the identity-scoping assertions are not vacuous.
const MCP_AGENT = 'Test MCP Agent';

describe('040: a restore is undoable through the undo endpoints', () => {
  let pool, persistence, userId;

  const para = (text) => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    return p;
  };

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    undoService.init(persistence);
    userId = await createTestUser(pool, `restore-undo-040-${Date.now()}@test.com`);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM agent_edits WHERE user_id = $1', [userId]);
    await cleanupTestUser(pool, userId);
    await persistence.destroy();
    await pool.end();
  });

  /** V1 = "Alpha" (clock 0); V2 = "Alpha"+"Beta" (clock 1). */
  async function seedDoc(docGuid) {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('default');
    let sv = Y.encodeStateVector(doc);
    doc.transact(() => frag.insert(0, [para('Alpha')]));
    await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(doc, sv), userId, null);
    sv = Y.encodeStateVector(doc);
    doc.transact(() => frag.insert(1, [para('Beta')]));
    await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(doc, sv), userId, null);
    doc.destroy();
  }

  /** Current document content as markdown — the user-visible truth. */
  async function markdownNow(docGuid) {
    const doc = await persistence.getYDoc(docGuid);
    try {
      return toMarkdown(doc.get('default', Y.XmlFragment));
    } finally {
      doc.destroy();
    }
  }

  async function cleanupDoc(docGuid) {
    await pool.query('DELETE FROM agent_edits WHERE doc_guid = $1', [docGuid]);
    await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docGuid]);
  }

  const noSharedDoc = { getSharedDoc: () => null, redisPubSub: null };

  // ---------------------------------------------------------------- US1 ----

  test('T013 (SC-001/SC-002): restore → undo restores the EXACT pre-restore content, and redo re-applies the restore', async () => {
    const docGuid = randomUUID();
    await seedDoc(docGuid);
    try {
      const beforeRestore = await markdownNow(docGuid); // "Alpha" + "Beta"
      expect(beforeRestore).toContain('Beta');

      // A web-UI restore, exactly as server/index.js's REST route performs it.
      const restore = await restoreVersion(persistence, docGuid, '0', userId, {
        ...noSharedDoc, agentName: CHAT_AGENT_NAME,
      });
      expect(restore.success).toBe(true);
      const afterRestore = await markdownNow(docGuid); // "Alpha" only
      expect(afterRestore).not.toContain('Beta');

      // SC-002: availability is log-derived and reports the restore.
      const status = await undoService.getUndoStatus(
        { docGuid, userId, agentName: CHAT_AGENT_NAME }, { persistence }
      );
      expect(status.canUndo).toBe(true);

      // SC-001: the undo genuinely succeeded — not the honest-empty result.
      const undo = await undoService.performUndo(
        { docGuid, userId, agentName: CHAT_AGENT_NAME }, { persistence, getSharedDoc: () => null }
      );
      expect(undo.undone).toBe(true);

      // BYTE-IDENTICAL to the pre-restore state, not merely "changed".
      expect(await markdownNow(docGuid)).toBe(beforeRestore);

      // D5: the restore participates in redo too.
      const redo = await undoService.performRedo(
        { docGuid, userId, agentName: CHAT_AGENT_NAME }, { persistence, getSharedDoc: () => null }
      );
      expect(redo.redone).toBe(true);
      expect(await markdownNow(docGuid)).toBe(afterRestore);
    } finally {
      await cleanupDoc(docGuid);
    }
  });

  test('T014 (US1 scenario 4): LIFO — a later chat edit is undone first, then the restore; inversions land as NEW forward rows', async () => {
    const docGuid = randomUUID();
    await seedDoc(docGuid);
    try {
      const restore = await restoreVersion(persistence, docGuid, '0', userId, {
        ...noSharedDoc, agentName: CHAT_AGENT_NAME,
      });
      const afterRestore = await markdownNow(docGuid);

      // A chat-assistant edit AFTER the restore, recorded like modify does.
      const doc = await persistence.getYDoc(docGuid);
      const sv = Y.encodeStateVector(doc);
      doc.transact(() => doc.getXmlFragment('default').insert(1, [para('Gamma')]));
      const editClock = await persistence.storeUpdate(
        docGuid, Y.encodeStateAsUpdate(doc, sv), userId, CHAT_AGENT_NAME
      );
      doc.destroy();
      await editRecords.recordEdit(persistence, {
        docGuid, userId, agentName: CHAT_AGENT_NAME,
        clockStart: editClock, clockEnd: editClock, clocks: [editClock],
      });
      const afterEdit = await markdownNow(docGuid);
      expect(afterEdit).toContain('Gamma');

      const clocksBefore = await pool.query(
        'SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]
      );

      // First undo inverts the CHAT EDIT (most recent), not the restore.
      const undo1 = await undoService.performUndo(
        { docGuid, userId, agentName: CHAT_AGENT_NAME }, { persistence, getSharedDoc: () => null }
      );
      expect(undo1.undone).toBe(true);
      expect(undo1.actedEditClockStart).toBe(editClock);
      expect(await markdownNow(docGuid)).toBe(afterRestore);

      // Second undo inverts the RESTORE.
      const undo2 = await undoService.performUndo(
        { docGuid, userId, agentName: CHAT_AGENT_NAME }, { persistence, getSharedDoc: () => null }
      );
      expect(undo2.undone).toBe(true);
      expect(undo2.actedEditClockStart).toBe(restore.newClock);
      expect(await markdownNow(docGuid)).toContain('Beta');

      // Nothing was deleted or rewritten: the log only GREW.
      const clocksAfter = await pool.query(
        'SELECT count(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]
      );
      expect(clocksAfter.rows[0].n).toBe(clocksBefore.rows[0].n + 2);
    } finally {
      await cleanupDoc(docGuid);
    }
  });

  test('T016 (FR-005/SC-001): the identity the restore route records under IS the identity the undo-status route queries', async () => {
    // A drift guard, not a tautology: server/index.js resolves BOTH from the
    // agent-identity leaf, and chat.js re-exports the same object. If any of
    // them ever re-declared its own literal, this fails.
    const identityModule = require('../agent-identity');
    const chat = require('../api/chat');
    expect(chat.CHAT_AGENT_NAME).toBe(identityModule.CHAT_AGENT_NAME);
    expect(identityModule.CHAT_AGENT_NAME).toBe('Squire Docs Assistant');

    // And end-to-end: what a restore WRITES is what undo-status QUERIES.
    const docGuid = randomUUID();
    await seedDoc(docGuid);
    try {
      await restoreVersion(persistence, docGuid, '0', userId, {
        ...noSharedDoc, agentName: identityModule.CHAT_AGENT_NAME,
      });
      const row = await pool.query(
        'SELECT agent_name FROM agent_edits WHERE doc_guid = $1', [docGuid]
      );
      const status = await undoService.getUndoStatus(
        { docGuid, userId, agentName: chat.CHAT_AGENT_NAME }, { persistence }
      );
      expect(row.rows[0].agent_name).toBe(chat.CHAT_AGENT_NAME);
      expect(status.canUndo).toBe(true);
    } finally {
      await cleanupDoc(docGuid);
    }
  });

  // ---------------------------------------------------------------- US2 ----

  test('T017 (SC-003): an MCP agent restore records under the AGENT own name in both stores and is inverted by that agent undo', async () => {
    const docGuid = randomUUID();
    await seedDoc(docGuid);
    try {
      const beforeRestore = await markdownNow(docGuid);
      const restore = await restoreVersion(persistence, docGuid, '0', userId, {
        ...noSharedDoc, agentName: MCP_AGENT,
      });

      // BOTH stores carry the agent own identity — never CHAT_AGENT_NAME.
      const logRow = await pool.query(
        'SELECT agent_name FROM yjs_updates WHERE doc_guid = $1 AND clock = $2',
        [docGuid, restore.newClock]
      );
      const editRow = await pool.query(
        'SELECT agent_name FROM agent_edits WHERE doc_guid = $1', [docGuid]
      );
      expect(logRow.rows[0].agent_name).toBe(MCP_AGENT);
      expect(editRow.rows).toHaveLength(1);
      expect(editRow.rows[0].agent_name).toBe(MCP_AGENT);

      // That same identity inverts it exactly.
      const undo = await undoService.performUndo(
        { docGuid, userId, agentName: MCP_AGENT }, { persistence, getSharedDoc: () => null }
      );
      expect(undo.undone).toBe(true);
      expect(await markdownNow(docGuid)).toBe(beforeRestore);
    } finally {
      await cleanupDoc(docGuid);
    }
  });

  test('T018 (US2 scenario 3, 016 FR-024): identity scoping holds in BOTH directions', async () => {
    // An agent restore is not offered to the chat-assistant identity ...
    const docA = randomUUID();
    await seedDoc(docA);
    try {
      await restoreVersion(persistence, docA, '0', userId, { ...noSharedDoc, agentName: MCP_AGENT });
      const chatStatus = await undoService.getUndoStatus(
        { docGuid: docA, userId, agentName: CHAT_AGENT_NAME }, { persistence }
      );
      expect(chatStatus.canUndo).toBe(false);
    } finally {
      await cleanupDoc(docA);
    }

    // ... and a web-UI restore does not affect an MCP agent undo status.
    const docB = randomUUID();
    await seedDoc(docB);
    try {
      await restoreVersion(persistence, docB, '0', userId, { ...noSharedDoc, agentName: CHAT_AGENT_NAME });
      const agentStatus = await undoService.getUndoStatus(
        { docGuid: docB, userId, agentName: MCP_AGENT }, { persistence }
      );
      expect(agentStatus.canUndo).toBe(false);
    } finally {
      await cleanupDoc(docB);
    }
  });

  // ---------------------------------------------------------------- US6 ----

  test('T046 (D14): the reported target clock is STABLE across an undo↔redo cycle, while undo/redo_target_* are rewritten', async () => {
    const docGuid = randomUUID();
    await seedDoc(docGuid);
    try {
      // A modify-shaped edit under the chat-assistant identity.
      const doc = await persistence.getYDoc(docGuid);
      const sv = Y.encodeStateVector(doc);
      doc.transact(() => doc.getXmlFragment('default').insert(2, [para('Gamma')]));
      const editClock = await persistence.storeUpdate(
        docGuid, Y.encodeStateAsUpdate(doc, sv), userId, CHAT_AGENT_NAME
      );
      doc.destroy();
      await editRecords.recordEdit(persistence, {
        docGuid, userId, agentName: CHAT_AGENT_NAME,
        clockStart: editClock, clockEnd: editClock, clocks: [editClock],
      });

      const identity = { docGuid, userId, agentName: CHAT_AGENT_NAME };
      const targets = async () => {
        const r = await pool.query(
          `SELECT undo_target_start, redo_target_start FROM agent_edits
           WHERE doc_guid = $1 AND edit_clock_start = $2`, [docGuid, editClock]
        );
        return r.rows[0];
      };

      const s0 = await undoService.getUndoStatus(identity, { persistence });
      expect(s0.nextUndo.editClockStart).toBe(editClock);
      const t0 = await targets();

      await undoService.performUndo(identity, { persistence, getSharedDoc: () => null });
      const s1 = await undoService.getUndoStatus(identity, { persistence });
      // SAME value, now reported for the other direction.
      expect(s1.nextRedo.editClockStart).toBe(editClock);
      const t1 = await targets();

      await undoService.performRedo(identity, { persistence, getSharedDoc: () => null });
      const s2 = await undoService.getUndoStatus(identity, { persistence });
      expect(s2.nextUndo.editClockStart).toBe(editClock);
      const t2 = await targets();

      // THE POINT: the rewritable target range moved; edit_clock_start did not.
      // This is why FR-016 reports edit_clock_start. A client matching on
      // undo_target_start would have stopped matching after the cycle and the
      // control would have vanished from a perfectly valid card.
      expect(t1.redo_target_start).not.toBe(t0.redo_target_start);
      expect([s0.nextUndo.editClockStart, s1.nextRedo.editClockStart, s2.nextUndo.editClockStart])
        .toEqual([editClock, editClock, editClock]);
      expect(t2.undo_target_start).not.toBe(t0.undo_target_start);
    } finally {
      await cleanupDoc(docGuid);
    }
  });

  test('T048 (SC-010(c), FR-018): with a restore as the next target, /undo still inverts the RESTORE correctly — the guard never changes what the endpoint does', async () => {
    const docGuid = randomUUID();
    await seedDoc(docGuid);
    try {
      // A chat modify first, then a restore on top of it.
      const doc = await persistence.getYDoc(docGuid);
      const sv = Y.encodeStateVector(doc);
      doc.transact(() => doc.getXmlFragment('default').insert(2, [para('Gamma')]));
      const editClock = await persistence.storeUpdate(
        docGuid, Y.encodeStateAsUpdate(doc, sv), userId, CHAT_AGENT_NAME
      );
      doc.destroy();
      await editRecords.recordEdit(persistence, {
        docGuid, userId, agentName: CHAT_AGENT_NAME,
        clockStart: editClock, clockEnd: editClock, clocks: [editClock],
      });

      const beforeRestore = await markdownNow(docGuid);
      const restore = await restoreVersion(persistence, docGuid, '0', userId, {
        ...noSharedDoc, agentName: CHAT_AGENT_NAME,
      });

      // The restore is the next target — NOT the modify.
      const status = await undoService.getUndoStatus(
        { docGuid, userId, agentName: CHAT_AGENT_NAME }, { persistence }
      );
      expect(status.nextUndo.editClockStart).toBe(restore.newClock);
      expect(status.nextUndo.editClockStart).not.toBe(editClock);

      // The endpoint inverts the RESTORE, correctly and completely.
      const undo = await undoService.performUndo(
        { docGuid, userId, agentName: CHAT_AGENT_NAME }, { persistence, getSharedDoc: () => null }
      );
      expect(undo.undone).toBe(true);
      expect(undo.actedEditClockStart).toBe(restore.newClock);
      expect(await markdownNow(docGuid)).toBe(beforeRestore);
    } finally {
      await cleanupDoc(docGuid);
    }
  });

  // T052 (FR-019 / D17 / SC-013): the lie must be impossible even when the
  // client guard is BYPASSED — an older client, a stale poll (N3), or a
  // direct POST. This is the half of FR-018 that does not depend on the
  // browser behaving.
  describe('T052: the server refuses to mislabel, with the client guard bypassed (FR-019, SC-013)', () => {
    const MODIFY_CALL = 'call-modify-1';

    /** In-memory chat store double with a completed modify part. */
    function makeChatStore(modifyEditClockStart) {
      const messages = [{
        role: 'assistant',
        parts: [{
          type: 'tool-modify',
          toolCallId: MODIFY_CALL,
          output: {
            changed: true,
            // `editRangePending` case when undefined — no editRange at all.
            ...(modifyEditClockStart === undefined
              ? { editRangePending: true }
              : { editRange: { clockStart: modifyEditClockStart, clockEnd: modifyEditClockStart } }),
          },
        }],
      }];
      return {
        messages,
        part: () => messages[0].parts[0],
        loadChat: async () => messages,
        saveChat: async (_c, _u, m) => { messages.splice(0, messages.length, ...m); },
      };
    }

    /** Seed a doc with a chat modify, then a restore on top of it. */
    async function seedModifyThenRestore(docGuid) {
      await seedDoc(docGuid);
      const doc = await persistence.getYDoc(docGuid);
      const sv = Y.encodeStateVector(doc);
      doc.transact(() => doc.getXmlFragment('default').insert(2, [para('Gamma')]));
      const editClock = await persistence.storeUpdate(
        docGuid, Y.encodeStateAsUpdate(doc, sv), userId, CHAT_AGENT_NAME
      );
      doc.destroy();
      await editRecords.recordEdit(persistence, {
        docGuid, userId, agentName: CHAT_AGENT_NAME,
        clockStart: editClock, clockEnd: editClock, clocks: [editClock],
      });
      const restore = await restoreVersion(persistence, docGuid, '0', userId, {
        ...noSharedDoc, agentName: CHAT_AGENT_NAME,
      });
      return { editClock, restoreClock: restore.newClock };
    }

    test('(N3, the ≤30s poll-staleness window) a restore is the true target, but the click carries the modify toolCallId: the undo happens and the modify is NOT marked "Reverted"', async () => {
      const docGuid = randomUUID();
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { editClock, restoreClock } = await seedModifyThenRestore(docGuid);

        // This is exactly the stale-poll situation: the client fetched status
        // BEFORE the restore (so it still believed the modify was next and
        // offered the button), the restore landed, and the click arrives now.
        const store = makeChatStore(editClock);

        const undo = await undoService.performUndo(
          { docGuid, userId, agentName: CHAT_AGENT_NAME },
          { persistence, getSharedDoc: () => null }
        );
        // The endpoint contract is UNCHANGED — the restore really is inverted.
        expect(undo.undone).toBe(true);
        expect(undo.actedEditClockStart).toBe(restoreClock);

        const result = await applyRevertedFlag(store, {
          chatId: 'chat-1', userId, toolCallId: MODIFY_CALL,
          reverted: true, actedEditClockStart: undo.actedEditClockStart,
        });

        // THE POINT: the modify was never labelled "Reverted".
        expect(result.refused).toBe(true);
        expect(result.changed).toBe(false);
        expect(store.part().reverted).toBeUndefined();
      } finally {
        warnSpy.mockRestore();
        await cleanupDoc(docGuid);
      }
    });

    test('the guard is a DISCRIMINATOR, not a blanket refusal: the toolCallId of the record actually acted on DOES get marked', async () => {
      const docGuid = randomUUID();
      try {
        await seedDoc(docGuid);
        const doc = await persistence.getYDoc(docGuid);
        const sv = Y.encodeStateVector(doc);
        doc.transact(() => doc.getXmlFragment('default').insert(2, [para('Gamma')]));
        const editClock = await persistence.storeUpdate(
          docGuid, Y.encodeStateAsUpdate(doc, sv), userId, CHAT_AGENT_NAME
        );
        doc.destroy();
        await editRecords.recordEdit(persistence, {
          docGuid, userId, agentName: CHAT_AGENT_NAME,
          clockStart: editClock, clockEnd: editClock, clocks: [editClock],
        });

        // No restore this time — the modify IS the next target.
        const store = makeChatStore(editClock);
        const undo = await undoService.performUndo(
          { docGuid, userId, agentName: CHAT_AGENT_NAME },
          { persistence, getSharedDoc: () => null }
        );
        expect(undo.actedEditClockStart).toBe(editClock);

        const result = await applyRevertedFlag(store, {
          chatId: 'chat-1', userId, toolCallId: MODIFY_CALL,
          reverted: true, actedEditClockStart: undo.actedEditClockStart,
        });
        expect(result.refused).toBe(false);
        expect(result.changed).toBe(true);
        expect(store.part().reverted).toBe(true);

        // And a redo clears it again, through the same rule.
        const redo = await undoService.performRedo(
          { docGuid, userId, agentName: CHAT_AGENT_NAME },
          { persistence, getSharedDoc: () => null }
        );
        await applyRevertedFlag(store, {
          chatId: 'chat-1', userId, toolCallId: MODIFY_CALL,
          reverted: false, actedEditClockStart: redo.actedEditClockStart,
        });
        expect(store.part().reverted).toBeUndefined();
      } finally {
        await cleanupDoc(docGuid);
      }
    });

    test('(N2) FAILS CLOSED for an editRangePending part — the record is known but the part is unidentifiable, so no guess is made', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const store = makeChatStore(undefined); // no editRange at all
        const result = await applyRevertedFlag(store, {
          chatId: 'chat-1', userId, toolCallId: MODIFY_CALL,
          reverted: true, actedEditClockStart: 42,
        });
        expect(result.refused).toBe(true);
        expect(store.part().reverted).toBeUndefined();
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('FAILS OPEN on the legacy path — no record backed the undo, and no competing record can exist, so today behavior is preserved', async () => {
      const store = makeChatStore(undefined);
      const result = await applyRevertedFlag(store, {
        chatId: 'chat-1', userId, toolCallId: MODIFY_CALL,
        reverted: true, actedEditClockStart: undefined,
      });
      expect(result.refused).toBe(false);
      expect(store.part().reverted).toBe(true);
    });
  });
});
