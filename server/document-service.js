/**
 * Document Service - Application layer for document updates
 *
 * Provides a unified interface for both WebSocket and MCP tools
 * to update documents. Ensures all updates go through the in-memory
 * ydoc cache and are broadcast to connected clients.
 */
const Y = require('yjs');
const { randomUUID } = require('crypto');
const { createOrigin } = require('./origin');
const documents = require('./documents');
const { BindFailedError } = require('./bind-failure');

let getYDocFn = null;
let extractDocGuidFn = null;
let docsMap = null;

/**
 * Initialize with server exports
 * @param {function(string, boolean): Y.Doc} getYDoc - Function to get shared ydoc
 * @param {function(string): string} extractDocGuid - Function to extract clean UUID
 * @param {Map|null} [docs] - y-websocket's own `docName -> Y.Doc` registry, for
 *   `peekSharedDoc`. Optional so existing callers/tests keep working; without it
 *   the peek honestly answers "not loaded".
 */
function init(getYDoc, extractDocGuid, docs = null) {
  getYDocFn = getYDoc;
  extractDocGuidFn = extractDocGuid;
  docsMap = docs;
}

/**
 * Get the shared in-memory ydoc for a document, CREATING it if it is not loaded.
 *
 * ⚠️ This is a write-path primitive. y-websocket's `getYDoc` is
 * `map.setIfUndefined(docs, ...)` — the lookup IS the creation, and it also
 * fires an asynchronous `bindState` full load. That is the correct contract for
 * `updateDocument` (an agent modify/import must have a doc to write into), but
 * it is the WRONG primitive for asking "is this document loaded?" — see
 * `peekSharedDoc` (feature 041, FR-013).
 *
 * @param {string} docGuid - Document UUID
 * @returns {Y.Doc} The shared WSSharedDoc instance
 */
function getSharedDoc(docGuid) {
  if (!getYDocFn) {
    throw new Error('Document service not initialized');
  }

  // y-websocket expects "s/{docGuid}" format
  const docName = `s/${docGuid}`;
  return getYDocFn(docName);
}

/**
 * Honest "is this document loaded on this instance?" probe (feature 041, FR-013).
 *
 * Returns the live shared doc if one exists, else `null` — and NEVER creates one.
 *
 * Every read-shaped consumer (restore, undo, redo) used to ask this question
 * through the creating `getSharedDoc`, so the answer was always "yes": the
 * not-loaded branches downstream were unreachable, every such operation on an
 * unopened document allocated an in-memory doc plus a spurious full load, and
 * nothing ever evicted it (eviction only happens when the last WebSocket
 * connection closes, and these docs never had one). That is a permanent
 * server-memory leak driven by read operations.
 *
 * @param {string} docGuid - Document UUID
 * @returns {Y.Doc|null} The live shared doc, or null when it is not loaded here
 */
function peekSharedDoc(docGuid) {
  if (!docsMap || typeof docsMap.get !== 'function') return null;
  return docsMap.get(`s/${docGuid}`) || null;
}

/**
 * Wait until a shared doc's bindState load has COMPLETED (feature 048, FR-013).
 *
 * y-websocket's `getYDoc` fires `bindState` without awaiting it, so a doc nobody
 * has open is returned EMPTY and the persisted state merges in later. A write
 * that lands in that window races the load and can lose: a title set on a cold
 * doc is a `Y.Map` set, and the later-arriving persisted title wins by LWW
 * roughly half the time (98/200 trials against this repo's yjs); an "append at
 * the end" computes its index against an empty fragment and lands at index 0 —
 * before the entire document. Both were reproduced, not theorised.
 *
 * This is the ONE owner of "is this document safe to write through?". It
 * replaces the state-vector poll `docs-import.js` used to carry, which cost an
 * extra `persistence.getYDoc` DB read per call and answered a strictly weaker
 * question: state coverage, not bind success — it spun to timeout on a failed
 * bind where this throws immediately.
 *
 * Note this is a distinct question from `isTrustedLiveDoc`
 * (`server/live-doc-trust.js`), which asks "may I compute a DURABLE artifact
 * from this live copy?" and additionally requires ≥1 live connection. Both read
 * the same `_bindComplete` substrate; the questions stay separate on purpose.
 *
 * Never creates a doc, never reads persistence, never mutates the doc.
 *
 * @param {Y.Doc} ydoc - The shared doc to wait on
 * @param {string} docGuid - Document UUID (for error messages)
 * @param {number} [timeoutMs=5000] - Bound on the wait
 * @returns {Promise<void>} Resolves once the doc has absorbed its persisted state
 * @throws {BindFailedError} When the bind was refused (at entry or while polling)
 * @throws {Error} `Timed out waiting for document <guid> to load` on timeout —
 *   the message shape the old `waitForDocLoaded` used, so route-level 500
 *   mapping is unchanged.
 */
async function waitForDocReady(ydoc, docGuid, timeoutMs = 5000) {
  // A refused bind is answered immediately rather than polled to timeout — the
  // doc will never complete, and callers already handle BindFailedError.
  if (ydoc._bindFailed) throw new BindFailedError(docGuid);
  // Fast path: a warm doc pays one flag check and no event-loop turn.
  if (ydoc._bindComplete === true) return;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (ydoc._bindFailed) throw new BindFailedError(docGuid);
    if (ydoc._bindComplete === true) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for document ${docGuid} to load`);
    }
  }
}

/**
 * Apply a function to a document with proper transacting
 * @param {string} docGuid - Document UUID
 * @param {function(Y.Doc): void} updateFn - Function that modifies the ydoc
 * @param {Object} options - Attribution options
 * @param {string|null} options.userId - User ID for attribution
 * @param {string|null} options.agentName - Agent name for attribution (e.g., 'Chat Assistant')
 * @returns {Promise<{update: Uint8Array|null, hadRedisHandler: boolean}>} Resolves
 *   when the update is applied and persistence is initiated, carrying the bytes
 *   this transaction emitted (feature 037, FR-018). ADDITIVE — every existing
 *   caller ignores it and no timing semantics changed.
 */
async function updateDocument(docGuid, updateFn, { userId = null, agentName = null } = {}) {
  const ydoc = getSharedDoc(docGuid);

  // ── BIND-READINESS GATE (feature 048, FR-013) ──────────────────────────────
  // BEFORE any read of doc state and before any listener is attached. The
  // lookup above CREATES the doc and fires an un-awaited bindState, so without
  // this the write races the load — see waitForDocReady for the reproduction.
  await waitForDocReady(ydoc, docGuid);

  // Attribution origin for this call. Its OBJECT IDENTITY is what scopes the
  // capture below — the same identity-not-shape discipline feature 037 adopted
  // for per-push sync origins (see SYNC_PUSH_MARKER in server/origin.js).
  const origin = createOrigin(userId, agentName);

  // Cross-instance fan-out capture (feature 037). A document reached through
  // getSharedDoc has NO Redis handler attached — that is wired lazily by the WS
  // connection handler — so on a replica holding no live connection an import
  // would persist and broadcast to nobody. The caller republishes when nothing
  // else did.
  let captured = { update: null, hadRedisHandler: false };
  let updateFired = false;

  // ── ORIGIN-SCOPED CAPTURE (feature 038 US4, FR-019/020/021) ────────────────
  // This listener captures ONLY this transaction's own update. It previously
  // used `ydoc.once` armed against a 50 ms timeout, which meant that on the
  // no-change path (where our own event never fires) the listener stayed armed
  // for 50 ms on a SHARED document and consumed whatever landed next — a
  // concurrent edit by an unrelated user, returned to this caller as "the bytes
  // this call produced" and republished under this call's attribution.
  //
  // `on` + an explicit `off` in `finally` replaces `once` because a
  // foreign-origin update must be IGNORED WITHOUT CONSUMING the listener.
  const updateHandler = (update, updOrigin) => {
    if (updOrigin !== origin) return; // not ours — never capture it
    updateFired = true;
    // `hadRedisHandler` MUST be sampled here, at emit time — not after the
    // await. The presence dial (or any browser) can attach the handler in the
    // window between the transaction and a post-hoc check, and a post-hoc
    // check would then skip publishing an update that handler never saw: a
    // silent cross-instance loss. The Redis handler is a peer 'update'
    // listener, so "was it attached when the event fired" is exactly "did it
    // publish" (research R3).
    captured = { update, hadRedisHandler: !!ydoc._redisUpdateHandler };
  };

  ydoc.on('update', updateHandler);

  // Apply changes in a transaction. Yjs fires the doc 'update' event
  // SYNCHRONOUSLY at transaction end, so by the time transact() returns the
  // event has either fired (a change) or never will (no change). There is
  // nothing left to wait for, and therefore no window to leave armed.
  //
  // The update event also drives:
  // 1. Broadcast to WebSocket clients
  // 2. Persistence to the database with userId attribution (bindState listener)
  try {
    ydoc.transact(() => {
      updateFn(ydoc);
    }, origin);
  } finally {
    // Detached synchronously on EVERY path, including a throwing updateFn (the
    // error still propagates). No armed listener survives this call.
    ydoc.off('update', updateHandler);
  }

  if (updateFired) {
    // "Persistence initiated" (FR-021): the bindState listener starts the write
    // synchronously from the same event, but callers rely on being able to
    // observe that it has begun. One event-loop turn preserves the contract
    // 037's callers were written against.
    await new Promise((resolve) => setImmediate(resolve));
  }

  // ── REFUSED BIND (feature 046, NEW-5) ──────────────────────────────────────
  // The listener's `_bindFailed` gate drops the persist for a document whose
  // load failed, and its comment assumes only WebSocket traffic reaches it —
  // which is true for browsers (refuseBind closes their sockets, they reconnect
  // and rebind) and FALSE for us. A server-side writer holds a handle it
  // acquired before the refusal: no connection to close, so it transacts, the
  // listener silently drops the write, and this function used to resolve
  // normally. An agent then reported "done" for content that exists nowhere and
  // kept building on it.
  //
  // Checked AFTER the transaction rather than before, because the interesting
  // window is exactly the one a pre-check cannot see: the bind failing between
  // handle acquisition and the write. A refusal that landed earlier is caught
  // here too, so one check covers both.
  //
  // Throwing, not refetching: `refuseBind` EVICTS the doc, so the caller's next
  // `getSharedDoc` builds a fresh one and re-attempts the load. Retrying inside
  // this call would re-run `updateFn` against a different document state with no
  // way to tell the caller that happened — for a mutation expressed as an
  // arbitrary function, that is the caller's decision to make.
  if (ydoc._bindFailed) {
    throw new BindFailedError(docGuid);
  }

  // No-change transactions never fire, so this returns the zero value
  // immediately — no timer, and nothing captured from anyone else.
  return captured;
}

/**
 * Create a server-seeded document in one step: the document record (with owner
 * + DB title), then its Yjs body — the title in the `meta` map and the given
 * prebuilt nodes inserted at the top of the default fragment, attributed to
 * userId/agentName. Shared by the create_document MCP tool and the onboarding
 * welcome flow so the two birth paths can't drift. Returns the new doc guid.
 *
 * @param {object} opts
 * @param {string} opts.userId - Owner / attribution user id
 * @param {string} opts.title - Document title (set in both the row and Yjs meta)
 * @param {Array<Y.XmlElement>} [opts.nodes=[]] - Prebuilt block nodes to seed
 * @param {string|null} [opts.agentName=null] - Attribution agent name
 * @returns {Promise<string>} The new document's guid
 */
async function createSeededDocument({ userId, title, nodes = [], agentName = null }) {
  const docGuid = randomUUID();

  await documents.createDocument(docGuid, userId, title);

  await updateDocument(
    docGuid,
    (ydoc) => {
      ydoc.getMap('meta').set('title', title);
      if (nodes.length > 0) {
        ydoc.get('default', Y.XmlFragment).insert(0, nodes);
      }
    },
    { userId, agentName }
  );

  return docGuid;
}

module.exports = {
  init,
  getSharedDoc,
  // Feature 041 (FR-013): the non-creating is-loaded probe.
  peekSharedDoc,
  // Feature 048 (FR-013): the ONE owner of "is this doc safe to write through?".
  waitForDocReady,
  updateDocument,
  createSeededDocument,
};
