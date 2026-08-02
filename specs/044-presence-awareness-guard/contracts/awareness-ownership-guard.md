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
| Awareness, asserts an unclaimed id | yes | **pass through** (first-writer-wins claim) |
| Awareness, asserts an id held only by connection(s) of the **same authenticated user** | yes | **pass through** (reconnect / multi-tab) |
| Awareness, asserts an id held by a **different** user's connection | would have | **DROP whole frame** + `WS_AWARENESS_BLOCKED` |
| Awareness, mixed own + foreign ids | would have (partially) | **DROP whole frame** — no partial apply, no re-encode |
| Awareness, zero entries | yes (no-op) | **pass through** (asserts nothing) |
| Awareness, undecodable before the first complete entry | no (applier throws) | **pass through** — applier rejects it identically |
| Awareness, decodable prefix then truncated | **yes, the prefix applies** | prefix ids are asserted and evaluated normally; drop if any is foreign |
| Awareness applied via the Redis relay (no connection) | yes | **not gated** — never passes through `ws.emit` (FR-008) |

**Invariant (the 038 varint lesson, one level deeper).** The guard's view of *which ids a
frame asserts* must never be narrower than the applier's. It decodes with the same
`lib0/decoding` primitives `applyAwarenessUpdate` uses, accepts non-minimal varint
encodings identically, and — because the applier is not atomic — counts every id in a
decodable prefix as asserted. Do not "optimize" this into byte indexing or an
all-or-nothing parse; either one re-opens the hole.

---

## 2. `server/ws-awareness-guard.js` (new module)

### `AWARENESS_BLOCKED_EVENT: 'WS_AWARENESS_BLOCKED'`

The observability event name. Distinct from `WS_EDIT_BLOCKED` and `WS_STEP2_BLOCKED` so
awareness spoofing stays separately countable (Q4).

### `AWARENESS_BLOCK_LOG_WINDOW_MS: 60000`

Suppression window.

### `parseAwarenessFrame(data) → { isAwareness, clientIds, truncated }`

- **Total and throw-free on any input.** `null`, `undefined`, empty, 1-byte, non-`Buffer`,
  truncated varint, overstated entry count — all return a well-formed result.
- `isAwareness: false, clientIds: [], truncated: false` when the first varint is not
  `MESSAGE_AWARENESS` or cannot be read.
- `clientIds` preserves wire order and duplicates.
- `truncated: true` when decoding stopped before `entryCount` entries were read;
  `clientIds` still holds everything decoded up to that point.

### `evaluateAwarenessFrame({ conns, conn, clientIds, principalOf }) → { allowed, foreignIds }`

- `conns`: the `Map<conn, Set<number>>` borrowed from `WSSharedDoc`. **Never mutated.**
- Returns `{ allowed: true, foreignIds: [] }` when `clientIds` is empty, when `conns` is
  not a `Map`, or when `conns` is `null` (no doc bound yet — the frame cannot reach any
  applier).
- `principalOf` defaults to `(c) => (c && c.userId != null ? c.userId : null)`.
- A `null` principal on either side never satisfies the same-user rule.
- `foreignIds` is de-duplicated and in first-seen order.

### `createDropSuppressor({ windowMs = AWARENESS_BLOCK_LOG_WINDOW_MS, now = Date.now })`

Returns `{ record() → null | { dropped, sinceLastLog, windowMs } }`.

- The **first** `record()` always returns a payload (SC-003: every spoofing connection
  produces at least one event).
- Subsequent calls return `null` until `windowMs` has elapsed since the last emission,
  then return a payload carrying the accumulated counts.
- `dropped` is cumulative for the connection; `sinceLastLog` resets on each emission.

---

## 3. `installGate` extension (`server/ws-edit-gate.js`)

```js
installGate(ws, { canEdit, onBlocked, getConns, principalOf })
```

Two **new, optional** handlers. Omitting them leaves 038's behavior byte-for-byte
unchanged, which is what keeps the existing gate tests and the mini-server harnesses valid.

| Handler | Type | Contract |
|---|---|---|
| `getConns` | `() => Map \| null` | Resolved **per frame**, not at install time (the doc handle does not exist yet when the gate is installed). Returning `null`/non-Map disables the awareness check for that frame. |
| `principalOf` | `(conn) => string \| null` | Same-user tie-break input. Defaults to reading `conn.userId`. |

**Ordering within the interceptor**, per frame:

1. `classifyFrame` → edit gating (038, unchanged; `canEdit` still read per frame).
2. If not an edit **and** the frame is an awareness frame **and** `getConns()` yields a Map:
   parse → evaluate → drop if foreign.
3. Step2 flag window (038, unchanged).

**On a drop**: `emit` returns `false`; no listener runs; nothing is applied, broadcast, or
relayed; the socket stays open and is not notified. `onBlocked` is invoked **only when the
suppressor emits**, as:

```js
onBlocked('WS_AWARENESS_BLOCKED', {
  kind: 'awareness',
  foreignIds,                 // number[]
  dropped, sinceLastLog, windowMs,
})
```

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
  getConns: () => (sharedDoc ? sharedDoc.conns : null),
  onBlocked: (event, info) => { /* logPerf(event, …) + console line */ },
});

// … later, after setupWSConnection(ws, req, { gc: true }):
const doc = getYDoc(wsDocName, true);
sharedDoc = doc;
```

**Constraints on the wiring** (pinned by structural tests, mirroring 038's C1 block):

- `server/index.js` MUST contain **exactly one** `installGate(` call.
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
