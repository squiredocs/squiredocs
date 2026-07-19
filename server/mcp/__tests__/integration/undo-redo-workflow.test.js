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
const OTHER_AGENT_NAME = 'Other MCP Agent';
const mockAgentToken = {
  userId: null, agentId: 'in-app-chat', agentName: AGENT_NAME,
  scopes: ['documents:read', 'documents:write'], rawToken: null,
};
const otherAgentToken = {
  userId: null, agentId: 'other-agent', agentName: OTHER_AGENT_NAME,
  scopes: ['documents:read', 'documents:write'], rawToken: null,
};

// rawToken -> identity, so the WS harness attributes each connection's
// updates like production auth does (ws.userId / ws.agentName).
const tokenIdentities = new Map();

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
      const token = new URL(req.url, 'http://localhost').searchParams.get('token');
      const ident = tokenIdentities.get(token) || { userId: testUserId, agentName: AGENT_NAME };
      ws.userId = ident.userId;
      ws.agentName = ident.agentName;
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
    otherAgentToken.userId = testUserId;
    otherAgentToken.rawToken = 'mock-other-' + Date.now();
    tokenIdentities.set(mockAgentToken.rawToken, { userId: testUserId, agentName: AGENT_NAME });
    tokenIdentities.set(otherAgentToken.rawToken, { userId: testUserId, agentName: OTHER_AGENT_NAME });
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
      // 020 (FR-003, spec US2 acceptance 2): the honest empty carries no diff.
      expect('diff' in result).toBe(false);
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

  // ------------------------------------------------------- 020 diff carry ----

  test('020: partial supersession — the undo diff shows ONLY the surviving revert (FR-002, SC-002)', async () => {
    const docGuid = await createDoc('020 partial supersession');

    // Filler paragraphs (foreign) BEFORE the agent's edit, so the doomed
    // paragraph's replacement sits far outside the diff's 2-line context
    // window around the surviving revert.
    await humanEdit(docGuid, (d, f) => {
      const mk = (text) => {
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, text);
        p.insert(0, [t]);
        return p;
      };
      f.insert(1, [mk('Filler one.'), mk('Filler two.'), mk('Filler three.')]);
    });

    // Agent edit A: TWO distinct paragraphs — one right after the base
    // paragraph, one at the end of the document.
    const modify = toolRegistry.getTool('modify');
    const script = `
export default function edit(doc) {
  const mk = (text) => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    return p;
  };
  doc.insert(1, [mk('SURVIVOR paragraph from the agent.')]);
  doc.insert(doc.length, [mk('DOOMED paragraph from the agent.')]);
}`;
    const editA = await modify.handler({ docGuid, script }, mockAgentToken);
    expect(editA.changed).toBe(true);
    killSessions();

    // Edit B, by a DIFFERENT identity, replaces the doomed paragraph.
    await humanEdit(docGuid, (d, f) => {
      f.delete(f.length - 1, 1);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'REPLACEMENT paragraph from the human.');
      p.insert(0, [t]);
      f.insert(f.length, [p]);
    });

    const undo = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    expect(undo.undone).toBe(true);
    expect(undo.diff).toBeDefined();

    // The diff shows exactly what the inverse did: the surviving paragraph
    // removed — and NOTHING about the superseded half or its replacement.
    const removed = undo.diff.lines.filter((l) => l.startsWith('-'));
    expect(removed.some((l) => l.includes('SURVIVOR paragraph from the agent.'))).toBe(true);
    for (const line of undo.diff.lines) {
      expect(line).not.toContain('DOOMED');
      expect(line).not.toContain('REPLACEMENT');
    }

    // And the document reality matches: survivor gone, replacement intact.
    const text = await dbText(docGuid);
    expect(text).not.toContain('SURVIVOR');
    expect(text).toContain('REPLACEMENT');
  });

  test('020: MCP tool results carry diff additively with unchanged 016 fields on undo AND redo (FR-004, SC-005)', async () => {
    const docGuid = await createDoc('020 additive contract');
    await modifyAppend(docGuid, 'DIFFED');
    killSessions();

    const undo = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    // 016 contract values, unchanged (C7).
    expect(undo.success).toBe(true);
    expect(undo.undone).toBe(true);
    expect(typeof undo.message).toBe('string');
    expect(typeof undo.clock).toBe('number');
    expect(undo.cursor).toBeUndefined(); // RBD-5 stays retired
    // Additive diff in modify's exact payload shape (C1/C2). `inlineSegments`
    // is the feature-022 additive word-level field, part of the shape now.
    const DIFF_KEYS = ['lines', 'hunkStarts', 'formatAnnotations', 'truncatedByServer', 'inlineSegments'];
    expect(Object.keys(undo.diff).every((k) => DIFF_KEYS.includes(k))).toBe(true);
    expect(undo.diff.lines.length).toBeGreaterThan(0);
    expect(Array.isArray(undo.diff.hunkStarts)).toBe(true);
    expect(undo.diff.lines.some((l) => l.startsWith('-') && l.includes('DIFFED'))).toBe(true);

    const redo = await toolRegistry.executeTool('redo', { docGuid }, mockAgentToken);
    expect(redo.success).toBe(true);
    expect(redo.redone).toBe(true);
    expect(typeof redo.message).toBe('string');
    expect(typeof redo.clock).toBe('number');
    expect(Object.keys(redo.diff).every((k) => DIFF_KEYS.includes(k))).toBe(true);
    expect(redo.diff.lines.some((l) => l.startsWith('+') && l.includes('DIFFED'))).toBe(true);
  });

  // ---------------------------------------------------------------- US3 ----

  /** Append a FOREIGN (human) edit directly to the durable log. */
  async function humanEdit(docGuid, fn) {
    const doc = await persistence.getYDoc(docGuid);
    const payloads = [];
    doc.on('update', (u) => payloads.push(u));
    doc.transact(() => fn(doc, doc.get('default', Y.XmlFragment)));
    doc.destroy();
    for (const u of payloads) {
      await persistence.storeUpdate(docGuid, u, null, null); // unattributed = foreign
    }
  }

  test('undo -> redo returns the document byte-for-byte to its pre-undo state (SC-005)', async () => {
    const docGuid = await createDoc('US3 round trip');
    await modifyAppend(docGuid, 'ROUNDTRIP');
    killSessions();
    const preUndo = await dbText(docGuid);

    const undo = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    expect(undo.undone).toBe(true);
    expect(await dbText(docGuid)).toBe('<paragraph>Original text.</paragraph>');

    const redo = await toolRegistry.executeTool('redo', { docGuid }, mockAgentToken);
    expect(redo.redone).toBe(true);
    expect(redo.cursor).toBeUndefined(); // RBD-5
    expect(typeof redo.clock).toBe('number');
    expect(await dbText(docGuid)).toBe(preUndo);
  });

  test('ten undo/redo cycles stay exact at every pole, across a simulated restart and an instance switch (SC-005)', async () => {
    const docGuid = await createDoc('US3 ten cycles');
    await modifyAppend(docGuid, 'CYCLED');
    killSessions();
    const edited = '<paragraph>Original text. CYCLED</paragraph>';
    const base = '<paragraph>Original text.</paragraph>';
    const identity = { docGuid, userId: testUserId, agentName: AGENT_NAME };

    for (let cycle = 0; cycle < 10; cycle++) {
      // Cycle 3 runs on a "restarted" server (fresh persistence, no live doc);
      // cycle 6 runs on a second "instance" (own persistence + own loaded doc).
      let deps = { persistence, getSharedDoc: () => null };
      let cleanup = null;
      if (cycle === 3) {
        const persistenceR = createPersistence();
        deps = { persistence: persistenceR, getSharedDoc: () => null };
        cleanup = () => persistenceR.destroy();
      } else if (cycle === 6) {
        const persistenceB = createPersistence();
        const liveB = await persistenceB.getYDoc(docGuid);
        deps = { persistence: persistenceB, getSharedDoc: () => liveB };
        cleanup = async () => { liveB.destroy(); await persistenceB.destroy(); };
      }

      const undo = await undoService.performUndo(identity, deps);
      expect(undo.undone).toBe(true);
      expect(await dbText(docGuid)).toBe(base);

      const redo = await undoService.performRedo(identity, deps);
      expect(redo.redone).toBe(true);
      expect(await dbText(docGuid)).toBe(edited);

      if (cleanup) await cleanup();
    }

    // FR-016: after each redo the chain row's undo_target is the LATEST redo's
    // own range, and redo_target the latest undo's range — never stale.
    const rec = await pool.query('SELECT * FROM agent_edits WHERE doc_guid = $1', [docGuid]);
    expect(rec.rows.length).toBe(1);
    const row = rec.rows[0];
    expect(row.state).toBe('active');
    const maxClock = (await logDump(docGuid)).length - 1;
    expect(row.undo_target_start).toBe(maxClock); // the 10th redo's row
    expect(row.undo_target_end).toBe(maxClock);
    expect(row.redo_target_start).toBe(maxClock - 1); // the 10th undo's row
  });

  test('redo with intervening collaborator edits is surgical (FR-015)', async () => {
    const docGuid = await createDoc('US3 intervening');
    await modifyAppend(docGuid, 'AGENT-PART');
    killSessions();

    const undo = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    expect(undo.undone).toBe(true);

    // A human edits while the agent edit sits undone.
    await humanEdit(docGuid, (d, f) => f.get(0).get(0).insert(14, ' HUMAN-WHILE-UNDONE'));

    const redo = await toolRegistry.executeTool('redo', { docGuid }, mockAgentToken);
    expect(redo.redone).toBe(true);

    const text = await dbText(docGuid);
    expect(text).toContain('AGENT-PART'); // reapplied
    expect(text).toContain('HUMAN-WHILE-UNDONE'); // preserved byte-for-byte
    expect(text.startsWith('<paragraph>Original text.')).toBe(true);
  });

  test('redo whose restoration target was superseded reports the honest nothing-left (FR-015)', async () => {
    const docGuid = await createDoc('US3 redo superseded');
    await modifyAppend(docGuid, 'GONE-SOON');
    killSessions();

    const undo = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    expect(undo.undone).toBe(true);

    // The human deletes the WHOLE paragraph the redo would restore into.
    await humanEdit(docGuid, (d, f) => f.delete(0, 1));

    const preCount = (await logDump(docGuid)).length;
    const redo = await toolRegistry.executeTool('redo', { docGuid }, mockAgentToken);
    expect(redo.success).toBe(true);
    expect(redo.redone).toBe(false);
    expect(typeof redo.message).toBe('string');
    expect('diff' in redo).toBe(false); // 020 (FR-003): honest empty, no diff
    expect((await logDump(docGuid)).length).toBe(preCount); // nothing appended
  });

  test('redo of a pre-016 undo (reverted flag, no record) is honestly redone:false (RBD-2)', async () => {
    const docGuid = await createDoc('US3 pre-016 undo');
    // A pre-016 history: the edit and its session-era undo are plain log rows;
    // no agent_edits record of any kind exists.
    await modifyAppend(docGuid, 'OLD-EDIT');
    await pool.query('DELETE FROM agent_edits WHERE doc_guid = $1', [docGuid]);
    killSessions();

    const redo = await toolRegistry.executeTool('redo', { docGuid }, mockAgentToken);
    expect(redo.success).toBe(true);
    expect(redo.redone).toBe(false);
  });

  test('chain results surface in version history as NEW attributed edits; prior versions untouched (FR-026/FR-027)', async () => {
    const versionHistory = require('../../../version-history');
    const docGuid = await createDoc('US3 version history');
    await modifyAppend(docGuid, 'HISTORIED');
    killSessions();

    const updatesBefore = await persistence.getUpdatesWithUsers(docGuid);
    const versionsBefore = versionHistory.groupUpdatesIntoVersions(updatesBefore, 1);

    const undo = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    expect(undo.undone).toBe(true);

    const updatesAfter = await persistence.getUpdatesWithUsers(docGuid);
    const versionsAfter = versionHistory.groupUpdatesIntoVersions(updatesAfter, 1);

    // The log strictly grew; the shared version prefix is unchanged.
    expect(updatesAfter.length).toBe(updatesBefore.length + 1);
    expect(versionsAfter.length).toBeGreaterThan(versionsBefore.length);
    for (let i = 0; i < versionsBefore.length; i++) {
      expect(versionsAfter[i].clockStart).toBe(versionsBefore[i].clockStart);
      expect(versionsAfter[i].clockEnd).toBe(versionsBefore[i].clockEnd);
    }

    // The inverse is its own NEW version, attributed to the acting identity.
    const inverseVersion = versionsAfter.find(
      (v) => v.clockStart <= undo.clock && undo.clock <= v.clockEnd
    );
    expect(inverseVersion).toBeDefined();
    expect(inverseVersion.authors.some(
      (a) => a.isAgent && a.id === testUserId && a.name.includes(AGENT_NAME)
    )).toBe(true);
  });

  test('the chat endpoints set and clear the persisted reverted flag on the tool part (US3 scenario 5)', async () => {
    const request = require('supertest');
    const express = require('express');
    const chatStore = require('../../../chat-store');
    chatStore.init(pool);

    const docGuid = await createDoc('US3 reverted flag');
    await modifyAppend(docGuid, 'FLAGGED');
    killSessions();

    // A stored chat holding the modify tool part.
    const toolCallId = 'call-016-' + Date.now();
    const chatId = 'chat016' + Date.now();
    await pool.query(
      'INSERT INTO chats (id, user_id, messages) VALUES ($1, $2, $3)',
      [chatId, testUserId, JSON.stringify([
        { role: 'assistant', parts: [{ type: 'tool-modify', toolCallId, output: { changed: true } }] },
      ])]
    );

    // Mini app replicating makeUndoRedoHandler + setChatPartReverted
    // (server/index.js) — the endpoint logic under test.
    async function setChatPartReverted(cId, userId, tcId, reverted) {
      const messages = await chatStore.loadChat(cId, userId);
      if (!messages || !messages.length) return;
      let changed = false;
      for (const m of messages) {
        for (const p of (m.parts || [])) {
          if (p.toolCallId === tcId && typeof p.type === 'string' && p.type.startsWith('tool-')) {
            if (reverted && p.reverted !== true) { p.reverted = true; changed = true; }
            else if (!reverted && p.reverted) { delete p.reverted; changed = true; }
          }
        }
      }
      if (changed) await chatStore.saveChat(cId, userId, messages);
    }
    const app = express();
    app.use(express.json());
    const makeHandler = (toolName) => async (req, res) => {
      const role = await documents.getRole(req.params.docId, testUserId);
      if (!role || role === 'viewer') return res.status(403).json({ error: 'forbidden' });
      const result = await toolRegistry.executeTool(toolName, { docGuid: req.params.docId }, mockAgentToken);
      const succeeded = toolName === 'undo' ? result.undone : result.redone;
      if (succeeded && req.body?.chatId && req.body?.toolCallId) {
        await setChatPartReverted(req.body.chatId, testUserId, req.body.toolCallId, toolName === 'undo');
      }
      res.json(result);
    };
    app.post('/api/docs/:docId/undo', makeHandler('undo'));
    app.post('/api/docs/:docId/redo', makeHandler('redo'));

    // Undo sets the flag...
    const undoRes = await request(app)
      .post(`/api/docs/${docGuid}/undo`).send({ chatId, toolCallId });
    expect(undoRes.status).toBe(200);
    expect(undoRes.body.undone).toBe(true);
    expect(typeof undoRes.body.clock).toBe('number');
    // 020 (FR-009, C8): the button-path HTTP response carries `diff` in
    // modify's shape — carried, not rendered; everything else is 016's shape.
    expect(undoRes.body.success).toBe(true);
    expect(typeof undoRes.body.message).toBe('string');
    expect(Array.isArray(undoRes.body.diff.lines)).toBe(true);
    expect(undoRes.body.diff.lines.length).toBeGreaterThan(0);
    expect(Array.isArray(undoRes.body.diff.hunkStarts)).toBe(true);
    let messages = await chatStore.loadChat(chatId, testUserId);
    expect(messages[0].parts[0].reverted).toBe(true);

    // ...and a successful redo clears it.
    const redoRes = await request(app)
      .post(`/api/docs/${docGuid}/redo`).send({ chatId, toolCallId });
    expect(redoRes.status).toBe(200);
    expect(redoRes.body.redone).toBe(true);
    expect(Array.isArray(redoRes.body.diff.lines)).toBe(true); // 020 (FR-009)
    messages = await chatStore.loadChat(chatId, testUserId);
    expect(messages[0].parts[0].reverted).toBeUndefined();

    await pool.query('DELETE FROM chats WHERE id = $1', [chatId]);
  });

  // ---------------------------------------------------------------- US4 ----

  test('repeated MCP undo steps back LIFO through the identity\'s edits; redo reapplies most-recently-undone first (FR-017/RBD-4)', async () => {
    const docGuid = await createDoc('US4 LIFO');
    await modifyAppend(docGuid, 'ONE');
    await modifyAppend(docGuid, 'TWO');
    killSessions();
    expect(await dbText(docGuid)).toBe('<paragraph>Original text. ONE TWO</paragraph>');

    // Undo walks back: TWO first, then ONE, then honest empty.
    let r = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    expect(r.undone).toBe(true);
    expect(await dbText(docGuid)).toBe('<paragraph>Original text. ONE</paragraph>');

    r = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    expect(r.undone).toBe(true);
    expect(await dbText(docGuid)).toBe('<paragraph>Original text.</paragraph>');

    r = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    expect(r.success).toBe(true);
    expect(r.undone).toBe(false); // nothing left — never an error
    expect(typeof r.message).toBe('string');

    // Redo reapplies most-recently-undone first: ONE, then TWO.
    r = await toolRegistry.executeTool('redo', { docGuid }, mockAgentToken);
    expect(r.redone).toBe(true);
    expect(await dbText(docGuid)).toBe('<paragraph>Original text. ONE</paragraph>');

    r = await toolRegistry.executeTool('redo', { docGuid }, mockAgentToken);
    expect(r.redone).toBe(true);
    expect(await dbText(docGuid)).toBe('<paragraph>Original text. ONE TWO</paragraph>');

    r = await toolRegistry.executeTool('redo', { docGuid }, mockAgentToken);
    expect(r.success).toBe(true);
    expect(r.redone).toBe(false);
  });

  test('identity scoping: an agent can only revert its own rows, never a human\'s or another agent\'s (FR-024)', async () => {
    const docGuid = await createDoc('US4 identity scope');
    // Human edit, then edits by two different agent identities of the SAME user.
    await humanEdit(docGuid, (d, f) => f.get(0).get(0).insert(14, ' HUMAN'));
    await modifyAppend(docGuid, 'CHAT-AGENT');
    killSessions();

    const modify = toolRegistry.getTool('modify');
    const otherScript = `
export default function edit(doc) {
  const t = doc.get(0).get(0);
  t.insert(t.length, ' OTHER-AGENT');
}`;
    const om = await modify.handler({ docGuid, script: otherScript }, otherAgentToken);
    expect(om.changed).toBe(true);
    agentPresence.clearUserSessions(testUserId);

    // The OTHER agent's undo reverts ONLY its own edit...
    let r = await toolRegistry.executeTool('undo', { docGuid }, otherAgentToken);
    expect(r.undone).toBe(true);
    let text = await dbText(docGuid);
    expect(text).not.toContain('OTHER-AGENT');
    expect(text).toContain('CHAT-AGENT'); // chat agent's edit untouched
    expect(text).toContain('HUMAN'); // human edit untouched

    // ...and with its own edit undone, it has nothing else to undo — it can
    // never step onto the chat agent's or the human's rows.
    r = await toolRegistry.executeTool('undo', { docGuid }, otherAgentToken);
    expect(r.undone).toBe(false);

    // The chat agent's own stack is intact and scoped the same way.
    r = await toolRegistry.executeTool('undo', { docGuid }, mockAgentToken);
    expect(r.undone).toBe(true);
    text = await dbText(docGuid);
    expect(text).not.toContain('CHAT-AGENT');
    expect(text).toContain('HUMAN');
  });

  test('viewer-role token is refused on undo and redo (FR-025) — with zero sessions created', async () => {
    // A second user with only viewer access.
    const v = await pool.query(
      `INSERT INTO users (google_id, name, email, picture) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['g-viewer-' + Date.now(), 'V', 'viewer-' + Date.now() + '@e.com', 'x'],
    );
    const viewerId = v.rows[0].id;
    const viewerToken = {
      userId: viewerId, agentId: 'viewer-agent', agentName: 'Viewer Agent',
      scopes: ['documents:read', 'documents:write'], rawToken: 'viewer-' + Date.now(),
    };
    const docGuid = await createDoc('US4 viewer refused');
    await pool.query(
      `INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1,$2,'viewer')`,
      [docGuid, viewerId]
    );

    const before = agentPresence._sessionsByKey.size;
    await expect(toolRegistry.executeTool('undo', { docGuid }, viewerToken))
      .rejects.toThrow(/editor access/);
    await expect(toolRegistry.executeTool('redo', { docGuid }, viewerToken))
      .rejects.toThrow(/editor access/);
    expect(agentPresence._sessionsByKey.size).toBe(before);

    await pool.query('DELETE FROM users WHERE id = $1', [viewerId]);
  });

  test('surface parity: the same sequence through MCP tools and through the chat endpoints yields identical states (SC-008)', async () => {
    const request = require('supertest');
    const express = require('express');
    const app = express();
    app.use(express.json());
    const makeHandler = (toolName) => async (req, res) => {
      const result = await toolRegistry.executeTool(toolName, { docGuid: req.params.docId }, mockAgentToken);
      res.json(result);
    };
    app.post('/api/docs/:docId/undo', makeHandler('undo'));
    app.post('/api/docs/:docId/redo', makeHandler('redo'));

    const docMcp = await createDoc('US4 parity MCP');
    const docChat = await createDoc('US4 parity chat');
    for (const doc of [docMcp, docChat]) {
      await modifyAppend(doc, 'STEP-ONE');
      await modifyAppend(doc, 'STEP-TWO');
    }
    killSessions();

    // Same sequence: undo, undo, redo.
    await toolRegistry.executeTool('undo', { docGuid: docMcp }, mockAgentToken);
    await toolRegistry.executeTool('undo', { docGuid: docMcp }, mockAgentToken);
    await toolRegistry.executeTool('redo', { docGuid: docMcp }, mockAgentToken);

    await request(app).post(`/api/docs/${docChat}/undo`).send({});
    await request(app).post(`/api/docs/${docChat}/undo`).send({});
    await request(app).post(`/api/docs/${docChat}/redo`).send({});

    const mcpText = await dbText(docMcp);
    const chatText = await dbText(docChat);
    expect(mcpText).toBe(chatText);
    expect(mcpText).toBe('<paragraph>Original text. STEP-ONE</paragraph>');
  });
});
