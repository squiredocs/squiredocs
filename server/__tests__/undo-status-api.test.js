/**
 * GET /api/docs/:docId/undo-status — log-derived availability (feature 016,
 * US5, FR-019/RBD-6, SC-006/SC-007).
 *
 * The endpoint derives { canUndo, canRedo } from agent_edits (+ the legacy
 * log derivation fallback) for the chat-assistant identity — no presence
 * session is consulted or created, so availability survives session expiry
 * and restarts. Viewer role and errors stay { false, false }.
 *
 * The express app replicates the endpoint handler from server/index.js (the
 * established endpoint-test pattern in this repo).
 */
const request = require('supertest');
const express = require('express');
const { randomUUID } = require('crypto');
const Y = require('yjs');
const { createPool, createPersistence, createTestUser, cleanupTestUser } = require('./helpers/db');
const documents = require('../documents');
const agentPresence = require('../mcp/agent-presence');
const undoService = require('../undo/undo-service');
const editRecords = require('../undo/edit-records');
const { getRevertedDocs } = require('../api/chat-staleness');
const versionHistory = require('../version-history');

// Feature 040 (FR-005): read from the one authoritative definition rather
// than re-declaring the literal — a local copy here could drift from the
// identity the restore route actually records under, which is the exact class
// of bug FR-005 exists to make impossible. T016 pins this.
const { CHAT_AGENT_NAME } = require('../agent-identity');

describe('GET /api/docs/:docId/undo-status', () => {
  let pool, persistence, app, userId, viewerId;

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    documents.init(pool);
    undoService.init(persistence);
    userId = await createTestUser(pool, `undo-status-${Date.now()}@test.com`);
    viewerId = await createTestUser(pool, `undo-status-viewer-${Date.now()}@test.com`);

    // Mirror of the server/index.js endpoint handler.
    app = express();
    app.use((req, res, next) => {
      req.user = { userId: req.headers['x-test-user'] || userId };
      next();
    });
    app.get('/api/docs/:docId/undo-status', async (req, res) => {
      try {
        const { docId } = req.params;
        const role = await documents.getRole(docId, req.user.userId);
        if (!role || role === 'viewer') {
          return res.json({ canUndo: false, canRedo: false });
        }
        res.json(await undoService.getUndoStatus({
          docGuid: docId,
          userId: req.user.userId,
          agentName: CHAT_AGENT_NAME,
        }));
      } catch (error) {
        res.json({ canUndo: false, canRedo: false });
      }
    });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM agent_edits WHERE user_id = $1', [userId]);
    await cleanupTestUser(pool, viewerId);
    await cleanupTestUser(pool, userId);
    await persistence.destroy();
    await pool.end();
  });

  /** Doc + share + base row; optionally an aged agent edit row in the log. */
  async function createDoc({ agentEdit = false, aged = true } = {}) {
    const doc = new Y.Doc();
    const payloads = [];
    doc.on('update', (u) => payloads.push(u));
    const frag = doc.get('default', Y.XmlFragment);
    doc.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'Original text.');
      p.insert(0, [t]);
      frag.insert(0, [p]);
    });
    if (agentEdit) {
      doc.transact(() => frag.get(0).get(0).insert(14, ' AGENT'));
    }
    const d = await pool.query(
      `INSERT INTO documents (id, title, creator_id) VALUES ($1,$2,$3) RETURNING id`,
      [randomUUID(), 'undo-status test', userId],
    );
    const docGuid = d.rows[0].id;
    await pool.query(
      `INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1,$2,'editor')`,
      [docGuid, userId]
    );
    const age = aged ? "now() - interval '30 minutes'" : 'now()';
    await pool.query(
      `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name, created_at)
       VALUES ($1, 0, $2, NULL, NULL, now() - interval '1 hour')`,
      [docGuid, Buffer.from(payloads[0])]
    );
    if (agentEdit) {
      await pool.query(
        `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name, created_at)
         VALUES ($1, 1, $2, $3, $4, ${age})`,
        [docGuid, Buffer.from(payloads[1]), userId, CHAT_AGENT_NAME]
      );
    }
    return docGuid;
  }

  test('canUndo with a recorded edit and ZERO live sessions; survives a simulated restart (SC-007)', async () => {
    const docGuid = await createDoc({ agentEdit: true });
    await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: CHAT_AGENT_NAME, clockStart: 1, clockEnd: 1,
    });

    expect(agentPresence._sessionsByKey.size).toBe(0); // no session anywhere
    const before = agentPresence._sessionsByKey.size;

    const res = await request(app).get(`/api/docs/${docGuid}/undo-status`);
    // 040 FR-016: canUndo/canRedo keep their exact prior values; the response
    // additionally carries the target record's immutable edit_clock_start.
    expect(res.body.canUndo).toBe(true);
    expect(res.body.canRedo).toBe(false);
    expect(res.body.nextUndo).toEqual({ editClockStart: 1 });

    // SC-006: the poll neither created nor extended any presence session.
    expect(agentPresence._sessionsByKey.size).toBe(before);

    // "Restart": a brand-new persistence over the same DB answers the same.
    const persistenceR = createPersistence();
    try {
      const status = await undoService.getUndoStatus(
        { docGuid, userId, agentName: CHAT_AGENT_NAME },
        { persistence: persistenceR }
      );
      expect(status.canUndo).toBe(true);
      expect(status.canRedo).toBe(false);
    } finally {
      await persistenceR.destroy();
    }
  });

  test('canRedo after an undo; canUndo reflects what remains', async () => {
    const docGuid = await createDoc({ agentEdit: true });
    await editRecords.recordEdit(persistence, {
      docGuid, userId, agentName: CHAT_AGENT_NAME, clockStart: 1, clockEnd: 1,
    });
    const result = await undoService.performUndo(
      { docGuid, userId, agentName: CHAT_AGENT_NAME },
      { persistence, getSharedDoc: () => null }
    );
    expect(result.undone).toBe(true);

    const res = await request(app).get(`/api/docs/${docGuid}/undo-status`);
    expect(res.body.canUndo).toBe(false);
    expect(res.body.canRedo).toBe(true);
    // 040 FR-016/D14: the redo target is reported by the record's IMMUTABLE
    // edit_clock_start — unchanged by the undo that just happened.
    expect(res.body.nextRedo).toEqual({ editClockStart: 1 });
    // canUndo is false, so its target field is ABSENT (not null, not 0).
    expect('nextUndo' in res.body).toBe(false);
  });

  test('viewer role gets { false, false }', async () => {
    const docGuid = await createDoc({ agentEdit: true });
    await pool.query(
      `INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1,$2,'viewer')`,
      [docGuid, viewerId]
    );
    const res = await request(app)
      .get(`/api/docs/${docGuid}/undo-status`)
      .set('x-test-user', viewerId);
    expect(res.body).toEqual({ canUndo: false, canRedo: false });
  });

  test('no access and never-edited docs are honestly { false, false }', async () => {
    // No access at all (unknown doc)
    let res = await request(app).get(`/api/docs/${randomUUID()}/undo-status`);
    expect(res.body).toEqual({ canUndo: false, canRedo: false });

    // Editor access, but the assistant never edited the doc
    const docGuid = await createDoc({ agentEdit: false });
    res = await request(app).get(`/api/docs/${docGuid}/undo-status`);
    expect(res.body).toEqual({ canUndo: false, canRedo: false });
  });

  test('errors degrade to { false, false }', async () => {
    const docGuid = await createDoc({ agentEdit: false });
    const broken = {
      getPool: () => ({ query: async () => { throw new Error('db down'); } }),
    };
    await expect(undoService.getUndoStatus(
      { docGuid, userId, agentName: CHAT_AGENT_NAME },
      { persistence: broken }
    )).rejects.toThrow('db down'); // the service throws; the endpoint catches:
    // replicate the endpoint's catch with a stubbed service failure
    const failingApp = express();
    failingApp.get('/api/docs/:docId/undo-status', async (req, res) => {
      try {
        throw new Error('boom');
      } catch {
        res.json({ canUndo: false, canRedo: false });
      }
    });
    const res = await request(failingApp).get(`/api/docs/${docGuid}/undo-status`);
    expect(res.body).toEqual({ canUndo: false, canRedo: false });
  });

  test('legacy fallback: a pre-016 edit with only log rows (no record) reports canUndo (FR-021)', async () => {
    const docGuid = await createDoc({ agentEdit: true, aged: true });
    // NO agent_edits record — pre-016 fixture (the chat part would persist
    // only the baseline clock).
    const res = await request(app).get(`/api/docs/${docGuid}/undo-status`);
    // 040 FR-016 rule 2: canUndo is still true, and BOTH target fields are
    // absent — this branch derives a range from the log and has no record, so
    // there is no stable identity to report. Asserted with toEqual so an
    // accidental null-guess would fail here.
    expect(res.body).toEqual({ canUndo: true, canRedo: false });
  });

  // T015 (040 FR-002 / SC-002): the headline defect. Before 040 a web-UI
  // restore recorded under the unreachable '' sentinel, so this endpoint
  // reported canUndo:false and no undo surface could invert it.
  describe('040 T015: a web-UI restore is reported as undoable (FR-002, SC-002)', () => {
    test('canUndo is true immediately after a web-UI restore, and survives a simulated process restart', async () => {
      const docGuid = await createDoc({ agentEdit: false });
      // Second revision, so there is an earlier version to restore to.
      const doc = await persistence.getYDoc(docGuid);
      const sv = Y.encodeStateVector(doc);
      doc.transact(() => doc.get('default', Y.XmlFragment).get(0).get(0).insert(0, 'Changed: '));
      await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(doc, sv), userId, null);
      doc.destroy();

      // The restore exactly as server/index.js's REST route performs it.
      const result = await versionHistory.restoreVersion(
        persistence, docGuid, '0', userId,
        { getSharedDoc: () => null, redisPubSub: null, agentName: CHAT_AGENT_NAME }
      );
      expect(result.success).toBe(true);

      const res = await request(app).get(`/api/docs/${docGuid}/undo-status`);
      expect(res.body.canUndo).toBe(true);
      // FR-016: and it names the restore's own record.
      expect(res.body.nextUndo.editClockStart).toBe(result.newClock);

      // Log-derived, not session-derived: a brand-new persistence over the
      // same DB (a "restarted" process, no in-memory state) answers the same.
      const persistenceR = createPersistence();
      try {
        const status = await undoService.getUndoStatus(
          { docGuid, userId, agentName: CHAT_AGENT_NAME },
          { persistence: persistenceR }
        );
        expect(status.canUndo).toBe(true);
        expect(status.nextUndo.editClockStart).toBe(result.newClock);
      } finally {
        await persistenceR.destroy();
      }
    });

    test('a viewer still gets { canUndo:false, canRedo:false } after a restore (unchanged edge case)', async () => {
      const docGuid = await createDoc({ agentEdit: false });
      const doc = await persistence.getYDoc(docGuid);
      const sv = Y.encodeStateVector(doc);
      doc.transact(() => doc.get('default', Y.XmlFragment).get(0).get(0).insert(0, 'Changed: '));
      await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(doc, sv), userId, null);
      doc.destroy();
      await versionHistory.restoreVersion(
        persistence, docGuid, '0', userId,
        { getSharedDoc: () => null, redisPubSub: null, agentName: CHAT_AGENT_NAME }
      );
      await pool.query(
        `INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1,$2,'viewer')`,
        [docGuid, viewerId]
      );
      const res = await request(app)
        .get(`/api/docs/${docGuid}/undo-status`)
        .set('x-test-user', viewerId);
      expect(res.body).toEqual({ canUndo: false, canRedo: false });
    });
  });

  // T045 (040 FR-016 / SC-011): the additive target fields, and the backward
  // compatibility that makes them safe to add.
  describe('040 T045: /undo-status additively reports the target record (FR-016, SC-011)', () => {
    test('(a) with an active record, nextUndo.editClockStart equals that row edit_clock_start', async () => {
      const docGuid = await createDoc({ agentEdit: true });
      await editRecords.recordEdit(persistence, {
        docGuid, userId, agentName: CHAT_AGENT_NAME, clockStart: 1, clockEnd: 1,
      });
      const row = await pool.query(
        'SELECT edit_clock_start FROM agent_edits WHERE doc_guid = $1', [docGuid]
      );
      const res = await request(app).get(`/api/docs/${docGuid}/undo-status`);
      expect(res.body.nextUndo.editClockStart).toBe(row.rows[0].edit_clock_start);
    });

    test('(b) with canUndo false, nextUndo is ABSENT — not null, not zero', async () => {
      const docGuid = await createDoc({ agentEdit: false });
      const res = await request(app).get(`/api/docs/${docGuid}/undo-status`);
      expect(res.body.canUndo).toBe(false);
      // Absence, asserted as absence. A `null` here would make a fail-open
      // client treat "no target" as "target unknown" and offer the control.
      expect('nextUndo' in res.body).toBe(false);
      expect('nextRedo' in res.body).toBe(false);
    });

    test('(d) canUndo/canRedo are byte-identical to today across every case', async () => {
      // No record at all.
      const empty = await createDoc({ agentEdit: false });
      let res = await request(app).get(`/api/docs/${empty}/undo-status`);
      expect({ canUndo: res.body.canUndo, canRedo: res.body.canRedo })
        .toEqual({ canUndo: false, canRedo: false });

      // Active record.
      const active = await createDoc({ agentEdit: true });
      await editRecords.recordEdit(persistence, {
        docGuid: active, userId, agentName: CHAT_AGENT_NAME, clockStart: 1, clockEnd: 1,
      });
      res = await request(app).get(`/api/docs/${active}/undo-status`);
      expect({ canUndo: res.body.canUndo, canRedo: res.body.canRedo })
        .toEqual({ canUndo: true, canRedo: false });

      // After an undo.
      await undoService.performUndo(
        { docGuid: active, userId, agentName: CHAT_AGENT_NAME },
        { persistence, getSharedDoc: () => null }
      );
      res = await request(app).get(`/api/docs/${active}/undo-status`);
      expect({ canUndo: res.body.canUndo, canRedo: res.body.canRedo })
        .toEqual({ canUndo: false, canRedo: true });
    });

    test('(e) viewer role still gets exactly { canUndo:false, canRedo:false } with no target fields', async () => {
      const docGuid = await createDoc({ agentEdit: true });
      await editRecords.recordEdit(persistence, {
        docGuid, userId, agentName: CHAT_AGENT_NAME, clockStart: 1, clockEnd: 1,
      });
      await pool.query(
        `INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1,$2,'viewer')`,
        [docGuid, viewerId]
      );
      const res = await request(app)
        .get(`/api/docs/${docGuid}/undo-status`)
        .set('x-test-user', viewerId);
      // toEqual: the viewer path must not leak a target record either.
      expect(res.body).toEqual({ canUndo: false, canRedo: false });
    });
  });

  test('legacy fallback refuses ambiguity: identity rows exist but the tail is foreign', async () => {
    const docGuid = await createDoc({ agentEdit: true, aged: true });
    // A foreign row after the agent's — no trailing identity run.
    const doc = await persistence.getYDoc(docGuid);
    const payloads = [];
    doc.on('update', (u) => payloads.push(u));
    doc.transact(() => doc.get('default', Y.XmlFragment).get(0).get(0).insert(0, 'Human: '));
    doc.destroy();
    await pool.query(
      `INSERT INTO yjs_updates (doc_guid, clock, update_data, user_id, agent_name, created_at)
       VALUES ($1, 2, $2, NULL, NULL, now() - interval '20 minutes')`,
      [docGuid, Buffer.from(payloads[0])]
    );
    const res = await request(app).get(`/api/docs/${docGuid}/undo-status`);
    expect(res.body).toEqual({ canUndo: false, canRedo: false });
  });

  test('FR-020 regression: the persisted reverted flag still drives the staleness reverted-doc warning', async () => {
    // The log-derived undo persists `reverted: true` on the chat modify part
    // exactly as before; getRevertedDocs keys off that unchanged chat state.
    const docGuid = randomUUID();
    const messages = [
      {
        role: 'assistant',
        parts: [
          { type: 'tool-modify', toolCallId: 'c1', input: { docGuid }, output: { changed: true }, reverted: true },
        ],
      },
    ];
    const reverted = getRevertedDocs(messages);
    expect(reverted.has(docGuid)).toBe(true);

    // A redo clears the flag — and the warning.
    delete messages[0].parts[0].reverted;
    expect(getRevertedDocs(messages).has(docGuid)).toBe(false);
  });
});
