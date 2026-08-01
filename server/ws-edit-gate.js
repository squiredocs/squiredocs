/**
 * WebSocket sync-protocol edit gate (feature 038 US1).
 *
 * ONE implementation of "is this frame an edit?", plus the interceptor that
 * installs it on a connection. Extracted out of server/index.js deliberately:
 * the previous inline `isEditMessage` was unexported, so its unit test
 * (permissions.test.js) could only pin it by keeping a hand-written MIRROR of
 * the function — and the mirror faithfully copied a security bug (SyncStep2
 * classified as "not an edit") with nothing forcing it to track the real code.
 * Every consumer — server/index.js, the unit tests, and the protocol-level
 * integration test — now imports THIS module. There are no other copies.
 *
 * ── DESIGN RULE (design/collaboration-core.md amendment, Sam, 2026-08-01) ─────
 * Any protocol frame that can reach the document-apply path is an EDIT for
 * permission purposes. SYNC_UPDATE and SYNC_STEP2 both reach Y.applyUpdate, so
 * both are edits. NEW SYNC MESSAGE TYPES MUST BE CLASSIFIED HERE (and in
 * specs/038-attribution-integrity/contracts/sync-protocol-gate.md) BEFORE THEY
 * SHIP. A frame that can mutate the document but is not in the table below is a
 * write-permission bypass by construction.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Frame      Bytes   Reaches Y.applyUpdate?   Classification
 * Step1      [0, 0]  no (read-only request)   not an edit
 * Step2      [0, 1]  YES                      edit  (kind: 'step2')
 * Update     [0, 2]  yes                      edit  (kind: 'update')
 * Awareness  [1, …]  no                       not an edit
 * < 2 bytes  —       no                       not an edit (y-websocket handles)
 *
 * Nothing here parses frame payloads beyond the two-byte header: this is an
 * ingestion surface for untrusted client bytes (Constitution V).
 */

// y-websocket protocol constants
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Sync message sub-types
const SYNC_STEP1 = 0;  // Request state vector
const SYNC_STEP2 = 1;  // Send full state (response) — CAN mutate the document
const SYNC_UPDATE = 2; // Send an update (edit)

/**
 * Property set on the connection object for the duration of ONE step2 frame's
 * application. y-websocket passes the connection (`ws`) as the Yjs transaction
 * origin, so the persistence listener can read this flag straight off the origin
 * it already receives — no plumbing between interceptor and listener, and no way
 * for the flag to leak across connections (another connection's update carries a
 * different origin object).
 */
const STEP2_ORIGIN_FLAG = '_applyingSyncStep2';

/**
 * Classify a raw WebSocket frame by its two-byte header.
 *
 * Pure and throw-free on ANY input (null, undefined, empty, 1-byte, non-Buffer,
 * garbage) — a malformed frame is simply "not an edit" and falls through to
 * y-websocket's own handling, exactly as before.
 *
 * @param {Buffer|Uint8Array|null|undefined} data - Raw message bytes
 * @returns {{ isEdit: boolean, kind: 'update'|'step2'|null }}
 */
function classifyFrame(data) {
  if (!data || typeof data.length !== 'number' || data.length < 2) {
    return { isEdit: false, kind: null };
  }
  if (data[0] !== MESSAGE_SYNC) return { isEdit: false, kind: null };
  if (data[1] === SYNC_UPDATE) return { isEdit: true, kind: 'update' };
  if (data[1] === SYNC_STEP2) return { isEdit: true, kind: 'step2' };
  return { isEdit: false, kind: null };
}

/**
 * Is this frame an edit for permission purposes? Thin predicate over
 * `classifyFrame` for callers that do not care which kind it is.
 *
 * @param {Buffer|Uint8Array|null|undefined} data
 * @returns {boolean}
 */
function isEditMessage(data) {
  return classifyFrame(data).isEdit;
}

/**
 * The observability event name for a blocked frame of the given kind.
 * Distinct names keep the two bypass shapes separately countable (SC-002).
 *
 * @param {'update'|'step2'} kind
 * @returns {'WS_EDIT_BLOCKED'|'WS_STEP2_BLOCKED'}
 */
function blockedEventFor(kind) {
  return kind === 'step2' ? 'WS_STEP2_BLOCKED' : 'WS_EDIT_BLOCKED';
}

/**
 * Read the step2 channel marker off a Yjs transaction origin.
 *
 * Returns `true` only when the update was produced during the synchronous
 * application of a step2 frame; otherwise `null` ("unknown" — the value the
 * via_sync column stores for every non-sync write, D1/D5). Never returns
 * `false`, so callers can pass the result straight through to storeUpdate.
 *
 * @param {*} origin - Yjs transaction origin (the ws object, on the WS path)
 * @returns {true|null}
 */
function viaSyncFromOrigin(origin) {
  return (origin && typeof origin === 'object' && origin[STEP2_ORIGIN_FLAG] === true) || null;
}

/**
 * Install the edit gate on a WebSocket connection by wrapping `ws.emit`.
 *
 * THIS is the production wiring — server/index.js and the FR-008 protocol
 * integration test both call it, so the test exercises the real gate installed
 * the real way. (An earlier design left installation inline in index.js and only
 * shared `classifyFrame`; that reintroduces the one-level-up mirror drift this
 * module exists to kill — the test could pass while production wiring rotted.)
 *
 * Behavior per frame, before y-websocket sees anything:
 *  - not an edit (step1 / awareness / short / garbage) ⇒ passed straight through
 *    for every role; downstream sync to viewers is untouched (FR-004).
 *  - edit frame from a connection that may NOT edit ⇒ DROPPED: `onBlocked` fires
 *    and emit returns false. No document mutation, no row, no rebroadcast, no
 *    reply. The connection STAYS OPEN and is not notified (D4, matching the
 *    pre-existing WS_EDIT_BLOCKED policy).
 *  - step2 frame from a connection that MAY edit ⇒ applied inside the step2 flag
 *    window (see below) so the rows it produces are marked via_sync.
 *
 * ── SYNCHRONICITY ASSUMPTION (FR-011) ────────────────────────────────────────
 * The flag is scoped by a plain set/`finally`-clear around the delegated emit.
 * That is exact ONLY because frame application is one fully synchronous chain on
 * the event loop:
 *     ws 'message' dispatch → y-websocket messageListener
 *       → syncProtocol.readSyncMessage → readSyncStep2
 *       → Y.applyUpdate(doc, payload, conn)   ← conn (this ws) is the origin
 *       → doc 'update' listeners (persistence)
 * Nothing in that chain awaits, so every update the frame produces is observed
 * while the flag is set, and no unrelated update can be. The `finally` is
 * load-bearing: a throwing Y.applyUpdate must not leave the flag stuck true and
 * mismark every subsequent live edit on this connection.
 * IF y-websocket EVER DEFERS FRAME APPLICATION (queues it, awaits inside
 * readSyncMessage), THIS SCOPING MUST BE REVISITED — the flag would then be set
 * during the wrong updates.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @param {import('ws').WebSocket} ws - The connection to gate
 * @param {object} handlers
 * @param {function(): boolean} handlers.canEdit - Reads the connection's CURRENT
 *   edit capability at frame time (so the 60 s role re-check, which fails closed,
 *   takes effect for step2 exactly when it does for update frames).
 * @param {function(string, {kind: 'update'|'step2'}): void} [handlers.onBlocked] -
 *   Called with the event name from `blockedEventFor` when a frame is dropped.
 * @returns {function} The original (unwrapped) `ws.emit`, bound to `ws`.
 */
function installGate(ws, { canEdit, onBlocked } = {}) {
  const originalEmit = ws.emit.bind(ws);

  ws.emit = (event, ...args) => {
    if (event === 'message') {
      const data = args[0];
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const { kind } = classifyFrame(buffer);

      if (kind !== null && !canEdit()) {
        if (onBlocked) onBlocked(blockedEventFor(kind), { kind });
        return false;
      }

      if (kind === 'step2') {
        // Step2 flag window — see the synchronicity assumption above.
        ws[STEP2_ORIGIN_FLAG] = true;
        try {
          return originalEmit(event, ...args);
        } finally {
          ws[STEP2_ORIGIN_FLAG] = false;
        }
      }
    }

    return originalEmit(event, ...args);
  };

  return originalEmit;
}

module.exports = {
  MESSAGE_SYNC,
  MESSAGE_AWARENESS,
  SYNC_STEP1,
  SYNC_STEP2,
  SYNC_UPDATE,
  STEP2_ORIGIN_FLAG,
  classifyFrame,
  isEditMessage,
  blockedEventFor,
  viaSyncFromOrigin,
  installGate,
};
