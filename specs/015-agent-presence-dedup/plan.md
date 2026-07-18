# Implementation Plan: Agent Presence Deduplication Across Instances

**Branch**: `015-agent-presence-dedup` | **Date**: 2026-07-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/015-agent-presence-dedup/spec.md`

**Design ground truth**: `design/collaboration-core.md` § "Real-time sync" — **Amendment (Sam, 2026-07-18) — agent presence is Redis-claim coordinated across instances** (RATIFIED). Where this plan and the spec disagree with the amendment, the amendment wins (Constitution Principle VI).

## Summary

Agent presence sessions (`server/mcp/agent-presence.js`) are instance-local; with 2 replicas behind non-sticky routing, two pods each announce the same agent and the awareness relay merges both into a duplicated avatar. The fix is a Redis presence claim — key `agent-presence:{userId}:{agentId}:{docGuid}`, acquired `SET NX PX`, heartbeat-refreshed — where only the claim-holding instance announces the agent in awareness, and **the claim follows the work**: the instance executing a tool call takes the claim over (unconditional owner-stamped `SET` + a pub/sub takeover nudge), the previous holder silences with `setLocalState(null)`, and the new holder announces and emits the call's full activity stream (cursor, sweep highlights, temporary selections). Non-holders keep fully-functional working sessions (edits merge via CRDT) but stay awareness-silent. Fail-open everywhere: no Redis configured → behavior byte-identical to today; Redis erroring → announce anyway (transient duplicates accepted). Plus one instance-local bug fix: session cleanup must not delete a `sessionsByKey` mapping that a newer session now owns (the cross-delete that makes duplicates snowball).

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS, matching `server/`)

**Primary Dependencies**: `ioredis` (already present — shared command client in `server/redis.js`), existing Redis pub/sub fan-out (`server/redis-pubsub.js`, per-instance ID `getInstanceId()`), `y-websocket` / `y-protocols` awareness (per-session `WebsocketProvider`), Jest (backend).

**Storage**: Redis (volatile claim keys with PX expiry — no schema, no persistence requirements; claims are best-effort by design). No PostgreSQL changes, no migrations.

**Testing**: Jest, `server/mcp/__tests__/` + `server/__tests__/`, serial-only backend runs (Constitution II). Redis is **mocked** in all new tests (hand-rolled in-memory fake implementing `set` with NX/PX, owner-checked scripts, and pub/sub bridging) — no test depends on a live Redis.

**Target Platform**: Linux server pods (k3s hardened cluster, 2 replicas HPA-capped; must be correct for N). Single-instance dev/Minikube must be unchanged.

**Project Type**: Backend-only change to the existing web service. Zero client changes — browsers already render whatever awareness states exist; fewer states = fewer avatars.

**Performance Goals**: Claim operations add no measurable latency to tool calls on healthy Redis (single round-trip, sub-ms in-cluster); on failing Redis every claim op is bounded by a timeout (default 500 ms, see RBD-5) and fails open. Heartbeat traffic: 1 Redis op per active session per 5 s (RBD-1).

**Constraints**: Fail-open is a hard requirement (FR-012/FR-013): coordination may never fail, block, or silence agent work. Highlight fidelity is a hard requirement (FR-008): the executing instance always announces. Claim TTL 15 s / heartbeat 5 s, env-overridable (RBD-1). Silencing on nudge is synchronous, bound one pub/sub hop, tested at < 1 s (RBD-3). Clean cleanup releases the claim owner-checked (RBD-4).

**Scale/Scope**: Handful of concurrent agent sessions today (beta); design is O(1) Redis ops per tool call + per heartbeat tick, fine to hundreds of concurrent sessions.

## Constitution Check

*GATE: evaluated against Constitution v1.1.1 before Phase 0; re-checked after Phase 1.*

| Principle | Verdict | Notes |
|---|---|---|
| I. Documentation Reflects Reality | PASS (with tasks) | README env-var section gains the new `AGENT_CLAIM_*` vars; README's agent-presence description gains one line on cluster-wide dedup. Tasks include the doc update. |
| II. Test-Backed Changes | PASS | Tests explicitly requested. New suites cover claim acquire/heartbeat/release, takeover + nudge silencing, TTL failover, fail-open (absent AND erroring Redis), the cross-delete guard, and a two-module multi-instance simulation. All against mocked Redis; serial backend runs preserved. No format/serialization changes → no round-trip suite impact. |
| III. Trunk-Based Solo Workflow | PASS | Feature branch used only because the pipeline runs parallel worktree implementers; no new ceremony. |
| IV. Collaboration-Safe Document Operations | PASS | No document mutation at all — awareness-only. Non-holder sessions keep editing through the CRDT untouched; attribution (`server/origin.js`) is unaffected. |
| V. Secure by Default | PASS | No new ingestion surface, endpoint, or token scope. Claim values are internal instance UUIDs; nudge messages ride the existing authenticated Redis (REDIS_PASSWORD honored via the shared config in `server/redis.js`). |
| VI. Design Docs Are Ground Truth | PASS | Mechanism is the ratified amendment verbatim; the four open decisions are RATIFIED-BY-DEFAULT in `clarifications-needed.md` (RBD-1..4); this plan adds RBD-5 (claim-op timeout bound) rather than deciding silently. |

**Post-Phase-1 re-check**: PASS — design artifacts introduce no new violations; no Complexity Tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/015-agent-presence-dedup/
├── spec.md
├── clarifications-needed.md   # RBD-1..4 (pre-existing) + RBD-5 (added by this plan)
├── checklists/requirements.md
├── plan.md                    # This file
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 output
├── quickstart.md              # Phase 1 output
├── contracts/
│   └── presence-claim.md      # Phase 1 output — module/Redis/pub-sub/env contract
└── tasks.md                   # /speckit-tasks output
```

### Source Code (repository root)

```text
server/
├── mcp/
│   ├── agent-presence.js          # MODIFIED: claim gating of all awareness writes,
│   │                              #   holder/silent session state, takeover hook in
│   │                              #   getOrCreateSession, cross-delete guard in cleanup,
│   │                              #   owner-checked claim release on cleanup
│   ├── presence-claim.js          # NEW: the claim coordinator — acquire (SET NX PX),
│   │                              #   takeover (SET PX + nudge), heartbeat loop
│   │                              #   (owner-checked refresh / NX re-acquire), owner-checked
│   │                              #   release, nudge subscription, fail-open + op timeout
│   └── __tests__/
│       ├── agent-presence.test.js          # EXTENDED: cross-delete guard, awareness gating
│       ├── presence-claim.test.js          # NEW: claim lifecycle vs mocked Redis
│       ├── presence-claim-failopen.test.js # NEW: Redis absent + Redis erroring postures
│       ├── presence-handoff.test.js        # NEW: takeover, nudge silencing, TTL failover
│       └── presence-multi-instance.test.js # NEW: two module instances, one mocked Redis
├── redis-pubsub.js                # MODIFIED: presence-claim channel (subscribe once,
│                                  #   publish takeover nudges; existing instance-ID
│                                  #   self-filtering reused)
└── __tests__/
    └── redis-pubsub.test.js       # EXTENDED: claim-channel encode/route/self-filter

README.md                          # MODIFIED: AGENT_CLAIM_* env vars + one-line behavior note
```

**Structure Decision**: single new module (`server/mcp/presence-claim.js`) beside the file it coordinates; all awareness-write gating stays inside `agent-presence.js` so there is exactly one place that touches `provider.awareness`. `redis-pubsub.js` is extended (not bypassed) for the nudge so instance-ID filtering, init/degradation behavior, and telemetry conventions are inherited rather than duplicated.

## Architecture

### Decision 1 — Claim coordinator as a separate module, sessions gate on it

`presence-claim.js` owns all Redis interaction and exposes a small API (see `contracts/presence-claim.md`): `ensureHeldForWork(claimKey)` (the takeover path), `tryAcquire(claimKey)` (NX path), `release(claimKey)`, `isHolder(claimKey)`, `onLost(callback)`, plus per-claim heartbeat management. `agent-presence.js` keeps a per-session `claimState` (`'holder'` | `'silent'`) and funnels **every** awareness write through one gate helper — `setLocalStateField('user', …)` (:616 today), cursor writes in `_broadcastCursor` (:141-147), the reuse-path cursor re-broadcast (:292-294), the finalize-path cursor init (:453-455), and the cleanup cursor clear (:348-350). When claims are disabled (no `REDIS_HOST`) the gate is a constant-true passthrough — byte-identical behavior to today (FR-012).

### Decision 2 — The hook point is `getOrCreateSession`, covering create *and* reuse

Verified: every document-touching caller goes through `getOrCreateSession` — `server/api/chat-tools.js:342` (getLiveFragment), `server/mcp/tools/modify.js:277`, `read-document.js:92`, `get-collaborators.js:99`, `restore-document-version.js:75`, `create-document.js:173`, `undo-redo-handler.js:25` — so hooking claim takeover there covers both new sessions and reused/extended ones (the takeover must fire on session *use*, not just creation). After `_createSessionCore` returns, `getOrCreateSession` awaits `ensureHeldForWork(sessionKey)`: already holder → no-op (FR-009); not holder → unconditional owner-stamped `SET … PX ttl` + takeover nudge publish, then announce (`user` field + current `session.cursor`) (FR-006/FR-008); Redis absent → holder by definition; Redis erroring/timing out → treated as holder, announce anyway (RBD-2, FR-013). The claim key **is** the existing session key content `${userId}-${agentId}-${docGuid}` (:598) rendered as `agent-presence:{userId}:{agentId}:{docGuid}` per FR-001.

### Decision 3 — Symmetric heartbeat loop: holders refresh, survivors probe

Every live session runs one claim timer at the heartbeat interval (5 s default, `unref()`'d):

- **Holder tick**: owner-checked TTL refresh (Lua via ioredis `defineCommand`: `GET == myInstanceId → PEXPIRE`, else 0). Refresh discovering foreign ownership → silence locally (FR-005 backstop for a lost nudge, bounding overlap to one heartbeat).
- **Non-holder (silent) tick**: `SET NX PX` probe. Success means the previous holder died (TTL expired, FR-010) or released cleanly (RBD-4) — announce. This yields failover within ≤ TTL after a crash and within ≤ 1 heartbeat after a clean release, satisfying US4 without a separate release-notification channel.

The owner identity is `redis-pubsub.js`'s existing `getInstanceId()` so claim ownership and nudge self-filtering share one identity.

### Decision 4 — Nudge rides `redis-pubsub.js` on one global channel

New channel `presence-claim` (single channel, not per-doc — claim events are rare and tiny), message = existing `encodeMessage()` framing (36-byte instance-ID prefix already filters self-messages) wrapping JSON `{ claimKey }`. `redis-pubsub.js` gains `subscribeToPresenceClaims(handler)` / `publishPresenceClaimTakeover(claimKey)` and routes the new channel in its existing `messageBuffer` handler. Init-ordering rule (verified in code): `agentPresence.init` runs from `server/mcp/tools/index.js:81` *before* `redisPubSub.init()` (inside the `server.listen` callback, `server/index.js:1601`), so `subscribeToPresenceClaims` only records the handler and the actual `SUBSCRIBE` is issued at `init()` (or immediately if init already ran) — a pre-init registration is never dropped. On receipt, `presence-claim.js` looks up the claim key; if this instance believed it held it → mark lost and fire `onLost` → `agent-presence.js` silences the session with **`provider.awareness.setLocalState(null)`** — full state, not per-field (FR-007) — without touching the working session, its presence-duration timer, provider, or undo history. Silencing an unheld/unknown claim is a no-op (idempotent, per spec edge case).

### Decision 5 — Fail-open posture, concretely

Matches the codebase's existing patterns (`redis-pubsub.js` warns-and-continues; `rate-limit.js` degrades to memory):

- `isRedisEnabled()` false → `presence-claim.js` is inert; every `isHolder` answer is true; zero Redis calls, zero timers (FR-012, SC-006).
- Redis configured but failing → every claim op is wrapped in `Promise.race` with `AGENT_CLAIM_OP_TIMEOUT_MS` (default 500 ms, RBD-5) and a `catch`; on error/timeout the session behaves as holder and announces (RBD-2). Errors log once per transition (not per op) to avoid log storms; recovery resumes normal claiming on the next successful op (US4 scenario 4).
- No claim op is ever on a tool call's failure path: `ensureHeldForWork` never throws (FR-013).

### Decision 6 — The cross-delete guard (instance-local bug fix)

In the session `cleanup` closure (`agent-presence.js:362` today: `sessionsByKey.delete(sessionKey)` unconditionally), guard with `if (sessionsByKey.get(sessionKey) === sessionId) sessionsByKey.delete(sessionKey)`. The `activeSessions` and `sessionsByUserId` entries are keyed by the unique `sessionId` and cannot cross-delete, so they need no guard. The rest of teardown (provider destroy, UndoManager destroy, timers, highlight queue, pending-creation entry) runs unconditionally (FR-015). The cluster-level analogue is the owner-checked claim release in the same cleanup path (RBD-4/FR-011): stop heartbeat, then Lua `GET == myInstanceId → DEL`.

### Decision 7 — Observability

Claim transitions (acquired / taken-over / silenced-by-nudge / silenced-by-heartbeat / released / reacquired-after-expiry / fail-open-entered / fail-open-recovered) log at info with `[presence-claim]` prefix + claim key (FR-016). No new metrics/spans in scope — logs are the requirement.

### Config (all env-overridable, defaults per RBD-1/RBD-5)

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_CLAIM_TTL_MS` | `15000` | Claim lifetime; worst-case failover blink |
| `AGENT_CLAIM_HEARTBEAT_MS` | `5000` | Refresh/probe interval (TTL/3) |
| `AGENT_CLAIM_OP_TIMEOUT_MS` | `500` | Per-op bound before failing open |

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.
