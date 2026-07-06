/**
 * modify tool conflict-detection tests.
 *
 * Specifically covers the gate added so that non-content foreign updates
 * (e.g., title writes to the `meta` map, prosemirror schema normalization,
 * IndexedDB-replayed updates) no longer trigger a false-positive `conflict`.
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

describe('modify conflict detection (content-aware gating)', () => {
  let testUserId;
  let httpServer;
  let wss;
  const createdDocIds = [];

  beforeAll(async () => {
    // Wire y-websocket persistence with a per-update listener so each Yjs
    // update lands in `yjs_updates` tagged with its origin — that's what the
    // conflict check inspects.
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
      },
      writeState: async () => {},
      provider: persistence,
    });

    documentService.init(getYDoc, extractDocGuid);
    documents.init(pool);
    toolRegistry.init(persistence);
    agentPresence.init(persistence);

    // Create the test user first so we can stamp each WS connection with its
    // identity — production does this in the auth middleware (server/index.js
    // sets ws.userId / ws.agentName before setupWSConnection). Without that
    // tagging, sandbox-origin updates that flow back through the WS would be
    // persisted with null user_id and look "foreign" to the agent itself.
    const u = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-modify-conflict-test', 'modify-conflict@test.local', 'Modify Conflict Test User')
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

  // Mint a foreign update on the agent's in-memory ydoc with an origin that
  // looks like the human typing directly (same user, null agentName) so the
  // conflict-check classifies it as foreign.
  function injectForeignUpdate(docGuid, mutateFn) {
    const ydoc = documentService.getSharedDoc(docGuid);
    const origin = { userId: testUserId, agentName: null };
    ydoc.transact(() => mutateFn(ydoc), origin);
  }

  async function flushPersistence() {
    // Updates persist via the on('update') listener — give them a tick.
    await new Promise((r) => setTimeout(r, 150));
    await Promise.all(pendingOperations);
  }

  async function seedDoc(title) {
    const create = toolRegistry.getTool('create_document');
    const modify = toolRegistry.getTool('modify');
    const created = await create.handler({ title }, agentToken());
    createdDocIds.push(created.docGuid);
    await flushPersistence();
    await pool.query(
      `INSERT INTO document_shares (doc_id, user_id, role)
       VALUES ($1, $2, 'owner') ON CONFLICT (doc_id, user_id) DO UPDATE SET role = 'owner'`,
      [created.docGuid, testUserId]
    );
    // Add some initial content so foreign updates have something to differ from.
    const seedResult = await modify.handler({
      docGuid: created.docGuid,
      script: `
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'seed');
          p.insert(0, [t]);
          doc.insert(0, [p]);
        }
      `,
    }, agentToken());
    await flushPersistence();
    return { docGuid: created.docGuid, baseClock: seedResult.clock };
  }

  test('foreign update that only touches `meta` (title) does NOT trigger conflict', async () => {
    const modify = toolRegistry.getTool('modify');
    const { docGuid, baseClock } = await seedDoc('Meta-Only Conflict Test');

    // Sam (the human, agentName=null) renames the doc — `meta.title` only.
    injectForeignUpdate(docGuid, (ydoc) => {
      ydoc.getMap('meta').set('title', 'Renamed By Sam');
    });
    await flushPersistence();

    const result = await modify.handler({
      docGuid,
      _baseClock: baseClock,
      script: `
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'agent-add');
          p.insert(0, [t]);
          doc.insert(doc.length, [p]);
        }
      `,
    }, agentToken());

    expect(result.conflict).toBeUndefined();
    expect(result.changed).toBe(true);
  }, 30000);

  test('foreign update that adds a paragraph DOES trigger conflict', async () => {
    const modify = toolRegistry.getTool('modify');
    const { docGuid, baseClock } = await seedDoc('Content Conflict Test');

    injectForeignUpdate(docGuid, (ydoc) => {
      const frag = ydoc.get('default', Y.XmlFragment);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'sam typed this');
      p.insert(0, [t]);
      frag.insert(frag.length, [p]);
    });
    await flushPersistence();

    const result = await modify.handler({
      docGuid,
      _baseClock: baseClock,
      script: `
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'agent-overwrite');
          p.insert(0, [t]);
          doc.insert(doc.length, [p]);
        }
      `,
    }, agentToken());

    expect(result.conflict).toBe(true);
    expect(result.editedBy).toEqual(expect.arrayContaining(['Modify Conflict Test User']));
  }, 30000);

  test('foreign update that touches BOTH meta and content triggers conflict', async () => {
    const modify = toolRegistry.getTool('modify');
    const { docGuid, baseClock } = await seedDoc('Mixed Conflict Test');

    injectForeignUpdate(docGuid, (ydoc) => {
      ydoc.getMap('meta').set('title', 'Sam-Renamed');
      const frag = ydoc.get('default', Y.XmlFragment);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'sam also typed');
      p.insert(0, [t]);
      frag.insert(frag.length, [p]);
    });
    await flushPersistence();

    const result = await modify.handler({
      docGuid,
      _baseClock: baseClock,
      script: `export default function edit(doc) {}`,
    }, agentToken());

    expect(result.conflict).toBe(true);
  }, 30000);

  test('same-author (agent re-running) does NOT trigger conflict', async () => {
    const modify = toolRegistry.getTool('modify');
    const { docGuid, baseClock } = await seedDoc('Self Author Test');

    // The agent itself adds a paragraph — its (userId, agentName) pair matches
    // the token, so it's never "foreign," regardless of content change.
    const second = await modify.handler({
      docGuid,
      _baseClock: baseClock,
      script: `
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'agent self');
          p.insert(0, [t]);
          doc.insert(doc.length, [p]);
        }
      `,
    }, agentToken());

    expect(second.conflict).toBeUndefined();
    expect(second.changed).toBe(true);
  }, 30000);

  test('omitted _baseClock skips the guard entirely (external callers)', async () => {
    const modify = toolRegistry.getTool('modify');
    const { docGuid } = await seedDoc('No BaseClock Test');

    // Foreign content edit, but caller (e.g. an external MCP client) didn't
    // pass _baseClock — guard should be a no-op.
    injectForeignUpdate(docGuid, (ydoc) => {
      const frag = ydoc.get('default', Y.XmlFragment);
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'sam typed outside conversation');
      p.insert(0, [t]);
      frag.insert(frag.length, [p]);
    });
    await flushPersistence();

    const result = await modify.handler({
      docGuid,
      script: `
        export default function edit(doc) {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, 'agent without baseclock');
          p.insert(0, [t]);
          doc.insert(doc.length, [p]);
        }
      `,
    }, agentToken());

    expect(result.conflict).toBeUndefined();
    expect(result.changed).toBe(true);
  }, 30000);

  test('runtime script errors include the get_tool_documentation hint', async () => {
    const modify = toolRegistry.getTool('modify');
    const { docGuid } = await seedDoc('Runtime Error Hint Test');

    let error;
    try {
      await modify.handler({
        docGuid,
        script: `
          export default function edit(doc) {
            throw new Error('intentional test failure');
          }
        `,
      }, agentToken());
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(error.message).toMatch(/Script execution failed/);
    expect(error.message).toContain('intentional test failure');
    // The truncated-description hint is appended exactly once
    expect(error.message.split('get_tool_documentation').length - 1).toBe(1);
  }, 30000);
});
