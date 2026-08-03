# Contract — Awareness Ownership Guard

**Feature**: 044-presence-awareness-guard
**Surface**: internal server module + the collaboration WebSocket ingestion path
**Sibling contract**: `specs/038-attribution-integrity/contracts/sync-protocol-gate.md`
(edit classification — untouched by this feature, FR-005)

---

## 1. Frame disposition table

This is the awareness counterpart of 038's classification table. **New awareness-frame
behavior must be classified here before it ships.**

| Frame | Reaches `applyAwarenessUpdate`? | Disposition |
|---|---|---|
| Not an awareness frame (sync step1/2/update, garbage) | n/a | Untouched by this guard. 038's edit gate decides. |
| Awareness, asserts only ids the connection owns | yes | **pass through** |
| Awareness, asserts an id no connection holds and the ledger does not record | yes | **pass through** (first-writer-wins claim) |
| Awareness, asserts an id the ledger records to the **same principal** | yes | **pass through** (reconnect / multi-tab / return after a drop) |
| Awareness, asserts an id held only by connection(s) of the **same authenticated user** | yes | **pass through** (reconnect / multi-tab) |
| Awareness, asserts an id held by a **different** user's connection | would have | **DROP whole frame** + `WS_AWARENESS_BLOCKED` |
| Awareness, asserts an id the ledger records to a **different principal** (incl. a lapsed one, within retention) | would have | **DROP whole frame** + `WS_AWARENESS_BLOCKED` |
| Awareness, asserts an id learned from the **cross-instance relay** | would have | **DROP whole frame** — `REMOTE_PRINCIPAL` matches no local principal |
| Awareness, every entry inert (the applier's precondition rejects it) | no (applier steps over it) | **pass through**, asserts nothing, no event — the routine client echo |
| Awareness, declares more than `MAX_FRAME_ENTRIES` entries | n/a (refused before parsing) | **DROP whole frame** + `WS_AWARENESS_BLOCKED` (`reason: 'entry-cap'`) |
| Awareness asserting ids on a connection whose doc handle never resolved | unknown | **DROP whole frame** (`reason: 'unbound'`) — fail closed |
| Awareness, mixed own + foreign ids | would have (partially) | **DROP whole frame** — no partial apply, no re-encode |
| Awareness, zero entries | yes (no-op) | **pass through** (asserts nothing) |
| Awareness, undecodable before the first complete entry | no (applier throws) | **pass through** — applier rejects it identically |
| Awareness, decodable prefix then truncated | **yes, the prefix applies** | prefix ids are asserted and evaluated normally; drop if any is foreign |
| Awareness applied via the Redis relay (no connection) | yes | **not gated** — never passes through `ws.emit` (FR-008) |

**Invariant (the 038 varint lesson, one level deeper).** The guard's view of *which ids a
frame asserts* must never be narrower than what the applier would ACT ON. It decodes with the same
`lib0/decoding` primitives `applyAwarenessUpdate` uses, accepts non-minimal varint
encodings identically, and — because the applier is not atomic — counts every id in a
decodable prefix as asserted. Do not "optimize" this into byte indexing or an
all-or-nothing parse; either one re-opens the hole.

The invariant is about the applier's EFFECT, not about the frame's contents. Entries the
applier would step over — a clock no higher than the server's, on anything but a removal
of a live state — are filtered out (`assertedIds`), because they cannot spoof and because
the real collaboration client emits them constantly (it re-broadcasts every awareness
change it applies, other participants' ids included). Refusing a frame outright, as the
entry cap does, is also within the invariant: it is the extreme of "not narrower".

---

## 2. `server/ws-awareness-guard.js` (new module)

### `AWARENESS_BLOCKED_EVENT: 'WS_AWARENESS_BLOCKED'`

The observability event name. Distinct from `WS_EDIT_BLOCKED` and `WS_STEP2_BLOCKED` so
awareness spoofing stays separately countable (Q4).

### `AWARENESS_BLOCK_LOG_WINDOW_MS: 60000`

Suppression window.

### `MAX_FRAME_ENTRIES: 64`

Largest entry count the parser will walk. Checked against the **declared** count before
the loop, so an over-count frame costs one comparison.

### `OWNERSHIP_RETENTION_MS: 300000` / `MAX_IDS_PER_PRINCIPAL: 32` / `MAX_LEDGER_ENTRIES: 4096`

Ledger bounds: how long a lapsed record reserves its id, how many ids one principal may
hold on one document, and the absolute per-document backstop.

### `REMOTE_PRINCIPAL: Symbol`

The owner recorded for a clientID learned from the cross-instance relay. A Symbol, so no
value `principalOf` can return is ever equal to it. Render it with `principalLabel`;
`JSON.stringify` drops Symbols silently.

### `parseAwarenessFrame(data) → { isAwareness, clientIds, entries, truncated, oversized }`

- **Total and throw-free on any input.** `null`, `undefined`, empty, 1-byte, non-`Buffer`,
  truncated varint, overstated entry count — all return a well-formed result.
- `isAwareness: false, clientIds: [], truncated: false` when the first varint is not
  `MESSAGE_AWARENESS` or cannot be read.
- `clientIds` preserves wire order and duplicates.
- `truncated: true` when decoding stopped before `entryCount` entries were read;
  `clientIds` still holds everything decoded up to that point.
- `oversized: true` when the declared entry count exceeds `MAX_FRAME_ENTRIES`. Nothing is
  parsed and `clientIds` is empty — callers MUST key the drop on `oversized`, never read
  the empty id list as "nothing to guard".
- `entries` is parallel to `clientIds` (same ids, same order) and carries each entry's
  `clock` and whether its state is the JSON literal `null`. `clock: null` marks an entry
  whose clock/state did not decode, which therefore has no precondition and is always
  asserted. The state is read as BYTES and never `JSON.parse`d (D-044-2).

### `assertedIds(parsed, awareness) → number[]`

The ids the applier could still act on, reproducing its own precondition:
`currClock < clock || (currClock === clock && state === null && states.has(clientID))`.

- Without an `awareness` (or one missing `meta`/`states`), every decoded id is returned —
  fail safe.
- An entry whose clock did not decode is always returned.
- Everything else is filtered out, which is what keeps the collaboration client's routine
  re-broadcast of other participants' states from being counted as an attack.

### `createOwnershipLedger({ now, retentionMs, maxPerPrincipal, maxEntries }) → { claim, lapse, ownerOf, size, entries }`

The per-document principal record (FR-002a).

- `claim(clientId, principal)` records or refreshes an owner. It NEVER steals a live
  record from another principal, and a `null` principal records nothing.
- `lapse(clientIds)` marks records whose presence state has gone away. The owner is
  **kept** for `retentionMs`, so a reconnect matches itself and a squatter does not win
  the gap. It deletes nothing from any document.
- `ownerOf(clientId)` returns the recorded principal, or `null` once retention expires.
- Per-principal quota pruning only ever forgets that principal's OWN oldest ids
  (`REMOTE_PRINCIPAL` exempt — a busy document can have any number of legitimate remote
  participants). At `maxEntries` the ledger refuses NEW records rather than evicting
  existing owners.

### `ownershipFor(doc) → { conns, awareness, ledger } | null`

The per-document view, cached in a `WeakMap` so it dies with the document. Returns `null`
for anything that is not a bound shared doc — callers fail closed on `null`.

On creation it seeds any existing awareness state that no local connection holds as
`REMOTE_PRINCIPAL`, and subscribes to the awareness `update` event so that removals lapse
and connection-less applies (the relay) record their ids as `REMOTE_PRINCIPAL` when nobody
owns them yet. An id already owned by a local principal is never relabelled, so a
participant who migrates between instances and returns still matches themselves.

### `evaluateAwarenessFrame({ conns, conn, clientIds, principalOf, ledger }) → { allowed, foreignIds, conflicts, principal }`

- `conns`: the `Map<conn, Set<number>>` borrowed from `WSSharedDoc`. **Never mutated.**
- `ledger`: optional. Omitted, the rules are exactly the pre-review ones (which is what
  keeps the ledger-free unit coverage meaningful). Supplied, a recorded owner decides the
  id: same principal allows, anyone else — including `REMOTE_PRINCIPAL` — refuses, and the
  holder scan is not reached.
- The ledger is **not written here**. Evaluation is pure; `installGate` claims after the
  verdict says allowed, so a decision and a record cannot be reordered by accident.
- `conflicts` carries `{ clientId, assertedBy, heldBy[] }` per refused id, as rendered
  principals. The shipped payload named only the asserting principal, which on a squatted
  clientID is the victim.
- Other connections are indexed **once per frame**, lazily, and only if some id is not
  resolved by the connection's own set or by the ledger.
- Returns `{ allowed: true, foreignIds: [] }` when `clientIds` is empty, when `conns` is
  not a `Map`, or when `conns` is `null` (no doc bound yet — the frame cannot reach any
  applier).
- `principalOf` defaults to `(c) => (c && c.userId != null ? c.userId : null)`.
- A `null` principal on either side never satisfies the same-user rule.
- `foreignIds` is de-duplicated and in first-seen order.

### `createDropSuppressor({ windowMs = AWARENESS_BLOCK_LOG_WINDOW_MS, now = Date.now })`

Returns `{ record(), flush() }`, both `→ null | { dropped, sinceLastLog, windowMs }`.

- The **first** `record()` always returns a payload (SC-003: every spoofing connection
  produces at least one event).
- Subsequent calls return `null` until `windowMs` has elapsed since the last emission,
  then return a payload carrying the accumulated counts.
- `dropped` is cumulative for the connection; `sinceLastLog` resets on each emission.
- `flush()` returns what the current window swallowed, or `null` when nothing has been
  suppressed since the last emission. The caller flushes on socket close, so a burst that
  ends with a disconnect reports its real size instead of `dropped: 1`.

---

## 3. `installGate` extension (`server/ws-edit-gate.js`)

```js
installGate(ws, { canEdit, onBlocked, getOwnership, principalOf })
```

Two **new, optional** handlers. Omitting them leaves 038's behavior byte-for-byte
unchanged, which is what keeps the existing gate tests and the mini-server harnesses valid.

| Handler | Type | Contract |
|---|---|---|
| `getOwnership` | `() => { conns, awareness, ledger } \| null` | Resolved **per frame**, not at install time (the doc handle does not exist yet when the gate is installed). Built by `ownershipFor(doc)`. Returning `null` makes awareness frames that assert ids FAIL CLOSED — the only way to reach that state is a collaboration-setup throw, and a socket on its way out has no presence to preserve. |
| `principalOf` | `(conn) => string \| null` | Same-user tie-break input. Defaults to reading `conn.userId`. |

**Ordering within the interceptor**, per frame:

1. `classifyFrame` → edit gating (038, unchanged; `canEdit` still read per frame).
2. If not an edit **and** the frame is an awareness frame:
   parse → drop if over the entry cap (before any ownership lookup) → filter to the ids
   the applier could act on → drop if the ownership view is missing → evaluate → drop if
   foreign → **claim the asserted ids for this principal** before delegating.
3. Step2 flag window (038, unchanged).

The claim happens BEFORE the delegated emit, not after: a removal frame is applied inside
that emit and lapses its own record on the way out, which a claim written afterwards would
resurrect.

**On a drop**: `emit` returns `false`; no listener runs; nothing is applied, broadcast, or
relayed; the socket stays open and is not notified. `onBlocked` is invoked **only when the
suppressor emits**, as:

```js
onBlocked('WS_AWARENESS_BLOCKED', {
  kind: 'awareness',
  reason,                     // 'foreign-id' | 'entry-cap' | 'unbound' | 'connection-closed'
  foreignIds,                 // number[]
  conflicts,                  // [{ clientId, assertedBy, heldBy: [...] }]
  dropped, sinceLastLog, windowMs,
})
```

One further emission shape: on socket close, a connection that dropped frames emits a
final `reason: 'connection-closed'` summary carrying the counts the suppression window
swallowed. Nothing is emitted for a connection that never dropped anything.

The existing edit-block call shape — `onBlocked(event, { kind })` — is unchanged.

**Edit classification is untouched (FR-005).** The awareness check runs only on frames
`classifyFrame` already returns `{ isEdit: false, kind: null }` for, and it never changes
what `classifyFrame` returns. Awareness frames remain "not an edit" for every role; the
guard is orthogonal and applies to viewers and editors alike.

---

## 4. `server/index.js` wiring

```js
let sharedDoc = null;                       // assigned after setupWSConnection

installGate(ws, {
  canEdit: () => currentCanEdit,            // 038, unchanged
  getOwnership: () => (sharedDoc ? awarenessOwnershipFor(sharedDoc) : null),
  onBlocked: (event, info) => { /* logPerf(event, …) + console line */ },
});

// ONE name, derived once, passed to both sides (FR-011):
const wsDocName = `s/${docId}`;
setupWSConnection(ws, req, { gc: true, docName: wsDocName });
const doc = getYDoc(wsDocName, true);
sharedDoc = doc;
```

The WebSocket server is constructed with an explicit `maxPayload` (FR-009); the transport
library's 100 MiB default is a memory-amplification primitive available to any
authenticated viewer.

**Constraints on the wiring** (pinned by structural tests, mirroring 038's C1 block):

- `server/index.js` MUST contain **exactly one** `installGate(` call.
- `server/index.js` MUST pass the SAME document-name value to `setupWSConnection` and
  `getYDoc` (FR-011), and MUST set `maxPayload` on the WebSocket server (FR-009).
- `server/index.js` MUST NOT define its own awareness parser. In particular the
  `parseAwarenessClientIds` helper deleted by 038 US5 MUST NOT reappear there — the parsing
  lives in `server/ws-awareness-guard.js` and answers a *different* question (see §6).
- `server/index.js` MUST NOT hand-roll `ws.emit = …`.
- The `onBlocked` handler MUST route `WS_AWARENESS_BLOCKED` through `logPerf`.

---

## 5. Observability

| Event | Emitted when | Payload |
|---|---|---|
| `WS_AWARENESS_BLOCKED` | An awareness frame is dropped for asserting a foreign clientID, subject to per-connection suppression | `{ connId, userId, docId, role, foreignIds, dropped, sinceLastLog }` |

Console-only via `logPerf`, matching `WS_EDIT_BLOCKED` — there is no metrics pipeline
(research R9). Countability is carried in the payload, not by a counter.

---

## 6. Note for future readers: this is not the 038 bug coming back

`server/index.js` used to hand-parse clientIDs out of a connection's first awareness frame
to guess *the sender's own id* for eviction. That was wrong by construction — an awareness
frame is a broadcast **about** a set of clients, not necessarily **from** one — and 038 US5
deleted it, moving eviction onto y-websocket's controlled-ids set.

This feature parses awareness frames again, for the opposite and correct question: **which
ids does this frame assert?** — which is exactly what a broadcast-about-a-set frame does
tell you. Eviction still comes solely from `closeConn` + the controlled-ids set; the guard
reads that set and never writes it. The comment block in `server/index.js` that records the
038 US5 deletion MUST be updated to say this, or the next reader will conclude the bug was
resurrected.
