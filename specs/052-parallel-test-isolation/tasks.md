---
description: "Task list for 052-parallel-test-isolation"
---

# Tasks: Parallel Test Isolation (Backend Suite)

**Input**: Design documents from `/specs/052-parallel-test-isolation/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/naming-and-env.md](./contracts/naming-and-env.md), [quickstart.md](./quickstart.md), [clarifications-needed.md](./clarifications-needed.md)

**Tests**: Test tasks are **mandatory** here, not optional — Constitution Principle II requires every behavioral change to be test-backed, and this feature's whole subject matter is the test suite. FR-004 additionally forbids fixing isolation by editing suites' own code, so the new tests are the only place isolation behavior gets asserted directly.

**Organization**: grouped by user story (US1–US4), in priority order, each independently completable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel — different file, no dependency on another incomplete task
- **[Story]**: US1 / US2 / US3 / US4, or `—` for setup/foundational/polish
- Every task names exact absolute-from-repo-root paths

---

## ⛔ Phase 0: Merge Gate (blocks EVERYTHING)

**Purpose**: 051 is rewriting `.github/workflows/test.yml` concurrently. Starting before it merges guarantees a conflict on the one file both features touch (N-052-B).

- [x] **T001** [—] Confirm **050-test-timeout-defects** and **051-ci-parallel-jobs** are merged to `main`: `git -C /local-dev log --oneline main | grep -E '05[01]-'`. If either is missing, **STOP** — do not begin implementation.
- [x] **T002** [—] Re-read `.github/workflows/test.yml` as 051 left it. Record the backend job name, its `env:` block, its `run:` line, and the `POSTGRES_DB` / `DATABASE_URL` values. If 051 introduced **sharding or a matrix** on the backend job, **STOP and re-plan** — concurrent shards are concurrent whole invocations against one base, which ratified D3 does not cover (plan.md, Rebase-on-051 protocol step 5).
- [x] **T003** [—] Capture the pre-change baseline per [quickstart.md](./quickstart.md) S0: serial wall time to `/tmp/052-baseline-serial.log` and the sorted serial pass list to `/tmp/052-passlist-serial.txt`. **This is unrecoverable once the default flips** — SC-003's diff needs it.

**Checkpoint**: gate cleared, baseline captured.

---

## Phase 1: Foundational — Derivation Helpers (BLOCKS all user stories)

**Purpose**: the pure, side-effect-free naming and URL functions every later phase consumes. Nothing else can start until these exist.

**⚠️ CRITICAL**: no user story work begins until this phase is complete.

- [x] **T004** [—] Write the derivation unit tests **first, and confirm they FAIL**, in new file `server/__tests__/db-isolation.test.js`: distinct workers → distinct names (INV-1); `JEST_WORKER_ID` unset → worker 1 (INV-2); credentials, host, port and query string preserved through splicing (INV-4); `derive(derive(x)) === derive(x)` (INV-5); distinct bases → disjoint `{template, worker}` families (INV-6); a base name failing `^[A-Za-z0-9_][A-Za-z0-9_$-]*$` is rejected with a message naming the value and the charset (INV-11).
- [x] **T005** [—] Implement the derivation helpers in `server/__tests__/helpers/db.js`, exporting `getBaseDatabaseUrl()`, `getWorkerId()`, `getWorkerDatabaseName(baseName, workerId)`, `getTemplateDatabaseName(baseName)` and `deriveDatabaseUrl(baseUrl, dbName)` per [contracts/naming-and-env.md](./contracts/naming-and-env.md) §2–3. Base resolution order: `TEST_BASE_DATABASE_URL` → `DATABASE_URL` → built-in default (research R3). Parse and splice with `new URL`, replacing **only** `pathname` (research R7).
- [x] **T006** [—] Add base-name charset validation and an identifier-quoting helper in `server/__tests__/helpers/db.js`; every name interpolated into DDL is double-quoted (research R6, Constitution Principle V).
- [x] **T007** [—] Change `getTestDatabaseUrl()` in `server/__tests__/helpers/db.js` from returning `DATABASE_URL` verbatim (current `:19`) to returning the worker-derived URL. Keep the signature. Keep `getDbConfig`, `createPool`, `createPersistence`, `createTestUser`, `cleanupTestUser`, `cleanupDocRows` unchanged (contract §3).
- [x] **T008** [—] Update the `TEST_DB_NAME` export's doc comment in `server/__tests__/helpers/db.js` to state it is the **base** name, not the name tests connect to. A stale reading of this constant is the most likely way a suite ends up on the wrong database.
- [x] **T009** [—] Run T004's tests to green: `npx jest server/__tests__/db-isolation.test.js --runInBand`.

**Checkpoint**: derivation is correct and proven. User stories may begin.

---

## Phase 2: User Story 1 — Every Jest worker owns its own database (P1) 🎯 MVP

**Goal**: template + per-worker database provisioning, so two workers can never see each other's rows.

**Independent Test**: full suite green serially against its derived database; then two workers on fixed-key suites both pass, with each worker's rows only in its own database.

**Independently valuable even alone**: under `--runInBand` it already upgrades every run to a fresh-from-template database, killing cross-*run* orphan accumulation.

### Tests for US1

- [x] **T010** [P] [US1] Extend `server/__tests__/db-isolation.test.js` with the cross-worker isolation case: two workers each insert the *same* fixed-key row and both succeed, with neither row visible from the other's database (US1 scenario 6, SC-005).

### Implementation for US1

- [x] **T011** [US1] Rewrite `server/__tests__/globalSetup.js` to accept `(globalConfig, projectConfig)` and read `globalConfig.maxWorkers` as the worker count (research R1). Resolve the base URL once and publish it as `process.env.TEST_BASE_DATABASE_URL` before any worker spawns (research R3).
- [x] **T012** [US1] Implement the template lifecycle in `server/__tests__/globalSetup.js`: create `<base>_template` if absent → `npm run migrate` against it → on failure, drop and rebuild once → on second failure, abort re-raising the **original** error (research R4, RBD-052-5, INV-3). Never copy from a template whose migration did not complete. The `script/migrate.js` phantom-`pgmigrations` guards (`:15–27`, `:29–45`) are inherited automatically — do not duplicate them.
- [x] **T013** [US1] Implement per-worker provisioning in `server/__tests__/globalSetup.js`: for each worker `1..maxWorkers`, `DROP DATABASE IF EXISTS "<base>_wN" WITH (FORCE)` then `CREATE DATABASE "<base>_wN" TEMPLATE "<base>_template"` (FR-001, research R5). Force-drop worker copies; do **not** force-drop the template.
- [x] **T014** [US1] Replace the admin-URL derivation in `server/__tests__/globalSetup.js` (current regex at `:11`) with `deriveDatabaseUrl(base, 'postgres')`. This retires the live latent bug at `:14–19`, which probes/creates the constant `TEST_DB_NAME` while `:37` migrates whatever `DATABASE_URL` names (research R7).
- [x] **T015** [US1] Wrap the provisioning failures in `server/__tests__/globalSetup.js` with the actionable messages required by contract §5: template-in-use (name the template, the connection holder, and the D3 one-run-at-a-time rule) and worker-drop-failed (name the database and the leaked-process cause). Postgres fails these immediately — wrap and re-raise, do **not** add timeouts.
- [x] **T016** [US1] In `server/__tests__/setup.js`, set `process.env.DATABASE_URL` to the worker's derived URL **unconditionally**, replacing the current `if (!process.env.DATABASE_URL)` guard. This is what makes raw-`process.env.DATABASE_URL` readers correct for free (research R3).
- [x] **T017** [US1] Sweep for suites or helpers that name a database directly instead of going through the helper, and fix them (spec Edge Cases, FR-004). Known starting points from the plan's sweep: `server/__tests__/helpers/otel-e2e-child.js:42` (raw env in a spawned child — resolved by T016 + T023) and `server/__tests__/ping-pool-release.test.js:39` (a deliberately unreachable URL for a failure-path test — verify it is intentional and leave it).
- [x] **T018** [US1] Validate US1 per [quickstart.md](./quickstart.md) S1: provisioning check via `psql -l`; stale-copy replacement; external base honored as a base; two concurrent worktree-style bases not colliding (RBD-052-1).

**Checkpoint**: US1 fully functional. Postgres isolation holds; the suite is still serial.

---

## Phase 3: User Story 2 — Every Jest worker owns its own Redis logical database (P2)

**Goal**: per-worker Redis logical databases, so pub/sub and keyed state cannot cross workers.

**Independent Test**: with `REDIS_DB` unset, the Redis config is byte-identical to today's; two workers publishing on identical channel names see only their own messages.

### Tests for US2

- [x] **T019** [P] [US2] Add the byte-identity test to `server/__tests__/db-isolation.test.js`: with `REDIS_DB` unset, the constructed `REDIS_CONFIG` has **no `db` key at all** — assert `('db' in config) === false`, *not* `db === 0`. Those are different objects and only the former satisfies SC-004 / INV-7. Also assert an explicit `REDIS_DB=0` **is** honored (the string `'0'` is truthy), so nobody later "fixes" the truthiness check and silently breaks it.
- [x] **T020** [P] [US2] Add the cross-worker pub/sub silence test to `server/__tests__/db-isolation.test.js` (US2 scenario 3), and the worker-cap fail-fast assertion (US2 scenario 4).

### Implementation for US2

- [x] **T021** [US2] Add the `REDIS_DB` knob to `REDIS_CONFIG` in `server/redis.js`, immediately after the `REDIS_PASSWORD` conditional spread at `:18`, using the identical pattern so the key is absent when unset (FR-006). Both `new Redis(REDIS_CONFIG)` sites (`:32` shared singleton, `:98` pub/sub factory) inherit it with no further plumbing (FR-007, INV-8) — confirm no third construction site has appeared.
- [x] **T022** [US2] In `server/__tests__/setup.js`, set `process.env.REDIS_DB = String(workerId)` — logical DB = `JEST_WORKER_ID` verbatim, so tests never touch DB 0 (RBD-052-2, INV-9). `setupFilesAfterEnv` runs before the test file loads, and `REDIS_CONFIG` is built at `require`-time of `server/redis.js`, so the ordering is already correct — no new `setupFiles` entry is needed.
- [x] **T023** [US2] Plumb the assignment into the spawned child: pass `REDIS_DB: process.env.REDIS_DB` in the child env at `server/__tests__/telemetry-traces.test.js:38–43`, and honor it in `server/__tests__/helpers/otel-e2e-child.js:43` (`new Redis({ host, ...(process.env.REDIS_DB ? { db: Number(process.env.REDIS_DB) } : {}) })`). This is the one Redis construction path that bypasses `server/redis.js`.
- [x] **T024** [US2] Implement the >15-worker fail-fast in `server/__tests__/globalSetup.js`, using the same `globalConfig.maxWorkers` value as T011 (FR-008, INV-10). Abort **before any test runs**, with a message naming the requested count, the cap of 15, the reason (16 logical DBs, DB 0 reserved for non-test consumers), and the fix (`JEST_MAX_WORKERS` / `--maxWorkers`). Never silently share, never silently clamp (RBD-052-3).
- [x] **T025** [US2] Verify within-worker pub/sub still passes: `npx jest server/__tests__/redis-pubsub-integration.test.js --runInBand` (US2 scenario 2) and `npx jest server/__tests__/rate-limit-degrade.test.js --runInBand`.
- [x] **T026** [US2] Validate US2 per [quickstart.md](./quickstart.md) S2, including the cap fail-fast producing **no test output at all**: `JEST_MAX_WORKERS=16 npm run test:server`.

**Checkpoint**: US1 + US2 both hold. The suite is parallel-*safe*; it is not yet parallel-*by-default*.

---

## Phase 4: User Story 3 — The written rules match the new reality (P2)

**Goal**: amend Principle II verbatim and sweep every surviving assertion of the old serial mandate.

**Independent Test**: Principle II reads exactly the design §2.3 text; `helpers/db.js`'s convention survives with a within-worker rationale; grep finds zero surviving serial-mandate claims.

**Note**: these four files were deliberately **not** edited during planning (pipeline parallel-agent overrides). They are edited here, in the implement phase, in one commit.

- [x] **T027** [US3] Amend Principle II in `.specify/memory/constitution.md`: replace the sentence "Backend tests share one database and MUST run serially — never launch concurrent backend test runs against the same DB." with the ratified design §2.3 replacement text, **character-for-character** as quoted in FR-009. Diff it against the design doc; do not retype from memory.
- [x] **T028** [US3] In the same file, make the Development Workflow gate coherent: "affected tests pass (serially for backend)" → drop the serial qualifier (FR-011, RBD-052-4, research R9 site 1).
- [x] **T029** [US3] In the same file, bump the version **1.2.0 → 1.3.0** (MINOR) per Governance and per **RBD-052-6** in [clarifications-needed.md](./clarifications-needed.md) — the level was arguable between MINOR and MAJOR and is recorded there rather than decided in passing. Update the Sync Impact Report comment: version change, the Principle II modification, the Development Workflow gate consequence, and the templates-propagation note (the plan-template's Constitution Check is generic, so no template edit is required — state that explicitly, as the 1.2.0 report did).
- [x] **T030** [P] [US3] Update `.claude/skills/the-pipeline/SKILL.md:64` (worktree guidance): keep the per-agent database requirement, describe the per-agent `DATABASE_URL` as a **base** the helper derives from, and remove "Within one DB, backend tests are serial-only (`--runInBand` is already wired in; don't defeat it)" — which would otherwise instruct every implementer agent to defeat the new default (research R9 site 2). State the observable consequence of base-URL semantics explicitly (analyze M4): an agent that sets `DATABASE_URL=.../collab_test_db_042` no longer runs IN that database — workers run in `collab_test_db_042_w1..wN`, and `collab_test_db_042` itself stays EMPTY after the run.
- [x] **T031** [P] [US3] Update `.claude/skills/the-pipeline/SKILL.md:46` (merge-queue step): drop the "serial-only" framing but **keep** "never overlap another backend run on the same DB" — that clause remains true under ratified D3 (research R9 site 3). This site was not enumerated in FR-011; it is the same ratified coherence principle applied to the complete set.
- [x] **T032** [P] [US3] Update `docs/dev.md:372–375`: replace the "Backend tests are serial-only against one database" paragraph with the isolation invariant. Keep the per-worktree-database advice (now base-URL semantics), keep the `REDIS_HOST` warning at `:365–369`, and keep the `--forceExit` / `--reporters=` positional-argument notes at `:356–361` (research R9 site 4, Constitution Principle I). Spell out the M4 breaking-change consequence here too: an explicitly-set `DATABASE_URL` is now a BASE name — the run happens in `<base>_wN` derivative databases, and inspecting the base database after a run shows no rows.
- [x] **T033** [US3] Rewrite the `cleanupDocRows` convention comment in `server/__tests__/helpers/db.js:84–114`. The convention **stays** (FR-010); only the rationale changes: within one worker, suites still run sequentially against one database, so deleting what you created still protects suite ordering. The cross-suite orphan flake class is eliminated by construction between workers, and cross-run accumulation entirely by fresh-from-template creation — neither may still be cited as the live threat.
- [x] **T034** [P] [US3] Fix the two stale in-code comments the sweep found: `server/undo/__tests__/undo-service.test.js:14` ("DB-backed, serial only (shared collab_test_db)") and `server/__tests__/pg-pool-limits.test.js:7–8` (which claims safety because "the serial runner shares process.env with other suites" — under workers each suite gets its own process, so the reasoning changed even though the conclusion holds).
- [x] **T035** [US3] Validate US3 per [quickstart.md](./quickstart.md) S3: all four greps return nothing (SC-007), and Principle II diffs clean against design §2.3.

**Checkpoint**: the written rules no longer forbid US4. All three P1/P2 stories complete.

---

## Phase 5: User Story 4 — The suite runs parallel by default, and earns it first (P3)

**Goal**: flip the default to parallel workers — **only** after the verification gate passes.

**Independent Test**: default command runs multiple workers; five-green gate locally and in CI; empty serial-vs-parallel pass-list diff; `--runInBand` green with unchanged reporter output.

### Configuration

- [x] **T036** [US4] Add `"maxWorkers": "50%"` to the `"jest"` config block in `package.json` (D4, FR-013). Verified honored from the config file — `getMaxWorkers` consults it, and `--runInBand` still short-circuits to 1 ahead of it (research R1).
- [x] **T037** [US4] Change `test:server` in `package.json:14` to drop `--runInBand` and add `${JEST_MAX_WORKERS:+--maxWorkers=$JEST_MAX_WORKERS}` (research R8). **Preserve `--forceExit`, `--silent`, and `--reporters=./script/jest-llm-reporter.js` last in the flag order** — `docs/dev.md:361` documents that positionals landing after `--reporters=` are misparsed (FR-015).
- [x] **T038** [US4] Leave `test:coverage` (`package.json:16`) on `--runInBand` — serial coverage is intentional and unaffected. Confirm `test:server:watch` (`:15`), already parallel, now picks up isolation.
- [x] **T039** [US4] **Rebase-on-051 CI edit**: add exactly one entry, `JEST_MAX_WORKERS: <n>`, to the **existing** `env:` block of the post-051 backend job in `.github/workflows/test.yml` (D4, FR-013). Do not touch the `run:` line, the services, or the client job. If 051 changed `POSTGRES_DB` or `DATABASE_URL`, no further edit is needed — those become the base by construction.
  - **Choosing `<n>` (decision rule, so the implementer does not guess)**: set it to the runner's core count as reported by `node -e 'console.log(require("os").availableParallelism())'` in a CI step, capped at 15. For GitHub-hosted `ubuntu-latest` at time of planning that is **4**, so `JEST_MAX_WORKERS: 4` is the default to land. D4 requires an *explicit* count in CI rather than a percentage precisely so this value is visible and reviewable in the workflow file — do not substitute `50%`. If T043's five CI runs show contention flakiness at that count, the remedy is the flaking suite's timing ceiling (FR-018), not a lower `<n>`.

### Fix the coupling tail

- [ ] **T040** [US4] Run the full suite in parallel and triage every failure. Each failure that traces to cross-suite coupling is fixed as a bug **in the offending suite's own setup/cleanup** (FR-017) — reverting to serial is not an acceptable resolution. Each suite that flakes under CPU contention gets its **timing ceiling** reviewed and adjusted (FR-018) — lowering the worker count is not an acceptable resolution. Record each fix and its resolution in the gate ledger. Expect a short, bounded tail (design §2.4).
- [ ] **T041** [US4] Confirm the LLM reporter is the active reporter in **both** modes (FR-015, SC-006): `npm run test:server | head -3` and `npm run test:server -- --runInBand | head -3`.

### ⛔ THE VERIFICATION GATE (FR-016 / SC-002 / SC-003)

**The serial default MUST NOT be considered dropped until every task below is recorded complete.** These are gates, not smoke tests. Procedure in [quickstart.md](./quickstart.md) S5.

- [ ] **T042** [US4] **Five consecutive green full parallel runs locally.** Consecutive is literal — any red run resets the counter to zero; fix the suite (T040) and restart from run 1. Logs to `/tmp/052-parallel-1..5.log`.
- [ ] **T043** [US4] **Five consecutive green parallel backend jobs in CI** on the post-051 workflow with `JEST_MAX_WORKERS` set. Record the five run URLs.
- [ ] **T044** [US4] **Serial-vs-parallel pass-list diff is empty** (SC-003). Generate both sorted pass lists and `diff` them. A non-empty diff names the mode-dependent suites — fix them and restart the gate from T042.
- [ ] **T045** [US4] Measure SC-001: full parallel suite wall time on the 10-core dev pod, plus the worker count actually used. Note that `50%` yields **5** workers here, not the design table's "6–8" — the ratified knob wins and this is not a defect (research R10). If 5 workers land outside the 30–50 s band, **report the timing to Sam** alongside measurements at other counts; changing the percentage is a D4 amendment and is Sam's call, not the implementer's.
- [ ] **T046** [US4] Fill in the gate ledger in [quickstart.md](./quickstart.md) S5 with evidence for every row, then mark the serial default formally dropped.

**Checkpoint**: all four user stories complete and the gate is green.

---

## Phase 6: Polish & Cross-Cutting

- [ ] **T047** [—] Run the whole of [quickstart.md](./quickstart.md) S1–S4 end to end as a final regression pass.
- [ ] **T048** [P] [—] Verify the full command matrix from contract §4 is green: `npm run test:server`, `npm run test:server -- --runInBand`, `npm run test:coverage`, `npx jest <one file>`.
- [ ] **T049** [P] [—] Confirm `npm run test:first-run` still passes untouched (`test/first-run/matrix-runner.mjs` reads `DATABASE_URL` directly and sees the unchanged base — out of scope, verified not regressed).
- [ ] **T050** [—] Clean up the quickstart's scratch databases per [quickstart.md](./quickstart.md) S6. Leave the suite's own `_template` / `_wN` databases in place — that is intentional (data-model.md §4).
- [ ] **T051** [—] Update `clarifications-needed.md` with any decision the implementation forced, and record in the feature ledger: tasks n/n, the coupling failures fixed in T040, and the SC-001 measurement.

---

## Dependencies & Execution Order

### Phase dependencies

```
Phase 0 (Merge Gate)      ── blocks everything
        ↓
Phase 1 (Foundational)    ── blocks all user stories
        ↓
   ┌────┴────┬──────────┐
Phase 2     Phase 3    Phase 4
 (US1)       (US2)      (US3)
   └────┬────┴──────────┘
        ↓
Phase 5 (US4)  ── requires US1 + US2 (isolation must exist) AND US3 (Principle II must permit it)
        ↓
Phase 6 (Polish)
```

### Critical ordering constraints

- **T001–T003 before anything.** T003's baseline is unrecoverable after T037.
- **Phase 1 before all stories** — every phase consumes the derivation helpers.
- **US3 (T027) before US4 (T036).** Principle II as currently written *forbids* the parallel default. Flipping the default first would put the tree in violation of its own constitution.
- **T040 before T042.** The gate cannot be satisfied while the coupling tail is unfixed — that is the forcing mechanism, by design.
- **T042/T043/T044 before T046.** All three gate parts must be green; a red run resets its counter.
- **T024 (cap fail-fast) must land before T036/T037** flip the default, so an over-configured run can never silently share a logical database.

### Story dependencies

- **US1 (P1)**: after Phase 1. No dependency on other stories. Independently valuable (fresh-from-template even serially).
- **US2 (P2)**: after Phase 1. Independent of US1 in code; meaningless in *purpose* until US1 exists to parallelize against.
- **US3 (P2)**: after Phase 1 — actually independent of all code, could land any time after T001. Documentation/policy only, zero code risk.
- **US4 (P3)**: hard dependency on US1 + US2 + US3.

### Parallel opportunities

- **T030, T031, T032** — three different documentation files, fully parallel.
- **T019, T020** — different test cases; parallel with each other and with all of Phase 2 (US1), since US2's tests touch no US1 file.
- **US2 and US3 in full** can proceed concurrently with US1 once Phase 1 is done.
- **T048, T049** — independent verification commands.
- **Not parallel**: T011–T015 all edit `server/__tests__/globalSetup.js`; T016 and T022 both edit `server/__tests__/setup.js`; T005–T008 and T033 all edit `server/__tests__/helpers/db.js`. Sequence within each file.

---

## Implementation Strategy

### MVP first (US1 only)

1. Phase 0 gate + baseline → 2. Phase 1 foundational → 3. Phase 2 (US1) → **STOP and validate**: the suite is still serial, but every run now gets a fresh per-worker database from a template. Cross-run orphan accumulation is already dead. This is a shippable increment on its own.

### Incremental delivery

1. Phase 0 + Phase 1 → foundation
2. + US1 → per-worker Postgres isolation (serial still) → validate
3. + US2 → per-worker Redis isolation → validate — **the suite is now parallel-safe but still serial by default**
4. + US3 → the rules permit what the code can now do → validate
5. + US4 → flip the default, behind the gate → the 30–50 s payoff

Steps 2–4 are each safely landable and revertible on their own. Step 5 is the only one with a hard gate, and it is deliberately last.

---

## Notes

- **51 tasks total.** [P] = different file, no dependency.
- Commit after each task or logical group; this repo commits straight to `main` for normal work, and the constitution amendment (T027–T029) is by Governance a sole-maintainer commit to `main`.
- The four documentation files in Phase 4 were read but deliberately not edited during planning (pipeline parallel-agent overrides); Phase 4 is where they change.
- **Never** resolve a parallel-run failure by reverting to serial (FR-017) or by lowering the worker count (FR-018). Those are the two failure modes the gate exists to prevent, and both would look locally reasonable in the moment.
