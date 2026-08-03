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
 * clientIDs it legitimately controls — its own, an unclaimed one, or one whose
 * recorded owner is the SAME authenticated principal (reconnect / multi-tab).
 * Anything else drops the whole frame, silently, with a rate-suppressed
 * WS_AWARENESS_BLOCKED event.
 *
 * ── WHERE OWNERSHIP LIVES, AND WHY IT IS NOT y-websocket's MAP ALONE ─────────
 * 044 shipped reading ownership solely from `WSSharedDoc.conns`, the
 * per-connection controlled-id set y-websocket maintains for presence eviction.
 * The post-merge reviewer proved that record LAPSES, permanently, on the most
 * ordinary event there is (HIGH-1):
 *
 *   y-websocket only ever adds a clientID to a connection's set from the
 *   `added` bucket (y-websocket/bin/utils.js awarenessChangeHandler), and
 *   `applyAwarenessUpdate` classifies an entry as `added` only when
 *   `awareness.meta.get(clientID) === undefined`. `removeAwarenessStates`
 *   deletes `states` but NEVER `meta`. So the FIRST time a doc sees a clientID
 *   it is `added`; every later announcement of that same id — after a wifi
 *   blip, laptop sleep, provider backoff reconnect or pod bounce — is
 *   `updated`, and the id never re-enters ANY connection's set. Ownership then
 *   reads as "unclaimed" and the guard fails OPEN forever: another user could
 *   overwrite and evict the reconnected participant with zero blocked events.
 *
 * The fix is the OWNERSHIP LEDGER below: a guard-owned
 * `Map<clientID, principal>` per document, written on ALLOWED frames and on the
 * cross-instance relay, lapsed when the awareness state goes away, and bounded.
 *
 * THIS IS NOT THE "SECOND OWNERSHIP MODEL" 038 KEPT FAILING ON. That failure
 * was a second EVICTION model — code that decided which presence to delete on
 * disconnect and got it wrong. Eviction is still, exclusively, y-websocket's
 * `closeConn` plus its controlled-ids set, and this module still NEVER writes
 * `doc.conns`. The ledger is a PRINCIPAL RECORD: it answers "who was allowed to
 * speak as this clientID?", it deletes nothing from any document, and if it is
 * wrong the worst outcome is a refused presence frame.
 *
 * ── CROSS-INSTANCE PARTICIPANTS ARE OWNED TOO (HIGH-2) ───────────────────────
 * The Redis relay applies remote participants' awareness with no connection at
 * all (`applyAwarenessUpdate(doc.awareness, …, ORIGIN_REDIS)`), so those
 * clientIDs exist in `doc.awareness` while belonging to NO local connection —
 * which made every remote participant hijackable from any local socket, and the
 * spoof relayed straight back to the victim's own pod. The ledger records
 * relay-learned ids under `REMOTE_PRINCIPAL`, a Symbol no authenticated
 * principal can ever equal, so a local connection cannot assert them. Relay
 * APPLIES stay exempt from the gate (FR-008) — nothing about that changed; what
 * changed is that the relay now TEACHES the ledger.
 *
 * ── AND THE PEER INSTANCE SAYS WHOSE THEY ARE (multi-replica review M4) ──────
 * `REMOTE_PRINCIPAL` alone says "somebody else's, on another instance" — which
 * is also what it says about YOUR OWN clientID once you have been relayed. With
 * two replicas behind a load balancer that is not a corner case: drop the
 * socket, get reconnected to the other instance, announce the clientID your
 * provider has held all along, and rule 2 refuses it — unconditionally, because
 * the recorded owner is a Symbol nothing can match. The frame is dropped BEFORE
 * apply, so the id never enters the new connection's controlled set and rule 1
 * never starts passing either; presence stays invisible until the record
 * expires (a removal relay plus `OWNERSHIP_RETENTION_MS`), and every 15 s
 * heartbeat in between is logged as a spoof by its own owner. Reproduced
 * against two instances before it was fixed.
 *
 * The instance that authenticated the connection knows the principal, so it now
 * SAYS SO: awareness relays carry an optional `{clientId: principal}` map (see
 * the ownership-trailer note in server/redis-pubsub.js) and `learnRelayedOwners`
 * upgrades the placeholder to the real principal. Rule 2 then does what it
 * always did — same principal passes, anyone else is refused — across instances
 * as well as within one. The placeholder remains for ids nobody vouched for.
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
 *
 * ── THE ONE THING THE GUARD MAY IGNORE: ENTRIES THE APPLIER CANNOT APPLY ─────
 * The rule above is "never NARROWER than the applier", not "never smaller than
 * the frame". `assertedIds` drops entries whose `(clientID, clock, state)`
 * fails `applyAwarenessUpdate`'s own precondition — an entry the applier will
 * step over cannot spoof anything. This is not an optimisation, it is a
 * CORRECTNESS fix (FP-1): the real y-websocket CLIENT re-broadcasts every
 * awareness change it applies, including OTHER participants' ids
 * (y-websocket/src/y-websocket.js `_awarenessUpdateHandler` ignores the origin),
 * so in any session with two or more participants every honest client sends the
 * server frames asserting the other participants' clientIDs. Those echoes carry
 * the clock the server already has, so the applier discards them — but the
 * shipped guard called them spoofs and logged an innocent user as the offender
 * on every join and every cursor move. The precondition is evaluated against
 * the live awareness immediately before the frame is delegated, in the same
 * synchronous turn the applier runs in, so the two cannot disagree.
 *
 * ── SELF-IMPERSONATION IS OUT OF SCOPE (LOW-8, Q3) ───────────────────────────
 * The principal is the authenticated USER ID, not the connection or the token.
 * A user's agent token can therefore assert and evict that same user's browser
 * clientID — one human impersonating themselves. That is deliberate: it is what
 * makes reconnect and multi-tab work (Q3), and it grants no access the principal
 * does not already have. Cross-principal assertion is the boundary this module
 * defends; intra-principal assertion is not defended, by design. Stated the same
 * way in specs/044-presence-awareness-guard/spec.md.
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
 * Hard cap on the entries the guard will parse out of one awareness frame
 * (HIGH-3). The reviewer measured a 9 MB frame declaring 3,000,000 entries:
 * `applyAwarenessUpdate` threw at entry 1 in 0.16 ms, while the guard spent
 * ~1 s of BLOCKED EVENT LOOP decoding and cross-checking ids — and then ALLOWED
 * the frame (every id unowned), so it did not even leave a log line. Any
 * authenticated viewer on any readable document could repeat it at will.
 *
 * An honest client encodes the clients it just saw change; the only frames that
 * legitimately carry many entries are a fresh client's echo of the server's
 * full-state broadcast, which is inert by clock (see `assertedIds`) and which
 * nothing depends on the server receiving. 64 is far above any real presence
 * fan-in and small enough that the parse is O(1) against a hostile count: the
 * count is checked BEFORE the loop, so an overstated count costs nothing.
 *
 * Dropping an over-cap frame is fail-CLOSED, which is always safe here: the
 * guard's id set may never be narrower than the applier's, and refusing a frame
 * outright is the extreme of "not narrower".
 */
const MAX_FRAME_ENTRIES = 64;

/**
 * How long the ledger keeps a lapsed clientID reserved for its last principal.
 *
 * When a participant's awareness state goes away (socket close, explicit
 * removal, y-protocols' 30 s staleness prune) the id is NOT forgotten
 * immediately: it is marked lapsed and stays matchable by the SAME principal
 * for this long. Two findings need that window.
 *
 *  - Reconnect (HIGH-1/FR-006c): a client that comes back after a blip, a sleep
 *    or a pod bounce re-announces its stable clientID and must match itself.
 *  - Squatting (MEDIUM-4): without a window, an attacker who watches the
 *    ordinary presence broadcast learns a victim's clientID, waits for the
 *    socket to drop, and claims the id first — the victim is then refused with
 *    a blocked event naming the VICTIM, and stays locked out for as long as the
 *    attacker keeps the forged state alive. Five minutes covers every reconnect
 *    path in this codebase (the client's backoff tops out in seconds, a pod
 *    rollout in tens of seconds) and makes the squat window a race the attacker
 *    has to win against the victim's own reconnect rather than a wait.
 *
 * It is a RESERVATION, never an eviction: a lapsed entry only ever refuses
 * another principal's claim. Nothing is deleted from any document because of it.
 */
const OWNERSHIP_RETENTION_MS = 300000;

/**
 * Ledger entries one principal may hold on one document before its oldest is
 * forgotten. A human has one clientID per tab; agent and import sessions have
 * one each. 32 is generous for real use and is what stops a flooder from
 * cannibalising OTHER principals' records: over-quota pruning only ever removes
 * the flooder's own entries, so no amount of id churn can un-own a victim.
 */
const MAX_IDS_PER_PRINCIPAL = 32;

/**
 * Absolute per-document ledger bound (memory backstop). Reached only by a
 * document with thousands of distinct principals inside one retention window;
 * past it the ledger refuses NEW records rather than evicting existing ones, so
 * the failure mode is "this id falls back to the y-websocket-only rules" — the
 * pre-fix behavior — and never "this id's owner was forgotten".
 */
const MAX_LEDGER_ENTRIES = 4096;

/**
 * The owner recorded for a clientID learned from the cross-instance relay
 * (HIGH-2). A Symbol, so it is not equal to any principal `principalOf` can
 * return — a local connection can never match it, whatever its userId. Exported
 * for tests and for log rendering; never compare it with `==`.
 */
const REMOTE_PRINCIPAL = Symbol('awareness.remote-instance');

/** JSON whitespace (RFC 8259): space, tab, LF, CR. Nothing else counts. */
const isJsonWhitespaceByte = (b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

/**
 * Are these UTF-8 bytes exactly the JSON literal `null` (the removal state)?
 *
 * Byte-level and allocation-free: the state string can be kilobytes of cursor
 * payload on every tick, and `JSON.parse` on that path is what D-044-2 refuses.
 * The test has to be EXACT in both directions, because it decides whether a
 * same-clock entry could still evict a participant:
 *   - saying "not null" about a real `null` would let a removal spoof through;
 *   - saying "null" about anything else only ever makes the guard stricter.
 * `JSON.parse` accepts leading/trailing JSON whitespace around a literal, so we
 * do too — and nothing else, since `JSON.parse` would throw on anything else
 * and the applier would then apply nothing.
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function isJsonNullBytes(bytes) {
  if (!bytes || typeof bytes.length !== 'number') return false;
  let start = 0;
  let end = bytes.length - 1;
  while (start <= end && isJsonWhitespaceByte(bytes[start])) start += 1;
  while (end >= start && isJsonWhitespaceByte(bytes[end])) end -= 1;
  return end - start === 3
    && bytes[start] === 0x6e      // n
    && bytes[start + 1] === 0x75  // u
    && bytes[start + 2] === 0x6c  // l
    && bytes[start + 3] === 0x6c; // l
}

/**
 * Extract what an awareness frame ASSERTS, parsing it the same way
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
 * The state is read as BYTES, never `JSON.parse`d (D-044-2). `readVarUint8Array`
 * consumes exactly what `readVarString` consumes — lib0's `readVarString` IS
 * `utf8TextDecoder.decode(readVarUint8Array(decoder))` — so the decoder advances
 * identically to the applier's while skipping a UTF-8 decode of every cursor
 * payload. The only thing read out of those bytes is whether they are the JSON
 * literal `null`, which `assertedIds` needs to reproduce the applier's
 * precondition for removals.
 *
 * Total and throw-free on ANY input — null, undefined, empty, 1-byte,
 * non-Buffer, garbage, truncated varint, overstated entry count — exactly the
 * contract `classifyFrame` holds.
 *
 * @param {Buffer|Uint8Array|null|undefined} data - Raw message bytes
 * @returns {{ isAwareness: boolean, clientIds: number[],
 *             entries: Array<{clientId: number, clock: number|null, stateIsNull: boolean}>,
 *             truncated: boolean, oversized: boolean }}
 *   `entries` is parallel to `clientIds` (same ids, same order); `clock === null`
 *   marks an entry whose clock/state could not be decoded, which therefore has
 *   no precondition and is always asserted.
 */
function parseAwarenessFrame(data) {
  const result = {
    isAwareness: false, clientIds: [], entries: [], truncated: false, oversized: false,
  };
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

  // HIGH-3: checked BEFORE the loop, so a frame declaring three million entries
  // costs one comparison instead of a second of event loop. Fail closed.
  if (entryCount > MAX_FRAME_ENTRIES) {
    result.oversized = true;
    return result;
  }

  for (let i = 0; i < entryCount; i++) {
    let clientId;
    try {
      // Recorded BEFORE clock/state: D-044-1 counts every decoded clientID.
      clientId = decoding.readVarUint(decoder);
    } catch {
      result.truncated = true;
      return result;
    }
    result.clientIds.push(clientId);

    try {
      const clock = decoding.readVarUint(decoder);
      const stateBytes = decoding.readVarUint8Array(decoder);
      result.entries.push({ clientId, clock, stateIsNull: isJsonNullBytes(stateBytes) });
    } catch {
      // The id is asserted; its precondition is unknowable, so it is never
      // filtered out downstream (`clock: null`).
      result.entries.push({ clientId, clock: null, stateIsNull: false });
      result.truncated = true;
      return result;
    }
  }

  return result;
}

/**
 * The ids a parsed frame asserts that `applyAwarenessUpdate` could still act on.
 *
 * Reproduces the applier's own per-entry precondition
 * (y-protocols/dist/awareness.cjs):
 *
 *   currClock < clock  ||  (currClock === clock && state === null && states.has(clientID))
 *
 * where `currClock` is `awareness.meta.get(clientID).clock`, or 0 when the id is
 * unknown. An entry failing that test changes NOTHING — no state, no meta, no
 * emitted event — so it cannot spoof, cannot evict, and must not be treated as
 * an assertion. That is what stops the real y-websocket client's routine
 * re-broadcast of other participants' states from being logged as an attack
 * (FP-1, see the module header).
 *
 * Conservative wherever it cannot be exact: an entry whose clock did not decode
 * (`clock === null`) is always asserted, and without an `awareness` to compare
 * against every decoded id is asserted. The result is never narrower than what
 * the applier would touch.
 *
 * @param {{clientIds: number[], entries: Array<object>}} parsed - `parseAwarenessFrame` output
 * @param {{meta: Map<number, {clock: number}>, states: Map<number, *>}} [awareness]
 * @returns {number[]} asserted ids, wire order, duplicates preserved
 */
function assertedIds(parsed, awareness) {
  if (!parsed || !Array.isArray(parsed.entries)) return [];
  if (!awareness || !(awareness.meta instanceof Map) || !(awareness.states instanceof Map)) {
    return Array.isArray(parsed.clientIds) ? parsed.clientIds.slice() : [];
  }

  const ids = [];
  for (const entry of parsed.entries) {
    if (entry.clock === null) {                       // undecodable ⇒ assume live
      ids.push(entry.clientId);
      continue;
    }
    const meta = awareness.meta.get(entry.clientId);
    const currClock = meta === undefined ? 0 : meta.clock;
    if (currClock < entry.clock) {
      ids.push(entry.clientId);
    } else if (currClock === entry.clock && entry.stateIsNull && awareness.states.has(entry.clientId)) {
      // A same-clock removal IS applied by the applier — the nastier half of
      // the original finding, and the one echo shape that is not inert.
      ids.push(entry.clientId);
    }
  }
  return ids;
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
 * The guard-owned ownership ledger for ONE document: which principal was last
 * allowed to speak as each clientID.
 *
 * Read the module header for why this exists and why it is not a second
 * eviction model. Operationally it is a small, bounded, self-pruning map:
 *
 *   claim(id, principal)  record/refresh an owner — only on ALLOWED frames and
 *                         on relay-learned ids; NEVER steals an id from a live
 *                         owner (a caller that tried would be a bug, so it is
 *                         refused rather than trusted)
 *   lapse(ids)            the awareness state went away: keep the owner, start
 *                         the retention clock
 *   ownerOf(id)           the current owner, or null once retention expires
 *
 * Everything is lazy — expiry happens on read, quota pruning on write — so
 * there is no timer to leak and nothing to unregister. The whole ledger is
 * garbage collected with its document (`ownershipFor` holds it in a WeakMap).
 *
 * @param {object} [options] - all injectable so tests advance a clock instead of sleeping
 * @returns {{claim: Function, lapse: Function, ownerOf: Function, size: Function, entries: Function}}
 */
function createOwnershipLedger({
  now = Date.now,
  retentionMs = OWNERSHIP_RETENTION_MS,
  maxPerPrincipal = MAX_IDS_PER_PRINCIPAL,
  maxEntries = MAX_LEDGER_ENTRIES,
} = {}) {
  /** @type {Map<number, {principal: *, lapsedAt: number|null}>} insertion-ordered */
  const records = new Map();

  const isExpired = (record, at) => record.lapsedAt !== null && at - record.lapsedAt >= retentionMs;

  /** Drop every expired record. Called only on the write path, never per frame. */
  function sweep(at) {
    for (const [clientId, record] of records) {
      if (isExpired(record, at)) records.delete(clientId);
    }
  }

  /**
   * Keep one principal's footprint bounded by forgetting ITS OWN oldest ids.
   * Deliberately not applied to REMOTE_PRINCIPAL: a busy document can have any
   * number of legitimate participants on other instances, and forgetting them
   * would re-open HIGH-2. Remote records stay bounded by `maxEntries`.
   */
  function enforceQuota(principal) {
    if (principal === REMOTE_PRINCIPAL) return;
    const owned = [];
    for (const [clientId, record] of records) {
      if (record.principal === principal) owned.push(clientId);
    }
    for (let i = 0; i < owned.length - maxPerPrincipal; i++) records.delete(owned[i]);
  }

  return {
    /**
     * Record `principal` as the owner of `clientId`, or refresh an existing
     * record of the same principal (which also un-lapses it).
     * @returns {boolean} whether the ledger now records this owner
     */
    claim(clientId, principal) {
      if (principal == null || !Number.isFinite(clientId)) return false;
      const at = now();
      const existing = records.get(clientId);
      if (existing !== undefined && !isExpired(existing, at)) {
        if (existing.principal !== principal) return false;  // never steal a live record
        existing.lapsedAt = null;
        return true;
      }
      records.delete(clientId);
      if (records.size >= maxEntries) {
        sweep(at);
        if (records.size >= maxEntries) return false;        // refuse, never evict a stranger
      }
      records.set(clientId, { principal, lapsedAt: null });
      enforceQuota(principal);
      return records.has(clientId);
    },

    /**
     * Record an owner a TRUSTED PEER INSTANCE vouched for (multi-replica review
     * M4). Called only from the Redis awareness relay, with the principal the
     * publishing instance authenticated for that clientID.
     *
     * WHY THIS IS NOT JUST `claim`: `claim` refuses to overwrite a live record,
     * and the record it has to overwrite here is the `REMOTE_PRINCIPAL`
     * placeholder this module writes when it knows an id came from elsewhere but
     * not whose it is. Leaving that placeholder in place is what made a
     * legitimate participant a "spoofer" the moment a load balancer moved them
     * to another instance: rule 2 refused their own clientID unconditionally,
     * the frame was dropped BEFORE apply so they never entered this connection's
     * controlled set, and nothing but expiry (a removal relay plus the 5 minute
     * retention) could ever release it.
     *
     * It UPGRADES a placeholder and refreshes the same principal; it never takes
     * an id away from a DIFFERENT principal that a LOCAL connection was allowed
     * to speak as. So the security property is unchanged — no local connection
     * can assert an id belonging to another authenticated user — and the guard
     * gets STRICTER, not looser: a relayed id is now owned by a named principal
     * instead of a placeholder that also blocked its real owner.
     *
     * @param {number} clientId
     * @param {*} principal - the remote instance's authenticated principal
     * @returns {boolean} whether the ledger now records this owner
     */
    learnRemote(clientId, principal) {
      if (principal == null || principal === REMOTE_PRINCIPAL || !Number.isFinite(clientId)) return false;
      const at = now();
      const existing = records.get(clientId);
      if (existing !== undefined && !isExpired(existing, at)) {
        if (existing.principal !== principal && existing.principal !== REMOTE_PRINCIPAL) return false;
        existing.principal = principal;
        existing.lapsedAt = null;
        enforceQuota(principal);
        return records.has(clientId);
      }
      records.delete(clientId);
      if (records.size >= maxEntries) {
        sweep(at);
        if (records.size >= maxEntries) return false;
      }
      records.set(clientId, { principal, lapsedAt: null });
      enforceQuota(principal);
      return records.has(clientId);
    },

    /**
     * The awareness states for these ids are gone. The owner is REMEMBERED for
     * `retentionMs` (see OWNERSHIP_RETENTION_MS) so a reconnect matches itself
     * and a squatter does not win the gap.
     * @param {Iterable<number>} clientIds
     */
    lapse(clientIds) {
      if (!clientIds) return;
      const at = now();
      for (const clientId of clientIds) {
        const record = records.get(clientId);
        if (record !== undefined && record.lapsedAt === null) record.lapsedAt = at;
      }
    },

    /**
     * @param {number} clientId
     * @returns {*} the recorded principal, or null when unrecorded or expired
     */
    ownerOf(clientId) {
      const record = records.get(clientId);
      if (record === undefined) return null;
      if (isExpired(record, now())) {
        records.delete(clientId);
        return null;
      }
      return record.principal;
    },

    /** Current record count (tests and the memory bound). */
    size() {
      return records.size;
    },

    /** A copy, for tests and diagnostics. Never the live map. */
    entries() {
      return new Map([...records].map(([id, r]) => [id, { ...r }]));
    },
  };
}

/**
 * The ownership view of one `WSSharedDoc`: y-websocket's controlled-id map, the
 * awareness the applier will act on, and this document's ledger.
 *
 * Created once per document and cached in a WeakMap, so it dies with the doc —
 * no global registry, no eviction handler to forget, and a doc rebuilt under the
 * same name (bind refusal, reconnect) starts with a fresh ledger.
 *
 * On creation it does two things beyond allocating:
 *
 *  1. SEEDS from any awareness state already present that no local connection
 *     holds. Those can only have come from somewhere else (the relay, a doc
 *     loaded before the first socket), so they are recorded as REMOTE_PRINCIPAL
 *     rather than left claimable.
 *  2. SUBSCRIBES to the awareness `update` event to keep the ledger honest:
 *     removals lapse, and applies that arrive with an origin that is NOT one of
 *     this document's connections — i.e. the cross-instance relay — record their
 *     ids as REMOTE_PRINCIPAL if nobody owns them yet. An id already owned by a
 *     LOCAL principal is left alone, so a participant who migrates between pods
 *     and comes back still matches themselves.
 *
 * The listener is registered on the document's own awareness, so it is torn down
 * with the document. It reads and writes only the ledger.
 *
 * @param {*} doc - a y-websocket `WSSharedDoc`
 * @returns {{conns: Map, awareness: object, ledger: object}|null} null when the
 *   handle is not a usable shared doc yet (callers must fail closed on null)
 */
const ownershipByDoc = new WeakMap();

function ownershipFor(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (!(doc.conns instanceof Map) || !doc.awareness) return null;

  const cached = ownershipByDoc.get(doc);
  if (cached) return cached;

  const ledger = createOwnershipLedger();
  const ownership = { conns: doc.conns, awareness: doc.awareness, ledger };
  ownershipByDoc.set(doc, ownership);

  const heldByAnyConnection = (clientId) => {
    for (const controlledIds of doc.conns.values()) {
      if (controlledIds && controlledIds.has(clientId)) return true;
    }
    return false;
  };

  if (typeof doc.awareness.getStates === 'function') {
    for (const clientId of doc.awareness.getStates().keys()) {
      if (!heldByAnyConnection(clientId)) ledger.claim(clientId, REMOTE_PRINCIPAL);
    }
  }

  if (typeof doc.awareness.on === 'function') {
    doc.awareness.on('update', ({ added, updated, removed }, origin) => {
      if (removed && removed.length > 0) ledger.lapse(removed);
      // A local frame's ids were already claimed by the gate, under the real
      // principal, BEFORE the frame was delegated. Anything else reaching the
      // awareness without a connection of this document behind it came from
      // another instance.
      if (doc.conns.has(origin)) return;
      if (added) {
        for (const clientId of added) {
          if (ledger.ownerOf(clientId) === null) ledger.claim(clientId, REMOTE_PRINCIPAL);
        }
      }
      if (updated) {
        for (const clientId of updated) {
          if (ledger.ownerOf(clientId) === null) ledger.claim(clientId, REMOTE_PRINCIPAL);
        }
      }
    });
  }

  return ownership;
}

/**
 * What this instance is willing to VOUCH FOR about the clientIDs it is relaying
 * (multi-replica review M4): the ledger's own record of which authenticated
 * principal was allowed to speak as each of them, as a JSON-able object for the
 * cross-instance awareness message.
 *
 * Only ids this instance owns LOCALLY are included. An id whose recorded owner
 * is `REMOTE_PRINCIPAL` was learned from somewhere else and this instance has
 * nothing first-hand to say about it, so it is omitted rather than re-asserted —
 * vouching travels one hop, from the instance that authenticated the connection.
 *
 * @param {*} doc - a y-websocket `WSSharedDoc`
 * @param {Iterable<number>} clientIds - the ids the outgoing message carries
 * @returns {Object|null} `{ [clientId]: principal }`, or null when there is
 *   nothing to vouch for (callers then publish exactly the pre-M4 bytes)
 */
function localOwnersOf(doc, clientIds) {
  if (!clientIds) return null;
  const ownership = ownershipFor(doc);
  if (!ownership) return null;
  let owners = null;
  for (const clientId of clientIds) {
    const principal = ownership.ledger.ownerOf(clientId);
    if (typeof principal !== 'string' || principal === '') continue;
    if (owners === null) owners = {};
    owners[clientId] = principal;
  }
  return owners;
}

/**
 * Teach this document's ledger the owners a peer instance vouched for (M4).
 *
 * Call BEFORE applying the relayed awareness update: the ledger listener
 * installed by `ownershipFor` stamps `REMOTE_PRINCIPAL` on ids it sees arrive
 * with no local connection behind them, and learning first means the real
 * principal is already recorded when that runs.
 *
 * Hostile-input rules apply even though the sender is a peer: ids and
 * principals are validated, and the batch is capped, so a malformed map costs
 * nothing and can never displace a live LOCAL record (see `learnRemote`).
 *
 * @param {*} doc - a y-websocket `WSSharedDoc`
 * @param {Object|null} owners - `{ [clientId]: principal }` from the relay
 * @returns {number} how many records were learned or refreshed
 */
function learnRelayedOwners(doc, owners) {
  if (!owners || typeof owners !== 'object') return 0;
  const ownership = ownershipFor(doc);
  if (!ownership) return 0;
  let learned = 0;
  let seen = 0;
  for (const key of Object.keys(owners)) {
    if ((seen += 1) > MAX_LEDGER_ENTRIES) break;
    const clientId = Number(key);
    const principal = owners[key];
    if (!Number.isFinite(clientId) || typeof principal !== 'string' || principal === '') continue;
    if (ownership.ledger.learnRemote(clientId, principal)) learned += 1;
  }
  return learned;
}

/**
 * Render a principal for a log line. The remote sentinel is a Symbol, which
 * `JSON.stringify` drops silently — exactly the kind of hole that makes an
 * incident unreadable.
 *
 * @param {*} principal
 * @returns {string|null}
 */
function principalLabel(principal) {
  if (principal === REMOTE_PRINCIPAL) return 'remote-instance';
  if (principal == null) return null;
  return String(principal);
}

/**
 * Decide whether `conn` may assert `clientIds` on this document (FR-001/FR-002).
 *
 * Ownership rules, per asserted clientID, in order:
 *   1. the id is in the connection's OWN controlled-id set        → allow
 *   2. the LEDGER records an owner for it
 *        · same principal (non-null)                              → allow
 *          (reconnect / multi-tab / same user's second pod — the last of those
 *           works because a peer instance vouches for its participants, M4)
 *        · anyone else, including REMOTE_PRINCIPAL                → foreign
 *          (REMOTE_PRINCIPAL now means "relayed and UNVOUCHED", so it no longer
 *           stands between a participant and their own id, see the header)
 *   3. no ledger record, and the id is held by NO other connection → allow
 *      (first-writer-wins: this is how a first announcement claims an id)
 *   4. no ledger record, and every holder has the SAME, non-null principal → allow
 *   5. otherwise                                                  → foreign
 *
 * ONE foreign id drops the WHOLE frame (Q2, FR-004): no partial apply, no
 * re-encode. A well-behaved client's awareness handler only ever encodes its
 * own single clientID, so honest traffic never reaches that path.
 *
 * `conns` is the `Map<conn, Set<number>>` borrowed from `WSSharedDoc`. It is
 * READ ONLY — never mutated here, not even to "help" y-websocket keep it
 * current. y-websocket's `awarenessChangeHandler` and `closeConn` are its sole
 * maintainers (research R4); a second writer is the drift this feature exists
 * not to repeat. The ledger is not written here either: this function is pure
 * so the decision and the record cannot be reordered by accident — `installGate`
 * claims AFTER the verdict says allowed.
 *
 * COST (SC-004, HIGH-3c). Rule 1 is one `Set.has` and terminates the honest
 * path before anything else is touched. The holder index over other connections
 * is built AT MOST ONCE PER FRAME, and only if some id reaches rule 3 — the
 * shipped code rescanned every connection for every asserted id, which is the
 * O(ids × conns) half of the DoS.
 *
 * @param {object} args
 * @param {Map<*, Set<number>>|null} args.conns - Borrowed ownership map
 * @param {*} args.conn - The asserting connection (a key of `conns`)
 * @param {number[]} args.clientIds - Ids the frame asserts, in wire order
 * @param {function(*): (string|null)} [args.principalOf] - Same-user tie-break input
 * @param {object} [args.ledger] - This document's ownership ledger (see `ownershipFor`)
 * @returns {{allowed: boolean, foreignIds: number[], conflicts: object[], principal: *}}
 *   `foreignIds` de-duplicated in first-seen order; `conflicts` carries the
 *   asserting and holding principals per refused id (MEDIUM-4: the shipped log
 *   named only the asserting user, which on a squat is the VICTIM).
 */
function evaluateAwarenessFrame({ conns, conn, clientIds, principalOf = defaultPrincipalOf, ledger = null }) {
  const principal = typeof principalOf === 'function' ? principalOf(conn) : null;
  // Nothing asserted, or no document bound yet (callers fail closed on a
  // missing map before they get here; this stays permissive so the function
  // itself is total).
  if (!Array.isArray(clientIds) || clientIds.length === 0) {
    return { allowed: true, foreignIds: [], conflicts: [], principal };
  }
  if (!(conns instanceof Map)) {
    return { allowed: true, foreignIds: [], conflicts: [], principal };
  }

  const ownIds = conns.get(conn);
  const foreignIds = [];
  const conflicts = [];
  const alreadyRecorded = new Set();

  /** Built lazily, once per frame — see the COST note above. */
  let holderIndex = null;
  const holdersOf = (clientId) => {
    if (holderIndex === null) {
      holderIndex = new Map();
      for (const [otherConn, controlledIds] of conns) {
        if (otherConn === conn || !controlledIds) continue;
        for (const heldId of controlledIds) {
          const holders = holderIndex.get(heldId);
          if (holders) holders.push(otherConn);
          else holderIndex.set(heldId, [otherConn]);
        }
      }
    }
    return holderIndex.get(clientId) || [];
  };

  const refuse = (clientId, heldBy) => {
    if (alreadyRecorded.has(clientId)) return;
    alreadyRecorded.add(clientId);
    foreignIds.push(clientId);
    conflicts.push({
      clientId,
      assertedBy: principalLabel(principal),
      heldBy: heldBy.map(principalLabel),
    });
  };

  for (const clientId of clientIds) {
    if (ownIds && ownIds.has(clientId)) continue;                     // rule 1

    // Rule 2 — the ledger. This is the record that survives a reconnect, and
    // the one that knows about participants living on another instance.
    const recordedOwner = ledger ? ledger.ownerOf(clientId) : null;
    if (recordedOwner !== null) {
      // A null principal NEVER matches, on EITHER side. Letting
      // `undefined === undefined` count as "the same user" would turn the
      // tie-break into a universal bypass for every connection missing the
      // field — fail-closed is the only correct default (research R6).
      if (principal != null && recordedOwner === principal) continue;
      refuse(clientId, [recordedOwner]);
      continue;
    }

    const holders = holdersOf(clientId);
    if (holders.length === 0) continue;                               // rule 3

    // Rule 4 — the same-user tie-break (Q3). A spoof is BY DEFINITION a
    // different principal claiming your identity: a connection sharing the
    // authenticated user of the current holder is that person reconnecting or
    // another of their own tabs, and they can already control their own
    // presence. EVERY holder must match, so one foreign holder still makes the
    // id foreign.
    if (principal != null && holders.every((holder) => principalOf(holder) === principal)) {
      continue;
    }

    refuse(clientId, holders.map((holder) => principalOf(holder)));   // rule 5
  }

  return { allowed: foreignIds.length === 0, foreignIds, conflicts, principal };
}

/**
 * A per-connection log suppressor for dropped awareness frames (FR-007).
 *
 * Awareness frames fire on every cursor move and every 15 s heartbeat, so an
 * attacker sending one spoof per tick would produce one log line per tick. This
 * bounds that: the FIRST drop on a connection always emits — which is what
 * makes "every distinct spoofing connection produces at least one countable
 * event" (SC-003) true — and afterwards at most one emission per window.
 *
 * There is no metrics pipeline in this codebase (research R9), so countability
 * has to survive suppression inside the payload: every emission carries the
 * connection's cumulative `dropped` and the `sinceLastLog` accumulated while it
 * was quiet. An operator can therefore reconstruct the volume from the lines
 * that did get logged.
 *
 * NOTE on the first emission's numbers: because the first drop emits
 * immediately, its payload reads `dropped: 1`. The accumulated count arrives
 * with the NEXT windowed emission (D-044-3). Emitting-first-then-summarising is
 * the ordering SC-003's "at least one event per spoofing connection" requires —
 * a suppressor that waited for the window to close would report richer counts
 * but could stay silent for a full window about an attack in progress.
 *
 * `flush()` closes the other half of that trade (LOW-5). A burst that ends
 * before the window does — 500 spoofs and then the socket drops — used to leave
 * the record reading `dropped: 1`, understating the attack 500-fold, because the
 * suppressor state lives in the caller's closure and simply went out of scope.
 * The caller flushes on close, and the final line reports what the window
 * swallowed.
 *
 * State lives in the caller's closure (the `installGate` closure, in practice),
 * so it is garbage collected with the socket: no global map, and no way for one
 * connection's traffic to silence another's alarm.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs] - Minimum gap between emissions
 * @param {function(): number} [options.now] - Injectable clock (tests advance it
 *   instead of sleeping, so the suite has no timing flake)
 * @returns {{record: Function, flush: Function}}
 */
function createDropSuppressor({ windowMs = AWARENESS_BLOCK_LOG_WINDOW_MS, now = Date.now } = {}) {
  let dropped = 0;
  let sinceLastLog = 0;
  let lastLoggedAt = null;

  return {
    /** Record one dropped frame. Returns a payload to log, or null if suppressed. */
    record() {
      dropped += 1;
      sinceLastLog += 1;

      const at = now();
      if (lastLoggedAt !== null && at - lastLoggedAt < windowMs) return null;

      lastLoggedAt = at;
      const payload = { dropped, sinceLastLog, windowMs };
      sinceLastLog = 0;
      return payload;
    },

    /**
     * Emit whatever the current window swallowed, for a connection that is
     * going away. Returns null when nothing has been suppressed since the last
     * emission, so a clean close adds no line.
     */
    flush() {
      if (sinceLastLog === 0) return null;
      const payload = { dropped, sinceLastLog, windowMs };
      sinceLastLog = 0;
      lastLoggedAt = now();
      return payload;
    },
  };
}

module.exports = {
  AWARENESS_BLOCKED_EVENT,
  AWARENESS_BLOCK_LOG_WINDOW_MS,
  MAX_FRAME_ENTRIES,
  OWNERSHIP_RETENTION_MS,
  MAX_IDS_PER_PRINCIPAL,
  MAX_LEDGER_ENTRIES,
  REMOTE_PRINCIPAL,
  parseAwarenessFrame,
  assertedIds,
  evaluateAwarenessFrame,
  createOwnershipLedger,
  ownershipFor,
  localOwnersOf,
  learnRelayedOwners,
  principalLabel,
  defaultPrincipalOf,
  createDropSuppressor,
};
