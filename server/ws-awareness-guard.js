/**
 * Awareness clientID ownership guard (feature 044).
 *
 * ── TRUST BOUNDARY (Constitution V) ──────────────────────────────────────────
 * An awareness frame arriving on a client WebSocket connection is UNTRUSTED
 * INPUT. The Yjs awareness protocol identifies each participant by a clientID
 * carried INSIDE the frame payload, and that clientID is client-chosen:
 * `applyAwarenessUpdate` accepts an update for ANY clientID whose clock is
 * higher, authenticating it against nothing. So a connected participant of any
 * role — including view-only — can hand-craft a frame carrying ANOTHER
 * participant's clientID and either overwrite their displayed name/colour or
 * evict their presence outright, fanned out to every connection and across
 * instances. (Reproduced by the 038 post-merge reviewer; see
 * specs/038-attribution-integrity/promotion-notes.md.)
 *
 * The rule this module enforces: a connection may assert presence ONLY for
 * clientIDs it legitimately controls — its own, an unclaimed one, or one held
 * by another connection of the SAME authenticated user (reconnect / multi-tab).
 * Anything else drops the whole frame, silently, with a rate-suppressed
 * WS_AWARENESS_BLOCKED event. Ownership is first-writer-wins, read from the
 * per-connection controlled-id set y-websocket already maintains for presence
 * eviction (`WSSharedDoc.conns`) — this module NEVER writes that map, because a
 * second maintainer of the ownership record is exactly the "second model"
 * failure 038 kept hitting.
 *
 * ── WHY THIS DECODES VARINTS INSTEAD OF INDEXING BYTES (FR-003) ──────────────
 * The 038 lesson, one level deeper. lib0's `readVarUint` accepts NON-MINIMAL
 * encodings: `0x81 0x00` decodes to 1, so a guard that read `payload[0]` would
 * see 129 and let a spoof of clientID 1 straight through while the applier
 * applied it. We therefore decode with the SAME `lib0/decoding` primitives
 * `applyAwarenessUpdate` uses, so the guard's view of which ids a frame asserts
 * cannot drift from the applier's view. Non-minimal encodings classify exactly
 * as their canonical equivalents do. Do not "optimize" this into byte indexing
 * — the two are not equivalent, and the difference is the bypass.
 *
 * ── THE APPLIER IS NOT ATOMIC (D-044-1) ──────────────────────────────────────
 * `applyAwarenessUpdate` decodes and applies entries one at a time inside a
 * single loop, and y-websocket's `messageListener` swallows the throw. A
 * failure on entry N therefore leaves entries 1..N-1 ALREADY APPLIED. So
 * `[well-formed spoof of Ca][garbage]` would spoof Ca even though the frame as
 * a whole is undecodable. The parser below is consequently INCREMENTAL: every
 * clientID decoded before a failure counts as asserted, and `truncated` never
 * shrinks the id set. Only a frame that fails before ONE complete entry asserts
 * nothing and passes through — that is the case the spec's "undecodable ⇒ pass
 * through, the applier rejects it identically" edge case actually describes.
 * The guard's id set must never be NARROWER than the applier's; a superset is
 * safe, a subset is a hole. An all-or-nothing parse re-opens it.
 *
 * ── THIS IS NOT 038 US5's DELETED PARSER COMING BACK ─────────────────────────
 * server/index.js used to hand-parse clientIDs out of a connection's first
 * awareness frame to guess THE SENDER'S OWN ID for eviction. That was wrong by
 * construction — an awareness frame is a broadcast ABOUT a set of clients, not
 * necessarily FROM one — and 038 US5 deleted it. This module parses awareness
 * frames for the OPPOSITE and correct question: WHICH IDS DOES THIS FRAME
 * ASSERT? — which is exactly what a broadcast-about-a-set frame does tell you.
 * Eviction still comes solely from y-websocket's `closeConn` plus the
 * controlled-ids set, which this module reads and never writes.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Contract: specs/044-presence-awareness-guard/contracts/awareness-ownership-guard.md
 */

const decoding = require('lib0/decoding');
// ONE definition of the protocol constants, shared with the edit gate. A local
// copy here is how a second, drifting model of the wire format starts.
const { MESSAGE_AWARENESS } = require('./ws-edit-gate');

/**
 * Observability event name for a dropped awareness frame. Distinct from
 * WS_EDIT_BLOCKED and WS_STEP2_BLOCKED so awareness spoofing stays separately
 * countable (Q4, FR-007).
 */
const AWARENESS_BLOCKED_EVENT = 'WS_AWARENESS_BLOCKED';

/**
 * Log-suppression window for dropped-frame events. Awareness frames fire per
 * cursor move and per 15 s heartbeat, so an unsuppressed per-frame log on a
 * spoof flood would be a log-volume incident of its own (research R9).
 */
const AWARENESS_BLOCK_LOG_WINDOW_MS = 60000;

/**
 * Extract the clientIDs an awareness frame ASSERTS, parsing it the same way
 * `applyAwarenessUpdate` parses it (FR-003).
 *
 * Wire shape (y-protocols/awareness `encodeAwarenessUpdate`, read back by
 * `applyAwarenessUpdate`; outer envelope from y-websocket's `messageListener`):
 *
 *   [varuint messageType = MESSAGE_AWARENESS]
 *   [varuint byteLength][ inner awareness update ]      <- readVarUint8Array
 *       inner: [varuint entryCount]
 *              repeated entryCount times:
 *                [varuint clientID]
 *                [varuint clock]
 *                [varstring JSON.stringify(state)]      <- "null" is a removal
 *
 * INCREMENTAL BY DESIGN (D-044-1): each clientID is recorded the moment it
 * decodes, before its clock and state are read, because the applier applies
 * entries in a loop and a decodable prefix lands before any throw. A frame that
 * fails before one complete clientID asserts nothing and passes through.
 *
 * The state string is READ but never `JSON.parse`d (D-044-2): advancing the
 * decoder is all we need, the guard is deliberately a superset of what the
 * applier will reach, and JSON parsing every cursor tick is real cost against
 * SC-004 for no security gain.
 *
 * Total and throw-free on ANY input — null, undefined, empty, 1-byte,
 * non-Buffer, garbage, truncated varint, overstated entry count — exactly the
 * contract `classifyFrame` holds.
 *
 * @param {Buffer|Uint8Array|null|undefined} data - Raw message bytes
 * @returns {{ isAwareness: boolean, clientIds: number[], truncated: boolean }}
 */
function parseAwarenessFrame(data) {
  const result = { isAwareness: false, clientIds: [], truncated: false };
  if (!data || typeof data.length !== 'number') return result;

  let inner;
  try {
    // Uint8Array view over the same bytes; Buffer is already one. Same coercion
    // the edit gate uses, so both see identical bytes.
    const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
    const outer = decoding.createDecoder(bytes);
    if (decoding.readVarUint(outer) !== MESSAGE_AWARENESS) return result;
    inner = decoding.readVarUint8Array(outer);
  } catch {
    // Unreadable message type, or an envelope whose declared length overruns
    // the buffer. y-websocket's decode fails on the same bytes; nothing can be
    // asserted, so nothing can be spoofed.
    return result;
  }

  // Past this point the frame IS an awareness frame; anything undecodable
  // inside it only ever shrinks how far we get, never what kind of frame it is.
  result.isAwareness = true;

  const decoder = decoding.createDecoder(inner);
  let entryCount;
  try {
    entryCount = decoding.readVarUint(decoder);
  } catch {
    result.truncated = true;
    return result;
  }

  for (let i = 0; i < entryCount; i++) {
    try {
      // Recorded BEFORE clock/state: D-044-1 counts every decoded clientID.
      result.clientIds.push(decoding.readVarUint(decoder));
      decoding.readVarUint(decoder);   // clock — read to advance, never trusted
      decoding.readVarString(decoder); // state — read to advance, never parsed
    } catch {
      result.truncated = true;
      return result;
    }
  }

  return result;
}

/**
 * The authenticated principal behind a connection, for the same-user tie-break.
 *
 * `server/index.js` stamps `ws.userId` on every connection already (y-websocket
 * passes `ws` as the Yjs transaction origin, so attribution rides on it), which
 * is why the naming convention stays owned by index.js and is injected here
 * rather than baked in.
 *
 * @param {*} conn
 * @returns {string|null} `null` when unknown — and `null` NEVER matches.
 */
const defaultPrincipalOf = (conn) => (conn && conn.userId != null ? conn.userId : null);

/**
 * Decide whether `conn` may assert `clientIds` on this document (FR-001/FR-002).
 *
 * Ownership rules, per asserted clientID, in order:
 *   1. the id is in the connection's OWN controlled-id set        → allow
 *   2. the id is held by NO other connection                      → allow
 *      (first-writer-wins: this is how a first announcement claims an id)
 *   3. every connection holding it has the SAME, non-null principal → allow
 *      (self reconnect / multi-tab)
 *   4. otherwise                                                  → foreign
 *
 * ONE foreign id drops the WHOLE frame (Q2, FR-004): no partial apply, no
 * re-encode. A well-behaved client's awareness handler only ever encodes its
 * own single clientID, so honest traffic never reaches that path.
 *
 * `conns` is the `Map<conn, Set<number>>` borrowed from `WSSharedDoc`. It is
 * READ ONLY — never mutated here, not even to "help" y-websocket keep it
 * current. y-websocket's `awarenessChangeHandler` and `closeConn` are its sole
 * maintainers (research R4); a second writer is the drift this feature exists
 * not to repeat.
 *
 * @param {object} args
 * @param {Map<*, Set<number>>|null} args.conns - Borrowed ownership map
 * @param {*} args.conn - The asserting connection (a key of `conns`)
 * @param {number[]} args.clientIds - Ids the frame asserts, in wire order
 * @param {function(*): (string|null)} [args.principalOf] - Same-user tie-break input
 * @returns {{ allowed: boolean, foreignIds: number[] }} `foreignIds` de-duplicated, first-seen order
 */
function evaluateAwarenessFrame({ conns, conn, clientIds, principalOf = defaultPrincipalOf }) {
  // Nothing asserted, or no document bound yet (the frame cannot reach any
  // applier before setupWSConnection installs the message listener).
  if (!Array.isArray(clientIds) || clientIds.length === 0) return { allowed: true, foreignIds: [] };
  if (!(conns instanceof Map)) return { allowed: true, foreignIds: [] };

  const ownIds = conns.get(conn);
  const foreignIds = [];
  const alreadyRecorded = new Set();

  for (const clientId of clientIds) {
    if (ownIds && ownIds.has(clientId)) continue;                     // rule 1

    const holders = [];
    for (const [otherConn, controlledIds] of conns) {
      if (otherConn === conn) continue;
      if (controlledIds && controlledIds.has(clientId)) holders.push(otherConn);
    }
    if (holders.length === 0) continue;                               // rule 2

    // Rule 3 — the same-user tie-break (Q3). A spoof is BY DEFINITION a
    // different principal claiming your identity: a connection sharing the
    // authenticated user of the current holder is that person reconnecting or
    // another of their own tabs, and they can already control their own
    // presence. This is what removes the reconnect-race false positive (a
    // client back before the server reaped its old socket) without weakening
    // the cross-user protection SC-001 actually measures.
    //
    // A null principal NEVER matches, on EITHER side. Letting
    // `undefined === undefined` count as "the same user" would turn the
    // tie-break into a universal bypass for every connection missing the field
    // — fail-closed is the only correct default (research R6). EVERY holder
    // must match, so one foreign holder still makes the id foreign.
    const principal = principalOf(conn);
    if (principal != null && holders.every((holder) => principalOf(holder) === principal)) {
      continue;
    }

    if (!alreadyRecorded.has(clientId)) {                             // rule 4
      alreadyRecorded.add(clientId);
      foreignIds.push(clientId);
    }
  }

  return { allowed: foreignIds.length === 0, foreignIds };
}

module.exports = {
  AWARENESS_BLOCKED_EVENT,
  AWARENESS_BLOCK_LOG_WINDOW_MS,
  parseAwarenessFrame,
  evaluateAwarenessFrame,
  defaultPrincipalOf,
};
