---
description: "Task list for feature 010-app-production-hardening"
---

# Tasks: Application Production Hardening

**Input**: Design documents from `/specs/010-app-production-hardening/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: INCLUDED — mandatory here (spec FR-025 + Constitution Principle II: every behavioral
change is test-backed; the suite is the only reviewer). Backend Jest runs **serially**
(`--runInBand`, shared DB); client is Vitest.

**Organization**: Grouped by user story (P1..P5). Each story is an independently testable,
independently valuable increment. Server-code-only — **no k8s manifests, no migrations.**

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1..US5 for story-phase tasks; Setup/Foundational/Polish carry no story label

## Path Conventions

Single Express web-service repo. Server under `server/`, client under `client/src/`, backend tests
under `server/__tests__/` and `__tests__/integration/`, client tests colocated in `__tests__/`.

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Add `rate-limiter-flexible` to `package.json` dependencies and run `npm install` inside the `app-dev` pod; confirm it resolves and `npm run build` still succeeds.
- [X] T002 [P] Establish the env-var default catalog referenced across modules (in each module's config read, no central file required): `TRUST_PROXY_HOPS`=1, `SHUTDOWN_DEADLINE_MS`=20000, `CHAT_BODY_LIMIT`=10mb, `DB_POOL_MAX`=20, `DB_POOL_ACQUIRE_TIMEOUT_MS`=5000, `DB_STATEMENT_TIMEOUT_MS`=30000, `REDIS_PASSWORD`=(unset), and the `RL_*` budgets per `contracts/rate-limiting.md`. Record the list in a code comment block so the converge step can fold it into README/docs (out of this agent's edit scope).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: shared process-lifecycle state consulted by both US1 (shutdown/WS) and US4 (/ready).

- [X] T003 Create `server/lifecycle.js` (shared process-state module) exporting `draining` and `initialized` flags with getters/setters (e.g. `isDraining()`, `beginDraining()`, `isInitialized()`, `markInitialized()`). This is the single source both the shutdown path (US1) and `/ready` + the WS upgrade guard read. No behavior yet beyond the flags.

**Checkpoint**: lifecycle flags importable; nothing else depends on incomplete work.

---

## Phase 3: User Story 1 — Rolling deploy never loses the edit tail (P1) 🎯 MVP

**Goal**: SIGTERM/SIGINT run one ordered graceful drain that flushes in-flight Yjs persistence
before exit, under a deadline below the 30s grace period. No acknowledged edit lost.

**Independent test**: two clients editing; send SIGTERM mid-typing; process exits within the
deadline; last pre-signal edits are persisted after restart; clients reconnect and converge.

### Implementation

- [X] T004 [US1] Add a pending-persistence tracker (`Set<Promise>`, e.g. `pendingWrites`) to the persistence wiring: in `server/index.js` `setPersistence.bindState` update listener (~L196-234), register each `retryWithBackoff(() => storeUpdate(...))` promise on start and remove on settle. Export the tracker (or a `flushPendingWrites()` helper) for the shutdown path and tests.
- [X] T005 [US1] Create the shared shutdown routine (`server/shutdown.js` or an inline `runShutdown({ deadlineMs })` in `server/index.js`) bound to **both** `SIGTERM` and `SIGINT`, replacing the current SIGINT-only handler (`server/index.js` ~L1895-1917). Ordered steps: ignore-if-draining (FR-002) → `lifecycle.beginDraining()` → close live WS sessions (`for (const c of wss.clients) c.close(1001)`) → `await` the pending-persistence tracker (`Promise.allSettled`) → `redisPubSub.cleanup()` → `persistenceProvider.destroy()` → `closeRedis()` → `server.close()` → `process.exit(0)`. Add a `setTimeout(()=>process.exit(0), SHUTDOWN_DEADLINE_MS).unref()` force-exit backstop (default 20000, RD-8).
- [X] T006 [US1] Refuse new WebSocket upgrades while draining: in the `server.on('upgrade')` handler (`server/index.js` ~L1511) return early with a `503`/socket-destroy when `lifecycle.isDraining()`, so clients fail over to a healthy replica (FR-001, US1 scenario 2).

### Tests

- [X] T007 [P] [US1] `server/__tests__/shutdown-flush.test.js`: with a still-pending write in the tracker, assert `runShutdown` awaits `pendingWrites` (mock `process.exit`) before exit, and that an update accepted just before drain is present in persisted state afterward (FR-004, SC-001).
- [X] T008 [P] [US1] `server/__tests__/shutdown-deadline.test.js`: wedge the flush (never-resolving) and assert force-exit fires at `SHUTDOWN_DEADLINE_MS`; assert SIGINT runs the same path and a second signal mid-drain is ignored (FR-002/003, SC-002).

**Checkpoint**: US1 independently shippable — graceful shutdown works end to end.

---

## Phase 4: User Story 2 — Abuse limits that can't be dodged by spoofing (P2)

**Goal**: Redis-backed per-IP limits on unauthenticated routes and per-user limits on expensive
routes, degrading to per-process on Redis outage; anonymous registration bounded; the limiter key
derived from a spoof-proof numeric trust-proxy hop count.

**Independent test**: exceed a per-IP budget → uniform 429 + `Retry-After`; restart mid-budget →
budget unchanged; forged `X-Forwarded-For` → still keyed on true source; per-user budget keyed on
user; registration flood capped with no rows written.

### Implementation

- [X] T009 [US2] Create `server/rate-limit.js`: build `RateLimiterRedis` over `getRedisClient()` with a `RateLimiterMemory` `insuranceLimiter` per route class (RD-3/FR-008); memory-only path when `!isRedisEnabled()` or `RL_FORCE_MEMORY=1`. Export namespaced key builders (`rl:auth:ip:`, `rl:token:ip:`, `rl:register:ip:`, `rl:register:global`, `rl:search:user:`, `rl:import:user:`, `rl:export:user:`, `rl:chat:user:`), a `perIp(class)` and `perUser(class)` middleware factory, a `checkRegistrationAdmission(ip)` helper, the 429 responder (`Retry-After` from `msBeforeNext` + neutral body, FR-009), and `_reset()` test seam. Budgets from env per `contracts/rate-limiting.md` (RD-1). _(Amended 2026-07-18: the `rl:register:ip:`/`rl:register:global` key builders, the `checkRegistrationAdmission` helper, and the `GLOBAL_KEY` constant were removed — sign-up is now unlimited; see promotion-notes §8.)_
- [X] T010 [US2] Change trust proxy from blanket `true` to numeric in `server/index.js` L64: `app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1))` (FR-014, RD-5).
- [X] T011 [US2] Mount `perIp` middleware: `perIp('auth')` on `/auth` (`server/index.js` L314) and `perIp('token')` narrowly on `POST /mcp/auth/token` (guard the token path only, not all of `/mcp/auth/*`) (FR-005).
- [X] T012 [US2] Mount `perUser` middleware (after `requireAuth`) on chat (`POST /api/chat`, `server/index.js` L319 / `server/api/chat.js` router), markdown import + document export routers (L1123/L1127), and content search — limit the search branch only when `searchMode === 'content'` (`server/index.js` ~L496) (FR-006).
- [X] T013 [US2] Apply registration admission caps in `server/mcp/auth/oauth-flow.js`: gate `handleRegister` (L602) with `perIp('register')` + global daily counter, and add an inline `checkRegistrationAdmission` guard on the auto-register branches in `handleAuthorize` (L114) and `handleApprove` (L215), sharing the same per-IP `register` budget; over budget → uniform 429, **no row written** (FR-011, RD-2). _(Amended 2026-07-18: registration admission caps removed — the register/auto-register paths are now unlimited; see promotion-notes §8.)_

### Tests

- [X] T014 [P] [US2] `server/__tests__/rate-limit-perip.test.js`: exceed `RL_AUTH_PER_MIN` from one IP → 429 + `Retry-After`, other IP unaffected; per-user chat budget keyed on user; `/health` + `/ready` exempt (FR-005/006/009/012, SC-003).
- [X] T015 [P] [US2] `server/__tests__/rate-limit-degrade.test.js`: budget persists across a simulated restart / other replica (shared Redis), and with Redis unavailable limiting degrades to per-process memory — no crash, no reject-all (FR-007/008, SC-003).
- [X] T016 [P] [US2] `server/__tests__/trust-proxy-spoof.test.js`: forged `X-Forwarded-For: 1.2.3.4, 5.6.7.8` and no-header cases both key on the true trusted-hop IP; 0 successful spoof-keyed requests over budget; `buildBaseUrl`/protocol still resolve (FR-015, SC-003).
- [X] T017 [P] [US2] `server/__tests__/registration-caps.test.js`: register flood from one IP capped at the per-IP budget with no new `registered_agents` rows over budget; aggregate never exceeds the global daily cap; the authorize auto-register path shares the same budget (FR-011, SC-004). _(Amended 2026-07-18: this test file was deleted when the registration admission caps were removed — see promotion-notes §8.)_

**Checkpoint**: US2 independently shippable — abuse surface bounded and spoof-proof.

---

## Phase 5: User Story 3 — Oversized chat request can't OOM a pod (P3)

**Goal**: chat inline body bounded with an actionable 413; attachment bytes travel the S3 path;
chat resolves references user-scoped; degrade gracefully without S3.

**Independent test**: attachment via upload path reaches the model; just-over-limit body → fast
413 with guidance; long text-only conversation accepted; user can't reference another user's
attachment; unconfigured S3 → clear 503.

### Implementation

- [X] T018 [US3] Shrink the `/api/chat` body limit: `express.json({ limit: process.env.CHAT_BODY_LIMIT || '10mb' })` (`server/index.js` L319) and make the `entity.too.large` → 413 branch (`server/index.js` ~L1466) emit the actionable message pointing at `POST /api/chat/attachments` (FR-017, RD-6).
- [X] T019 [US3] Create `server/api/chat-attachments.js`: `POST /api/chat/attachments` (`requireAuth`) storing bytes via `s3-images.putObject` under `chat-attachments/<userId>/<uuid>`, returning a reference; mime allow-list + per-file size mirror `document-images.storeImage`; 503 clear message when `!s3Images.isEnabled()` (FR-016/019). Mount it in `server/index.js` beside the chat router.
- [X] T020 [US3] Resolve attachment references in `server/api/chat.js`: extend `extractMessageImages` (L400) and `inlineDataUrls` (L381) so a message file part carrying a reference is resolved via `s3-images.getObject(key)` **only if** the key's `<userId>` equals `req.user.userId` (user-scope, FR-016); feed resolved bytes into both the model file parts and the `messageImages` array so `insert_image` and the model behave as before (FR-018).
- [X] T021 [US3] Client: in `client/src/contexts/AiChatContext.jsx` send path (`sendMessage`, ~L595), upload each file to `/api/chat/attachments` first and send references instead of inline `data:` URLs; keep draft persistence and last-message retry working.

### Tests

- [X] T022 [P] [US3] `server/__tests__/chat-body-limit.test.js`: body just over `CHAT_BODY_LIMIT` (incl. legacy inline-base64) → 413 with attachment-path guidance; long text-only conversation under the limit accepted (FR-017, SC-005/009).
- [X] T023 [P] [US3] `server/__tests__/chat-attachments.test.js`: upload → reference → resolution feeds the model; user A cannot resolve user B's key (403/refusal); unconfigured S3 → 503 clear message (FR-016/019).
- [X] T024 [P] [US3] Client Vitest (colocated under `client/src/contexts/__tests__/`): send with files uploads to `/api/chat/attachments` and sends references, not base64 (FR-016).

**Checkpoint**: US3 independently shippable — chat OOM vector closed, attachments preserved.

---

## Phase 6: User Story 4 — Dead-dependency pod stops taking traffic (P4)

**Goal**: `GET /ready` gates on Postgres reachability + lifecycle state, reports (not gates) cache;
`/health` stays pure liveness. (Repointing the k8s probe is feature 011's job.)

**Independent test**: healthy `/ready` 200 with detail; Postgres down → `/ready` 503 while
`/health` 200; cache down → `/ready` 200 degraded; startup/drain → 503; no secrets leaked.

### Implementation

- [X] T025 [US4] Add `persistenceProvider.ping()` in `server/postgres-persistence.js`: `SELECT 1` with a short timeout (`Promise.race`/`statement_timeout`), acquiring and releasing a connection immediately (must not hold a pool connection past the check — Edge Cases).
- [X] T026 [US4] Add `GET /ready` in `server/index.js` (unauthenticated, not wrapped by the limiter): 200 iff `lifecycle.isInitialized()` && `!lifecycle.isDraining()` && `ping()` succeeds; else 503. Body `{status, datastore, cache}` where `cache` reflects `isRedisReady()`/pubsub but **never gates** (RD-4, FR-020/021); no secrets/versions/hostnames (FR-022).
- [X] T027 [US4] Set `lifecycle.markInitialized()` at the end of the `server.listen` callback after `redisPubSub.init()` resolves (`server/index.js` ~L1483-1501), so `/ready` returns 503 during startup (US4 scenario 4). Confirm `/health` (L472) is unchanged and both endpoints are limiter-exempt (FR-012/022).

### Tests

- [X] T028 [P] [US4] `server/__tests__/ready-endpoint.test.js`: healthy → 200 `{datastore:'up',cache:'up'}`; Postgres unreachable → 503 within ~2s while `/health` stays 200; cache down + datastore up → 200 `cache:'degraded'`; pre-init and draining → 503; body exposes no secrets/versions/hostnames (FR-020/021/022, SC-006).

**Checkpoint**: US4 independently shippable — `/ready` live (unused by orchestrator until 011).

---

## Phase 7: User Story 5 — Bounded datastore misbehavior + Redis AUTH (P5)

**Goal**: pg pool gets explicit max, acquisition timeout, and server-side statement timeout (app
pool only); Redis honors `REDIS_PASSWORD` when set (byte-identical when unset).

**Independent test**: saturate the pool → waiting request fails fast at acquisition timeout, slow
statements killed at statement timeout, pool self-recovers; Redis auth works with password set and
is unchanged when unset.

### Implementation

- [X] T029 [US5] In `server/postgres-persistence.js` constructor (L13-17), merge into the `Pool` config: `max` (`DB_POOL_MAX`||20), `connectionTimeoutMillis` (`DB_POOL_ACQUIRE_TIMEOUT_MS`||5000), `statement_timeout` (`DB_STATEMENT_TIMEOUT_MS`||30000) — app pool sessions only; migration (`script/migrate.js`) and backup processes use their own connections and are untouched (FR-023, RD-7).
- [X] T030 [P] [US5] In `server/redis.js` `REDIS_CONFIG` (L4), conditionally spread `...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {})` so both `getRedisClient()` and `createPubSubClient()` authenticate when set and the config is **byte-identical** when unset (FR-024).

### Tests

- [X] T031 [P] [US5] `server/__tests__/pg-pool-limits.test.js`: saturate the pool with slow statements → an unrelated request fails fast at the acquisition timeout; slow statements killed at `statement_timeout` and the pool self-recovers without a restart (FR-023, SC-007).
- [X] T032 [P] [US5] `server/__tests__/redis-auth.test.js`: with a password-protected Redis + `REDIS_PASSWORD` set, the shared client and a pub/sub client authenticate and function; unset against an unauthenticated Redis, behavior/config unchanged (FR-024, SC-008).

**Checkpoint**: US5 independently shippable — pool bounded, Redis AUTH-capable.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T033 Run the authoritative gate: `npm test` (backend serial + client) and `npm run build` both green; confirm normal interactive use (login, search, import/export, chat with attachments, collaborative editing) hits no 429/413 at default limits (SC-009).
- [X] T034 [P] Compile the converge hand-off note: new endpoints (`GET /ready`, `POST /api/chat/attachments`) and the full env-var catalog need to reach `README.md` + `docs/dev.md` (out of this agent's edit scope — pipeline override). Also restate the two feature-011 handoffs (readinessProbe repoint; `REDIS_PASSWORD`/`--requirepass` provisioning) and the two secondary alignments (`TRUST_PROXY_HOPS`=2 prod; `terminationGracePeriodSeconds` > shutdown deadline) so the merge/deploy owner picks them up.

---

## Dependencies & Execution Order

- **Setup (T001-T002)** → **Foundational (T003)** → user stories.
- **Foundational (T003 lifecycle flags)** blocks US1 (shutdown/WS) and US4 (/ready). Do it first.
- **User stories are independent** and can proceed in any order after Foundational, but priority
  order is P1(US1) → P2(US2) → P3(US3) → P4(US4) → P5(US5).
- Within US2, T009 (rate-limit module) blocks T011-T017; T010 (trust proxy) blocks T016.
- Within US3, T019 (upload endpoint) and T020 (resolution) precede T024/T023; T021 (client)
  depends on T019's contract.
- Within US4, T025 (ping) + T027 (init flag) precede T026/T028.
- Polish (T033-T034) runs last.

## Parallel Opportunities

- Setup: T002 ∥ (after T001).
- All per-story **test** tasks are `[P]` (distinct files): T007∥T008; T014∥T015∥T016∥T017;
  T022∥T023∥T024; T031∥T032.
- Cross-story: once Foundational is done, US5's T029/T030 (`[P]`, isolated files) can proceed in
  parallel with US1-US4 implementation since they touch only `postgres-persistence.js` / `redis.js`.

## Implementation Strategy

- **MVP = User Story 1 (P1)** alone: it stops active, recurring data loss on every deploy — the
  only harm already occurring on a schedule. Ship + verify US1 before layering US2-US5.
- Each subsequent story is an independent increment with its own checkpoint and test gate.
- Final gate: `npm test` + `npm run build` (T033).

## Notes

- Server-code-only: **no** k8s manifest edits, **no** node-pg-migrate migrations in any task.
- Two cross-feature handoffs are feature 011's, not tasks here: readinessProbe repoint and Redis
  `--requirepass`/`REDIS_PASSWORD` provisioning (T034 hands them off).
- FR-013/RD-9 (don't double-limit 008/009 login budgets) is vacuous in this worktree (no login
  code at HEAD `881aa9f`); key namespacing in T009 keeps a later merge collision-free.
