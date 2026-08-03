/**
 * Protocol-level end-to-end for the sync-protocol edit gate (feature 038, FR-008).
 *
 * A unit test on `classifyFrame` cannot prove the security property — the claim
 * is about bytes on a socket reaching (or not reaching) `Y.applyUpdate` and the
 * `yjs_updates` log. So this suite stands up a real mini-server (the harness
 * pattern of __tests__/integration/collaboration.test.js), installs the REAL
 * gate from `server/ws-edit-gate.js` exactly as production does, wires a
 * production-shaped bindState persistence listener (parseOrigin -> viaSync ->
 * storeUpdate), and speaks raw hand-crafted frames at it (the frame-crafting
 * pattern of server/__tests__/attribution-bug.test.js).
 *
 * The one thing this file cannot check from inside — that server/index.js really
 * installs this gate rather than a private copy — is pinned structurally by the
 * C1 guard at the bottom of server/__tests__/ws-edit-gate.test.js.
 */
const WebSocket = require('ws');
const express = require('express');
const crypto = require('crypto');
const Y = require('yjs');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const syncProtocol = require('y-protocols/dist/sync.cjs');
const { setupWSConnection, setPersistence, getYDoc } = require('y-websocket/bin/utils');

const { createPersistence, createPool, createTestUser, cleanupTestUser } = require('../../server/__tests__/helpers/db');
const { parseOrigin, ORIGIN_DB_LOAD } = require('../../server/origin');
const {
  MESSAGE_SYNC,
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  installGate,
  viaSyncFromOrigin,
} = require('../../server/ws-edit-gate');

const extractDocGuid = (docName) => (docName.startsWith('s/') ? docName.slice(2) : docName);

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` returns truthy, or throw. Persistence is asynchronous. */
async function waitFor(fn, { timeout = 4000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timeout waiting for ${label}`);
    await tick(20);
  }
}

// ─── frame crafting (raw wire bytes, no provider) ────────────────────────────

function encodeSyncFrame(syncType, payload) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, syncType);
  encoding.writeVarUint8Array(encoder, payload);
  return Buffer.from(encoding.toUint8Array(encoder));
}

/** A step2 frame carrying the full state of `doc` — content the server lacks. */
const step2FrameFrom = (doc) => encodeSyncFrame(SYNC_STEP2, Y.encodeStateAsUpdate(doc));

/** An update frame carrying `update` bytes. */
const updateFrame = (update) => encodeSyncFrame(SYNC_UPDATE, update);

/** A step1 frame (read-only state-vector request) — never an edit. */
const step1FrameFrom = (doc) => encodeSyncFrame(SYNC_STEP1, Y.encodeStateVector(doc));

/** Build a private doc holding text the server has never seen. */
function docWithParagraph(text) {
  const doc = new Y.Doc();
  const fragment = doc.get('default', Y.XmlFragment);
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  fragment.insert(0, [p]);
  return doc;
}

/** The server-side shared doc's XML, as the source of truth for "did it apply". */
const serverXml = (docGuid) => getYDoc(`s/${docGuid}`, true).get('default', Y.XmlFragment).toString();

// ─── mini-server ─────────────────────────────────────────────────────────────

describe('Step2 viewer block (protocol-level)', () => {
  let server;
  let wss;
  let persistence;
  let pool;
  let port;
  let viewerUserId;
  let editorUserId;

  /** Role for the NEXT connection, keyed by the `role` query param. */
  const perfEvents = [];
  const storeCalls = [];

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    await persistence._init();

    viewerUserId = await createTestUser(pool, `038-viewer-${crypto.randomUUID()}@test.local`);
    editorUserId = await createTestUser(pool, `038-editor-${crypto.randomUUID()}@test.local`);

    setPersistence({
      // Production-shaped bindState: attach the update listener FIRST (y-websocket
      // does not await bindState), skip sentinel origins, read the step2 channel
      // marker off the origin, thread it into storeUpdate.
      bindState: async (docName, ydoc) => {
        const docGuid = extractDocGuid(docName);

        ydoc.on('update', (update, origin) => {
          const parsed = parseOrigin(origin);
          if (!parsed) return;
          const { userId, agentName } = parsed;

          // FR-010/FR-012 — computed AFTER the sentinel early-return, exactly as
          // server/index.js does it.
          const viaSync = viaSyncFromOrigin(origin);

          const p = persistence
            .storeUpdate(docGuid, update, userId, agentName, null, null, { meaningful: null, viaSync })
            .catch((err) => { console.error('[test bindState] persist failed:', err.message); });
          storeCalls.push(p);
        });

        try {
          const persisted = await persistence.getYDoc(docGuid);
          Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persisted), ORIGIN_DB_LOAD);
        } catch { /* new document */ }
        // Mirrors the real createBindState's completion mark, which the 048
        // bind-readiness gate in updateDocument waits on.
        ydoc._bindComplete = true;
      },
      writeState: async () => {},
      provider: persistence,
    });

    const app = express();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        port = server.address().port;
        wss = new WebSocket.Server({ server });

        wss.on('connection', (ws, req) => {
          const url = new URL(req.url, 'http://localhost');
          const role = url.searchParams.get('role') || 'viewer';
          const userId = url.searchParams.get('userId') || null;
          const docId = extractDocGuid(req.url.slice(1).split('?')[0]);

          // Attribution, exactly as production sets it (y-websocket passes ws as
          // the transaction origin).
          ws.userId = userId;
          ws.agentName = null;

          let currentCanEdit = role === 'editor' || role === 'owner';

          // THE REAL GATE, installed the real way.
          installGate(ws, {
            canEdit: () => currentCanEdit,
            onBlocked: (event) => {
              perfEvents.push({ event, userId, docId, role });
            },
          });

          setupWSConnection(ws, req, { gc: true });
        });

        resolve();
      });
    });
  });

  afterAll(async () => {
    await Promise.allSettled(storeCalls);
    await new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    await tick(50);
    await cleanupTestUser(pool, viewerUserId);
    await cleanupTestUser(pool, editorUserId);
    await pool.end();
    await persistence.destroy();
  });

  beforeEach(() => {
    perfEvents.length = 0;
  });

  // ── helpers bound to the running server ────────────────────────────────────

  /**
   * Open a raw connection. Nothing is auto-replied: the caller controls exactly
   * which bytes hit the wire, so "the connection's FIRST frame" means it.
   */
  async function connect(docGuid, role, userId) {
    const ws = new WebSocket(`ws://localhost:${port}/s/${docGuid}?role=${role}&userId=${userId}`);
    const received = [];
    /** A client-side doc fed by whatever the server sends us (read path). */
    const clientDoc = new Y.Doc();

    ws.on('message', (data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      received.push(buffer);
      try {
        const decoder = decoding.createDecoder(buffer);
        if (decoding.readVarUint(decoder) === MESSAGE_SYNC) {
          syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), clientDoc, 'server');
        }
      } catch { /* not a sync frame we model */ }
    });

    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    // Let the server's own step1/awareness land before the caller speaks.
    await tick(50);
    return { ws, received, clientDoc };
  }

  const rowsFor = async (docGuid) => (
    await pool.query('SELECT clock, user_id, agent_name, via_sync FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock', [docGuid])
  ).rows;

  // ── US1: the security property ─────────────────────────────────────────────

  describe('viewer role', () => {
    test('a step2 frame carrying new content is dropped: no doc change, no row, one WS_STEP2_BLOCKED, socket stays open', async () => {
      const docGuid = crypto.randomUUID();
      const { ws, clientDoc } = await connect(docGuid, 'viewer', viewerUserId);

      try {
        const xmlBefore = serverXml(docGuid);
        expect(await rowsFor(docGuid)).toHaveLength(0);

        // A viewer's forged catch-up reply, carrying content the server lacks.
        const smuggled = docWithParagraph('SMUGGLED BY VIEWER');
        ws.send(step2FrameFrom(smuggled));
        await tick(150);

        // 1. The document never changed.
        expect(serverXml(docGuid)).toBe(xmlBefore);
        expect(serverXml(docGuid)).not.toContain('SMUGGLED BY VIEWER');

        // 2. Nothing was persisted.
        expect(await rowsFor(docGuid)).toHaveLength(0);

        // 3. Exactly one blocked event, with the identifying payload.
        const blocked = perfEvents.filter((e) => e.event === 'WS_STEP2_BLOCKED');
        expect(blocked).toHaveLength(1);
        expect(blocked[0]).toMatchObject({ userId: viewerUserId, docId: docGuid, role: 'viewer' });
        expect(perfEvents.filter((e) => e.event === 'WS_EDIT_BLOCKED')).toHaveLength(0);

        // 4. The connection stays open (D4 — dropped frame, not a disconnect).
        expect(ws.readyState).toBe(WebSocket.OPEN);

        // 5. ...and still syncs downstream: an editor's edit reaches the viewer.
        const editor = await connect(docGuid, 'editor', editorUserId);
        try {
          const authored = docWithParagraph('EDITOR CONTENT');
          editor.ws.send(step2FrameFrom(authored));
          await waitFor(() => serverXml(docGuid).includes('EDITOR CONTENT'), { label: 'editor content applied' });
          await waitFor(
            () => clientDoc.get('default', Y.XmlFragment).toString().includes('EDITOR CONTENT'),
            { label: 'viewer receives the editor edit' }
          );
        } finally {
          editor.ws.close();
        }
      } finally {
        ws.close();
      }
    });

    test('a plain update frame is still dropped with WS_EDIT_BLOCKED (unchanged behavior)', async () => {
      const docGuid = crypto.randomUUID();
      const { ws } = await connect(docGuid, 'viewer', viewerUserId);

      try {
        const smuggled = docWithParagraph('SMUGGLED VIA UPDATE');
        ws.send(updateFrame(Y.encodeStateAsUpdate(smuggled)));
        await tick(150);

        expect(serverXml(docGuid)).not.toContain('SMUGGLED VIA UPDATE');
        expect(await rowsFor(docGuid)).toHaveLength(0);
        expect(perfEvents.filter((e) => e.event === 'WS_EDIT_BLOCKED')).toHaveLength(1);
        expect(perfEvents.filter((e) => e.event === 'WS_STEP2_BLOCKED')).toHaveLength(0);
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        ws.close();
      }
    });

    test('step1 from a viewer is answered normally — the read path is untouched (FR-004)', async () => {
      const docGuid = crypto.randomUUID();

      // Seed content as an editor so there is something to read back.
      const editor = await connect(docGuid, 'editor', editorUserId);
      editor.ws.send(step2FrameFrom(docWithParagraph('READABLE CONTENT')));
      await waitFor(() => serverXml(docGuid).includes('READABLE CONTENT'), { label: 'seed content' });
      editor.ws.close();

      const { ws, clientDoc } = await connect(docGuid, 'viewer', viewerUserId);
      try {
        ws.send(step1FrameFrom(new Y.Doc()));
        await waitFor(
          () => clientDoc.get('default', Y.XmlFragment).toString().includes('READABLE CONTENT'),
          { label: 'viewer reads the document' }
        );
        expect(perfEvents.filter((e) => e.event === 'WS_STEP2_BLOCKED')).toHaveLength(0);
      } finally {
        ws.close();
      }
    });
  });

  describe('editor role', () => {
    test('the same step2 frame applies and persists exactly one attributed row', async () => {
      const docGuid = crypto.randomUUID();
      const { ws } = await connect(docGuid, 'editor', editorUserId);

      try {
        expect(await rowsFor(docGuid)).toHaveLength(0);

        const authored = docWithParagraph('OFFLINE EDIT RESUPPLIED');
        ws.send(step2FrameFrom(authored));

        await waitFor(() => serverXml(docGuid).includes('OFFLINE EDIT RESUPPLIED'), { label: 'content applied' });
        const rows = await waitFor(async () => {
          const r = await rowsFor(docGuid);
          return r.length > 0 ? r : null;
        }, { label: 'the row to persist' });

        expect(rows).toHaveLength(1);
        expect(rows[0].user_id).toBe(editorUserId);
        expect(rows[0].agent_name).toBe(null);
        expect(perfEvents).toHaveLength(0);
      } finally {
        ws.close();
      }
    });
  });

  // ── US2: the channel marker, end to end (SC-003) ──────────────────────────

  describe('via_sync flag window', () => {
    test('a step2 row is flagged; a live update on the SAME connection right after is not', async () => {
      const docGuid = crypto.randomUUID();
      const { ws } = await connect(docGuid, 'editor', editorUserId);

      try {
        // 1. Reconnect catch-up: content the editor authored while offline.
        const offline = docWithParagraph('AUTHORED OFFLINE');
        ws.send(step2FrameFrom(offline));
        await waitFor(async () => (await rowsFor(docGuid)).length >= 1, { label: 'the step2 row' });

        // 2. A live keystroke immediately afterwards, on the same socket. Its
        //    update must NOT inherit the step2 window — the flag is cleared in a
        //    finally the moment the frame finishes applying.
        const svAfter = Y.encodeStateVector(offline);
        offline.get('default', Y.XmlFragment).get(0).get(0).insert(0, 'LIVE ');
        ws.send(updateFrame(Y.encodeStateAsUpdate(offline, svAfter)));

        const rows = await waitFor(async () => {
          const r = await rowsFor(docGuid);
          return r.length >= 2 ? r : null;
        }, { label: 'the live-edit row' });

        expect(rows).toHaveLength(2);

        // The catch-up row: flagged, attribution UNCHANGED (via_sync records the
        // channel, not a verdict on authorship — this really is the editor's work).
        expect(rows[0].via_sync).toBe(true);
        expect(rows[0].user_id).toBe(editorUserId);

        // The live row: never flagged. A leaking flag would mark every keystroke
        // after a reconnect as relayed and quietly disable undo over them.
        expect(rows[1].via_sync).toBe(null);
        expect(rows[1].user_id).toBe(editorUserId);
      } finally {
        ws.close();
      }
    });

    test('a second step2 on the same connection gets its own flagged window', async () => {
      const docGuid = crypto.randomUUID();
      const { ws } = await connect(docGuid, 'editor', editorUserId);

      try {
        const first = docWithParagraph('FIRST CATCHUP');
        ws.send(step2FrameFrom(first));
        await waitFor(async () => (await rowsFor(docGuid)).length >= 1, { label: 'first step2 row' });

        // Interleaved live edit (unflagged), then a second catch-up (flagged).
        const sv = Y.encodeStateVector(first);
        first.get('default', Y.XmlFragment).get(0).get(0).insert(0, 'LIVE ');
        ws.send(updateFrame(Y.encodeStateAsUpdate(first, sv)));
        await waitFor(async () => (await rowsFor(docGuid)).length >= 2, { label: 'live row' });

        const second = docWithParagraph('SECOND CATCHUP');
        ws.send(step2FrameFrom(second));

        const rows = await waitFor(async () => {
          const r = await rowsFor(docGuid);
          return r.length >= 3 ? r : null;
        }, { label: 'second step2 row' });

        expect(rows.map((r) => r.via_sync)).toEqual([true, null, true]);
      } finally {
        ws.close();
      }
    });

    test('an empty-diff step2 produces no row and no error', async () => {
      const docGuid = crypto.randomUUID();
      const { ws } = await connect(docGuid, 'editor', editorUserId);

      try {
        // Seed, then re-send the very same state: Yjs has nothing to apply, so
        // no update event fires and nothing is persisted.
        const doc = docWithParagraph('ALREADY KNOWN');
        ws.send(step2FrameFrom(doc));
        await waitFor(async () => (await rowsFor(docGuid)).length >= 1, { label: 'seed row' });
        const before = await rowsFor(docGuid);

        ws.send(step2FrameFrom(doc));
        await tick(200);

        expect(await rowsFor(docGuid)).toHaveLength(before.length);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        expect(perfEvents).toHaveLength(0);
      } finally {
        ws.close();
      }
    });

    test('a blocked viewer step2 leaves no flag behind for anyone', async () => {
      const docGuid = crypto.randomUUID();
      const viewer = await connect(docGuid, 'viewer', viewerUserId);
      const editor = await connect(docGuid, 'editor', editorUserId);

      try {
        viewer.ws.send(step2FrameFrom(docWithParagraph('BLOCKED')));
        await tick(100);

        // The editor's ordinary live edit is unaffected and unflagged.
        const doc = docWithParagraph('EDITOR LIVE EDIT');
        editor.ws.send(updateFrame(Y.encodeStateAsUpdate(doc)));

        const rows = await waitFor(async () => {
          const r = await rowsFor(docGuid);
          return r.length >= 1 ? r : null;
        }, { label: 'the editor row' });

        expect(rows).toHaveLength(1);
        expect(rows[0].via_sync).toBe(null);
        expect(rows[0].user_id).toBe(editorUserId);
      } finally {
        viewer.ws.close();
        editor.ws.close();
      }
    });
  });
});
