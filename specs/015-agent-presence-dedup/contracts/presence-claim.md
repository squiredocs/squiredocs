# Contract — presence claim coordination (internal module + Redis + pub/sub + env)

This feature exposes no HTTP/MCP surface. Its contracts are: (A) the new
`server/mcp/presence-claim.js` module API consumed by `server/mcp/agent-presence.js`,
(B) the Redis key protocol shared by all instances, (C) the pub/sub nudge channel
added to `server/redis-pubsub.js`, and (D) environment configuration.

## A. Module API — `server/mcp/presence-claim.js`

All functions are safe to call with claims disabled (no `REDIS_HOST`): they resolve
immediately with holder-favoring answers and perform zero Redis I/O. **No function
ever throws or rejects due to Redis state** (FR-013); internal errors resolve to the
fail-open result and log a transition (RBD-2).

```js
init({ onLost })            // wire the lost-claim callback: onLost(claimKey) is invoked
                            //   when a nudge or heartbeat reveals this instance no longer
                            //   owns a claim it believed it held. Also subscribes the
                            //   nudge channel (via redis-pubsub). Idempotent.

async ensureHeldForWork(claimKey)
                            // The tool-call hook (FR-006/FR-009). Returns { held: true }
                            //   always (by fail-open definition). Behavior:
                            //   - claims disabled            -> no-op
                            //   - already held (local belief)-> no-op (FR-009: no blink)
                            //   - not held                   -> SET key instanceId PX ttl
                            //                                   (unconditional takeover),
                            //                                   publish nudge, mark held
                            //   - Redis error/timeout        -> mark failOpen, treat held
                            //   Bounded by AGENT_CLAIM_OP_TIMEOUT_MS (RBD-5).

async tryAcquire(claimKey)  // SET key instanceId NX PX ttl. Returns true iff acquired
                            //   (or claims disabled / fail-open -> true). Used for the
                            //   survivor probe and available to the initial-create path.

async release(claimKey)     // Owner-checked delete (Lua: GET==id -> DEL). Never deletes
                            //   a foreign owner's claim (FR-011). Stops the heartbeat
                            //   for claimKey. Safe when not held / disabled.

isHeld(claimKey)            // Synchronous local belief (boolean). True when disabled
                            //   or failing open.

startHeartbeat(claimKey)    // Ensure the per-claim timer runs (AGENT_CLAIM_HEARTBEAT_MS,
                            //   unref()'d). Holder tick: owner-checked refresh (Lua:
                            //   GET==id -> PEXPIRE); refresh returning "not owner" ->
                            //   mark lost + fire onLost (FR-005). Non-holder tick:
                            //   tryAcquire probe; success -> mark held + return value
                            //   surfaces via onAcquired (below).
stopHeartbeat(claimKey)     // Stop + drop local claim record. Called from session cleanup.

// Optional callback registered in init:
//   onAcquired(claimKey)   -> fired when a probe wins (failover/clean-release pickup)
//                             so agent-presence can announce the surviving session.

buildClaimKey(userId, agentId, docGuid)
                            // -> `agent-presence:${userId}:${agentId}:${docGuid}` (FR-001)

_resetForTests()            // Clear module state, timers, registered scripts.
```

**Consumption by `agent-presence.js`:**

- `getOrCreateSession` (after session obtained): `await ensureHeldForWork(...)`;
  then announce (`user` + cursor) iff `isHeld(...)`; `startHeartbeat(...)`.
- Session `cleanup`: `release(...)` (which stops the heartbeat) — fire-and-forget
  with `.catch` (cleanup must not become async-fallible).
- `onLost(claimKey)`: resolve session via `sessionsByKey`; set
  `claimState='silent'`; `provider.awareness.setLocalState(null)` (FR-007). Session,
  provider, timers, undo history untouched. Idempotent.
- `onAcquired(claimKey)`: resolve session; set `claimState='holder'`; re-announce
  `setLocalStateField('user', session.agentInfo)` then cursor if present (US4).
- Every awareness write goes through the gate: writes proceed iff
  `session.claimState === 'holder'`; cursor values are always recorded on
  `session.cursor` regardless (R6).

## B. Redis key protocol (cross-instance wire contract)

| Aspect | Value |
|---|---|
| Key | `agent-presence:{userId}:{agentId}:{docGuid}` — `agentId` falls back to `default`; components are the same raw strings used in the in-memory sessionKey `${userId}-${agentId}-${docGuid}` |
| Value | Owner's instance UUID (`redis-pubsub.getInstanceId()`) |
| Acquire | `SET key id NX PX <AGENT_CLAIM_TTL_MS>` — atomic, first-writer-wins (FR-002) |
| Takeover | `SET key id PX <AGENT_CLAIM_TTL_MS>` — unconditional (FR-006), always paired with a nudge publish |
| Refresh | Lua (atomic): `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end` |
| Release | Lua (atomic): `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end` |
| Client | Shared command client `server/redis.js getRedisClient()` — never the pub/sub clients |

Compatibility: keys are new (no migration); mixed-version rollout is safe — old
pods simply never claim, and fail-open on the new pods preserves availability
(worst case = today's duplicate, only during the rollout).

## C. Pub/sub nudge channel (addition to `server/redis-pubsub.js`)

| Aspect | Value |
|---|---|
| Channel | `presence-claim` (exact string; one global channel, no per-doc suffix) |
| Framing | Existing `encodeMessage(data)` — `<36-char instance UUID>:` prefix; receivers drop own messages via existing filter |
| Payload | UTF-8 JSON: `{"claimKey":"agent-presence:..."}` |
| New exports | `subscribeToPresenceClaims(handler)` — registers `handler(payloadObject)`; `publishPresenceClaimTakeover(claimKey)` — fire-and-forget, error logged not thrown |
| Routing | Added to the existing `messageBuffer` handler beside `awareness:`/`updates:` prefix routing; malformed JSON payloads are logged and dropped |
| Degradation | Inherits redis-pubsub behavior: no-ops when `isEnabled()` is false; hang-safe init unchanged |
| Init ordering | **`subscribeToPresenceClaims` may be called before `redis-pubsub.init()`** — verified: `agentPresence.init` runs from `server/mcp/tools/index.js:81` while `redisPubSub.init()` runs later inside the `server.listen` callback (`server/index.js:1601`). The function therefore only *records* the handler; the actual channel `SUBSCRIBE` is issued by `init()` when a handler is registered (and immediately if `init()` already ran). A pre-init registration must never be silently dropped. First claim operations are additionally guaranteed post-init because tool calls arrive only after the readiness gate, which `redisPubSub.init()` precedes. |

Delivery is best-effort. Correctness does not depend on the nudge: the heartbeat
ownership check (A) bounds a lost nudge to one heartbeat interval (FR-005, spec
edge case "Takeover nudge lost or delayed").

## D. Environment configuration

| Variable | Default | Constraint |
|---|---|---|
| `AGENT_CLAIM_TTL_MS` | `15000` | Positive integer; worst-case failover gap (SC-004) |
| `AGENT_CLAIM_HEARTBEAT_MS` | `5000` | Positive integer; should be ≤ TTL/2 (default TTL/3) |
| `AGENT_CLAIM_OP_TIMEOUT_MS` | `500` | Positive integer; per-op fail-open bound (RBD-5) |

Invalid/absent values fall back to defaults (same `num()` idiom as
`server/rate-limit.js`). Documented in README's environment section (Constitution I).

## E. Behavioral guarantees (testable contract summary)

1. Concurrent first `tryAcquire` from two instances: exactly one wins (FR-002).
2. `ensureHeldForWork` on a non-holder: claim owner flips, exactly one nudge
   published, previous holder's `onLost` fires on delivery (FR-006/FR-007).
3. `ensureHeldForWork` on the holder: zero Redis writes beyond none, zero nudges,
   no re-announce (FR-009).
4. Holder crash (no release): key expires after TTL; survivor probe acquires within
   TTL + one heartbeat (FR-010/SC-004).
5. Clean `release` by owner: key gone immediately; survivor probe acquires within
   one heartbeat (FR-011/RBD-4).
6. `release` by non-owner: foreign claim untouched (FR-011).
7. Redis disabled: all APIs resolve holder-favoring, zero I/O, zero timers (FR-012).
8. Redis erroring/timing out: all APIs resolve holder-favoring within
   `AGENT_CLAIM_OP_TIMEOUT_MS`; no throw reaches a tool call (FR-013/RBD-2/RBD-5).
