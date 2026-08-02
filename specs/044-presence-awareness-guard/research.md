# Phase 0 Research — 044-presence-awareness-guard

All findings below were read out of the actual code and the vendored libraries, not
recalled. File references are symbol-anchored where possible: **041 and 042 both land in
`server/index.js` before this feature, so every line number in this document is a
2026-08-02-on-`main` snapshot and will shift.**

---

## R1 — Where the asserted clientIDs actually live in the frame

**Finding.** An awareness frame on the wire is:

```
[varuint messageType = 1 (MESSAGE_AWARENESS)]
[varuint byteLength][ awareness update bytes ]      <- lib0 writeVarUint8Array
```

and the inner awareness update (`y-protocols/awareness.js` `encodeAwarenessUpdate`, read
back by `applyAwarenessUpdate`) is:

```
[varuint entryCount]
  repeated entryCount times:
    [varuint clientID]
    [varuint clock]
    [varstring JSON.stringify(state)]     // "null" for a removal
```

The applier is reached from `y-websocket/bin/utils.js` `messageListener`:

```js
case messageAwareness: {
  awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(decoder), conn)
  break
}
```

**Decision.** The guard parses with exactly this shape and exactly these primitives:
`decoding.createDecoder` → `readVarUint` (message type) → `readVarUint8Array` (inner
update) → `readVarUint` (count) → per entry `readVarUint` / `readVarUint` /
`readVarString`. No byte indexing, no length arithmetic of our own.

**Rationale.** FR-003, and the module-header lesson in `server/ws-edit-gate.js`: lib0's
`readVarUint` accepts **non-minimal** encodings (`0x80 0x00` → 0), so a byte-index model
of the frame is a *different* model from the applier's and the difference is the bypass.
Same trap applies here one level deeper: `0x81 0x00` is clientID 1, and a guard that read
`payload[0]` would see 129.

**Alternatives rejected.** (a) Rejecting non-canonical encodings outright — closes the
hole but re-introduces a second opinion about well-formedness, which is what 038's review
called out three times. (b) Reusing `awarenessProtocol.modifyAwarenessUpdate` as a parser —
it JSON-parses and re-encodes every state; heavier, and Q2 already rejected re-encoding.

---

## R2 — Partial-decode is an exploitable gap in the spec's stated "undecodable ⇒ pass through" rule

**Finding (new, not in the spec).** `applyAwarenessUpdate` is **not atomic**. It decodes
and applies entries one at a time inside a single loop; a decode failure on entry *N*
leaves entries *1..N-1* already applied, and `messageListener`'s `try/catch` swallows the
throw. So the frame

```
[awareness][ count=2 | entry(victim clientID, high clock, forged state) | <truncated garbage> ]
```

would, under a literal reading of the spec's edge case ("undecodable ⇒ the guard treats it
as asserting no ids and lets the applier's own handling stand"), sail through the guard and
**still spoof the victim**, because the applier applies the well-formed prefix before
throwing. That is the exploit the feature exists to stop, wearing a hat.

**Decision (D-044-1, new).** Parse **incrementally**: every clientID successfully decoded
before a failure counts as asserted, and the frame is evaluated against that set. A frame
that fails before a single complete entry asserts nothing and passes straight through
(the applier rejects it identically — the spec's stated behavior, preserved for the case it
was actually describing). The parser therefore returns `{ clientIds, truncated }`, and
`truncated` never *reduces* the id set.

**Rationale.** Keeps the invariant the spec wanted ("the guard's view cannot be narrower
than the applier's") true in the presence of a non-atomic applier. Conservative in the safe
direction: the guard may see a *superset* of what the applier will apply, never a subset.

**Consequence for review.** This refines, not contradicts, the spec's "Undecodable /
malformed awareness payload" edge case. Recorded as a decision in `plan.md`.

---

## R3 — The guard reads state, it does not JSON-parse it

**Finding.** `applyAwarenessUpdate` does `JSON.parse(decoding.readVarString(decoder))`. A
frame whose entry-2 state is invalid JSON applies entry 1 and throws.

**Decision.** The guard calls `readVarString` to advance the decoder but does **not**
`JSON.parse`. It therefore sees entry 2's clientID where the applier never would.

**Rationale.** That is a superset, i.e. conservative in the same safe direction as R2 — the
guard can only over-protect. The cost is a theoretical false-positive drop for a frame with
a foreign id in an entry whose state is malformed JSON, which no honest client can emit
(every client encodes through `encodeAwarenessUpdate`, which `JSON.stringify`s). Parsing
JSON on every cursor tick would also be real per-frame cost against SC-004 for no gain.

---

## R4 — The ownership record already exists and is exactly the right one

**Finding.** `y-websocket/bin/utils.js` `WSSharedDoc` maintains
`this.conns: Map<conn, Set<number>>` — "Maps from conn to set of controlled user ids" — and
its `awarenessChangeHandler` maintains it as a side effect of application:

```js
const connControlledIDs = this.conns.get(conn)
if (connControlledIDs !== undefined) {
  added.forEach(clientID => { connControlledIDs.add(clientID) })
  removed.forEach(clientID => { connControlledIDs.delete(clientID) })
}
```

`closeConn` evicts exactly that set. This is the set 038 US5 switched presence cleanup onto.

**Decision.** Ownership = membership in these sets. The guard **reads** them and never
writes them; y-websocket stays the sole maintainer.

**Rationale.** FR-002 and Q1: no second identity model. It is also self-consistent by
construction — a first announcement is `added`, so it lands in the announcer's set right
after the guard allows it, which is what makes first-writer-wins work with no extra
bookkeeping.

**Alternatives rejected.** A reverse `Map<clientID, conn>` index maintained by the guard —
O(1) instead of O(conns) per lookup, but it is a second model of ownership that can drift
from `doc.conns` (the exact failure shape 038 kept hitting), for a lookup that is already
trivial (see R8).

**Known, pre-existing, out of scope.** Because `awarenessChangeHandler` only adds `added`
ids, a same-user reconnect that re-asserts a still-owned id registers as `updated` and does
**not** enter the new connection's set; when the stale socket is finally reaped, `closeConn`
evicts the id and the reconnected client re-adds it on its next tick (≤15 s). That flicker
exists today, is not caused by the guard, and the guard must not "fix" it by writing to
`doc.conns` — doing so would make the guard a second maintainer of the set (R4's whole
point). Called out here so a reviewer does not misattribute it to this feature.

---

## R5 — The gate has no doc handle at install time

**Finding.** In `server/index.js`'s `wss.on('connection')` handler, `installGate(ws, …)` is
called well before `setupWSConnection(ws, req, …)`, and the `doc` handle
(`getYDoc('s/' + docId, true)`) is only obtained after that. The gate therefore cannot be
handed `doc.conns` at install time.

Ordering matters and must not be swapped: leaving installation where it is keeps 038's
wiring (and the structural C1 guards that pin "exactly one `installGate(` call") intact.

**Decision.** Wire a **lazy accessor**: declare `let sharedDoc = null;` above the
`installGate` call, pass `getConns: () => (sharedDoc ? sharedDoc.conns : null)`, and assign
`sharedDoc = doc` immediately after the existing `const doc = getYDoc(wsDocName, true)`.
`getConns()` returning null (or a non-Map) means "no doc yet" ⇒ **pass through**, which is
safe because before `setupWSConnection` runs there is no `conn.on('message')` listener at
all, so the frame cannot reach any applier.

**Alternatives rejected.** (a) Hoisting `getYDoc(wsDocName, true)` above `installGate` —
works, but creates the shared doc (and triggers `bindState`) earlier and even on paths
where `setupWSConnection` throws; a behavior change for no benefit. (b) Moving
`installGate` below `setupWSConnection` — the emit wrapper would still intercept, but it
reorders 038's wiring and invalidates the reasoning recorded in its comments.

**Connection identity is safe.** `wsSimulator.simulateFlakyConnection(ws)` returns the
*same* object (it mutates `send`/`close` in place, and returns `ws` unchanged when
disabled), so the object passed to `installGate` is identical to the `conn` key
`setupWSConnection` stores in `doc.conns`. No proxy, no identity split.

---

## R6 — The connection principal for the Q3 same-user tie-break

**Finding.** `server/index.js` already stamps `ws.userId = req.user?.userId` (and
`ws.agentName`) on every connection, because y-websocket passes `ws` as the Yjs transaction
origin and `server/origin.js` `parseOrigin` reads it back. The integration harness in
`__tests__/integration/step2-viewer-block.test.js` sets the same fields "exactly as
production sets it".

**Decision.** The principal is `conn.userId`, read through an injectable
`principalOf(conn)` handler defaulting to `conn && conn.userId != null ? conn.userId : null`.
A `null` principal on **either** side never matches — two connections with unknown
principals are not "the same user".

**Rationale.** Q3 allows the carve-out only for the *same authenticated user*. Letting
`undefined === undefined` count as a match would turn the tie-break into a universal bypass
for any connection missing the field — fail-closed is the only correct default here. The
injection point keeps the `.userId` naming convention owned by `server/index.js` rather than
baked into the guard module.

**Agents are covered for free.** Agent-presence (`server/mcp/agent-presence.js`) and
import-presence (`server/import-presence.js`, which rides agent-presence sessions) connect
as ordinary `WebsocketProvider` clients with their own `Y.Doc` clientID and their own agent
JWT, so they announce ids they own and carry a real `userId`. No special case (FR-006d).

---

## R7 — The Redis relay is exempt by construction

**Finding.** The cross-instance apply path calls
`awarenessProtocol.applyAwarenessUpdate(doc.awareness, new Uint8Array(buffer), ORIGIN_REDIS)`
directly inside `redisPubSub.subscribeToDocument({ onAwareness })`. It never goes through a
`ws`, so it never passes through the gate's `emit` wrapper.

**Decision.** No code is required for FR-008. It is satisfied structurally; the plan covers
it with a **test** that pins the exemption rather than an implementation task.

**Rationale.** Anything else would be inventing a bypass in order to test it. Also note the
guard cannot accidentally catch it: `doc.conns.get(ORIGIN_REDIS)` is `undefined` because
`ORIGIN_REDIS` is the string `'redis'`, never a connection key.

---

## R8 — Cost per frame (SC-004)

**Finding.** Honest awareness traffic is one entry per frame (a client's
`awarenessChangeHandler` encodes only its own `changedClients`). The guard's work per frame
is: two varints + one length-prefixed slice + one varint + `(1 × 3)` varint/string reads,
then a `Set.has` on the sender's own set — which is the hit for essentially **every** honest
frame, terminating the check before any iteration over other connections.

Only a miss on the sender's own set (a first announcement, or a spoof) walks the other
connections' sets: O(conns × ids), with conns-per-doc in the single digits to low tens.

**Decision.** Accept the linear scan; no index, no cache, no memoization.

**Rationale.** SC-004 is "no round-trip and no perceptible latency". The common path is a
single hash lookup on top of a decode the applier is about to do anyway. Optimizing it
would buy nothing and cost the second-model risk of R4.

---

## R9 — Observability shape (Q4) with no metrics pipeline

**Finding.** `logPerf(label, data)` in `server/index.js` is a `console.log` of
`[PERF <ts>] <label> <json>` — the only "telemetry" that exists. 038's review recorded that
`WS_EDIT_BLOCKED` is console-only with no counter, and that `WS_STEP2_BLOCKED` is
noisy-by-frequency. Awareness frames fire per cursor move and per heartbeat, so an
unsuppressed per-frame log is a log-volume incident.

**Decision.** `WS_AWARENESS_BLOCKED`, emitted through the existing `onBlocked` handler, with
**per-connection** suppression built into the guard module: the first drop on a connection
always emits; afterwards at most one emission per 60 s window. Every emission carries
`{ dropped, sinceLastLog, foreignIds }` so the count survives the suppression — that is what
"countable" means with no counter infrastructure.

**Rationale.** Satisfies FR-007 and both halves of SC-003 (*every* spoofing connection
produces ≥1 event because the first is never suppressed; volume is bounded because the rest
are windowed). Per-connection state lives in the `installGate` closure and is garbage
collected with the socket — no map to leak, no cleanup handler to forget.

**Testability.** The suppressor takes an injectable `now()`; tests advance a fake clock
instead of sleeping, so the suite has no timing flake.

---

## R10 — Test strategy, inherited from 038

**Finding.** 038 established the rigor bar in three layers, all present in the tree:

1. `server/__tests__/ws-edit-gate.test.js` — unit tests against the **real exported
   module** (the file's header records why: its predecessor was pinned by a hand-written
   mirror that faithfully copied a security bug).
2. The same file's `C1` block — **structural drift guards** asserting `server/index.js`
   owns no mirrored classification logic and installs the gate exactly once.
3. `__tests__/integration/step2-viewer-block.test.js` — a real mini-server that installs
   the **real** `installGate` and speaks hand-crafted wire bytes at it, including
   non-canonical varints.

**Decision.** Mirror all three layers for awareness (see `contracts/` and `quickstart.md`).
The integration suite for 044 needs **no database** — awareness never persists — so it
stands up the mini-server without `setPersistence`, sidestepping the shared-DB serial
constraint entirely.

**Rationale.** The claim under test is "these bytes on this socket do not change that
participant's presence". Only real frames through the real wiring can prove it; a unit test
on the parser cannot.
