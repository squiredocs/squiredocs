/**
 * Feature 057 FR-011 / SC-003 — the modify livelock dissolves via
 * reconciliation ALONE.
 *
 * THE LIVELOCK (spec §"Second-order effect"): `modify`'s conflict gate rebuilds
 * the expected document from Postgres and compares it against the CURRENT
 * content, which comes from this pod's memory. When that memory is missing rows
 * the log already has — one dropped fan-out message — the two can never match.
 * Every retry recomputes the same divergence and refuses again, forever, on
 * that pod. Nothing in the system could break the cycle, and the agent had no
 * remedy: the advice it is given is "retry", and retry is exactly what does not
 * work.
 *
 * Production reaches this state on the ordinary path. Two replicas sit behind a
 * non-sticky ingress, and the chat layer carries the highest clock it has
 * observed across a turn, so a clock learned from a current pod travels with the
 * agent to a diverged one.
 *
 * WHAT THIS PROVES: the gate is not the bug and is not touched. Applying the
 * rows the pod was missing is sufficient, and the same refused `modify` then
 * succeeds on the first attempt.
 */
const fs = require('fs');
const path = require('path');
const Y = require('yjs');
const WebSocket = require('ws');
const http = require('http');
const { createPool, createPersistence } = require('./helpers/db');
const { setupWSConnection, setPersistence, getYDoc, docs } = require('y-websocket/bin/utils');
const { ORIGIN_DB_LOAD, parseOrigin } = require('../origin');
const documents = require('../documents');
const documentService = require('../document-service');
const toolRegistry = require('../mcp/tools/index');
const agentPresence = require('../mcp/agent-presence');
const { reconcileDoc } = require('../collab-reconcile');

const pool = createPool();
const persistence = createPersistence();
const pendingOperations = [];

const extractDocGuid = (docName) => (docName.startsWith('s/') ? docName.slice(2) : docName);

describe('057 FR-011 — the modify livelock dissolves after reconciliation', () => {
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
        const { maxClock } = await persistence.getClockRange(docGuid);
        ydoc._verifiedClock = maxClock ?? -1;
        ydoc._bindComplete = true;
      },
      writeState: async () => {},
      provider: persistence,
    });

    documentService.init(getYDoc, extractDocGuid, docs);
    documents.init(pool);
    toolRegistry.init(persistence);
    agentPresence.init(persistence);

    const u = await pool.query(
      `INSERT INTO users (id, google_id, email, name)
       VALUES (uuid_generate_v4(), 'google-057-livelock', '057-livelock@test.local', '057 Livelock User')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    testUserId = u.rows[0].id;

    httpServer = http.createServer();
    wss = new WebSocket.Server({ server: httpServer, verifyClient: () => true });
    wss.on('connection', (ws, req) => {
      ws.userId = testUserId;
      ws.agentName = 'Livelock Agent';
      setupWSConnection(ws, req, { gc: false });
    });
    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        process.env.WS_PORT = httpServer.address().port;
        process.env.WS_HOST = 'localhost';
        process.env.WS_PROTOCOL = 'ws';
        resolve();
      });
    });
  }, 30000);

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
  }, 30000);

  const agentToken = () => ({
    userId: testUserId,
    agentId: 'livelock-agent',
    agentName: 'Livelock Agent',
    delegationId: 'livelock-delegation',
    scopes: ['documents:write'],
    rawToken: 'livelock-token-' + Date.now(),
  });

  const appendScript = (word) => `
    export default function edit(doc) {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, '${word}');
      p.insert(0, [t]);
      doc.insert(doc.length, [p]);
    }
  `;

  async function flushPersistence() {
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
      `INSERT INTO document_shares (doc_id, user_id, role, granted_by)
       VALUES ($1, $2, 'owner', $2) ON CONFLICT (doc_id, user_id) DO UPDATE SET role = 'owner'`,
      [created.docGuid, testUserId]
    );
    const seed = await modify.handler({ docGuid: created.docGuid, script: appendScript('seed') }, agentToken());
    await flushPersistence();
    return { docGuid: created.docGuid, baseClock: seed.clock };
  }

  /**
   * Commit a foreign edit the way ANOTHER POD would: build it on a copy
   * rebuilt from the log, persist it through a second persistence handle, and
   * never deliver it to this pod's live document. That is precisely a dropped
   * fan-out message.
   */
  async function commitElsewhereWithoutFanout(docGuid, word) {
    const remote = await persistence.getYDoc(docGuid);
    const before = Y.encodeStateVector(remote);
    remote.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, word);
      p.insert(0, [t]);
      remote.get('default', Y.XmlFragment).push([p]);
    });
    await persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(remote, before), testUserId, null);
    const { maxClock } = await persistence.getClockRange(docGuid);
    return maxClock;
  }

  /**
   * A foreign NON-CONTENT write on this pod's live doc — the human renaming the
   * document. It touches the `meta` map, never the `default` fragment.
   *
   * This is what puts the gate into its content-comparison branch: the branch
   * only runs when some row sits ABOVE the agent's baseClock, and a title sync
   * is the commonest such row. On a healthy pod it correctly waves the edit
   * through (the 023-era "meta-only is not a conflict" rule). On a DIVERGED pod
   * it is the doorway into the comparison that can never succeed — which is the
   * livelock, and why retrying is not a remedy.
   */
  function injectForeignTitleWrite(docGuid, title) {
    const ydoc = documentService.getSharedDoc(docGuid);
    ydoc.transact(() => { ydoc.getMap('meta').set('title', title); },
      { userId: testUserId, agentName: null });
  }

  test('a diverged pod refuses every retry, then succeeds after reconcileDoc alone', async () => {
    const modify = toolRegistry.getTool('modify');
    const { docGuid } = await seedDoc('057 Livelock Doc');

    // Two foreign content commits this pod never hears about.
    await commitElsewhereWithoutFanout(docGuid, 'remote-one');
    const observedClock = await commitElsewhereWithoutFanout(docGuid, 'remote-two');

    // A later title sync — the ordinary row that puts the gate into its
    // content-comparison branch. This one DID reach the pod.
    injectForeignTitleWrite(docGuid, 'Renamed While Diverged');
    await flushPersistence();

    const liveDoc = documentService.getSharedDoc(docGuid);
    const liveText = () => liveDoc.get('default', Y.XmlFragment).toString();
    expect(liveText()).not.toContain('remote-one'); // genuinely diverged

    // The agent carries a clock it learned from a CURRENT pod (non-sticky
    // ingress + the chat layer's observed-clock high-water mark), so its
    // baseClock covers rows this pod never integrated.
    const attempt = () => modify.handler(
      { docGuid, _baseClock: observedClock, script: appendScript('agent-edit') },
      agentToken()
    );

    const first = await attempt();
    expect(first.conflict).toBe(true);
    expect(first.changed).toBe(false); // refused: the edit did not land

    // THE LIVELOCK: retrying — the remedy the agent is given — changes nothing.
    const second = await attempt();
    expect(second.conflict).toBe(true);
    const third = await attempt();
    expect(third.conflict).toBe(true);

    // Reconciliation ALONE. No conflict-gate change, no manual intervention.
    const outcome = await reconcileDoc(docGuid, liveDoc, { persistence, docs });
    expect(outcome.repaired).toBe(true);
    expect(liveText()).toContain('remote-one');
    expect(liveText()).toContain('remote-two');

    // SC-003: the same modify now succeeds on the FIRST attempt.
    const afterRepair = await attempt();
    expect(afterRepair.conflict).toBeUndefined();
    expect(afterRepair.changed).toBe(true);
    await flushPersistence();
    expect(liveText()).toContain('agent-edit');
  }, 60000);

  test('the reconcile that dissolves it writes no rows of its own', async () => {
    const modify = toolRegistry.getTool('modify');
    const { docGuid } = await seedDoc('057 Livelock Rows Doc');
    const observedClock = await commitElsewhereWithoutFanout(docGuid, 'remote-only');
    injectForeignTitleWrite(docGuid, 'Renamed Too');
    await flushPersistence();

    const liveDoc = documentService.getSharedDoc(docGuid);
    const refused = await modify.handler(
      { docGuid, _baseClock: observedClock, script: appendScript('blocked') },
      agentToken()
    );
    expect(refused.conflict).toBe(true);

    const countRows = async () => Number((await pool.query(
      'SELECT COUNT(*)::int AS n FROM yjs_updates WHERE doc_guid = $1', [docGuid]
    )).rows[0].n);
    const before = await countRows();

    await reconcileDoc(docGuid, liveDoc, { persistence, docs });
    await flushPersistence();

    expect(await countRows()).toBe(before);
  }, 60000);

  test('the conflict gate itself is untouched by this feature', () => {
    // FR-011 is explicit that the livelock resolves via reconciliation with NO
    // change to the gate. If a later edit reaches for the reconciler from
    // inside modify, that claim quietly stops being true.
    const source = fs.readFileSync(
      path.join(__dirname, '../mcp/tools/modify.js'), 'utf8'
    );
    expect(source).not.toContain('collab-reconcile');
    expect(source).not.toContain('verified-clock');
    expect(source).not.toContain('_verifiedClock');
  });
});
