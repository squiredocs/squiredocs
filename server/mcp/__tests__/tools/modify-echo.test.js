/**
 * modify tool echoContent tests.
 *
 * The content echo is opt-in: by default a successful modify returns
 * diff/summary/clock with contentOmitted: true, and only echoes the full
 * updated document when echoContent: true is passed (still subject to the
 * 60k-character cap).
 */

const Y = require('yjs');
const WebSocket = require('ws');
const http = require('http');
const { createPool, createPersistence } = require('../../../__tests__/helpers/db');
const { setupWSConnection, setPersistence, getYDoc } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../../../origin');
const documents = require('../../../documents');
const documentService = require('../../../document-service');
const toolRegistry = require('../../tools/index');
const agentPresence = require('../../agent-presence');

const pool = createPool();
const persistence = createPersistence();
const pendingOperations = [];

const extractDocGuid = (docName) =>
  docName.startsWith('s/') ? docName.slice(2) : docName;

const ADD_PARAGRAPH_SCRIPT = `
  export default function edit(doc) {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, 'echo test content');
    p.insert(0, [t]);
    doc.insert(doc.length, [p]);
  }
`;

describe('modify echoContent (opt-in content echo)', () => {
  let testUserId;
  let httpServer;
  let wss;
  const createdDocIds = [];

  beforeAll(async () => {
    setPersistence({
      bindState: async (docName, ydoc) => {
        const docGuid = extractDocGuid(docName);
        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          pendingOperations.push(
            persistence.storeUpdate(docGuid, update, parsed.userId, parsed.agentName)
              .catch((err) => console.error(`persist err ${docGuid}:`, err))
          );
        });
        try {
          const persisted = await persistence.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persisted), ORIGIN_DB_LOAD);
        } catch (_) { /* new doc */ }
        // Mirrors the real createBindState's completion mark, which the 048
        // bind-readiness gate in updateDocument waits on.
        ydoc._bindComplete = true;
      },
      writeState: async () => {},
      provider: persistence,
    });

    documentService.init(getYDoc, extractDocGuid);
    documents.init(pool);
    toolRegistry.init(persistence);
    agentPresence.init(persistence);

    const u = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-modify-echo-test', 'modify-echo@test.local', 'Modify Echo Test User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = u.rows[0].id;

    httpServer = http.createServer();
    wss = new WebSocket.Server({ server: httpServer, verifyClient: () => true });
    wss.on('connection', (ws, req) => {
      ws.userId = testUserId;
      ws.agentName = 'Test Agent';
      setupWSConnection(ws, req, { gc: false });
    });
    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        const port = httpServer.address().port;
        process.env.WS_PORT = port;
        process.env.WS_HOST = 'localhost';
        process.env.WS_PROTOCOL = 'ws';
        resolve();
      });
    });
  });

  afterAll(async () => {
    agentPresence.clearUserSessions(testUserId);
    await new Promise((r) => setTimeout(r, 100));
    wss.close();
    await new Promise((r) => httpServer.close(r));
    await new Promise((r) => setTimeout(r, 100));
    await Promise.all(pendingOperations);
    pendingOperations.length = 0;
    for (const docId of createdDocIds) {
      await pool.query('DELETE FROM yjs_updates WHERE doc_guid = $1', [docId]);
      await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
      await pool.query('DELETE FROM documents WHERE id = $1', [docId]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
    await pool.end();
    await persistence.destroy();
  }, 15000);

  const agentToken = () => ({
    userId: testUserId,
    agentId: 'test-agent',
    agentName: 'Test Agent',
    delegationId: 'test-delegation',
    scopes: ['documents:write'],
    rawToken: 'test-token-' + Date.now(),
  });

  async function flushPersistence() {
    await new Promise((r) => setTimeout(r, 150));
    await Promise.all(pendingOperations);
  }

  async function createDoc(title) {
    const create = toolRegistry.getTool('create_document');
    const created = await create.handler({ title }, agentToken());
    createdDocIds.push(created.docGuid);
    await flushPersistence();
    return created.docGuid;
  }

  test('default: returns diff/clock/summary but no content, with contentOmitted', async () => {
    const modify = toolRegistry.getTool('modify');
    const docGuid = await createDoc('Echo Default Test');

    const result = await modify.handler(
      { docGuid, script: ADD_PARAGRAPH_SCRIPT },
      agentToken()
    );

    expect(result.changed).toBe(true);
    expect(result.diff).toBeDefined();
    expect(typeof result.clock).toBe('number');
    expect(result.summary).toBeDefined();
    expect(result.operationCount).toBeGreaterThan(0);

    expect(result.content).toBeUndefined();
    expect(result.blockCount).toBeUndefined();
    expect(result.characterCount).toBeUndefined();
    expect(result.contentOmitted).toBe(true);
    expect(result.message).toContain('read_document');
  }, 30000);

  test('echoContent: true returns the full updated content', async () => {
    const modify = toolRegistry.getTool('modify');
    const docGuid = await createDoc('Echo Opt-In Test');

    const result = await modify.handler(
      { docGuid, script: ADD_PARAGRAPH_SCRIPT, echoContent: true },
      agentToken()
    );

    expect(result.changed).toBe(true);
    expect(result.content).toBeDefined();
    expect(result.contentOmitted).toBeUndefined();
    expect(result.blockCount).toBeGreaterThan(0);
    expect(result.characterCount).toBeGreaterThan(0);
    expect(JSON.stringify(result.content)).toContain('echo test content');
  }, 30000);

  test('echoContent: false behaves like the default', async () => {
    const modify = toolRegistry.getTool('modify');
    const docGuid = await createDoc('Echo Explicit-False Test');

    const result = await modify.handler(
      { docGuid, script: ADD_PARAGRAPH_SCRIPT, echoContent: false },
      agentToken()
    );

    expect(result.changed).toBe(true);
    expect(result.content).toBeUndefined();
    expect(result.contentOmitted).toBe(true);
  }, 30000);
});
