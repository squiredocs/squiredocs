# Tasks: Test Timeout Defects (Test Suite Speed, Train A)

**Input**: Design documents from `/specs/050-test-timeout-defects/`

**Prerequisites**: [plan.md](./plan.md) (required), [spec.md](./spec.md) (user stories),
[research.md](./research.md) (R1-R7), [quickstart.md](./quickstart.md).
`data-model.md` and `contracts/` are intentionally absent (no product entities, no
external interface — see plan.md Phase 1 Design Notes).

**Tests**: no NEW test files are written. The two suites under change ARE the
deliverable; every task's verification is running them. The only assertion additions
allowed are the strictly-additive `editRangePending` checks (FR-006 / RBD-050-2).

**Organization**: grouped by the three user stories from spec.md. US1 (backend) and
US2 (client) touch disjoint files and are fully independent; US3 (sweep) depends on
US1 only for the porting bar it reuses.

**Feature invariant (applies to every task below)**: test wiring only, never product
code, never a change to what an existing assertion proves.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 / US2 / US3

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: worktree environment ready and the baseline captured, so the speedup and
the "no semantics changed" claims are both provable.

- [ ] T001 Install dependencies in the worktree: `npm ci && (cd client && npm ci)` (worktrees do not inherit `node_modules`).
- [ ] T002 Create the per-worktree backend database and migrate it: `createdb collab_test_db_050`, then `export DATABASE_URL=postgresql://$USER@localhost:5432/collab_test_db_050` and `npm run migrate`. NEVER point at the shared `collab_test_db` — concurrent runs against it corrupt fixed-key rows. Keep `DATABASE_URL` exported for every backend command in this feature. Also export `REDIS_HOST` deliberately (`collab-redis` in the pod, `localhost` otherwise) so single-file `npx jest` runs target the same Redis as `npm run test:server`, and keep `--forceExit` on every single-file run — without it a lingering Redis client makes the run block forever (`docs/dev.md`). `npm run test:server -- <path>` does NOT work; use `npx jest <path> --runInBand --forceExit`. Do NOT defeat `--runInBand` (already wired into `npm run test:server`; backend stays serial within one DB — parallel workers are Train C/052, out of scope per FR-009).
- [ ] T003 [P] Capture the backend baseline: `npx jest server/mcp/__tests__/integration/document-editing-workflow.test.js --runInBand --forceExit --verbose 2>&1 | tee /tmp/050-backend-before.log`. Record the file total and per-test times (expect ~103s, per-test 4.97-5.31s, ~10s for the two two-modify tests) and `grep -c editRangePending` (expect > 0).
- [ ] T004 [P] Capture the client baseline: `cd client && npx vitest run src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx` plus a full-suite wall-time run. Record the file time (expect ~14.8s) and the Vitest wall (expect ~18.2s).

**Checkpoint**: environment isolated, baselines recorded — the before/after evidence for SC-001..SC-004 exists.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: read the reference pattern and the precedent before editing anything, so
the ports are copy-adaptation rather than invention.

**⚠️ CRITICAL**: no user story work begins until T005/T006 are done.

- [ ] T005 [P] Read the backend reference wiring end to end: `server/mcp/__tests__/tools/modify-echo.test.js:21-115` and `server/mcp/__tests__/tools/modify-conflict-detection.test.js:20-100`. Note the four load-bearing pieces: the module-level `pendingOperations` array, the `ydoc.on('update')` → `parseOrigin` → `persistence.storeUpdate(docGuid, update, parsed.userId, parsed.agentName)` listener, the `ORIGIN_DB_LOAD` third argument on the initial apply, and the no-op `writeState` with `provider: persistence`.
- [ ] T006 [P] Read the client fake-timer precedent in the sibling suite: `client/src/contexts/__tests__/AiChatContext.test.jsx:556-597` (`vi.useFakeTimers()` → `await act(async () => { await vi.advanceTimersByTimeAsync(6000); })` → `vi.useRealTimers()`), and `client/src/contexts/AiChatContext.jsx:26,33-39,62-77` (the establish window, `withTimeout`, and `waitForReply`'s `Date.now()` deadline + `setTimeout` poll — all on the faked clock).

**Checkpoint**: the reference pattern and precedent are understood; user stories can proceed in parallel.

---

## Phase 3: User Story 1 — Backend integration suite stops paying the 5s durability timeout (Priority: P1) 🎯 MVP

**Goal**: every changed `modify` in `document-editing-workflow.test.js` resolves its
durability wait in one or two 150ms polls instead of timing out at 5s, with existing
assertions untouched and no orphan rows left behind.

**Independent Test**: run the file alone — it drops from ~103s to ≤ ~13s, no result
contains `editRangePending`, and every test still passes on its existing assertions.

**All tasks below edit ONE file** — `server/mcp/__tests__/integration/document-editing-workflow.test.js` — so none of them are `[P]` with each other.

- [ ] T007 [US1] Add `const { ORIGIN_DB_LOAD, parseOrigin } = require('../../../origin');` to the imports and declare a module-scope `const pendingOperations = [];` in `server/mcp/__tests__/integration/document-editing-workflow.test.js` (mirrors `modify-echo.test.js:15,23`).
- [ ] T008 [US1] Replace the `setPersistence({...})` block (currently lines 50-63) in `server/mcp/__tests__/integration/document-editing-workflow.test.js` with the per-update attributed pattern: in `bindState`, install `ydoc.on('update', (update, origin) => {...})` FIRST — `parseOrigin(origin)`, early-return on `null`, otherwise push `persistence.storeUpdate(docGuid, update, parsed.userId, parsed.agentName).catch(...)` onto `pendingOperations` — then load persisted state inside `try/catch` and apply it with `ORIGIN_DB_LOAD` as the third argument to `Y.applyUpdate`, and keep `ydoc._bindComplete = true`. (FR-001)
- [ ] T009 [US1] In the same `setPersistence` object, replace the snapshot `writeState` with `writeState: async () => {}` and add `provider: persistence`. The old `persistence.storeUpdate(docGuid, Y.encodeStateAsUpdate(ydoc))` snapshot MUST be deleted, not kept alongside the listener — keeping both double-stores the document as unattributed rows (spec Edge Case "`writeState` on close"). (FR-001)
- [ ] T010 [US1] Stamp WS identity in `server/mcp/__tests__/integration/document-editing-workflow.test.js`: set `ws.userId = testUserId;` and `ws.agentName = 'Test Agent';` inside `wss.on('connection', ...)` before `setupWSConnection(ws, req, { gc: false })`, and move the test-user `INSERT` (currently lines 100-109) ABOVE the `httpServer.listen` block so the identity exists before any connection is accepted. `'Test Agent'` must equal `mockAgentToken.agentName` — the durability wait filters rows by `(userId, agentName)`. (research R2)
- [ ] T011 [US1] Add the teardown flush to `afterAll` in `server/mcp/__tests__/integration/document-editing-workflow.test.js`: `await Promise.all(pendingOperations); pendingOperations.length = 0;` placed AFTER the server-close waits and BEFORE the first `DELETE FROM ...`. Do not remove or reorder the existing sleeps or the existing delete order — the suite-cleanup convention (`server/__tests__/helpers/db.js`, reindexStale orphan class) stays exactly as it is. (FR-003)
- [ ] T012 [US1] Run the file alone and confirm the durability fix: `npx jest server/mcp/__tests__/integration/document-editing-workflow.test.js --runInBand --forceExit --verbose 2>&1 | tee /tmp/050-backend-after.log`. Gates: all tests pass, `grep -c editRangePending /tmp/050-backend-after.log` is `0`, file total ≤ ~13s, and no test carries ~5s/~10s of durability wait. (SC-001, SC-002)
- [ ] T013 [US1] Add the strictly-additive guard assertions in `server/mcp/__tests__/integration/document-editing-workflow.test.js`: for every `modify` result the suite captures, add `expect(<result>.editRangePending).toBeUndefined();` beside the existing expectations (bind the result to a variable where it currently is not, without restructuring surrounding assertions). No existing `expect` may be moved, weakened, removed, or reordered. (FR-006, RBD-050-2 — this is what keeps SC-002 enforced by the suite forever.)
- [ ] T014 [US1] Re-run the file after T013 and diff-review the change: `git diff -- server/mcp/__tests__/integration/document-editing-workflow.test.js` must show only `setPersistence` wiring, WS identity stamping + user-creation move, the teardown flush, additive `editRangePending` assertions, and (optionally) reduced per-test timeout annotations. If the `undo should succeed` / `redo should succeed` tests (~lines 1096-1168) now fail, that is a REAL finding about the record-backed undo path (they previously ran through legacy derivation because every modify timed out) — report it; never relax the assertion or revert the wiring to make it pass. (FR-006, SC-006)

**Checkpoint**: US1 is independently complete — the backend defect is fixed and self-guarding.

---

## Phase 4: User Story 2 — Client suite stops sleeping through real reconnect windows (Priority: P2)

**Goal**: the banner-persistence recovery tests verify the same outcomes without
spending real wall-clock time in the 5-second establish window.

**Independent Test**: run the client suite alone — the file completes in about a
second, Vitest wall time is under 10s, and every assertion is semantically identical.

**All tasks below edit ONE file** — `client/src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx` — so none are `[P]` with each other, but the whole phase is `[P]` with Phase 3.

- [ ] T015 [P] [US2] Add the timer-agnostic settle helper near the top of `client/src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx`: `const settle = async (ms) => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(ms) : new Promise((r) => setTimeout(r, ms)));` and replace every `await new Promise((r) => setTimeout(r, N))` in the file with `await settle(N)` (lines 64, 98, 113, 126, 139, 189, 192, 199, 227, 253; the 5600ms sleep at line 157 is converted in T017 as part of that test's rework). Behavior under real timers is unchanged, so the eight non-recovery tests keep running exactly as today. (FR-005)
- [ ] T016 [US2] Add `vi.useRealTimers();` to the existing `afterEach` in `client/src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx` (beside `cleanup()` and `vi.restoreAllMocks()`) so a failing test can never leak a fake clock into the next one.
- [ ] T017 [US2] Rework the failed-recovery test (`'a failed recovery (resume opens, no reply lands) leaves the banner'`, line 146) in `client/src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx`: insert `vi.useFakeTimers();` AFTER the opening `await waitFor(() => expect(mockApi.get).toHaveBeenCalled())` and before `sendWith(...)` — never before that `waitFor` (RTL v14 does not detect Vitest fake timers, so a `waitFor` under a fake clock hangs; research R5 hazard 1). The 5600ms sleep becomes `await settle(5600)` inside the same `act`. Assertions and their order stay byte-identical. The explicit `10000` per-test timeout may be dropped. (FR-005, FR-006, spec US2 scenario 2)
- [ ] T018 [US2] Rework the late-reply test (`'a reply that lands LATE (past the establish window)...'`, line 163) in `client/src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx`: insert `vi.useFakeTimers();` after the opening `waitFor` and BEFORE the `t.reconnectToStream = ...` patch, so the 6500ms scheduled delivery is armed on the same fake clock as the establish window (spec Edge Case "the 6500ms scheduled delivery"). Then `await settle(30)` after `sendMessage('my draft')`, `await settle(5500)` before the first-stage assertions (banner + restored draft + `reconnecting === false`), and `await settle(3200)` before the second-stage assertions (banner retired, draft withdrawn). The two-stage ORDER must remain observable — 5500 crosses the 5000ms window but not the 6500ms delivery; 3200 then crosses it. The explicit `20000` per-test timeout may be dropped. (FR-005, FR-006, spec US2 scenario 3)
- [ ] T019 [US2] Run the file and the full client suite: `cd client && npx vitest run src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx` then `npx vitest run --reporter=../script/vitest-llm-reporter.mjs`. Gates: all 10 tests pass, the file reports ≈1s or less, and Vitest wall time is under 10s. (SC-004)
- [ ] T020 [US2] Diff-review `git diff -- client/src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx`: only the `settle` helper + substitutions, the `afterEach` timer restore, two `vi.useFakeTimers()` installs, and dropped per-test timeout annotations. Confirm `client/src/contexts/AiChatContext.jsx` and all other product files are UNCHANGED (`git status`). If fake timers proved infeasible, STOP and report — do NOT reach for the injectable window; that breaches FR-007 and re-opens G-050-1. (FR-006, FR-007, SC-006, spec US2 scenario 4)

**Checkpoint**: US1 and US2 both work independently.

---

## Phase 5: User Story 3 — No other suite carries the pre-016 wiring gap (Priority: P3)

**Goal**: the defect class is provably closed across the whole backend test tree, with a
reproducible method and a recorded classification — even when the sweep finds nothing.

**Independent Test**: `specs/050-test-timeout-defects/sweep-results.md` exists and
classifies every backend suite that executes a live `modify`.

- [ ] T021 [US3] Re-execute the sweep at implement time over BOTH backend roots (`server` and the repo-root `__tests__` — Constitution Principle II names both; the spec's spec-time evidence enumerated `server/` only) using the three commands in [research.md](./research.md) R6: (a) `grep -rl "setPersistence" --include=*.test.js server __tests__ | sort`, (b) the snapshot-only filter loop, (c) the registry-users-without-persistence check. Capture raw output.
- [ ] T022 [US3] Classify every file from T021 as per-update-attributed / snapshot-only / not-applicable (mocked registry or `modify` as a name-string only), and write `specs/050-test-timeout-defects/sweep-results.md` containing the commands, their raw output, the per-file classification, and the explicit finding — including "no additional offenders beyond document-editing-workflow" if that is the result. (FR-004, SC-007, RBD-050-3)
- [ ] T023 [US3] If T022 found any additional snapshot-only suite that executes a live `modify` through the tool registry, port it to the same bar as US1 (T008-T011 pattern: listener + `ORIGIN_DB_LOAD` + no-op `writeState` + teardown flush) and re-run that suite. If the sweep is empty, record that explicitly and skip — the empty result is the deliverable. (FR-004, spec US3 scenario 2)

**Checkpoint**: all three user stories independently complete.

---

## Phase 6: Polish & Cross-Cutting Verification

- [ ] T024 Run the authoritative full verification with `DATABASE_URL` still pointed at `collab_test_db_050`: `time npm run test:server` (keeps `--runInBand` + `./script/jest-llm-reporter.js`), then `npm run test:client`, then `npm run test:first-run`. All three MUST be green. (FR-008, SC-005)
- [ ] T025 Record the measured numbers in `specs/050-test-timeout-defects/sweep-results.md` (or a short "Results" section appended to it): backend total before/after, document-editing-workflow file before/after with per-test spread, client file and Vitest wall before/after. The ≈175s backend total is a reference-machine EXPECTATION for the design doc's trend table, not a gate (SC-003, RBD-050-4).
- [ ] T026 Final scope audit: `git diff --name-only` must contain only files under `__tests__` directories plus `specs/050-test-timeout-defects/`. Confirm zero product-code changes (`client/src/contexts/AiChatContext.jsx`, `server/mcp/yjs/edit-range.js`, everything under `server/mcp/` outside `__tests__/`), zero migrations, zero policy changes (no CI workflow, no perf-guard move, no constitution edit — FR-009 keeps §1.3/§1.4/Part 2 for Trains B and C). (FR-007, FR-009)
- [ ] T027 Walk [quickstart.md](./quickstart.md) top to bottom and confirm each of SC-001..SC-007 has a recorded pass, then drop the scratch database (`dropdb collab_test_db_050`).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies. T003/T004 are the before-measurements and MUST be taken before any file edit.
- **Foundational (Phase 2)**: depends on T001. Blocks all user stories (reading the reference pattern is what makes the ports faithful).
- **US1 (Phase 3)** and **US2 (Phase 4)**: both depend only on Phase 2; they touch disjoint files and can run fully in parallel.
- **US3 (Phase 5)**: the sweep (T021/T022) is independent and can run any time after Phase 2; T023's porting reuses the US1 pattern, so it should follow Phase 3.
- **Polish (Phase 6)**: depends on all three stories.

### Within Each User Story

- US1: T007 → T008 → T009 → T010 → T011 → T012 (verify) → T013 (additive guards) → T014 (re-verify + diff review). Strictly sequential — one file.
- US2: T015 → T016 → T017 → T018 → T019 (verify) → T020 (diff review). Strictly sequential — one file.
- US3: T021 → T022 → T023.

### Parallel Opportunities

- T003 and T004 (backend vs. client baselines) — different suites.
- T005 and T006 (reading backend reference vs. client precedent) — read-only.
- The whole of Phase 3 (US1) runs in parallel with the whole of Phase 4 (US2) — disjoint files, disjoint runners. **Caveat**: only ONE backend Jest run may be in flight against `collab_test_db_050` at a time; client Vitest runs are unaffected.
- T021/T022 (sweep) can overlap with either story.

### Parallel Example

```bash
# After Phase 2, two independent tracks:
Track A (backend): T007 → T008 → T009 → T010 → T011 → T012 → T013 → T014
Track B (client):  T015 → T016 → T017 → T018 → T019 → T020
# Sweep (T021 → T022) may run alongside either; T023 waits for Track A's pattern.
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup (including the baselines — without them the speedup is unprovable).
2. Phase 2 Foundational.
3. Phase 3 US1 → **STOP and VALIDATE** with T012/T014: ~103s → ≤ ~13s, zero `editRangePending`, all assertions intact.
4. That alone removes 90 of the ~103 wasted backend seconds and makes the suite certify the correct code path.

### Incremental Delivery

1. US1 → validate → the largest single win in the entire test run.
2. US2 → validate → roughly halves Vitest wall time; independent of US1.
3. US3 → validate → closes the defect class with a recorded, reproducible sweep.

---

## Notes

- `[P]` tasks = different files, no dependencies.
- Commit after each task or logical group (implementer only, in its own worktree; the plan/tasks agent never commits).
- **Never weaken a test to make it pass.** Every existing `expect` keeps its meaning, order and trigger conditions; only strictly-additive assertions are permitted (FR-006 / RBD-050-2). A test that fails after the port is evidence about the code path the suite was previously timing out around — report it.
- **Never touch product code** (FR-007). If fake timers turn out to be infeasible, STOP and report rather than making the establish window injectable (RBD-050-1 / G-050-1).
- Backend runs stay serial (`--runInBand`) against the feature's OWN database; parallel isolation is Train C (052).
