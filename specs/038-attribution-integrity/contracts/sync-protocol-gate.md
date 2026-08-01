# Contract: Sync-protocol edit gate

The per-connection permission gate on the y-websocket wire protocol
(`server/ws-edit-gate.js`, installed by the `ws.emit` interceptor in `server/index.js`).

## Frame classification (FR-001, FR-006)

Frames are classified by their first two bytes (`[messageType, syncType]`); frames
shorter than 2 bytes are never edit-classified.

| Frame | Bytes | Can reach `Y.applyUpdate`? | Classification | Viewer (< editor) | Editor+ |
|---|---|---|---|---|---|
| Sync Step1 | `[0, 0]` | no (read-only request) | not an edit | allowed | allowed |
| Sync Step2 | `[0, 1]` | **yes** | **edit** (NEW) | **dropped** + `WS_STEP2_BLOCKED` | allowed (offline-edit path, FR-005) |
| Sync Update | `[0, 2]` | yes | edit (unchanged) | dropped + `WS_EDIT_BLOCKED` | allowed |
| Awareness | `[1, …]` | no | not an edit | allowed | allowed |
| Short/malformed (< 2 bytes) | — | no | not an edit | passed through (y-websocket's own handling, unchanged) | same |

**Design rule (design amendment 2026-08-01)**: any protocol frame that can reach the
document-apply path is an edit for permission purposes. **New sync message types MUST be
classified in this table (and in `server/ws-edit-gate.js`) before they ship.**

## Blocked-frame policy (FR-002, D4)

Dropping a frame means: it never reaches y-websocket protocol processing — no document
mutation, no `yjs_updates` row, no rebroadcast to any participant, no reply. The
connection **stays open**; the client is not notified; there is no throttling or
escalation (matches existing `WS_EDIT_BLOCKED` policy; escalation is deliberate
follow-on work, cf. the 034 detector).

Downstream sync to viewers is unaffected (FR-004): the server still sends its step1 /
step2 / live updates / awareness to every role. Protocol-safe because the server never
awaits the client's step2 reply.

## Role timing (spec edge case)

The gate reads the connection's cached edit capability (`role ≥ editor`), refreshed by
the existing 60-second DB role re-check (fail-closed on re-check errors). Promotions and
demotions take effect for step2 exactly when they take effect for update frames.

## Observability events

Emitted via `logPerf` (the structured perf log channel):

| Event | When | Payload (minimum) |
|---|---|---|
| `WS_EDIT_BLOCKED` | viewer sync-update frame dropped (unchanged) | `{ connId, userId, docId, role }` |
| `WS_STEP2_BLOCKED` | viewer step2 frame dropped (NEW, FR-003) | `{ connId, userId, docId, role }` |

Distinct names make bypass attempts separately countable (SC-002).

## Module interface (`server/ws-edit-gate.js`)

Exports (exact names finalized in implementation; the contract is the semantics):

- Protocol constants: `MESSAGE_SYNC`, `MESSAGE_AWARENESS`, `SYNC_STEP1`, `SYNC_STEP2`,
  `SYNC_UPDATE`.
- `classifyFrame(buffer) → { isEdit: boolean, kind: 'update' | 'step2' | null }` —
  pure, throw-free on any input (null, empty, short, non-sync frames ⇒
  `{ isEdit: false, kind: null }`).
- (Equivalent predicate forms are acceptable, but there is exactly ONE classification
  implementation, imported by both `server/index.js` and every test — no mirrored
  copies. `server/__tests__/permissions.test.js` MUST import from this module.)

## Trust boundary statement (Constitution V)

The WS sync protocol is an ingestion surface for untrusted client bytes. Validation
policy: role gating per this table before protocol processing; malformed frames follow
y-websocket's existing handling; nothing in the gate parses frame payloads beyond the
two-byte header.
