/**
 * Integration: log-derived undo/redo (feature 016, US1/US2/US3/US4).
 *
 * The retired flow popped an in-memory session Y.UndoManager; these tests pin
 * the replacement: undo/redo derive from the durable yjs_updates log via
 * server/undo/undo-service.js, work with NO live session, from any instance,
 * across simulated restarts, create zero presence sessions, and never rewrite
 * history. The WS harness mirrors production bindState: every client-origin
 * update is persisted per-update with (userId, agentName) attribution.
 */
const http = require('http');
const WebSocket = require('ws');
const Y = require('yjs');
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');
const toolRegistry = require('../../tools/index');
const { setupWSConnection, setPersistence, getYDoc } = require('y-websocket/bin/utils');
const agentPresence = require('../../agent-presence');
const documents = require('../../../documents');
const documentService = require('../../../document-service');
const { parseOrigin, ORIGIN_DB_LOAD } = require('../../../origin');
const undoService = require('../../../undo/undo-service');

const AGENT_NAME = 'Squire Docs Assistant';
const mockAgentToken = {
  userId: null, agentId: 'in-app-chat', agentName: AGENT_NAME,
  scopes: ['documents:read', 'documents:write'], rawToken: null,
};

describe('Log-derived undo/redo workflow', () => {
  let pool, persistence, httpServer, wss, testUserId;

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    const extractDocGuid = (n) => (n.startsWith('s/') ? n.slice(2) : n);
    setPersistence({
      bindState: async (docName, ydoc) => {
        const g = extractDocGuid(docName);
        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          persistence.storeUpdate(g, update, parsed.userId, parsed.agentName)
            .catch((e) => console.error('[test bindState] persist failed:', e.message));
        });
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(await persistence.getYDoc(g)), ORIGIN_DB_LOAD);
      },
      writeState: async () => {},
    });
    documents.init(pool);
    documentService.init(getYDoc, extractDocGuid);
    toolRegistry.init(persistence);
    agentPresence.init(persistence);
    undoService.init(persistence);

    httpServer = http.createServer();
    wss = new WebSocket.Server({ server: httpServer, verifyClient: () => true });
    wss.on('connection', (ws, req) => {
      ws.userId = testUserId;
      ws.agentName = AGENT_NAME;
      setupWSConnection(ws, req, { gc: false });
    });
    await new Promise((r) => httpServer.listen(0, () => {
      process.env.WS_PORT = httpServer.address().port;
      process.env.WS_HOST = 'localhost';
      process.env.WS_PROTOCOL = 'ws';
      r();
    }));

    const u = await pool.query(
      `INSERT INTO users (google_id, name, email, picture) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['g-wf-' + Date.now(), 'T', 'wf-' + Date.now() + '@e.com', 'x'],
    );
    testUserId = u.rows[0].id;
    mockAgentToken.userId = testUserId;
    mockAgentToken.rawToken = 'mock-' + Date.now();
  });

  afterAll(async () => {
    agentPresence.clearUserSessions(testUserId);
    await new Promise((r) => setTimeout(r, 100));
    wss.close();
    await new Promise((r) => httpServer.close(r));
    await new Promise((r) => setTimeout(r, 100));
    await pool.query('DELETE FROM agent_edits WHERE user_id = $1', [testUserId]);
    await pool.end();
  });

  async function createDoc(title, initialText = 'Original text.') {
    const ydoc = new Y.Doc();
    const frag = ydoc.get('default', Y.XmlFragment);
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, initialText);
    p.insert(0, [t]);
    frag.insert(0, [p]);
    const d = await pool.query(
      `INSERT INTO documents (id, title, creator_id) VALUES (uuid_generate_v4(),$1,$2) RETURNING id`,
      [title, testUserId],
    );
    const docGuid = d.rows[0].id;
    await pool.query(
      `INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1,$2,'editor')`,
      [docGuid, testUserId]
    );
    await pool.query(
      `INSERT INTO yjs_updates (doc_guid, clock, update_data, created_at) VALUES ($1,0,$2,NOW())`,
      [docGuid, Buffer.from(Y.encodeStateAsUpdate(ydoc))]
    );
    return docGuid;
  }

  async function modifyAppend(docGuid, text) {
    const modify = toolRegistry.getTool('modify');
    const script = `
export default function edit(doc) {
  const t = doc.get(0).get(0);
  t.insert(t.length, ' ${text}');
}`;
    const result = await modify.handler({ docGuid, script }, mockAgentToken);
    expect(result.changed).toBe(true);
    expect(result.editRange).toBeDefined();
    return result;
  }

  /** Rebuild the doc from the DB alone — what any other instance would see. */
  async function dbText(docGuid) {
    const doc = await persistence.getYDoc(docGuid);
    const text = doc.get('default', Y.XmlFragment).toString();
    doc.destroy();
    return text;
  }

  async function logDump(docGuid) {
    const { rows } = await pool.query(
      'SELECT clock, md5(update_data) AS hash FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock',
      [docGuid]
    );
    return rows;
  }

  function killSessions() {
    agentPresence.clearUserSessions(testUserId);
    expect(agentPresence._sessionsByKey.size).toBe(0);
  }

  // ---------------------------------------------------------------- US1 ----

  test('undo works with NO live session, creates none, and the inverse row carries the acting identity', async () => {
    const docGuid = await createDoc('US1 no-session undo');
    await modifyAppend(docGuid, 'EDITED');
    expect(await dbText(docGuid)).toBe('<paragraph>Original text. EDITED</paragraph>');

    const preRows = await logDump(docGuid);
    killSessions(); // the session (and the retired UndoManager) are gone

    const sessionsBefore = agentPresence._sessionsByKey.size;
    const undo = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    expect(undo.success).toBe(true);
    expect(undo.undone).toBe(true);
    expect(typeof undo.clock).toBe('number');
    expect(undo.cursor).toBeUndefined(); // RBD-5: cursor retired

    // FR-008 / SC-006: zero sessions created or extended by the undo
    expect(agentPresence._sessionsByKey.size).toBe(sessionsBefore);

    expect(await dbText(docGuid)).toBe('<paragraph>Original text.</paragraph>');

    // SC-009: pre-existing rows byte-identical; the log strictly grew
    const postRows = await logDump(docGuid);
    expect(postRows.length).toBe(preRows.length + 1);
    expect(postRows.slice(0, preRows.length)).toEqual(preRows);

    // FR-026: the inverse is a normally-attributed row of the acting identity
    const inverseRow = await pool.query(
      'SELECT user_id, agent_name FROM yjs_updates WHERE doc_guid = $1 AND clock = $2',
      [docGuid, undo.clock]
    );
    expect(inverseRow.rows[0].user_id).toBe(testUserId);
    expect(inverseRow.rows[0].agent_name).toBe(AGENT_NAME);
  });

  test('cross-instance: edit through the WS instance, undo through a second instance sharing only the DB (SC-001)', async () => {
    const docGuid = await createDoc('US1 cross-instance');
    await modifyAppend(docGuid, 'FROM-A');
    killSessions();

    // "Instance B": its own persistence and its own independently loaded doc.
    const persistenceB = createPersistence();
    const liveB = await persistenceB.getYDoc(docGuid);
    try {
      const result = await undoService.performUndo(
        { docGuid, userId: testUserId, agentName: AGENT_NAME },
        { persistence: persistenceB, getSharedDoc: () => liveB }
      );
      expect(result.undone).toBe(true);
      // B's live doc saw the inverse applied...
      expect(liveB.get('default', Y.XmlFragment).toString()).toBe('<paragraph>Original text.</paragraph>');
      // ...and the durable truth reverted for every other instance.
      expect(await dbText(docGuid)).toBe('<paragraph>Original text.</paragraph>');
    } finally {
      liveB.destroy();
      await persistenceB.destroy();
    }
  });

  test('undo after a simulated restart: fresh persistence, no shared doc, zero in-memory state (SC-002)', async () => {
    const docGuid = await createDoc('US1 restart');
    await modifyAppend(docGuid, 'BEFORE-RESTART');
    killSessions();

    // "Restart": nothing in memory — a brand-new persistence, no live doc at all.
    const persistenceR = createPersistence();
    try {
      const result = await undoService.performUndo(
        { docGuid, userId: testUserId, agentName: AGENT_NAME },
        { persistence: persistenceR, getSharedDoc: () => null }
      );
      expect(result.undone).toBe(true);
      expect(await dbText(docGuid)).toBe('<paragraph>Original text.</paragraph>');
    } finally {
      await persistenceR.destroy();
    }
  });

  test('undo before the identifier is recorded is honestly empty (RBD-7(b))', async () => {
    const docGuid = await createDoc('US1 unrecorded');
    await modifyAppend(docGuid, 'UNRECORDED');
    // Simulate the pre-durability window: the edit's rows are in the log but
    // the agent_edits record does not exist (yet).
    await pool.query('DELETE FROM agent_edits WHERE doc_guid = $1', [docGuid]);
    killSessions();

    const undo = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    expect(undo.success).toBe(true);
    expect(undo.undone).toBe(false);
    expect(typeof undo.message).toBe('string');
    // No inverse was appended; the document is untouched.
    expect(await dbText(docGuid)).toBe('<paragraph>Original text. UNRECORDED</paragraph>');
  });

  test('undo on a never-edited doc is honestly empty, not an error', async () => {
    const docGuid = await createDoc('US1 never edited');
    const undo = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    expect(undo.success).toBe(true);
    expect(undo.undone).toBe(false);
  });

  // ---------------------------------------------------------------- US2 ----

  test('concurrent duplicate undo: exactly one inverse row, the loser reports honestly (FR-028)', async () => {
    const docGuid = await createDoc('US2 concurrent undo');
    await modifyAppend(docGuid, 'RACED');
    killSessions();

    const preCount = (await logDump(docGuid)).length;
    const attempt = () => undoService.performUndo(
      { docGuid, userId: testUserId, agentName: AGENT_NAME },
      { persistence, getSharedDoc: () => null }
    );
    const [a, b] = await Promise.all([attempt(), attempt()]);

    const winners = [a, b].filter((r) => r.undone);
    const losers = [a, b].filter((r) => !r.undone);
    expect(winners.length).toBe(1); // zero-double-apply (SC-004)
    expect(losers.length).toBe(1);
    expect(losers[0].success).toBe(true);
    expect(typeof losers[0].message).toBe('string');

    // Exactly ONE inverse appended; the reversion applied exactly once.
    const postCount = (await logDump(docGuid)).length;
    expect(postCount).toBe(preCount + 1);
    expect(await dbText(docGuid)).toBe('<paragraph>Original text.</paragraph>');
  });

  test('a live in-flight collaborator edit racing the undo survives byte-for-byte and merges (FR-013/RBD-9, SC-010)', async () => {
    const docGuid = await createDoc('US2 live race');
    await modifyAppend(docGuid, 'AGENT-EDIT');
    killSessions();

    // The serving instance's live doc holds an in-flight collaborator edit
    // that is NOT yet persisted to the log (typed while the undo lands).
    const liveDoc = await persistence.getYDoc(docGuid);
    liveDoc.get('default', Y.XmlFragment).get(0).get(0).insert(14, ' TYPED-DURING-UNDO');
    const liveBefore = liveDoc.get('default', Y.XmlFragment).toString();
    expect(liveBefore).toContain('TYPED-DURING-UNDO');

    try {
      const result = await undoService.performUndo(
        { docGuid, userId: testUserId, agentName: AGENT_NAME },
        { persistence, getSharedDoc: () => liveDoc }
      );
      expect(result.undone).toBe(true);

      // The collaborator's in-flight text survives byte-for-byte; only the
      // agent's contribution reverted.
      const liveAfter = liveDoc.get('default', Y.XmlFragment).toString();
      expect(liveAfter).toBe('<paragraph>Original text. TYPED-DURING-UNDO</paragraph>');
    } finally {
      liveDoc.destroy();
    }
  });

  test('a live in-flight deletion of everything the edit did yields the honest empty (supersession vs live state)', async () => {
    const docGuid = await createDoc('US2 live supersession');
    await modifyAppend(docGuid, 'DOOMED');
    killSessions();

    // In the live doc, a collaborator has already removed the agent's text
    // (not yet persisted). Supersession is evaluated against the merged live
    // state (FR-013): nothing left to undo, nothing appended.
    const liveDoc = await persistence.getYDoc(docGuid);
    const t = liveDoc.get('default', Y.XmlFragment).get(0).get(0);
    t.delete(14, 7); // removes ' DOOMED'

    const preCount = (await logDump(docGuid)).length;
    try {
      const result = await undoService.performUndo(
        { docGuid, userId: testUserId, agentName: AGENT_NAME },
        { persistence, getSharedDoc: () => liveDoc }
      );
      expect(result.undone).toBe(false);
      expect(result.success).toBe(true);
      expect((await logDump(docGuid)).length).toBe(preCount); // zero log growth (SC-004)

      // The edit was NOT marked reverted — still active for a later undo.
      const rec = await pool.query(
        'SELECT state FROM agent_edits WHERE doc_guid = $1', [docGuid]
      );
      expect(rec.rows[0].state).toBe('active');
    } finally {
      liveDoc.destroy();
    }
  });
});
