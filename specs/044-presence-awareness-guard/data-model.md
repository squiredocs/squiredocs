# Phase 1 Data Model — 044-presence-awareness-guard

**No database entities. No migrations. No schema change.** Presence is ephemeral Yjs
awareness state held in memory per server instance; nothing this feature touches is
persisted, and `yjs_updates` is not on any path here. The "data model" is entirely
in-memory protocol and connection state.

---

## 1. Awareness frame (untrusted wire input)

The ingestion surface this feature declares a trust boundary over (Constitution V).

| Field | Wire form | Notes |
|---|---|---|
| `messageType` | varuint | `1` = `MESSAGE_AWARENESS`. Anything else is not this feature's concern. |
| `payload` | varuint length + bytes | The inner awareness update, read with `readVarUint8Array`. |
| `payload.entryCount` | varuint | Declared number of `(clientID, clock, state)` tuples. **Not trusted** — may exceed the bytes actually present. |
| `payload.entries[i].clientID` | varuint | **Client-chosen. Authenticated against nothing by the protocol.** This is the field the whole feature is about. |
| `payload.entries[i].clock` | varuint | Higher clock wins in `applyAwarenessUpdate`; this is what makes an unguarded overwrite possible. |
| `payload.entries[i].state` | varstring | `JSON.stringify(state)`; the literal string `"null"` is a removal (eviction). |

**Validation policy**: none of these fields is corrected, rewritten, or re-encoded. The
frame is either passed through untouched or dropped whole (Q2). Encodings are accepted
exactly as `lib0/decoding` accepts them, non-minimal varints included (FR-003).

---

## 2. `ParsedAwarenessFrame` (derived, in-memory, per frame)

Produced by `parseAwarenessFrame(data)`; the guard's only view of the frame.

| Field | Type | Meaning |
|---|---|---|
| `isAwareness` | `boolean` | The frame's first varint decoded to `MESSAGE_AWARENESS`. `false` short-circuits everything else. |
| `clientIds` | `number[]` | Every clientID successfully decoded, **in wire order**, including duplicates. |
| `truncated` | `boolean` | Decoding stopped early (short buffer, bad varint, `entryCount` overstated). Diagnostic only. |

**Invariants**

- `clientIds` is a **superset** of the ids `applyAwarenessUpdate` will actually reach, never
  a subset (research R2, R3). `truncated: true` never shrinks `clientIds`.
- `isAwareness: false` and `clientIds: []` for every non-awareness or wholly undecodable
  input; the function is total and throw-free on any input (`null`, `undefined`, empty,
  1-byte, non-Buffer, garbage) — the same contract `classifyFrame` holds.

---

## 3. Ownership map (read-only borrow from y-websocket)

`WSSharedDoc.conns: Map<conn, Set<number>>` — "maps from conn to set of controlled user
ids". Owned and maintained **solely** by `y-websocket`'s `awarenessChangeHandler` (adds on
`added`, deletes on `removed`) and consumed by `closeConn` for eviction.

| Relationship | Cardinality | Notes |
|---|---|---|
| conn → controlled clientIDs | 1 → 0..n | Empty at `setupWSConnection`; the first allowed announcement populates it. |
| clientID → owning conn | 1 → 0..n | Normally 0 (unclaimed) or 1 (owned). Transiently >1 during a same-user reconnect race. |

**This feature only reads this map.** Writing to it would make the guard a second maintainer
of the ownership record — the "second model" failure 038 hit three times (research R4).

---

## 4. Ownership verdict (derived, per frame)

`evaluateAwarenessFrame({ conns, conn, clientIds, principalOf })` → `{ allowed, foreignIds }`.

Per asserted clientID, in order:

| # | Condition | Verdict | Requirement |
|---|---|---|---|
| 1 | id ∈ `conns.get(conn)` | **own** — allow | FR-002a |
| 2 | id ∈ no other conn's set | **unclaimed** — allow (first-writer-wins claim) | FR-002b |
| 3 | every conn holding id has the *same, non-null* principal as `conn` | **same user** — allow | FR-002c / Q3 |
| 4 | otherwise | **foreign** — record in `foreignIds` | FR-001 |

`allowed = foreignIds.length === 0`. **One foreign id drops the whole frame** — no partial
apply, no re-encode (Q2, FR-004).

**Fail-closed detail**: a `null`/`undefined` principal on *either* side is never a match, so
rule 3 cannot degrade into "any connection missing `userId` may assert anything"
(research R6).

---

## 5. Connection principal

`principalOf(conn)` → the authenticated user id behind a connection, defaulting to
`conn.userId` (already stamped by `server/index.js` for attribution). Used **only** for
rule 3 above. Not an identity model — it is a tie-break input.

---

## 6. Drop-suppressor state (per connection, in-memory)

Lives in the `installGate` closure; created lazily on first drop, garbage collected with
the socket. No global map, no cleanup handler.

| Field | Type | Meaning |
|---|---|---|
| `dropped` | `number` | Total awareness frames dropped on this connection, for the connection's lifetime. |
| `sinceLastLog` | `number` | Drops since the last emission; reset on emit. |
| `lastLoggedAt` | `number \| null` | Timestamp of the last emission; `null` before the first. |

**Emission rule**: the first drop on a connection always emits; afterwards, at most one
emission per `AWARENESS_BLOCK_LOG_WINDOW_MS` (60 000 ms). Every emission carries `dropped`
and `sinceLastLog`, so the count survives the suppression (FR-007, SC-003).

---

## State transitions — a clientID's ownership over a connection's life

```
        unclaimed
            │  connection C sends first awareness frame asserting X
            │  (guard rule 2: allow) → applyAwarenessUpdate → 'added'
            ▼
      owned by C          ── C sends more frames for X (rule 1: allow) ──┐
            │                                                            │
            │                                             ◄──────────────┘
            │  C sends null-state for X  → 'removed' → X deleted from C's set
            ├──────────────────────────────────────────────► unclaimed
            │
            │  C's socket closes → closeConn → removeAwarenessStates(C's set)
            ├──────────────────────────────────────────────► unclaimed
            │
            │  connection D (same user as C) asserts X   → rule 3: allow
            │  connection E (different user) asserts X   → rule 4: DROP + WS_AWARENESS_BLOCKED
            ▼
```
