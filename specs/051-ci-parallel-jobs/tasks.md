# Tasks: CI Parallel Jobs and Warm Transform Cache

**Input**: Design documents from `/specs/051-ci-parallel-jobs/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/ci-contract.md](./contracts/ci-contract.md),
[quickstart.md](./quickstart.md)

**Tests**: No test-authoring tasks. The spec requests none, and FR-009 forbids changing any
test source file. This feature's verification is the existing suites running unchanged plus
the contract checks in `contracts/ci-contract.md` — those appear below as explicit verification
tasks, not as new test files.

**Organization**: Grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 from spec.md
- Paths are repository-relative from `/local-dev`

## Path Conventions

Only three tracked files change (FR-009): `.github/workflows/test.yml`, `package.json`,
`.gitignore`. There is no `src/`-style layout involved — this is build infrastructure.
`[P]` is therefore rare: most tasks in a story touch the same single file and must be serial.

---

## Phase 1: Setup

**Purpose**: Capture the "before" state so parity (SC-002) and speed (SC-001) can be argued
from evidence rather than memory. Nothing in this phase modifies the repository.

- [X] T001 Save the pre-split workflow for later diffing: `git show HEAD:.github/workflows/test.yml > /tmp/test.yml.baseline`, and record from the most recent green CI run on `main` the single `test` job's total duration and per-step durations (server / client / first-run). These are the SC-001 comparison baseline.
- [X] T002 [P] Record the pre-split suite totals by running `npm run test:server`, `npm run test:client`, and `npm run test:first-run` in the app-dev pod and noting each suite's file and test counts (design baseline: backend 254 files / 4574 tests, client 72 files / 936 tests, first-run 31 tests). This is the SC-002 parity baseline.

**Checkpoint**: Baseline captured; the repository is still untouched.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The one change that must land before any other, because it prevents a
self-inflicted mess.

**⚠️ CRITICAL**: T003 must precede T009. The moment `jest.cacheDirectory` moves into the repo,
every local backend run writes hundreds of megabytes into the working tree. Adding the ignore
line first makes that a non-event; adding it after means at least one run leaves a dirty tree.
The line is a harmless no-op on its own (it names a directory that does not exist yet), which
is why it is safe to land first.

- [X] T003 Add `.jest-cache/` to `.gitignore`, placed with a short comment near the other generated-artifact entries (for example after the `coverage/` / `.nyc_output/` group), following the file's existing convention of a comment explaining each non-obvious entry. Satisfies FR-008 and underwrites US3's clean-tree guarantee.

**Checkpoint**: The ignore list is ready for the cache directory that US2 will create.

---

## Phase 3: User Story 1 - Every push is gated by parallel, not sequential, checks (Priority: P1) 🎯 MVP

**Goal**: One sequential job becomes two concurrent jobs — `backend` (with services) and
`client` (without) — that together run exactly what the single job ran, and together gate the
push.

**Independent Test**: Push a commit; two jobs appear, start within seconds of each other, each
reports its own result, and the run's post-install wall time ≈ the backend job's duration.
Fully deliverable without US2 — the split is valuable with a cold cache.

### Implementation for User Story 1

- [X] T004 [US1] In `.github/workflows/test.yml`, rename the single `test` job to `backend` and reduce it to the backend path: keep `runs-on: ubuntu-latest`, keep both service containers (`postgres`: `pgvector/pgvector:pg15` and `redis`: `redis:7`) with their images, env, ports and health-check options byte-identical to the baseline, keep the checkout / setup-node@v4 (`node-version: '22'`, `cache: 'npm'`) / root `npm ci` steps, keep the `Run server tests` step with its `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT` env and its `npm run test:server` command. Delete from this job the `cd client && npm ci` step, the client test step, and the first-run test step. Add no `needs:` key. (FR-002, data-model J-block + S1 + E1)
- [X] T005 [US1] In `.github/workflows/test.yml`, add a second top-level job `client` alongside `backend`: `runs-on: ubuntu-latest`, **no** `services:` key and **no** database/Redis env anywhere, no `needs:` key; steps = `actions/checkout@v4`, `actions/setup-node@v4` (`node-version: '22'`, `cache: 'npm'`, no `cache-dependency-path`), `npm ci`, `cd client && npm ci`, then `npm run test:client`, then `npm run test:first-run` — preserving the first-run step's existing descriptive step name. (FR-003, FR-010, CN-051-03/R2, R6)
- [X] T006 [US1] Validate the edited `.github/workflows/test.yml` parses and has the intended shape, using the `js-yaml` one-liner in `quickstart.md` §A1. Expect jobs `['backend','client']`, both with `needs` null, `backend` with services `postgres,redis`, `client` with none. A YAML error here would otherwise surface only as a workflow that never starts, on the very push that introduces it.
- [X] T007 [US1] Verify the workflow-side contracts by inspection of `.github/workflows/test.yml`: C-1 (no `jest` / `vitest` / `node --test` / `maxWorkers` / `runInBand` / `--reporters` token anywhere in the file — FR-002), C-4 (every `services:`, `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT` occurrence falls inside `backend` — FR-003), C-7 (no `continue-on-error`, no `if: always()`, no `||` swallowing a non-zero exit — FR-005), and W1 (the `on: push` / `branches: ['*']` trigger is unchanged — FR-001). Commands are in `quickstart.md` §A2.
- [X] T008 [US1] Diff the new `backend` job's services and env blocks against `/tmp/test.yml.baseline` from T001 and confirm only indentation and placement differ — no image, port, health-check parameter, or environment value changed (contract C-3, invariant S1).

**Checkpoint**: US1 is complete and shippable on its own. CI is parallel; the Jest cache is
still the OS-tmp default and still cold every run.

---

## Phase 4: User Story 2 - Repeat CI runs reuse the backend transform cache (Priority: P2)

**Goal**: Jest writes its transform cache to a repo-local `.jest-cache/`, and the backend job
saves and restores that directory across runs keyed on the root lockfile.

**Independent Test**: Two consecutive runs with no dependency change — the second restores a
cache and its test step is measurably faster. Bump the lockfile: the next run reports a
primary-key miss, a `restore-keys` hit, and still passes.

**Depends on**: T003 (ignore line must exist first). Independent of US1 in principle, but
lands after it because both edit `.github/workflows/test.yml`.

### Implementation for User Story 2

- [X] T009 [US2] In `package.json`, add exactly one key to the existing `"jest"` block: `"cacheDirectory": "<rootDir>/.jest-cache"`. Do not create a `jest.config.js`, do not touch any `scripts.*` entry, and do not add a `--cacheDirectory` flag to `test:server`. (FR-006, R5, contracts C-2 and C-5)
- [X] T010 [US2] Confirm the config took effect: `npx jest --showConfig | grep -i cacheDirectory` must report an absolute path ending in `/local-dev/.jest-cache`, not `/tmp/jest_0`. A stale value here means the CI cache step would archive an empty directory forever with no visible error (`quickstart.md` §A3).
- [X] T011 [US2] In `.github/workflows/test.yml`, add an `actions/cache@v4` step to the `backend` job only, positioned after `Set up Node.js` and before the `Run server tests` step, with `path: .jest-cache`, `key: jest-cache-${{ runner.os }}-${{ hashFiles('package-lock.json') }}`, and a `restore-keys` prefix fallback of `jest-cache-${{ runner.os }}-`. Leave the existing `cache: 'npm'` on `setup-node` in place in both jobs — the two caches are additive, not alternatives. (FR-006, CN-051-02/R3, R6, contract C-6)
- [X] T012 [US2] Verify the three-way cache-path agreement (contract C-5): `grep -rn 'jest-cache' package.json .github/workflows/test.yml .gitignore` returns exactly three hits, all designating `.jest-cache` — `<rootDir>/.jest-cache` in the jest config, `.jest-cache` as the workflow `path:`, `.jest-cache/` in the ignore list. Also confirm `client/package-lock.json` appears nowhere in the cache key (contract C-6). This is the feature's primary silent-failure mode: each file is independently valid with a wrong path.

**Checkpoint**: US1 + US2 both complete. The split is parallel and the backend job is
cache-warm on repeat runs.

---

## Phase 5: User Story 3 - Local development is untouched (Priority: P3)

**Goal**: Prove the guardrail — same suites, same reporters, same results, clean working tree,
zero application-source change.

**Independent Test**: Run the suites locally after the change; results and reporter output are
unchanged and `git status` shows no new untracked files.

### Implementation for User Story 3

- [ ] T013 [US3] In the app-dev pod, `rm -rf .jest-cache` then run `npm run test:server`. Confirm the pass/fail result and the LLM reporter's output shape match the T002 baseline, and that `.jest-cache/` is created and populated. (SC-005, US3 scenario 1)
- [ ] T014 [US3] Run `git status --short` and confirm `.jest-cache` does **not** appear as untracked. A `?? .jest-cache/` line means the T003 ignore entry is missing or misspelled. (FR-008, SC-005, invariant C2)
- [ ] T015 [US3] [P] Run `npm run test:client` and `npm run test:first-run` locally and confirm both are unchanged against the T002 baseline — same file and test counts, same reporter output shape. (SC-002, FR-004)
- [ ] T016 [US3] Run a second `npm run test:server` without clearing the cache and confirm it is faster than T013's cold run with an identical result — a local preview of SC-003 and a direct check of FR-007's correctness-neutrality. (`quickstart.md` §A5)
- [ ] T017 [US3] Verify the scope contract C-8: `git diff --stat HEAD` lists exactly `.github/workflows/test.yml`, `package.json`, `.gitignore`, and nothing under `server/`, `client/`, `shared/`, `script/`, `test/`, or `__tests__/`. If the Principle I check in T019 later adds a `README.md` correction, re-run this check and confirm that is the only additional path. (FR-009, US3 scenario 2)

**Checkpoint**: All three user stories independently verified locally. Everything remaining
requires a push.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T018 Verify contract C-2 (Constitution, "Test output MUST stay LLM-friendly"): `git diff HEAD -- package.json` shows the `jest.cacheDirectory` key added and **no** change to any `scripts.*` entry, so `--reporters=./script/jest-llm-reporter.js` and `--reporter=../script/vitest-llm-reporter.mjs` remain attached inside the npm scripts where the workflow cannot detach them.
- [ ] T019 Constitution Principle I check: re-read the CI note in `README.md` (around line 243) and confirm the split did not falsify it — it describes *what* CI runs and that CI builds no image, neither of which this feature changes. If it is now inaccurate, correct it in the same commit. While there, the pre-existing omission of the first-run rehearsal suite from that sentence may be corrected; a documentation file is not an application source file under FR-009. Do not restructure the section.
- [ ] T020 [P] Verify contract C-9 — the coordination surface reserved for feature 052 is untouched: `scripts.test:server` (still carrying `--runInBand`), the absence of `jest.maxWorkers`, `jest.globalSetup`, and the literal `DATABASE_URL` value are all unchanged from HEAD. This is what keeps 052's worker work from colliding with this feature.
- [ ] T021 After the push: open the workflow run and confirm US1 in the live system — two jobs `backend` and `client`, start times within seconds of each other, each reporting independently, and post-install wall time ≈ the backend job's own duration. Compare against the T001 baseline, not the design table's `~180s` (that figure assumes feature 050 has landed — gap G-051-A). (SC-001, `quickstart.md` §B1)
- [ ] T022 After the push: confirm executed-test parity in the live run (SC-002) — the union of suites across the two jobs matches the T002 baseline exactly, and both LLM reporters are visibly in use (one-line summaries for passing suites, only failures expanded). (FR-004, `quickstart.md` §B2)
- [ ] T023 After the push: validate the cache lifecycle across three runs (SC-003, `quickstart.md` §B3) — (a) first run reports a cache miss and passes; (b) a second push with an unchanged `package-lock.json` reports a restore and a measurably faster `Run server tests` step; (c) a push that bumps the lockfile reports a primary-key miss, a `restore-keys` prefix hit, passes, and saves under the new key. The result must be identical in all three (FR-007).
- [ ] T024 On a throwaway branch, demonstrate gating both ways (SC-004, `quickstart.md` §B4): push a deliberately failing backend test and confirm the workflow run is red with the failure attributed to `backend`; then the same for a client test and the `client` job. Revert the throwaway commits; do not merge them.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: no dependencies; must complete before any edit, or the baselines are lost.
- **Phase 2 (Foundational)**: T003 blocks T009. Nothing else depends on it.
- **Phase 3 (US1)**: can start immediately after Phase 1. Does not need Phase 2.
- **Phase 4 (US2)**: needs T003; sequenced after Phase 3 because T011 edits the same file as T004/T005.
- **Phase 5 (US3)**: needs Phases 3 and 4 complete — it verifies their combined result.
- **Phase 6 (Polish)**: T018–T020 need Phase 5; T021–T024 need the push.

### User Story Dependencies

- **US1 (P1)**: independent. Shippable alone as the MVP.
- **US2 (P2)**: independent in principle (needs only T003), but shares `test.yml` with US1, so it is sequenced after in practice.
- **US3 (P3)**: a guardrail story — it verifies US1 and US2 rather than adding behavior, so it necessarily follows both.

### Task-Level Dependencies

```text
T001, T002 ──▶ everything (baselines)
T003 ──▶ T009 ──▶ T010
T004 ──▶ T005 ──▶ T006 ──▶ T007, T008
T009, T011 ──▶ T012
T013 ──▶ T014, T016
T004..T012 ──▶ T017
push ──▶ T021 ──▶ T022, T023, T024
```

### Parallel Opportunities

Genuinely few — three files, two of them touched by one task each:

- T002 `[P]` runs alongside T001 (different activity, no shared file).
- T015 `[P]` runs alongside T013/T014 (client and first-run suites are independent of the backend run).
- T020 `[P]` runs alongside T018/T019 (read-only checks of different files).
- Everything in Phases 3 and 4 is serial: T004, T005, T007, T008, T011 all edit or read `.github/workflows/test.yml`.

### Parallel Example: Phase 5

```bash
# T013/T014 (backend run + tree check) and T015 (client + first-run) can proceed together:
Task: "Run npm run test:server cold, confirm results and .jest-cache populated, git status clean"
Task: "Run npm run test:client and npm run test:first-run, confirm counts match baseline"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 (T001–T002) — capture baselines.
2. Phase 3 (T004–T008) — the job split.
3. **STOP and VALIDATE**: push, confirm two concurrent jobs and executed-test parity.
4. This alone delivers the design's headline outcome ("CI wall time becomes roughly the
   backend job alone"). The cache is pure additional speed.

### Incremental Delivery

1. Setup + Foundational → baselines captured, ignore line in place.
2. US1 → parallel CI → validate → ship.
3. US2 → warm cache → validate over two consecutive runs → ship.
4. US3 → guardrail verification of both.
5. Polish → contract checks, Principle I doc check, live CI validation.

### Notes

- `[P]` means different files and no dependency on an incomplete task.
- No task creates, moves, or edits a test file, an npm script, or any application source — if
  one appears to require that, stop: it is outside FR-009 and needs a spec amendment.
- The workflow change takes effect on the push that introduces it, so T006's local YAML
  validation is not optional ceremony — it is the only pre-flight this feature gets.
- T021–T024 cannot be completed by the implementing agent in a worktree; they are the
  post-merge verification owed on the live CI system.

---

## Recorded baselines (T001 / T002), measured 2026-08-04

### T001 — last green pre-split run on `main`

Run `30935305773` ("Identify the affected user in exception notification emails", `f5ef249a`),
single job `test`, total **511s (8m31s)**. Per-step:

| Step | Duration |
| --- | --- |
| Set up job + Initialize containers | 28s |
| Checkout code | 3s |
| Set up Node.js | 3s |
| Install dependencies (root `npm ci`) | 20s |
| Install client dependencies | 9s |
| Run server tests | **320s** |
| Run client tests | **121s** |
| Run first-run rehearsal suite | **2s** |
| Post/teardown steps | ~5s |

Post-install test wall time today: **443s sequential**. After the split the two jobs'
post-install work is backend ≈ 320s and client ≈ 123s, so the run's post-install wall time
should land at ≈ the backend job alone (~320s), a saving of ~123s. Note this measured
baseline is larger than the spec's "~290s sequential" figure — SC-001 must be judged against
this run, not against the design table (gap G-051-A).

### T002 — pre-split suite totals

| Suite | Measured | Design baseline | Match |
| --- | --- | --- | --- |
| Backend (Jest) | 254 test files (`npx jest --listTests`) | 254 files / 4574 tests | files ✓ |
| Client (Vitest) | 72 suites, 936 passed | 72 files / 936 tests | ✓ |
| First-run (`node --test`) | 31 tests, 31 pass | 31 tests | ✓ |

Pre-change effective Jest `cacheDirectory`: `/tmp/jest_0` (the OS-tmp default), as research.md
recorded.

**Deviation**: the backend total was taken with `npx jest --listTests` (file inventory) rather
than a full `npm run test:server` execution. The worktree has no backend database of its own,
and the shared `collab_test_db` is serial-only — a full backend run from this worktree risks
corrupting the database another agent may be using. File-count parity plus the structural
argument (no npm script, no test file, and no jest `testMatch`/`testPathIgnorePatterns` entry
changed) carries SC-002 for the backend suite locally; the authoritative executed-test parity
check is T022 on the live CI run.
