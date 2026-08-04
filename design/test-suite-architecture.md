<!-- source: https://squiredocs.com/d/f4f95e7b-ace9-4363-8ef9-05b009140d76
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Proposal: Test Suite Architecture (Speed and Isolation)

_Status: Ratified 2026-08-04 (Sam; open decisions D1-D4 taken at their stated defaults) · Scope: cut test wall-clock time from about 5 minutes to under 1 minute by fixing two measured timeout defects, restructuring CI, and moving the backend suite from mandated-serial to isolated-parallel execution. Requires a Constitution Principle II amendment (Part 2 only). Pipeline: Train A = 050-test-timeout-defects, Train B = 051-ci-parallel-jobs, Train C = 052-parallel-test-isolation._

## Summary

The full test run today is about 264 seconds of backend Jest, 18 seconds of client Vitest, and 3 seconds of the first-run rehearsal suite, and CI runs all three strictly in sequence on one runner. Profiling on 2026-08-04 (report: tmp/test-suite-speed-analysis-2026-08-04.md in the repo) showed the time is not spread evenly: 8 backend files account for 66% of backend time, and the two biggest costs are not real work but timeouts being paid in full. This proposal fixes those defects (Part 1), restructures CI (Part 1), and then makes the backend suite parallel-safe with per-worker database and Redis isolation (Part 2). Expected end state: backend suite around 30 to 50 seconds, client suite around 7 seconds, CI wall time roughly equal to the backend job alone.

## Current State (measured 2026-08-04, app-dev pod, 10 cores)

| Suite | Runner | Time | Notes |
| --- | --- | --- | --- |
| Backend (254 files, 4574 tests) | Jest, --runInBand | 264s | Serial per Constitution II; uses ~26% of one core |
| Client (72 files, 936 tests) | Vitest, parallel | 18.2s wall | One file is 14.8s, more than the next ten combined |
| first-run rehearsal (31 tests) | node --test | 3.2s | Not a factor |

Backend distribution: 8 files account for 174s (66%). The remaining 246 files average 0.37s each, about 90s total. The top offenders:

| File | Seconds | Cause (verified) |
| --- | --- | --- |
| server/mcp/__tests__/integration/document-editing-workflow.test.js | 103.0 | Every changed modify pays the full 5s edit-range durability timeout (defect, below) |
| server/mcp/__tests__/tools/modify-sources.test.js | 17.8 | Convergence polling at 100-150ms intervals over many streamed modifies |
| server/__tests__/borrowed-identity-performance.test.js | 15.8 | Deliberate perf guard (feature 043) |
| __tests__/integration/awareness-spoof-block.test.js | 11.6 | Real WS server, tick(60) waits and bounded polls |
| server/mcp/__tests__/tools/modify-conflict-detection.test.js | 7.4 | Genuine work (correctly wired) |
| server/__tests__/per-operation-doc.test.js | 6.7 | Deliberate perf guard (feature 049) |
| server/mcp/__tests__/integration/undo-redo-workflow.test.js | 6.6 | Genuine work (correctly wired) |
| server/mcp/sandbox/__tests__/security.test.js | 5.4 | Genuine isolate work |

## Part 1: Fix the Measured Defects (no policy change)

### 1.1 Backend: pre-016 persistence wiring in document-editing-workflow (103s to ~13s)

Since feature 016, every `modify` that changes the document waits for the update log to durably contain identity-attributed rows covering the edit (`awaitDurableRange`, bounded by `EDIT_RANGE_WAIT_MS = 5000` in server/mcp/yjs/edit-range.js, polling every 150ms). Suites written after 016 wire their test persistence so each streamed update is stored with identity: `persistence.storeUpdate(docGuid, update, userId, agentName)` (see modify-echo.test.js:52 and modify-conflict-detection.test.js:44). The wait then resolves in one or two polls.

document-editing-workflow.test.js predates 016 and still uses snapshot-only persistence: `bindState` plus a `writeState` that only runs on connection close. The attributed rows never appear while the tool polls, so every changed modify times out at the full 5 seconds and returns editRangePending. Measured per-test times cluster at 4.97 to 5.31 seconds, and the two tests that run two modifies each take about 10 seconds. The sandbox worker path itself measures about 80ms per call, so the suite is almost pure timeout.

**Change:** port the suite setup to the per-update identity-attributed storeUpdate pattern used by modify-echo. Sweep the other pre-016 suites for the same wiring gap (any suite that calls modify through the tool registry but registers only bindState/writeState). Expected saving: about 90 seconds, taking the backend suite from 264s to roughly 175s.

### 1.2 Client: real sleeps waiting out real reconnect windows (18.2s to ~7s)

`AiChatContext.banner-persistence.test.jsx` takes 14.8 seconds, more than the next ten client files combined, and it is the wall-clock critical path of the Vitest run. Its recovery tests wait out the real 5-second reconnect-establish window with real sleeps (5600ms, 6500ms plus 3200ms, 5500ms against `RECONNECT_ESTABLISH_MS`).

**Change:** switch the file to fake timers, or make the establish window injectable so tests can shrink it. Either collapses the file to under a second. The test semantics do not change: the tests assert what happens when the window elapses, not that 5 real seconds passed.

### 1.3 CI: parallel jobs and a warm transform cache

The single job in .github/workflows/test.yml runs `npm ci` twice, then backend, client, and first-run strictly in sequence, with a cold Jest transform cache every run (locally that cache is 543MB; the Babel transform of @ai-sdk and 254 suites is real work that CI repeats each time).

- Split into two parallel jobs: backend (postgres + redis services) and client plus first-run (no services needed). CI wall time becomes roughly the backend job alone.
- Set a repo-local Jest `cacheDirectory` and cache it with actions/cache keyed on package-lock.json, alongside the existing npm cache.
- No behavior change to what is tested; both jobs still gate the push.

### 1.4 Optional: separate the perf guards

borrowed-identity-performance (15.8s) and per-operation-doc (6.7s) are deliberate regression guards with generous contention-tolerant ceilings. Option: move them to a `test:perf` script that CI always runs but the local default skips. This trades 22 seconds of local loop time against the risk that a perf regression is only caught in CI. Decision left open (D2 below).

## Part 2: Isolated-Parallel Backend Execution

The serial mandate exists because all 254 suites share one database (`collab_test_db`) and some suites use fixed-key rows, so concurrent runs corrupt each other. That constraint has already produced the reindexStale class of CI flakes, where orphan rows written by one suite surface as failures in an unrelated one, and the suite-cleanup convention in helpers/db.js exists to manage it. Isolation removes the root cause instead of managing it. After Part 1 the suite is about 175s serial while using a quarter of one core on a 10-core machine; Jest workers with isolated state should land at 30 to 50 seconds.

### 2.1 Design decision: per-worker template databases

Three isolation approaches were considered:

| Approach | How | Verdict |
| --- | --- | --- |
| Per-worker databases (recommended) | globalSetup migrates a template once, then CREATE DATABASE collab_test_db_wN TEMPLATE for each worker; helpers/db.js keys the URL off JEST_WORKER_ID | Small diff, no per-suite changes, template copy is fast, matches how suites already assume a whole database |
| Per-test transaction rollback | Wrap each test in BEGIN/ROLLBACK | Does not work here: suites exercise real WS servers, pools, and background writers that need committed rows across connections |
| Container per worker (testcontainers) | One postgres container per worker | Heavyweight, slow startup, new dependency; solves the same problem as template databases with more moving parts |

Mechanics for the recommended approach: globalSetup creates and migrates `collab_test_db_template`, then creates one `collab_test_db_w<N>` per worker from the template (dropping stale copies first). `getTestDatabaseUrl()` appends the `JEST_WORKER_ID` suffix; with --runInBand the id is 1, so serial runs keep working unchanged. CI passes an explicit DATABASE_URL today, which becomes a base URL the helper suffixes the same way.

### 2.2 Redis isolation

server/redis.js currently has no database or key-prefix knob. Add `REDIS_DB` support to REDIS_CONFIG (default 0, so production config is byte-identical when unset), and have the test setup assign each worker its own logical database from JEST_WORKER_ID. Redis ships 16 logical databases, which caps workers at 15; that is far above the useful worker count on our runners. Suites that exercise pub/sub keep working because both the shared client and pub/sub clients read the same config.

### 2.3 Constitution amendment (Principle II)

Current text: "Backend tests share one database and MUST run serially — never launch concurrent backend test runs against the same DB." Proposed replacement, keeping the invariant that actually matters:

> Backend test runs MUST be isolated: each Jest worker (and each concurrent invocation) gets its own database and Redis logical database, derived from JEST_WORKER_ID. Two runs or workers MUST never share a database. Suites must not assume they own the only database; fixed-key rows stay scoped to the suite that creates them.

The amendment is a sole-maintainer commit to main per the Governance section. The suite-cleanup convention in helpers/db.js stays (it still protects within-worker suite ordering), but the cross-suite orphan flake class disappears by construction.

### 2.4 Risks and their handling

- Two concurrent invocations (for example, a manual run while a pipeline merge-queue run is active) would both derive w1, w2, and so on from JEST_WORKER_ID alone. Either keep the one-run-at-a-time rule for whole invocations, or add a per-run nonce to the database name. Recommendation: keep the rule; the merge queue is already serial and a nonce complicates cleanup. Open as D3.
- Hidden cross-suite coupling: suites that accidentally depend on rows another suite left behind will start failing once suites land on different workers. Those failures are the isolation working; each one gets fixed as a self-contained suite bug. Expect a short tail of these on first parallel runs.
- Timing-sensitive suites may flake under CPU contention with 6 to 8 workers. The perf guards already use contention-tolerant ceilings; any other suite that flakes gets its ceiling reviewed, not the worker count.
- jest --runInBand remains fully supported (worker id 1), so bisecting a failure serially still works, and the LLM reporter output is unchanged.

## Expected Outcomes

| Stage | Backend | Client | CI wall (after npm ci) |
| --- | --- | --- | --- |
| Today | 264s | 18s | ~290s, sequential |
| After Part 1 | ~175s | ~7s | ~180s, jobs in parallel |
| After Part 2 (6-8 workers) | 30-50s | ~7s | ~40-60s |

Part 2 also removes the shared-database flake class (reindexStale orphans, fixed-key collisions) by construction, which is worth as much as the speed.

## Verification

- Part 1.1: per-test times in document-editing-workflow drop from ~5s to well under 1s; no editRangePending in the suite; full backend suite green.
- Part 1.2: Vitest wall time under 10s; the banner-persistence assertions unchanged.
- Part 2: five consecutive full parallel runs green locally and in CI before the serial default is dropped; run the suite serially and in parallel and diff the pass lists to confirm no suite depends on execution mode.
- Keep the LLM-friendly reporters wired in throughout (constitution requirement).

## Rollout and Pipeline Queueing

Three trains, in order. Part 1 items are independent of Part 2 and land first; nothing in Part 1 touches policy.

1. Train A (small, direct or single feature): 1.1 persistence wiring fix plus the pre-016 sweep, and 1.2 client fake timers.
2. Train B (small): 1.3 CI split and cache. Pure workflow-file change, no app code.
3. Train C (feature train through /the-pipeline): Part 2 isolation: template databases, JEST_WORKER_ID plumbing, REDIS_DB knob, constitution amendment, CI maxWorkers. Gate merging on the five-green-runs verification.

## Open Decisions

| ID | Question | Default if unanswered |
| --- | --- | --- |
| D1 | Ratify the Principle II amendment in 2.3? | Proceed as written (RATIFIED-BY-DEFAULT per pipeline rules) since it strengthens the real invariant |
| D2 | Move the two perf guards to test:perf (CI-only)? | Leave them in the default run; 22s is tolerable once Part 2 lands |
| D3 | Concurrent whole invocations: keep one-run-at-a-time, or per-run nonce? | Keep one-run-at-a-time |
| D4 | Local default worker count | maxWorkers: 50% locally, explicit maxWorkers in CI sized to the runner |