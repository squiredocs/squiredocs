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
 * Frame      Header      Reaches Y.applyUpdate?   Classification
 * Step1      sync, 0     no (read-only request)   not an edit
 * Step2      sync, 1     YES                      edit  (kind: 'step2')
 * Update     sync, 2     yes                      edit  (kind: 'update')
 * Awareness  awareness   no                       not an edit
 * undecodable —          no                       not an edit (y-websocket handles)
 *
 * ── WHY THIS DECODES VARINTS INSTEAD OF INDEXING BYTES (038 review, HIGH) ─────
 * The header fields are lib0 VARINTS, not fixed bytes. lib0's `readVarUint`
 * accepts NON-MINIMAL encodings: `0x80 0x00` decodes to 0 and `0x82 0x00`
 * decodes to 2, so the four-byte header `80 00 82 00` is an ordinary
 * sync/update to y-protocols. The original gate compared `data[0]`/`data[1]`
 * against 0/1/2 and therefore classified that frame as "not an edit" while
 * y-websocket applied it — a complete bypass of the viewer block, reproduced
 * end-to-end during review (a view-only user could write, attributed to
 * themselves).
 *
 * The invariant that fixes it, and that any future edit here must preserve:
 * CLASSIFY THE FRAME THE SAME WAY THE APPLIER PARSES IT. We decode with the
 * same `lib0/decoding` primitive y-websocket uses, so the gate's view of a
 * frame cannot drift from the applier's view. Do not "optimize" this back into
 * byte indexing — the two are not equivalent, and the difference is a
 * privilege escalation. (Rejecting non-canonical encodings outright would also
 * close this hole, but decoding keeps the gate defined by the applier's
 * behavior rather than by a second opinion about what is well-formed.)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Nothing here parses frame payloads beyond the two header varints: this is an
 * ingestion surface for untrusted client bytes (Constitution V). The ONE thing
 * that does need the payload — which clientIDs an awareness frame asserts
 * (feature 044) — lives in server/ws-awareness-guard.js and is called from
 * `installGate` below, so this file's invariant stays true while the connection
 * still has exactly ONE frame-interception point.
 */

const decoding = require('lib0/decoding');

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
 * The awareness ownership guard (feature 044), resolved on FIRST USE.
 *
 * The two modules reference each other by design: the guard reuses the protocol
 * constants defined here rather than keeping a second copy of the wire format,
 * and `installGate` below calls the guard. Requiring it at module scope would
 * hand the guard this file's half-built `module.exports` (assigned at the
 * bottom) and `MESSAGE_AWARENESS` would arrive as `undefined`. Resolving at
 * call time means both modules are fully loaded whichever is required first.
 * `require` is cached, so this is a hash lookup per install, not a re-read.
 */
let awarenessGuardModule = null;
const awarenessGuard = () => (
  awarenessGuardModule || (awarenessGuardModule = require('./ws-awareness-guard'))
);

/**
 * Classify a raw WebSocket frame by its two header varints.
 *
 * Decodes with the SAME primitive y-websocket uses (see the varint note in the
 * module header) so the gate cannot disagree with the applier about what a
 * frame is. Non-minimal varint encodings therefore classify exactly as their
 * canonical equivalents do.
 *
 * Pure and throw-free on ANY input (null, undefined, empty, 1-byte, non-Buffer,
 * garbage, truncated varint) — anything undecodable is simply "not an edit" and
 * falls through to y-websocket's own handling, which rejects it the same way.
 *
 * @param {Buffer|Uint8Array|null|undefined} data - Raw message bytes
 * @returns {{ isEdit: boolean, kind: 'update'|'step2'|null }}
 */
function classifyFrame(data) {
  if (!data || typeof data.length !== 'number' || data.length < 2) {
    return { isEdit: false, kind: null };
  }

  let messageType;
  let syncType;
  try {
    // Uint8Array view over the same bytes; Buffer is already one.
    const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
    const decoder = decoding.createDecoder(bytes);
    messageType = decoding.readVarUint(decoder);
    if (messageType !== MESSAGE_SYNC) return { isEdit: false, kind: null };
    syncType = decoding.readVarUint(decoder);
  } catch {
    // Undecodable header (truncated varint, unreadable buffer): not an edit.
    // y-websocket's own decode will fail on the same bytes.
    return { isEdit: false, kind: null };
  }

  if (syncType === SYNC_UPDATE) return { isEdit: true, kind: 'update' };
  if (syncType === SYNC_STEP2) return { isEdit: true, kind: 'step2' };
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
 * ── via_sync CONTRACT (FR-015), stated where the flag is SET ─────────────────
 * A via_sync row proves the content reached the server THROUGH this client —
 * never that this client WROTE it. The flag records the CHANNEL, not a verdict
 * on authorship, and it does NOT alter attribution: a genuine offline edit
 * re-supplied on reconnect is still that user's work and stays stamped to them.
 * Only `true` carries meaning; `null` (every pre-feature row — there is no
 * backfill — and every non-step2 write) means "not known to be sync" and must
 * never be read as suspicious. The same contract is restated for readers on the
 * column mapping in server/postgres-persistence.js.
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
 * @param {function(string, object): void} [handlers.onBlocked] -
 *   Called with the event name from `blockedEventFor` when an edit frame is
 *   dropped, or AWARENESS_BLOCKED_EVENT when an awareness frame is (044).
 * @param {function(): (Map|null)} [handlers.getConns] - OPTIONAL (044). Resolves
 *   the document's `Map<conn, Set<number>>` ownership record PER FRAME — the doc
 *   does not exist yet when the gate is installed. Returning null/non-Map
 *   disables the awareness check for that frame, which is safe: before
 *   setupWSConnection runs there is no message listener for a frame to reach.
 * @param {function(*): (string|null)} [handlers.principalOf] - OPTIONAL (044).
 *   The same-user tie-break input; defaults to reading `conn.userId`.
 * @returns {function} The original (unwrapped) `ws.emit`, bound to `ws`.
 */
function installGate(ws, { canEdit, onBlocked, getConns, principalOf } = {}) {
  const originalEmit = ws.emit.bind(ws);

  // Per-connection log suppression for awareness drops (feature 044, FR-007),
  // created on the FIRST drop so honest connections never allocate one. Living
  // in this closure means it is garbage collected with the socket: no global
  // map to leak, no cleanup handler to forget, and one connection's flood can
  // never suppress another connection's first alarm.
  let dropSuppressor = null;

  ws.emit = (event, ...args) => {
    if (event === 'message') {
      const data = args[0];
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const { kind } = classifyFrame(buffer);

      if (kind !== null && !canEdit()) {
        if (onBlocked) onBlocked(blockedEventFor(kind), { kind });
        return false;
      }

      // ── Awareness ownership guard (feature 044) ────────────────────────────
      // Orthogonal to edit classification, which is untouched: this runs only
      // on frames `classifyFrame` already called "not an edit", and it never
      // changes what `classifyFrame` returns (FR-005). Awareness frames remain
      // "not an edit" for every role; the guard applies to viewers and editors
      // alike. Skipped entirely when the caller passes no `getConns`, which is
      // what keeps every pre-044 caller and test byte-for-byte unaffected.
      if (kind === null && getConns) {
        const conns = getConns();
        if (conns instanceof Map) {
          const guard = awarenessGuard();
          const { isAwareness, clientIds } = guard.parseAwarenessFrame(buffer);
          if (isAwareness && clientIds.length > 0) {
            const { allowed, foreignIds } = guard.evaluateAwarenessFrame({
              conns, conn: ws, clientIds, principalOf,
            });
            if (!allowed) {
              // Dropped whole: no listener runs, so nothing is applied, nothing
              // is broadcast to other connections, and — because the Redis
              // awareness publisher is driven by the doc's own awareness
              // 'update' event — nothing is relayed cross-instance either.
              // The socket stays OPEN and is NOT notified.
              if (!dropSuppressor) dropSuppressor = guard.createDropSuppressor();
              const counts = dropSuppressor.record();
              // Counted always; LOGGED only when the suppressor lets one
              // through. The counts ride in the payload, so the volume is
              // still recoverable from the lines that were emitted.
              if (onBlocked && counts) {
                onBlocked(guard.AWARENESS_BLOCKED_EVENT, {
                  kind: 'awareness',
                  foreignIds,
                  ...counts,
                });
              }
              return false;
            }
          }
        }
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
