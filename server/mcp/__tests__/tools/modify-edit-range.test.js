/**
 * modify's durable edit identifier (feature 016, FR-001..004, RBD-1/RBD-8).
 *
 * Real tool handler + real WS session against the test DB, with a bindState
 * mirroring the production per-update persistence listener (attributed rows).
 * The modify result must carry `editRange` selecting exactly the call's rows —
 * recorded only after the rows are durably readable — while the existing
 * `clock` field keeps its pre-edit-baseline meaning. The result object is what
 * the chat layer persists verbatim as the tool part's output, so asserting
 * `editRange` on it covers the part-level record half of FR-002.
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

const AGENT_NAME = 'Squire Docs Assistant';
const mockAgentToken = {
  userId: null, agentId: 'in-app-chat', agentName: AGENT_NAME,
  scopes: ['documents:read', 'documents:write'], rawToken: null,
};

describe('modify editRange recording', () => {
  let pool, persistence, httpServer, wss, testUserId;

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    const extractDocGuid = (n) => (n.startsWith('s/') ? n.slice(2) : n);

    // Mirror the production bindState: per-update persistence with attribution
    // taken from the transaction origin (the ws conn for client updates).
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
        // Mirrors the real createBindState's completion mark, which the 048
        // bind-readiness gate in updateDocument waits on.
        ydoc._bindComplete = true;
      },
      writeState: async () => {},
    });
    documents.init(pool);
    documentService.init(getYDoc, extractDocGuid);
    toolRegistry.init(persistence);
    agentPresence.init(persistence);

    httpServer = http.createServer();
    wss = new WebSocket.Server({ server: httpServer, verifyClient: () => true });
    wss.on('connection', (ws, req) => {
      // Mirror production: the agent's authenticated conn carries its identity,
      // so updates applied with origin = conn attribute to (userId, agentName).
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
      ['g-er-' + Date.now(), 'T', 'edit-range-' + Date.now() + '@e.com', 'x'],
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

  async function createDoc(title) {
    const ydoc = new Y.Doc();
    const frag = ydoc.get('default', Y.XmlFragment);
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, 'Original text.');
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

  test('result carries editRange selecting exactly the call\'s durable rows; clock stays the pre-edit baseline; agent_edits row inserted', async () => {
    const docGuid = await createDoc('EditRange basic');
    const modify = toolRegistry.getTool('modify');
    const script = `
export default function edit(doc) {
  const t = doc.get(0).get(0);
  t.insert(t.length, ' EDITED');
}`;
    const result = await modify.handler({ docGuid, script }, mockAgentToken);
    expect(result.changed).toBe(true);

    // RBD-1: the existing clock field is STILL the pre-edit baseline (0).
    expect(result.clock).toBe(0);

    // FR-001/002: an explicit durable range is returned.
    expect(result.editRange).toBeDefined();
    const { clockStart, clockEnd } = result.editRange;
    expect(clockStart).toBeGreaterThan(0);
    expect(clockEnd).toBeGreaterThanOrEqual(clockStart);

    // FR-004: every row in the range is durably readable NOW, attributed to
    // the acting identity, and replaying baseline+range reproduces the edit.
    const { rows } = await pool.query(
      `SELECT clock, user_id, agent_name FROM yjs_updates
       WHERE doc_guid = $1 AND clock >= $2 AND clock <= $3 ORDER BY clock`,
      [docGuid, clockStart, clockEnd]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.user_id).toBe(testUserId);
      expect(r.agent_name).toBe(AGENT_NAME);
    }
    // No identity rows outside the range beyond the baseline (exactly the call's rows).
    const outside = await pool.query(
      `SELECT count(*)::int AS n FROM yjs_updates
       WHERE doc_guid = $1 AND clock > 0 AND (clock < $2 OR clock > $3)`,
      [docGuid, clockStart, clockEnd]
    );
    expect(outside.rows[0].n).toBe(0);

    // The agent_edits record exists, active, with the same range.
    const rec = await pool.query(
      `SELECT * FROM agent_edits WHERE doc_guid = $1`, [docGuid]
    );
    expect(rec.rows.length).toBe(1);
    expect(rec.rows[0].state).toBe('active');
    expect(rec.rows[0].edit_clock_start).toBe(clockStart);
    expect(rec.rows[0].edit_clock_end).toBe(clockEnd);
    expect(rec.rows[0].user_id).toBe(testUserId);
    expect(rec.rows[0].agent_name).toBe(AGENT_NAME);
  });

  test('multi-update edit: a sanitization-pass mutation lands inside the recorded range', async () => {
    const docGuid = await createDoc('EditRange sanitizer');
    const modify = toolRegistry.getTool('modify');
    // The script inserts a link with a blocked protocol; the post-script link
    // sanitizer strips the mark in a SECOND mutation of the same call. The
    // recorded range must span script + sanitization rows (spec Edge
    // "Multi-update edits").
    const script = `
export default function edit(doc) {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, 'dangerous link', { link: { href: 'javascript:alert(1)' } });
  p.insert(0, [t]);
  doc.push([p]);
}`;
    const result = await modify.handler({ docGuid, script }, mockAgentToken);
    expect(result.changed).toBe(true);
    expect(result.linkErrors && result.linkErrors.length).toBe(1);
    expect(result.editRange).toBeDefined();

    const { clockStart, clockEnd } = result.editRange;
    // Script row + sanitizer row: the range covers more than one row.
    expect(clockEnd).toBeGreaterThan(clockStart);

    // Replaying the log INCLUDING the range must show the sanitized result
    // (text kept, link mark gone) — i.e. the sanitizer row is in the range.
    const all = await pool.query(
      `SELECT update_data FROM yjs_updates WHERE doc_guid = $1 AND clock <= $2 ORDER BY clock`,
      [docGuid, clockEnd]
    );
    const replay = new Y.Doc();
    for (const r of all.rows) Y.applyUpdate(replay, new Uint8Array(r.update_data));
    const xml = replay.get('default', Y.XmlFragment).toString();
    expect(xml).toContain('dangerous link');
    expect(xml).not.toContain('javascript:');
  });

  test('changed:false records nothing — no editRange, no agent_edits row', async () => {
    const docGuid = await createDoc('EditRange noop');
    const modify = toolRegistry.getTool('modify');
    const script = `
export default function edit(doc) {
  // touches nothing
}`;
    const result = await modify.handler({ docGuid, script }, mockAgentToken);
    expect(result.changed).toBe(false);
    expect(result.editRange).toBeUndefined();
    expect(result.editRangePending).toBeUndefined();

    const rec = await pool.query('SELECT count(*)::int AS n FROM agent_edits WHERE doc_guid = $1', [docGuid]);
    expect(rec.rows[0].n).toBe(0);
  });

  test('two successive modify calls record two separate ranges/rows', async () => {
    const docGuid = await createDoc('EditRange successive');
    const modify = toolRegistry.getTool('modify');
    const mk = (txt) => `
export default function edit(doc) {
  const t = doc.get(0).get(0);
  t.insert(t.length, ' ${txt}');
}`;
    const r1 = await modify.handler({ docGuid, script: mk('ONE') }, mockAgentToken);
    const r2 = await modify.handler({ docGuid, script: mk('TWO') }, mockAgentToken);
    expect(r1.editRange).toBeDefined();
    expect(r2.editRange).toBeDefined();
    expect(r2.editRange.clockStart).toBeGreaterThan(r1.editRange.clockEnd);

    const rec = await pool.query(
      'SELECT edit_clock_start FROM agent_edits WHERE doc_guid = $1 ORDER BY edit_clock_start',
      [docGuid]
    );
    expect(rec.rows.length).toBe(2);
  });
});
