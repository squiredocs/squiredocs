/**
 * GET /api/docs/:docId/undo-status — log-derived availability (feature 016,
 * US5, FR-019/RBD-6, SC-006/SC-007).
 *
 * The endpoint derives { canUndo, canRedo } from agent_edits (+ the legacy
 * log derivation fallback) for the chat-assistant identity — no presence
 * session is consulted or created, so availability survives session expiry
 * and restarts. Viewer role and errors stay { false, false }.
 *
 * Feature 043 (FR-006c, X4): this suite used to replicate the endpoint handler
 * from server/index.js in-file, and the replica had already drifted — it
 * omitted the `console.error` that production logs on the failure path, so the
 * one thing a mirror is supposed to prove (that these assertions describe
 * production) was already false. The handler is now a mounted router and this
 * app mounts the real one. Stubbing *authentication* below is still legitimate;
 * stubbing the handler under test is not.
 */
const request = require('supertest');
const express = require('express');
const { randomUUID } = require('crypto');
const Y = require('yjs');
const { createPool, createPersistence, createTestUser, cleanupTestUser, cleanupDocRows } = require('./helpers/db');
const documents = require('../documents');
const agentPresence = require('../mcp/agent-presence');
const undoService = require('../undo/undo-service');
const editRecords = require('../undo/edit-records');
const { getRevertedDocs } = require('../api/chat-staleness');

// Read from the one authoritative definition rather than re-declaring the
// literal, so a local copy here cannot drift from the identity the chat
// assistant actually records under.
const { CHAT_AGENT_NAME } = require('../agent-identity');
const { createUndoStatusRouter } = require('../api/undo-status');

describe('GET /api/docs/:docId/undo-status', () => {
  let pool, persistence, app, userId, viewerId;

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    documents.init(pool);
    undoService.init(persistence);
    userId = await createTestUser(pool, `undo-status-${Date.now()}@test.com`);
    viewerId = await createTestUser(pool, `undo-status-viewer-${Date.now()}@test.com`);

    // THE REAL ROUTER, mounted the real way, behind a fake-auth middleware
    // standing in for `requireAuth` (the only thing stubbed here).
    app = express();
    app.use(createUndoStatusRouter({
      documents,
      undoService,
      requireAuth: (req, res, next) => {
        req.user = { userId: req.headers['x-test-user'] || userId };
        next();
      },
    }));
  });

  // Feature 043 (FR-010, ledger D3): every doc_guid this suite causes update-log
  // rows to exist under. See the convention block in ./helpers/db.js.
  const createdDocGuids = [];

  afterAll(async () => {
    await cleanupDocRows(pool, createdDocGuids);
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
    createdDocGuids.push(docGuid);
    await pool.query(
      `INSERT INTO document_shares (doc_id, user_id, role, granted_by) VALUES ($1, $2, 'editor', $2)`,
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
    expect(res.body).toEqual({ canUndo: true, canRedo: false });

    // SC-006: the poll neither created nor extended any presence session.
    expect(agentPresence._sessionsByKey.size).toBe(before);

    // "Restart": a brand-new persistence over the same DB answers the same.
    const persistenceR = createPersistence();
    try {
      const status = await undoService.getUndoStatus(
        { docGuid, userId, agentName: CHAT_AGENT_NAME },
        { persistence: persistenceR }
      );
      expect(status).toEqual({ canUndo: true, canRedo: false });
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
    expect(res.body).toEqual({ canUndo: false, canRedo: true });
  });

  test('viewer role gets { false, false }', async () => {
    const docGuid = await createDoc({ agentEdit: true });
    await pool.query(
      `INSERT INTO document_shares (doc_id, user_id, role, granted_by) VALUES ($1, $2, 'viewer', $2)`,
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
    )).rejects.toThrow('db down'); // the service throws; the endpoint catches.

    // Feature 043 (FR-006c): the catch is now the PRODUCTION catch. The router
    // is mounted with a service that throws, so this exercises the real
    // degrade-to-{false,false} path rather than a second in-file replica of it.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const failingApp = express();
      failingApp.use(createUndoStatusRouter({
        documents,
        undoService: { getUndoStatus: async () => { throw new Error('boom'); } },
        requireAuth: (req, res, next) => { req.user = { userId }; next(); },
      }));
      const res = await request(failingApp).get(`/api/docs/${docGuid}/undo-status`);
      expect(res.body).toEqual({ canUndo: false, canRedo: false });

      // ...and it is LOGGED. The in-file mirror this suite used to run omitted
      // this line, so a silent-failure regression would have passed. That
      // omission is the concrete drift FR-006 exists to prevent.
      expect(errSpy).toHaveBeenCalledWith('Error checking undo status:', expect.any(Error));
    } finally {
      errSpy.mockRestore();
    }
  });

  test('legacy fallback: a pre-016 edit with only log rows (no record) reports canUndo (FR-021)', async () => {
    const docGuid = await createDoc({ agentEdit: true, aged: true });
    // NO agent_edits record — pre-016 fixture (the chat part would persist
    // only the baseline clock).
    const res = await request(app).get(`/api/docs/${docGuid}/undo-status`);
    expect(res.body).toEqual({ canUndo: true, canRedo: false });
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
