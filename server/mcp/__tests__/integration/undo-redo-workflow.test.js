/**
 * Integration test: modify -> undo -> redo via the MCP tools against a live
 * agent-presence session. Covers the server side of the chat "Undo edit" button,
 * which drives the assistant session's Y.UndoManager (undo/redo tools) — including
 * with a second client (the user's editor) connected to the same document.
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

const mockAgentToken = { userId: null, agentId: 'in-app-chat', agentName: 'Squire Docs Assistant', scopes: ['documents:read', 'documents:write'], rawToken: null };

describe('Undo/Redo workflow', () => {
  let pool, persistence, httpServer, wss, testUserId, testDocGuid;

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    const extractDocGuid = (n) => (n.startsWith('s/') ? n.slice(2) : n);
    setPersistence({
      bindState: async (docName, ydoc) => {
        const g = extractDocGuid(docName);
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(await persistence.getYDoc(g)));
      },
      writeState: async (docName, ydoc) => {
        await persistence.storeUpdate(extractDocGuid(docName), Y.encodeStateAsUpdate(ydoc));
      },
    });
    documents.init(pool);
    documentService.init(getYDoc, extractDocGuid);
    toolRegistry.init(persistence);
    agentPresence.init(persistence);

    httpServer = http.createServer();
    wss = new WebSocket.Server({ server: httpServer, verifyClient: () => true });
    wss.on('connection', (ws, req) => setupWSConnection(ws, req, { gc: false }));
    await new Promise((r) => httpServer.listen(0, () => {
      process.env.WS_PORT = httpServer.address().port;
      process.env.WS_HOST = 'localhost';
      process.env.WS_PROTOCOL = 'ws';
      r();
    }));

    const u = await pool.query(
      `INSERT INTO users (google_id, name, email, picture) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['g-' + Date.now(), 'T', 't-' + Date.now() + '@e.com', 'x'],
    );
    testUserId = u.rows[0].id;
    mockAgentToken.userId = testUserId;
    mockAgentToken.rawToken = 'mock-' + Date.now();

    const ydoc = new Y.Doc();
    const frag = ydoc.get('default', Y.XmlFragment);
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, 'Original text.');
    p.insert(0, [t]);
    frag.insert(0, [p]);
    const d = await pool.query(
      `INSERT INTO documents (id, title, creator_id) VALUES (uuid_generate_v4(),$1,$2) RETURNING id`,
      ['Undo/Redo Test', testUserId],
    );
    testDocGuid = d.rows[0].id;
    await pool.query(`INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1,$2,'editor')`, [testDocGuid, testUserId]);
    await pool.query(`INSERT INTO yjs_updates (doc_guid, clock, update_data, created_at) VALUES ($1,0,$2,NOW())`,
      [testDocGuid, Buffer.from(Y.encodeStateAsUpdate(ydoc))]);
  });

  afterAll(async () => {
    agentPresence.clearUserSessions(testUserId);
    await new Promise((r) => setTimeout(r, 100));
    wss.close();
    await new Promise((r) => httpServer.close(r));
    await new Promise((r) => setTimeout(r, 100));
    await pool.end();
  });

  test('modify -> undo -> redo restores the edit', async () => {
    const modify = toolRegistry.getTool('modify');
    const readDoc = toolRegistry.getTool('read_document');

    const script = `
export default function edit(doc) {
  const t = doc.get(0).get(0);
  t.insert(t.length, ' EDITED');
}`;
    const m = await modify.handler({ docGuid: testDocGuid, script }, mockAgentToken);
    console.log('[undo-redo] modify.changed =', m.changed);
    expect(m.changed).toBe(true);

    const after = await readDoc.handler({ docGuid: testDocGuid, format: 'text' }, mockAgentToken);
    console.log('[undo-redo] after modify:', JSON.stringify(after.content || after.text));

    const undo = await toolRegistry.executeTool('undo', { docGuid: testDocGuid }, mockAgentToken);
    console.log('[undo-redo] undo result:', JSON.stringify(undo));
    expect(undo.undone).toBe(true);

    const afterUndo = await readDoc.handler({ docGuid: testDocGuid, format: 'text' }, mockAgentToken);
    console.log('[undo-redo] after undo:', JSON.stringify(afterUndo.content || afterUndo.text));

    const redo = await toolRegistry.executeTool('redo', { docGuid: testDocGuid }, mockAgentToken);
    console.log('[undo-redo] redo result:', JSON.stringify(redo));

    const afterRedo = await readDoc.handler({ docGuid: testDocGuid, format: 'text' }, mockAgentToken);
    console.log('[undo-redo] after redo:', JSON.stringify(afterRedo.content || afterRedo.text));

    expect(redo.redone).toBe(true);
  });

  test('redo still works while a second client (the user editor) is connected', async () => {
    const { WebsocketProvider } = require('y-websocket');
    const modify = toolRegistry.getTool('modify');
    const readDoc = toolRegistry.getTool('read_document');

    // Simulate the user having the document open in the editor: a second Yjs
    // client connected to the same doc over the WebSocket.
    const clientDoc = new Y.Doc();
    const wsUrl = `ws://localhost:${process.env.WS_PORT}`;
    const provider = new WebsocketProvider(wsUrl, `s/${testDocGuid}`, clientDoc, { WebSocketPolyfill: WebSocket, connect: true });
    await new Promise((resolve) => {
      if (provider.synced) return resolve();
      provider.once('sync', resolve);
    });
    await new Promise((r) => setTimeout(r, 200));

    const script = `
export default function edit(doc) {
  const t = doc.get(0).get(0);
  t.insert(t.length, ' SECOND');
}`;
    const m = await modify.handler({ docGuid: testDocGuid, script }, mockAgentToken);
    expect(m.changed).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    console.log('[undo-redo] client sees after modify:', JSON.stringify(clientDoc.get('default', Y.XmlFragment).toString().slice(0, 80)));

    const undo = await toolRegistry.executeTool('undo', { docGuid: testDocGuid }, mockAgentToken);
    console.log('[undo-redo] undo:', JSON.stringify(undo));
    await new Promise((r) => setTimeout(r, 200));

    const redo = await toolRegistry.executeTool('redo', { docGuid: testDocGuid }, mockAgentToken);
    console.log('[undo-redo] redo:', JSON.stringify(redo));

    const afterRedo = await readDoc.handler({ docGuid: testDocGuid, format: 'text' }, mockAgentToken);
    console.log('[undo-redo] after redo:', JSON.stringify(afterRedo.content || afterRedo.text));

    provider.destroy();
    expect(undo.undone).toBe(true);
    expect(redo.redone).toBe(true);
  });
});
