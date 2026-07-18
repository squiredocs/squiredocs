# Research — 015-agent-presence-dedup

Phase 0 output. All unknowns from Technical Context resolved; each decision records
what was chosen, why, and what was rejected. Code references verified against the
working tree on 2026-07-18.

## R1: Which Redis client performs claim commands

- **Decision**: The shared command client from `server/redis.js` (`getRedisClient()`),
  which is the ioredis singleton already used by rate limiting
  (`server/rate-limit.js` via `RateLimiterRedis`) and Redis persistence. Enablement
  check is the same `isRedisEnabled()` (`REDIS_HOST` set).
- **Rationale**: Redis forbids mixing pub/sub subscriptions with regular commands on
  one connection — the `redis-pubsub.js` clients (`createPubSubClient()`) cannot run
  `SET`/`EVAL`. The shared client already carries the production config
  (`REDIS_PASSWORD`, retry strategy, `maxRetriesPerRequest: 3`, 5 s connect timeout)
  and is battle-tested by the rate limiter under the same fail-degraded expectations.
- **Alternatives considered**: A dedicated new ioredis connection (rejected: one more
  connection per pod for a handful of tiny ops, no isolation benefit); reusing the
  pub/sub publisher client (rejected: protocol restriction above).

## R2: Atomic owner-checked refresh and release

- **Decision**: Two tiny Lua scripts registered with ioredis `defineCommand`:
  - `claimRefresh(key, instanceId, ttlMs)`: `if GET(key)==instanceId then PEXPIRE(key, ttl) return 1 else return 0`
  - `claimRelease(key, instanceId)`: `if GET(key)==instanceId then DEL(key) return 1 else return 0`
  Acquisition needs no script: `SET key instanceId NX PX ttl` (initial/probe) and
  `SET key instanceId PX ttl` (takeover) are single commands.
- **Rationale**: GET-then-PEXPIRE/DEL as two round trips has a window where another
  instance's takeover lands between them — the release variant would recreate, at
  cluster level, exactly the cross-delete bug this feature fixes locally (an old
  actor deleting a new owner's entry). The check-and-act must be one atomic unit;
  this is the standard Redlock-style release pattern. ioredis `defineCommand` ships
  the script with EVALSHA caching for free and is already a project dependency.
- **Alternatives considered**: WATCH/MULTI transactions (rejected: clumsy on a shared
  client, aborts under contention); tolerating the non-atomic race because claims are
  cosmetic (rejected: RBD-4 explicitly names the owner-check as a correctness
  requirement, and the race is trivially avoidable).

## R3: Where the takeover hook lives

- **Decision**: Inside `getOrCreateSession` (`server/mcp/agent-presence.js:590`),
  after the session is obtained and before/with the `user` awareness announce.
- **Rationale**: Verified by grep that **all** document-touching session use funnels
  through this one function — `server/api/chat-tools.js:342`,
  `server/mcp/tools/modify.js:277`, `read-document.js:92`, `get-collaborators.js:99`,
  `restore-document-version.js:75`, `create-document.js:173`,
  `undo-redo-handler.js:25`. It runs on *every* tool call (create, reuse, and
  extend paths alike), which is precisely FR-006's "hook into session use, not just
  creation". No per-tool changes needed; zero risk of a tool bypassing the claim.
- **Alternatives considered**: Hooking each tool handler (rejected: 7 call sites,
  guaranteed drift); hooking `_createSessionCore` only (rejected: misses the reuse
  path at :285-298, which is the common case mid-conversation and exactly where the
  work lands on a non-holding pod).

## R4: How survivors detect a freed claim (failover without a release channel)

- **Decision**: A symmetric per-session claim timer at the heartbeat interval:
  holders run the owner-checked refresh; silent sessions run a `SET NX PX` probe and
  announce on success.
- **Rationale**: Gives crash failover ≤ TTL (US4-1/SC-004) and clean-release
  takeover ≤ 1 heartbeat (US4-2, "without waiting for expiry") with one mechanism
  and no extra pub/sub message type. NX probing can never steal from a live holder,
  so it is safe to run unconditionally. Cost: one Redis op per silent session per
  5 s — negligible.
- **Alternatives considered**: A "released" pub/sub broadcast so survivors claim
  instantly (rejected: second message type + subscriber bookkeeping for a ≤5 s win
  on a cosmetic property); no probing, reclaim only on next tool call (rejected:
  violates US4-1 — an idle-but-alive survivor would leave the avatar absent
  indefinitely, not ≤ one TTL).

## R5: Nudge transport and message shape

- **Decision**: Extend `server/redis-pubsub.js` with one global channel
  (`presence-claim`), publishing via the existing `encodeMessage()` instance-ID
  framing; payload JSON `{ claimKey }`. New exports `subscribeToPresenceClaims(handler)`
  and `publishPresenceClaimTakeover(claimKey)`; routing added to the existing
  `messageBuffer` handler.
- **Rationale**: The per-instance ID filter (`INSTANCE_ID`, `decodeMessage`) already
  solves self-message suppression; the module already owns init/degradation
  (hang-safe init, warn-and-continue) so the nudge inherits the right failure
  behavior. One global channel beats per-doc channels because takeovers are rare,
  payloads are tiny, and per-doc subscribe/unsubscribe lifecycle would couple claim
  code to document-open lifecycle for no benefit.
- **Alternatives considered**: Publishing on the existing per-doc `awareness:` channel
  with a sentinel payload (rejected: those carry binary y-protocols awareness frames;
  a JSON interloper risks decode errors in every instance's hot path); a separate
  raw ioredis subscription owned by presence-claim.js (rejected: duplicates instance
  identity and lifecycle already solved in redis-pubsub.js).

## R6: Awareness silencing semantics

- **Decision**: On losing the claim: `provider.awareness.setLocalState(null)` — the
  whole local state, not field-by-field. On becoming holder: re-announce `user`
  (from `session.agentInfo`) then `cursor` (from `session.cursor` if set). All
  awareness writes in `agent-presence.js` go through a single gate that no-ops for
  silent sessions while still recording `session.cursor` locally.
- **Rationale**: `setLocalState(null)` is the amendment's ratified mechanism (FR-007)
  and is what y-protocols awareness broadcasts to peers as a removal — exactly the
  eager-eviction shape the server already uses for disconnects. Keeping
  `session.cursor` updated while silent means a later takeover announces at the
  agent's true current position instead of a stale one (FR-008 fidelity across
  handoffs). The single gate guarantees FR-003's "no awareness state at all" — the
  write sites today are :616 (`user`), :141-147 (`_broadcastCursor`), :292-294
  (reuse re-broadcast), :453-455 (finalize init), :348-350 (cleanup clear).
- **Alternatives considered**: Setting only `user: null` (rejected: leaves a cursor
  state announced, violating FR-003 and rendering a ghost cursor); disconnecting the
  provider when silent (rejected: FR-004 requires the working session to keep
  editing; the y-websocket connection *is* the edit path).

## R7: Fail-open bound on claim operations

- **Decision**: Every claim op is `Promise.race`d against
  `AGENT_CLAIM_OP_TIMEOUT_MS` (default 500 ms) and wrapped in `catch`; error or
  timeout → treat as holder, announce, log the transition once. Recorded as RBD-5
  in `clarifications-needed.md`.
- **Rationale**: ioredis with `maxRetriesPerRequest: 3` and a backoff retry strategy
  can hold a command pending for multiple seconds when Redis is flapping; FR-013
  forbids measurable tool-call delay. 500 ms is far above healthy in-cluster Redis
  RTT (<5 ms) and far below human-perceptible tool-call latency budgets. The race
  timer must `unref()` and the losing promise's eventual settlement must be
  swallowed (no unhandled rejection).
- **Alternatives considered**: Relying on ioredis timeouts alone (rejected:
  retry-amplified, seconds-scale); fire-and-forget claim writes with immediate
  optimistic announce (rejected for the takeover path: FR-006 orders the claim
  write before/with announcing so the nudge and claim state precede the double
  avatar window; on healthy Redis the await costs sub-ms).

## R8: Test strategy for multi-instance behavior

- **Decision**: Hand-rolled in-memory Redis fake in a shared test helper
  (`server/mcp/__tests__/helpers/fake-claim-redis.js`): a Map with `set` supporting
  `NX`/`PX` semantics, virtual TTL expiry driven by jest fake timers or an
  explicit `advance(ms)` method, the two `defineCommand` scripts emulated, and a
  pub/sub bus that delivers published nudges to registered handlers. Multi-instance
  simulation loads two independent copies of `presence-claim.js` (+ gated
  agent-presence session objects) via `jest.isolateModules`, each configured with a
  distinct instance ID, both pointed at one fake.
- **Rationale**: The backend test DB/Redis constraints (serial-only, shared state)
  make live-Redis claim tests flaky and order-dependent; a deterministic fake makes
  TTL expiry and race interleavings scriptable. `jest.isolateModules` gives two real
  module instances with separate module-level state — an honest simulation of two
  pods — without process spawning. Existing `agent-presence.test.js` already
  demonstrates the mock-session pattern (fake provider with `setLocalStateField`
  jest.fn) these suites will extend (adding a `setLocalState` fn for FR-007
  assertions).
- **Alternatives considered**: `ioredis-mock` package (rejected: new dependency, and
  its TTL/eval fidelity is version-sensitive; the needed surface is ~5 commands);
  spawning two real server processes against real Redis (rejected: belongs to the
  maintainer's browser/E2E verification, not the Jest suite; Constitution II demands
  serial deterministic suites).

## R9: Interaction with presence-duration clamp (observation, no action)

- **Observation**: `getOrCreateSession` clamps duration to 300 s
  (`Math.max(1, Math.min(300, durationSeconds))`, `agent-presence.js:595`), so the
  undo/redo handler's requested 3600 s is effectively 300 s today. The spec's
  Out-of-Scope note describes it as a 1-hour session. No design impact — the claim
  protocol treats all sessions uniformly and the undo/redo session lifetime is
  explicitly out of scope — but recorded here so the analyze stage and future work
  see the discrepancy. Not fixed in this feature (out of scope by spec).

## R10: Claim-state logging shape

- **Decision**: `console.log`/`console.warn` with a `[presence-claim]` prefix,
  always including the claim key and this instance's ID, one line per transition:
  `acquired`, `takeover`, `silenced (nudge)`, `silenced (heartbeat)`, `released`,
  `reacquired (expiry)`, `fail-open enter`, `fail-open recover`.
- **Rationale**: Matches the module logging idiom used across `server/`
  (`[agent-presence]`, `[RedisPubSub]`) and satisfies FR-016's reconstruction
  requirement (owner at any time = last `acquired`/`takeover`/`reacquired` line for
  the key, bounded by `silenced`/`released`). Structured telemetry is not required
  by the spec and is deliberately not added.
