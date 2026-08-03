/**
 * Shared real-WebSocket collaboration harness (feature 043, contract
 * `specs/043-version-history-test-hardening/contracts/harness-contract.md`).
 *
 * Used by the US1/US2/US3/US4 end-to-end suites. It exists so those four suites
 * do not each grow their own copy of the wiring — that drift is the exact thing
 * this feature removes.
 *
 * ── THE DESIGN RULE (D10) ───────────────────────────────────────────────────
 * The harness owns TRANSPORT PLUMBING ONLY. Every *decision* — who you are,
 * whether you may edit, how a frame is classified, what gets persisted with
 * what identity — is made by the production module:
 *
 *   - identity            → server/permissions.js `extractUser` (real tokens)
 *   - document access     → server/permissions.js `can.view` (real ACL rows)
 *   - token scope         → the same `tokenMayWrite` predicate index.js uses
 *   - connection identity → server/agent-identity.js `identityFromPrincipal` (X2)
 *   - frame gating        → server/ws-edit-gate.js `installGate` (the real gate)
 *   - persistence         → server/collab-bind-state.js `createBindState` (X1)
 *
 * There is NO `?role=` / `?userId=` shortcut and no hand-written
 * `ydoc.on('update')` listener. If a scenario cannot be expressed without
 * faking a decision, the harness is wrong — report rather than fake.
 *
 * It deliberately does NOT require server/index.js: that file starts Redis,
 * cron, MCP, the search indexer and a listening server at require time.
 */
const WebSocket = require('ws');
const express = require('express');
const crypto = require('crypto');
const Y = require('yjs');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const syncProtocol = require('y-protocols/dist/sync.cjs');
const { setupWSConnection, setPersistence, getYDoc } = require('y-websocket/bin/utils');

const { createPool, createPersistence, createTestUser, cleanupTestUser, cleanupDocRows } = require('../../../server/__tests__/helpers/db');

// ── production decision-makers ───────────────────────────────────────────────
const permissions = require('../../../server/permissions');
const documents = require('../../../server/documents');
const apiTokens = require('../../../server/mcp/auth/api-tokens');
const { generateAccessToken } = require('../../../server/auth/jwt');
const { identityFromPrincipal } = require('../../../server/agent-identity');
const { createBindState, extractDocGuid } = require('../../../server/collab-bind-state');
// H7: frame constants come from the gate module. Redeclaring the numbers here
// would be a fourth mirror of the y-websocket protocol.
const {
  MESSAGE_SYNC,
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  installGate,
} = require('../../../server/ws-edit-gate');

// ── deterministic waiting (H9) ───────────────────────────────────────────────

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `fn()` returns truthy, or throw. Persistence is asynchronous, so
 * every wait on an OBSERVABLE condition goes through here. A `setTimeout` sleep
 * is permitted only to await an ABSENCE, and must say so in a comment.
 *
 * @param {() => any} fn
 * @param {{timeout?: number, label?: string}} [opts]
 */
async function waitFor(fn, { timeout = 4000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timeout waiting for ${label}`);
    await tick(20);
  }
}

// ── frame crafting (raw wire bytes, no provider) ─────────────────────────────

function encodeSyncFrame(syncType, payload) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, syncType);
  encoding.writeVarUint8Array(encoder, payload);
  return Buffer.from(encoding.toUint8Array(encoder));
}

/** A step2 frame carrying the full state of `doc` — the reconnect catch-up reply. */
const step2FrameFrom = (doc) => encodeSyncFrame(SYNC_STEP2, Y.encodeStateAsUpdate(doc));
/** An ordinary edit frame carrying `update` bytes. */
const updateFrame = (update) => encodeSyncFrame(SYNC_UPDATE, update);
/** A step1 frame (read-only state-vector request) — never an edit. */
const step1FrameFrom = (doc) => encodeSyncFrame(SYNC_STEP1, Y.encodeStateVector(doc));

/** Build a detached doc holding a paragraph of text. */
function docWithParagraph(text) {
  const doc = new Y.Doc();
  const fragment = doc.get('default', Y.XmlFragment);
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  fragment.insert(0, [p]);
  return doc;
}

/** Append a paragraph to an existing doc and return ONLY the resulting update bytes. */
function appendParagraph(doc, text) {
  let captured;
  const capture = (u) => { captured = u; };
  doc.on('update', capture);
  const fragment = doc.get('default', Y.XmlFragment);
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [p]);
  doc.off('update', capture);
  return captured;
}

/** The server-side shared doc's XML — the source of truth for "did it apply". */
const serverXml = (docGuid) => getYDoc(`s/${docGuid}`, true).get('default', Y.XmlFragment).toString();

// ── identities: real rows, real tokens, no fabrication ───────────────────────

/**
 * A human principal: a real `users` row plus a real browser-session access
 * token. The principal `extractUser` returns has NO `scopes` array — that is
 * the browser shape, and it must not be "helpfully" given scopes, because the
 * absence is exactly what makes `tokenMayWrite` true.
 *
 * @param {import('pg').Pool} pool
 * @param {string} email
 * @returns {Promise<{userId: string, token: string, email: string}>}
 */
async function createHumanIdentity(pool, email) {
  const userId = await createTestUser(pool, email);
  const token = generateAccessToken({ id: userId, email, name: 'Test User' });
  return { userId, token, email };
}

/**
 * An agent principal: a real `users` row plus a real `sk_sqd_` token minted
 * through the production mint path. `extractUser` returns
 * `{ userId, agentId: 'api-token:<id>', agentName, scopes, isAgent: true }` —
 * the true MCP-agent shape. `agentName` is the token's name, and that is what
 * lands in `yjs_updates.agent_name`.
 *
 * @param {import('pg').Pool} pool
 * @param {string} email
 * @param {string} agentName
 * @param {string[]} [scopes]
 */
async function createAgentIdentity(pool, email, agentName, scopes = ['documents:read', 'documents:write']) {
  const userId = await createTestUser(pool, email);
  const created = await apiTokens.createToken(userId, agentName, { scopes });
  return {
    userId,
    agentName,
    token: created.token,
    tokenId: created.id ?? created.tokenId ?? created.record?.id,
    scopes,
  };
}

/** Delete a minted token row. `cleanupTestUser` does not know about them. */
async function cleanupAgentToken(pool, userId) {
  await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [userId]);
}

/** FR-010: delete this suite's update-log rows. */
async function cleanupDoc(pool, docGuid) {
  await cleanupDocRows(pool, docGuid);
}

// ── failure injection (US3) ──────────────────────────────────────────────────

/**
 * Wrap a persistence provider so that `storeUpdate` REJECTS for one specific
 * update — matched by its payload bytes — on every attempt, while every other
 * update goes through untouched.
 *
 * Scoped to that one update on purpose. A global failure switch would take down
 * the document load and the unrelated writes around it, and the resulting
 * "outcome" would characterize the harness rather than the product.
 *
 * The returned handle carries `restore()` for a `finally` block, plus the
 * observed call counts.
 *
 * @param {object} persistence - the provider to wrap (mutated in place)
 * @param {(update: Uint8Array) => boolean} predicate
 */
function rejectUpdateMatching(persistence, predicate) {
  const original = persistence.storeUpdate.bind(persistence);
  const handle = { attempts: 0, rejected: 0, restore: null };

  persistence.storeUpdate = (docGuid, update, ...rest) => {
    if (predicate(update)) {
      handle.attempts += 1;
      handle.rejected += 1;
      // Rejecting here models persistence that has already exhausted its
      // transient retries: the listener's terminal `.catch` sees exactly the
      // rejected promise it would see in production.
      return Promise.reject(new Error('injected persistence failure (US3)'));
    }
    return original(docGuid, update, ...rest);
  };

  handle.restore = () => { persistence.storeUpdate = original; };
  return handle;
}

/** Do two byte arrays match exactly? The identity test for a specific update. */
function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// ── the mini server ──────────────────────────────────────────────────────────

/**
 * Boot a mini collaboration server wired with the production modules.
 *
 * @param {object} [opts]
 * @param {object} [opts.persistence] - override/wrap the persistence provider
 *   (US3 failure injection). Defaults to a real PostgresPersistence.
 * @returns {Promise<object>} Harness
 */
async function startCollabServer(opts = {}) {
  const pool = createPool();
  const persistence = opts.persistence || createPersistence();
  await persistence._init?.();

  // The production decision modules need the pool. Both are idempotent inits.
  documents.init(pool);
  apiTokens.init(pool);

  /** Every blocked-frame event the REAL gate reported. */
  const blockedEvents = [];
  /** Every in-flight persistence promise (H8). */
  const pendingWrites = new Set();
  /** notifyException calls, so US3 can assert observability without spying on console. */
  const notifications = [];
  const perfEvents = [];

  const notifyException = (err, ctx) => { notifications.push({ err, ctx }); };

  // H1: the REAL bindState from X1. No hand-written update listener exists in
  // this file — grep it: `ydoc.on('update'` appears nowhere.
  setPersistence({
    bindState: createBindState({
      persistenceProvider: persistence,
      pendingWrites,
      notifyException,
      searchIndexer: { markDirty: () => {} },
      collabGuardrail: { evaluateUpdate: () => Promise.resolve() },
      logPerf: (event, fields) => { perfEvents.push({ event, ...fields }); },
    }),
    writeState: async () => {},
    provider: persistence,
  });

  const app = express();
  let server;
  let wss;
  let port;

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      port = server.address().port;
      wss = new WebSocket.Server({ noServer: true });

      // ── the upgrade path: production's decision chain, in production's order
      server.on('upgrade', async (request, socket, head) => {
        try {
          const url = new URL(request.url, 'http://localhost');
          const docId = extractDocGuid(url.pathname.slice(1));
          const queryToken = url.searchParams.get('token');

          // H2: real token verification. No ?userId= shortcut exists.
          const user = await permissions.extractUser({ queryToken });
          if (!user) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }

          // H2: real ACL check against real document_shares rows.
          const viewPermission = await permissions.can.view(user.userId, docId);
          if (!viewPermission.allowed) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }

          request.user = user;
          request.userRole = viewPermission.role;
          request.docId = docId;
          // H3: the SECOND authorization axis, same predicate as production.
          request.tokenMayWrite = !Array.isArray(user.scopes) || user.scopes.includes('documents:write');

          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
        } catch (err) {
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        }
      });

      wss.on('connection', (ws, req) => {
        const userRole = req.userRole;
        const docId = req.docId;

        // H3: BOTH axes, ANDed, exactly as index.js does it.
        const tokenMayWrite = req.tokenMayWrite !== false;
        const currentCanEdit = tokenMayWrite && documents.ROLES[userRole] >= documents.ROLES['editor'];

        // H4: connection identity from X2. Never a literal.
        const wsIdentity = identityFromPrincipal(req.user);
        ws.userId = wsIdentity.userId;
        ws.agentName = wsIdentity.agentName;

        // H5: the REAL gate, installed the real way, BEFORE setupWSConnection.
        installGate(ws, {
          canEdit: () => currentCanEdit,
          onBlocked: (event, info = {}) => {
            blockedEvents.push({ event, userId: ws.userId, docId, role: userRole, ...info });
          },
        });

        // H6: y-websocket owns the socket from here.
        setupWSConnection(ws, req, { gc: true });
      });

      resolve();
    });
  });

  /**
   * Open a raw connection with a REAL token. Nothing is auto-replied: the
   * caller controls exactly which bytes hit the wire.
   *
   * @param {string} docGuid
   * @param {string} token - a real session JWT or sk_sqd_ token
   */
  async function connect(docGuid, token) {
    const ws = new WebSocket(`ws://localhost:${port}/s/${docGuid}?token=${encodeURIComponent(token)}`);
    const received = [];
    /** A client-side doc fed by whatever the server sends (read path). */
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

    return {
      ws,
      clientDoc,
      received,
      sendUpdate: (update) => ws.send(updateFrame(update)),
      sendStep2: (doc) => ws.send(step2FrameFrom(doc)),
      sendStep1: (doc) => ws.send(step1FrameFrom(doc)),
      close: () => new Promise((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', () => resolve());
        ws.close();
      }),
    };
  }

  const rowsFor = async (docGuid) => (
    await pool.query(
      'SELECT clock, user_id, agent_name, via_sync, meaningful, update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock',
      [docGuid]
    )
  ).rows;

  /** H8: await in-flight writes, then close the transport. */
  async function close() {
    await Promise.allSettled([...pendingWrites]);
    await new Promise((resolve) => wss.close(() => server.close(() => resolve())));
    // Awaiting an ABSENCE — letting any late socket teardown settle before the
    // pool closes under it. There is no observable condition to poll here (H9).
    await tick(50);
    await pool.end();
    await persistence.destroy?.();
  }

  return {
    port,
    pool,
    persistence,
    blockedEvents,
    perfEvents,
    notifications,
    pendingWrites,
    connect,
    rowsFor,
    serverXml,
    close,
  };
}

module.exports = {
  startCollabServer,
  createHumanIdentity,
  createAgentIdentity,
  cleanupAgentToken,
  cleanupTestUser,
  cleanupDoc,
  rejectUpdateMatching,
  sameBytes,
  waitFor,
  tick,
  docWithParagraph,
  appendParagraph,
  serverXml,
  documents,
  crypto,
  Y,
};
