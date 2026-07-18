# Tasks: Agent Presence Deduplication Across Instances

**Input**: Design documents from `/specs/015-agent-presence-dedup/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/presence-claim.md, quickstart.md

**Tests**: REQUIRED — tests are explicitly requested for this feature (Constitution II; spec Independent Tests; pipeline deliverables). Within each story, write the tests first and watch them fail before implementing. All Redis interaction in tests uses the in-memory fake (T001); backend Jest runs are serial-only (`--runInBand`).

**Organization**: Tasks grouped by user story (US1 one-avatar, US2 work-follows-claim, US3 cross-delete guard, US4 failover/fail-open) so each story is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1..US4, matching spec.md user stories

## Path Conventions

Existing backend layout: production code in `server/`, backend tests in `server/__tests__/` and `server/mcp/__tests__/`. No client, DB, or infra changes.

---

## Phase 1: Setup (Shared Test Infrastructure)

**Purpose**: The deterministic Redis fake every claim suite depends on.

- [X] T001 Create in-memory fake Redis helper in `server/mcp/__tests__/helpers/fake-claim-redis.js`: `set` with `NX`/`PX` semantics and a virtual clock (`advance(ms)` expires keys), emulation of the two owner-checked commands (`claimRefresh`: GET==id → PEXPIRE; `claimRelease`: GET==id → DEL), a `get`/`del` surface, an error-injection switch (`failNext(n)` / `failAll(bool)` and a hang mode for timeout tests), and a pub/sub bus (`publish(channel, buffer)` delivering to all registered handlers) so two module instances can be bridged. Export a factory so each test gets isolated state.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The claim coordinator skeleton, the nudge channel, and the awareness-write gate — every story builds on these.

**⚠️ CRITICAL**: complete before any user story phase.

- [X] T002 Create `server/mcp/presence-claim.js` skeleton per contracts/presence-claim.md § A: env config (`AGENT_CLAIM_TTL_MS`=15000, `AGENT_CLAIM_HEARTBEAT_MS`=5000, `AGENT_CLAIM_OP_TIMEOUT_MS`=500, using the `num()` fallback idiom from `server/rate-limit.js`), `buildClaimKey(userId, agentId, docGuid)` → `agent-presence:{userId}:{agentId}:{docGuid}`, module-level claim-record map (data-model.md Entity 3), `init({ onLost, onAcquired })`, inert disabled mode keyed off `isRedisEnabled()` from `server/redis.js` (zero I/O, holder-favoring answers), and `_resetForTests()`. Redis handle comes from `getRedisClient()` (never the pub/sub clients — research R1); allow test injection of a fake client.
- [X] T003 In `server/mcp/presence-claim.js`, register the two Lua owner-checked commands via ioredis `defineCommand` (`claimRefresh`, `claimRelease` — exact scripts in contracts § B) and implement the shared op wrapper: every Redis call raced against `AGENT_CLAIM_OP_TIMEOUT_MS` (unref'd timer, losing promise's settlement swallowed) with `catch` → fail-open result; **no claim API ever throws/rejects** (FR-013, RBD-5). Depends on T002.
- [X] T004 [P] Extend `server/redis-pubsub.js` with the nudge channel per contracts § C: `PRESENCE_CLAIM_CHANNEL = 'presence-claim'`, `subscribeToPresenceClaims(handler)` (**records** the handler; the channel `SUBSCRIBE` is issued by `init()` for a pre-registered handler, or immediately if already initialized — required because `agentPresence.init` at `server/mcp/tools/index.js:81` runs before `redisPubSub.init()` at `server/index.js:1601`), `publishPresenceClaimTakeover(claimKey)` (existing `encodeMessage()` framing, JSON `{claimKey}` payload, fire-and-forget with error log), routing in the existing `messageBuffer` handler (drop malformed JSON with a warn), cleanup/_reset coverage for the new subscription, and the new exports.
- [X] T005 In `server/mcp/agent-presence.js`, add session claim state and the single awareness-write gate (research R6, data-model Entity 2): new session fields `claimState` (`'holder'`|`'silent'`) and `agentId`; a `_setAwareness(session, field, value)` / silence helper through which ALL five existing awareness write sites are routed — `getOrCreateSession` user announce (:616), `_broadcastCursor` (:141-147), reuse-path cursor re-broadcast (:292-294), finalize cursor init (:453-455), cleanup cursor clear (:348-350). Gate behavior in this task: when claims are disabled every session is `'holder'` and behavior is byte-identical to today (FR-012); `session.cursor` is always recorded locally even when the write is suppressed. Depends on T002 (for the disabled check only), parallel-safe with T003/T004.
- [X] T006 [P] Extend `server/__tests__/redis-pubsub.test.js`: presence-claim channel publish uses instance-ID framing, subscribed handler receives decoded `{claimKey}` from a foreign instance, self-messages are dropped, malformed payloads are dropped without throwing, and a handler registered **before** `init()` still receives nudges after `init()` completes (contracts § C init-ordering rule). Depends on T004.

**Checkpoint**: claim module loads inert without Redis; full existing backend suite still green.

---

## Phase 3: User Story 1 — One agent avatar, cluster-wide (Priority: P1) 🎯 MVP

**Goal**: Only the claim-holding instance announces the agent; concurrent first sessions on two instances resolve to exactly one announcer; distinct (user, agent, doc) combos stay independent; no-Redis behavior unchanged.

**Independent Test**: two presence-claim module instances against one fake Redis — concurrent first acquisitions yield exactly one holder, and only the holder's session performs awareness writes (spec US1 Independent Test, simulated).

### Tests for User Story 1 (write first, watch fail)

- [X] T007 [P] [US1] Create `server/mcp/__tests__/presence-claim.test.js`: `tryAcquire` sets `agent-presence:{u}:{a}:{d}` with NX+PX and this instance's ID; second instance's `tryAcquire` on the held key returns false; `isHeld` reflects local belief; distinct claim keys are independent; disabled mode (no REDIS_HOST) → `tryAcquire`/`isHeld` true with zero fake-Redis calls; `buildClaimKey` shape matches FR-001. Uses T001 fake.
- [X] T008 [P] [US1] Extend `server/mcp/__tests__/agent-presence.test.js` (mock-session pattern already in the file; add a `setLocalState` jest.fn to the mock awareness): a `'silent'` session performs zero awareness writes through the gate while `session.cursor` still updates locally (`updateSessionCursor`, `setTemporarySelection`, `queueHighlightSequence` paths); a `'holder'` session announces `user` and `cursor`; disabled-claims mode reproduces today's write behavior exactly (FR-003/FR-004/FR-012).

### Implementation for User Story 1

- [X] T009 [US1] Implement in `server/mcp/presence-claim.js`: `tryAcquire(claimKey)` (`SET key id NX PX ttl` through the T003 wrapper), `isHeld(claimKey)`, local claim-record create/update. Depends on T003, T007.
- [X] T010 [US1] Wire initial acquisition + gated announce into `server/mcp/agent-presence.js` `getOrCreateSession`: after the session is obtained, `tryAcquire` its claim; set `claimState` from the result (fail-open/disabled → `'holder'`); announce `user` + current cursor only when holder (silent sessions announce nothing); reuse path re-broadcast equally gated. Store `agentId` on the session at creation. Depends on T005, T008, T009.
- [X] T011 [US1] Create `server/mcp/__tests__/presence-multi-instance.test.js` (part 1): load two independent `presence-claim.js` instances via `jest.isolateModules`, distinct instance IDs, one shared T001 fake; simultaneous first `tryAcquire` for the same key → exactly one winner (FR-002, spec edge "simultaneous first tool calls"); same user+agent on two docs → two independent claims (spec US1 scenario 3). Depends on T009.

**Checkpoint**: US1 suites green; existing suites green with and without REDIS_HOST.

---

## Phase 4: User Story 2 — The presence follows the work (Priority: P1)

**Goal**: A tool call on a non-holding instance takes the claim over (unconditional SET + nudge), the previous holder silences via `setLocalState(null)` within one hop, the executing instance announces and emits the activity stream; holder-path calls are zero-overhead no-ops.

**Independent Test**: alternate `ensureHeldForWork` between two module instances bridged by the fake pub/sub bus; at every steady point exactly one holder, previous holder silenced < 1 s, no-op when already holder.

### Tests for User Story 2 (write first, watch fail)

- [X] T012 [P] [US2] Create `server/mcp/__tests__/presence-handoff.test.js` (takeover block): `ensureHeldForWork` on a non-holder overwrites the claim value to this instance and publishes exactly one nudge with the claim key; on the losing instance the nudge fires `onLost` → session silenced with `provider.awareness.setLocalState(null)` (full state — assert the exact call, FR-007) while its session object, provider, presence timer, and undoManager survive (FR-004); silencing an unknown/already-silent claim is a no-op (idempotence edge case); `ensureHeldForWork` when already holder performs no Redis write, no nudge, no re-announce (FR-009); end-to-end silence latency asserted < 1000 ms under fake timers (SC-003/RBD-3). Uses T001 fake + two isolated module instances.

### Implementation for User Story 2

- [X] T013 [US2] Implement `ensureHeldForWork(claimKey)` in `server/mcp/presence-claim.js`: local-held → immediate no-op; else unconditional `SET key id PX ttl` (T003 wrapper) + `publishPresenceClaimTakeover(claimKey)` via `server/redis-pubsub.js` + mark held; error/timeout → mark fail-open, resolve held (RBD-2). Always resolves `{ held: true }`. Depends on T003, T004, T009, T012.
- [X] T014 [US2] Implement nudge/loss handling in `server/mcp/agent-presence.js`: module init registers `presence-claim.init({ onLost, onAcquired })`; `onLost(claimKey)` resolves the session via `sessionsByKey`, sets `claimState='silent'`, calls `setLocalState(null)` through the gate helper, logs the transition — idempotent, never touches session teardown; `onAcquired(claimKey)` sets `claimState='holder'` and re-announces `user` (from `session.agentInfo`) then `cursor` (if recorded). Wire `subscribeToPresenceClaims` → presence-claim's nudge handler. Depends on T005, T012, T013.
- [X] T015 [US2] Hook the takeover into `server/mcp/agent-presence.js` `getOrCreateSession`: replace the T010 bare `tryAcquire` with `await ensureHeldForWork(...)` on every call (covers create, reuse, and extend paths — and therefore all seven callers: `server/api/chat-tools.js:342`, `server/mcp/tools/modify.js:277`, `read-document.js:92`, `get-collaborators.js:99`, `restore-document-version.js:75`, `create-document.js:173`, `undo-redo-handler.js:25` — with no per-tool edits); announce after the claim resolves so activity always originates from the executing instance (FR-006/FR-008). Depends on T010, T013, T014.
- [X] T016 [US2] Extend `server/mcp/__tests__/presence-multi-instance.test.js` (part 2): drive an alternating sequence of `ensureHeldForWork` + gated announce/cursor writes across the two bridged instances; assert at most one holder at every steady-state observation point, that every "tool call" emitted its awareness activity from the executing instance (SC-001/SC-002), and that a rapid alternation never leaves both instances announcing simultaneously beyond the nudge hop. Depends on T013, T014, T015.

**Checkpoint**: US1+US2 = the observed prod defect fixed in simulation; MVP complete.

---

## Phase 5: User Story 3 — Cross-delete guard (Priority: P2)

**Goal**: A stale session's cleanup never orphans a newer session that took over the same session key; duplicates cannot snowball on one instance.

**Independent Test**: existing single-instance test suite: create session, force stale, create replacement owning the same key, run old cleanup, key still resolves to the replacement (spec US3 Independent Test).

### Tests for User Story 3 (write first, watch fail)

- [X] T017 [P] [US3] Extend `server/mcp/__tests__/agent-presence.test.js` with a cross-delete-guard block: (a) old session's cleanup runs after a newer session owns the same sessionKey → `sessionsByKey` still maps to the newer sessionId, which stays findable via `getUndoRedoAvailability` and reusable via the reuse path (FR-014, SC-005); (b) a session that still owns its mapping deletes it on cleanup exactly as today (spec US3 scenario 2); (c) the guarded cleanup still releases every own resource — provider destroyed, undoManager destroyed, timers cleared, highlightQueue cleared, `activeSessions`/`sessionsByUserId` entries removed (FR-015); (d) a repeated stale→replace→cleanup cycle loop never yields >1 live session per key (spec US3 scenario 3).

### Implementation for User Story 3

- [X] T018 [US3] Implement the guard in the cleanup closure of `server/mcp/agent-presence.js` (today's unconditional `sessionsByKey.delete(sessionKey)` at :362): delete only when `sessionsByKey.get(sessionKey) === sessionId`; leave all other teardown unconditional. No changes to `activeSessions`/`sessionsByUserId` handling (unique-keyed, cannot cross-delete — plan Decision 6). Depends on T017 (independent of Phases 3–4; only needs Phase 2's file state).

**Checkpoint**: US3 independently green — runnable even with claims disabled.

---

## Phase 6: User Story 4 — Failover and fail-open (Priority: P2)

**Goal**: Holder crash → survivor re-announces within one TTL; clean cleanup → survivor picks up within one heartbeat without expiry wait; Redis absent or erroring → tool calls always succeed with visible presence.

**Independent Test**: with the fake's virtual clock, kill the holder record and advance time → survivor probe acquires and re-announces; separately run all claim APIs with the fake erroring/hanging → holder-favoring results within the op timeout.

### Tests for User Story 4 (write first, watch fail)

- [X] T019 [P] [US4] Extend `server/mcp/__tests__/presence-handoff.test.js` (failover block): holder heartbeat tick refreshes TTL (owner-checked — a foreign-owned key is NOT extended); a holder whose refresh discovers foreign ownership silences itself within one heartbeat (FR-005 lost-nudge backstop, spec edge case); holder vanishes without release → `advance()` past `AGENT_CLAIM_TTL_MS` → surviving instance's probe acquires and `onAcquired` re-announces (FR-010, SC-004); clean release by the holder → survivor acquires on its next probe tick without any TTL wait (FR-011/RBD-4, US4 scenario 2); heartbeat stops when its session is cleaned up and never re-extends afterward (spec edge "claim never outlives its session").
- [X] T020 [P] [US4] Create `server/mcp/__tests__/presence-claim-failopen.test.js`: **absent** — REDIS_HOST unset → every API resolves holder-favoring with zero client calls and zero timers, session announces exactly as today (FR-012, SC-006); **erroring** — fake set to throw → APIs resolve holder-favoring, no rejection propagates, transition logged once (not per op); **hanging** — fake set to never resolve → APIs resolve within `AGENT_CLAIM_OP_TIMEOUT_MS` (assert with fake timers, RBD-5) and no unhandled rejection when the hung op later settles; **recovery** — after errors clear, next op resumes real claiming and steady-state single-holder returns (US4 scenario 4, SC-007).

### Implementation for User Story 4

- [X] T021 [US4] Implement the heartbeat loop in `server/mcp/presence-claim.js` (`startHeartbeat`/`stopHeartbeat`, research R4): per-claim `setInterval` at `AGENT_CLAIM_HEARTBEAT_MS`, `unref()`'d; holder tick → `claimRefresh`; result 0 → mark lost + fire `onLost`; non-holder tick → `tryAcquire` probe; success → mark held + fire `onAcquired`. Started from `getOrCreateSession` wiring (holder or silent alike), stopped from release. Depends on T009, T013, T019.
- [X] T022 [US4] Implement `release(claimKey)` in `server/mcp/presence-claim.js` (owner-checked `claimRelease` + `stopHeartbeat` + drop local record) and wire it into the session cleanup closure in `server/mcp/agent-presence.js` as fire-and-forget with `.catch` (cleanup stays synchronous and infallible) (FR-011, RBD-4). Depends on T003, T019; touches the same cleanup closure as T018 — coordinate ordering (T018 first).
- [X] T023 [US4] Implement the fail-open state machine in `server/mcp/presence-claim.js`: per-claim `failOpen` flag set on any op error/timeout (behaving as held), cleared on next success; log `fail-open enter`/`fail-open recover` once per transition; heartbeat keeps ticking during fail-open so recovery is automatic (US4 scenarios 3–4). Depends on T013, T020, T021.

**Checkpoint**: all four stories independently green.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T024 [P] FR-016 logging audit across `server/mcp/presence-claim.js` and `server/mcp/agent-presence.js`: every transition (acquired, takeover, silenced-by-nudge, silenced-by-heartbeat, released, reacquired-after-expiry, fail-open enter/recover) logs one `[presence-claim]` line with claim key + instance ID; spot-assert the key transitions in existing suites where cheap.
- [X] T025 [P] Update `README.md`: add `AGENT_CLAIM_TTL_MS`, `AGENT_CLAIM_HEARTBEAT_MS`, `AGENT_CLAIM_OP_TIMEOUT_MS` to the environment-variable section and a one-line note on cluster-wide agent presence dedup where agent presence is described (near the "Agent presence (cursor/highlights)" architecture line) (Constitution I).
- [X] T026 Full serial backend regression: `npx jest --runInBand server` with REDIS_HOST unset (SC-006), then the feature suites per quickstart.md; fix any fallout without weakening assertions.
- [X] T027 Reconcile `specs/015-agent-presence-dedup/quickstart.md` scenario table against the implemented suites (file names, scenario coverage); update quickstart if names drifted during implementation.

---

## Dependencies

**Phase order**: Phase 1 → Phase 2 → {Phase 3 → Phase 4} and {Phase 5} → Phase 6 → Phase 7.

- Phase 2 requires T001 only for its test task (T006); T002→T003 serial, T004/T005 parallel to T003.
- **US1 (Phase 3)** requires Phase 2. **US2 (Phase 4)** requires US1 (T015 replaces T010's wiring; T016 extends T011's file).
- **US3 (Phase 5)** requires only Phase 2's file state of `agent-presence.js` (T005) — independent of US1/US2/US4; may run in parallel with Phases 3–4 in a single-writer worktree ONLY if file conflicts on `agent-presence.js`/`agent-presence.test.js` are managed; otherwise run after Phase 4.
- **US4 (Phase 6)** requires US2 (heartbeat interacts with `ensureHeldForWork` bookkeeping; T022 orders after T018 in the shared cleanup closure).
- Phase 7 requires all stories.

**Story completion order**: US1 → US2 → US3 → US4 (US3 movable earlier if desired).

## Parallel Execution Examples

- Phase 2: T003, T004, T005 in parallel after T002 (three different files); T006 after T004.
- Phase 3: T007 and T008 in parallel (different test files) before T009/T010.
- Phase 6: T019 and T020 in parallel (different test files) before T021–T023.
- Phase 7: T024 and T025 in parallel.

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1)**: cluster-wide single announcer with atomic first-claim — already eliminates the steady-state duplicate for conversations that stay on one pod and caps the damage elsewhere. **Phase 4 (US2)** completes the prod fix (the claim follows the work — no invisible edits). **Phase 5 (US3)** is the independent single-instance bug fix and can ship any time after Phase 2. **Phase 6 (US4)** hardens failover and outage behavior. Each checkpoint leaves the tree green with the full serial backend suite, with and without REDIS_HOST.
