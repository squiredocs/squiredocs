# Data Model — 015-agent-presence-dedup

No database entities. All state is either a volatile Redis key, in-process module
state, or a transient pub/sub message. No migrations.

## Entity 1: Presence claim (Redis, volatile)

The cluster-wide record of which instance currently announces a given
(user, agent, document) presence.

| Field | Type | Notes |
|---|---|---|
| key | string | `agent-presence:{userId}:{agentId}:{docGuid}` (FR-001). `agentId` defaults to `'default'`, mirroring `getOrCreateSession`. |
| value | string | Owner instance ID — `redis-pubsub.js` `getInstanceId()` UUID. |
| TTL | ms | `AGENT_CLAIM_TTL_MS` (default 15000, RBD-1). Set on every acquire/takeover/refresh via `PX`. |

**Validation rules**
- At most one claim exists per key (Redis key semantics).
- Created only via `SET NX PX` (initial acquire / survivor probe, FR-002) or
  `SET PX` (work-follows-the-claim takeover, FR-006).
- Refreshed only by its owner (atomic owner-checked `PEXPIRE`, FR-005).
- Deleted only by its owner (atomic owner-checked `DEL`, FR-011/RBD-4) or by TTL
  expiry (FR-010).

**State transitions** (per key)

```text
(absent) --SET NX by A--> owned(A)            # initial acquire / survivor probe
owned(A) --SET by B + nudge--> owned(B)       # takeover: work moved to B
owned(A) --owner-checked DEL by A--> (absent) # clean release on session cleanup
owned(A) --TTL expiry--> (absent)             # crash failover backstop
owned(A) --owner-checked PEXPIRE by A--> owned(A)  # heartbeat refresh
```

## Entity 2: Agent presence session (existing, in-process — gains claim state)

Defined in `server/mcp/agent-presence.js` (`activeSessions` map). Existing fields
unchanged. New/changed fields:

| Field | Type | Notes |
|---|---|---|
| claimState | `'holder'` \| `'silent'` | NEW. `'holder'` when this instance owns the claim (or claims are disabled/failing open); `'silent'` otherwise. Gates every awareness write. |
| agentId | string | NEW on the session object (needed to derive the claim key from a session during heartbeat/nudge handling; today only embedded in `key`). |
| cursor | object\|null | Existing — now ALSO updated while silent (local record only, no awareness write) so a takeover announces the true current position. |

**Invariants**
- Across all instances, at most one session per (user, agent, doc) has
  `claimState === 'holder'` at steady state (SC-001); transient double-holder is
  bounded by one nudge hop / one heartbeat (SC-003, FR-005).
- A `'silent'` session performs zero awareness writes (FR-003) but is otherwise
  fully functional (FR-004): provider connected, edits merging, undo history
  accumulating, presence-duration timer running.
- When claims are disabled (`REDIS_HOST` unset), every session is `'holder'`
  (FR-012).

## Entity 3: Claim record (in-process, per instance — `presence-claim.js`)

Module-level map: claimKey → local claim bookkeeping.

| Field | Type | Notes |
|---|---|---|
| claimKey | string | Redis key (Entity 1). |
| held | boolean | This instance's belief about ownership. Corrected by heartbeat (FR-005) and nudges. |
| heartbeatTimer | Timeout | Per-claim interval at `AGENT_CLAIM_HEARTBEAT_MS`, `unref()`'d. Holder → refresh; non-holder with a live local session → NX probe. Stopped on session cleanup. |
| failOpen | boolean | True while Redis ops are erroring/timing out (RBD-2/RBD-5); behaves as held. Cleared on next successful op. |

**Invariant**: a heartbeat timer exists iff a live local session exists for the
claim key (the claim "is refreshed for as long as its owning session is alive, and
never outlives it" — spec edge case; enforced by wiring start/stop to session
create/cleanup).

## Entity 4: Takeover nudge (pub/sub message, transient)

| Field | Type | Notes |
|---|---|---|
| channel | string | `presence-claim` (one global channel). |
| framing | binary | Existing `encodeMessage()`: 36-byte sender instance-ID prefix + `:`. Self-messages dropped by the existing filter. |
| payload | JSON | `{ "claimKey": "agent-presence:{userId}:{agentId}:{docGuid}" }` |

**Processing rules**: receiver looks up the claim key locally; if it believed it
held it → silence (`setLocalState(null)`, `claimState = 'silent'`, keep session
alive) and log; if unknown or already silent → no-op (idempotent, spec edge case).
Delivery is best-effort — loss is backstopped by the heartbeat ownership check
(FR-005).

## Entity 5: Session-key mapping (existing, in-process — invariant restored)

`sessionsByKey`: sessionKey (`${userId}-${agentId}-${docGuid}`) → sessionId.

**Restored invariant (FR-014)**: the mapping always points at the newest live
session or is absent. Enforced by the cross-delete guard in cleanup:
`delete` only when `sessionsByKey.get(sessionKey) === sessionId` of the session
being cleaned. All other teardown of the stale session runs regardless (FR-015).
`activeSessions` and `sessionsByUserId` are keyed by unique sessionId and need no
guard.
