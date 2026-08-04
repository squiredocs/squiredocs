# Feature Specification: CI Parallel Jobs and Warm Transform Cache

**Feature Branch**: `051-ci-parallel-jobs`

**Created**: 2026-08-04

**Status**: Draft

**Input**: User description: "051-ci-parallel-jobs CI parallel jobs split — Train B of the ratified Test Suite Architecture proposal (design/test-suite-architecture.md, Part 1 section 1.3): split the single sequential CI job into two parallel jobs (backend with services; client + first-run rehearsal without), and give the backend job a warm Jest transform cache. Workflow-file change only, no app code."

**Design ground truth**: `design/test-suite-architecture.md` (ratified 2026-08-04) — Part 1 §1.3, Current State, Expected Outcomes. §1.4's perf-guard split was decided **D2 = leave the perf guards in the default run** and is explicitly OUT of scope here.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every push is gated by parallel, not sequential, checks (Priority: P1)

Sam (and every pipeline agent whose merge lands on a branch) pushes a commit. Today the single CI job runs the backend suite, then the client suite, then the first-run rehearsal suite strictly in sequence (~290s after dependency install). After this feature, the same push triggers two independent jobs that run concurrently: a backend job (Jest suite, backed by the postgres+pgvector and redis service containers it needs) and a client job (Vitest suite plus the first-run rehearsal suite, which need no services). The push is green only when both jobs are green, and the total wall time collapses to roughly the duration of the backend job alone.

**Why this priority**: This is the entire point of the feature — the client and rehearsal suites currently add ~21s of pure sequential tail to every CI run, and the design's Expected Outcomes table defines Train B's contribution as "jobs in parallel". Without this story there is no feature.

**Independent Test**: Push a commit to a branch and observe the workflow run: two jobs appear, start concurrently, and each reports its own pass/fail. Compare the run's wall time (after dependency install) to the backend job's own duration — they should be roughly equal.

**Acceptance Scenarios**:

1. **Given** the restructured workflow, **When** a commit is pushed to any branch, **Then** two jobs start (backend; client + first-run rehearsal) and neither waits for the other.
2. **Given** both jobs pass, **When** the run completes, **Then** the overall workflow run is reported successful and its wall time is dominated by the backend job.
3. **Given** the backend suite passes but a client or first-run test fails, **When** the run completes, **Then** the overall workflow run is reported failed (and vice versa for a backend failure).
4. **Given** the split workflow, **When** the executed test inventory is compared with the pre-split workflow (backend suite, client suite, first-run rehearsal suite), **Then** the union of what is executed is identical — nothing skipped, nothing added, same reporters.

---

### User Story 2 - Repeat CI runs reuse the backend transform cache (Priority: P2)

The backend suite's startup cost includes transforming 254 test files and heavyweight dependencies on every CI run, because the Jest cache is cold each time (locally that cache measures 543MB — the design calls this "real work that CI repeats each time"). After this feature, Jest writes its cache to a repo-local directory that CI saves and restores across runs, keyed to the dependency lockfile, alongside the existing package-manager cache. A push that does not change dependencies starts with a warm transform cache; a push that changes dependencies starts cold once and warms subsequent runs.

**Why this priority**: Direct wall-time reduction for the job that is the critical path after User Story 1, but the split is useful without it.

**Independent Test**: Trigger two consecutive CI runs with no dependency changes; the second run's backend job restores a cache and its test step is measurably faster than a cold run (transform work not repeated). Change the lockfile; the next run reports a cache miss and still passes.

**Acceptance Scenarios**:

1. **Given** a prior successful run on the same dependency lockfile, **When** a new run starts, **Then** the backend job restores the saved Jest cache before running tests.
2. **Given** no saved cache exists (first run, dependency change, or cache eviction by the CI platform), **When** the backend job runs, **Then** all tests still execute and pass exactly as with a warm cache — the cache affects speed only, never correctness or results.
3. **Given** the dependency lockfile changed, **When** the run completes, **Then** a fresh cache is saved under the new key so later runs on that lockfile are warm.

---

### User Story 3 - Local development is untouched (Priority: P3)

A developer (or agent) running tests in the app-dev pod sees no behavior change: the same npm scripts run the same suites with the same reporters, `git status` stays clean after a test run (the new repo-local cache directory is ignored), and no app, server, or client source code changes at all.

**Why this priority**: Guardrail story — the feature is CI-only by design ("Pure workflow-file change, no app code"), and the one repo-visible side effect (the Jest cache location moving into the repo) must not pollute the working tree or alter local workflows.

**Independent Test**: Run the backend suite locally after the change; confirm results and reporter output are unchanged and `git status` shows no new untracked files.

**Acceptance Scenarios**:

1. **Given** the feature is merged, **When** the backend suite runs locally, **Then** test selection, results, and reporter output are unchanged, and the cache directory it creates is ignored by version control.
2. **Given** the feature is merged, **When** the diff is inspected, **Then** it touches only the CI workflow definition, the test-runner cache-location configuration, and the version-control ignore list — no application source files.

---

### Edge Cases

- **One job fails while the other passes**: the workflow run as a whole is failed; both jobs' results remain independently visible so the failure is attributable to the right suite.
- **Cache eviction or corruption**: the CI platform may evict caches at any time, and a restored cache may be stale after unrelated changes. The test runner treats its cache as advisory (it re-transforms on mismatch), so any cache state must yield identical test results — only timing differs.
- **Dependency change without lockfile change is impossible by policy** (installs are lockfile-driven with `npm ci`), so keying the cache on the lockfile is sound; a same-key restore after a source-only change is safe because the runner invalidates per-file entries itself.
- **Concurrent pushes**: two runs in flight simultaneously each get their own jobs and service containers; they share nothing but the read-only caches.
- **Workflow file is itself under test**: the change to the workflow takes effect on the very push that introduces it, so the first push after merge is the live verification of the split.
- **Service-container startup failure** (postgres/redis health check never passes): the backend job fails visibly at startup rather than running without services — same failure mode as today, now scoped to the one job that needs services.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The CI workflow MUST trigger on the same events as today (every push to any branch) and MUST run two jobs with no dependency between them, so they execute in parallel.
- **FR-002**: The **backend job** MUST run the full backend test suite through the existing npm script indirection (`npm run test:server`) — not by inlining test-runner flags into the workflow — and MUST provide the postgres (pgvector image) and redis service containers with the same images, health checks, and `DATABASE_URL` / `REDIS_HOST` / `REDIS_PORT` environment values the current job provides. *(The script indirection is a coordination constraint: feature 052-parallel-test-isolation will later adjust worker settings in this same workflow; keeping the invocation behind the npm script minimizes the conflict surface.)*
- **FR-003**: The **client job** MUST run the client test suite (`npm run test:client`) and the first-run rehearsal suite (`npm run test:first-run`) and MUST NOT declare any database or redis service containers.
- **FR-004**: The union of tests executed across the two jobs MUST be identical to what the current single job executes — no suite dropped, none added, and the LLM-friendly reporters MUST remain wired in for both suites (Constitution, Development Workflow: "Test output MUST stay LLM-friendly").
- **FR-005**: A failure in either job MUST cause the overall workflow run for that push to be reported as failed; both jobs gate every push exactly as the single job does today.
- **FR-006**: The backend test runner MUST be configured (via its config block in `package.json` — the one in-scope non-workflow change) to write its transform cache to a repo-local directory, and the CI backend job MUST save/restore that directory across runs using a cache keyed on the root dependency lockfile (`package-lock.json`), in addition to the existing setup-node npm cache.
- **FR-007**: Cache behavior MUST be correctness-neutral: a missing, evicted, or stale cache MUST only make the run slower, never change which tests run or their results.
- **FR-008**: The repo-local cache directory MUST be excluded from version control (ignore-list entry) so local runs after the config change leave the working tree clean.
- **FR-009**: Scope of change MUST be limited to: `.github/workflows/test.yml`, the test-runner `cacheDirectory` setting in `package.json`, and the `.gitignore` entry for the cache directory. No application, server, client, or test source files change.
- **FR-010**: Each job MUST install the dependencies its own suites need (see Assumptions for the per-job install split); neither job may depend on artifacts produced by the other.

### Out of Scope

- **Perf-guard separation (§1.4)**: decided **D2 = leave `borrowed-identity-performance` and `per-operation-doc` in the default run** (ratified at default 2026-08-04). This feature MUST NOT introduce a `test:perf` split.
- **Worker parallelism inside the backend suite** (`maxWorkers`, per-worker DB/Redis isolation): Train C, feature 052-parallel-test-isolation.
- **The timeout-defect fixes** (§1.1, §1.2): Train A, feature 050-test-timeout-defects. This feature's wall-time outcome does not depend on 050 having landed, but the absolute numbers do (see SC-001).
- Any change to what tests assert, how suites select tests, branch-protection settings, or deploy workflows.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: CI wall time after dependency install is roughly the backend job's duration alone, whatever that duration is at merge time: ~264s while feature 050 has not landed, ~175-180s once it has (the design's Expected Outcomes "~180s, jobs in parallel" row already assumes 050's backend fix; see G-051-A, which records this dependency the correct way round). Either way the sequential ~290s total collapses to the backend job. The client job finishes well inside the backend job's window (client ~18s + first-run ~3s today). [Corrected 2026-08-04 per analyze finding I1: an earlier draft attached ~180s to the pre-050 state.]
- **SC-002**: The set of test suites and tests executed per push is the same as before the split (verified by diffing the executed-suite lists of a pre-split and post-split run); zero tests gained or lost.
- **SC-003**: On a warm cache (second consecutive run, unchanged lockfile), the backend job's test step is measurably faster than the cold-cache run of the same commit, and the run logs show the cache was restored.
- **SC-004**: A push containing a deliberately failing test in either suite produces a failed workflow run — gating behavior demonstrated for both jobs.
- **SC-005**: After merge, a local backend test run produces unchanged results and reporter output and leaves `git status` clean.

## Assumptions

All defaults below are recorded with rationale in `specs/051-ci-parallel-jobs/clarifications-needed.md` as RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-04). Umbrella decisions D1–D4 are already ratified at their defaults and are not re-opened here.

- **Cache directory location**: the design says "repo-local" but names no path; default is a dot-directory at the repo root (e.g. `.jest-cache`), gitignored (CN-051-01).
- **Cache key composition**: the design says "keyed on package-lock.json"; default is a runner-OS + root-lockfile-hash key with a prefix fallback (`restore-keys`) so a near-miss still warms most transforms — safe because the runner invalidates stale entries itself (CN-051-02).
- **Per-job dependency installs**: the design is silent on which of today's two `npm ci` invocations each job needs. Default: the backend job installs root dependencies only; the client job installs root and client dependencies (the first-run rehearsal suite and the shared reporter scripts live at the repo root; the Vitest suite needs `client/node_modules`) (CN-051-03).
- **Gating semantics**: this repo has no branch-protection/required-checks layer (solo trunk-based workflow, Constitution III); "both jobs gate every push" means the workflow run is red if either job fails, exactly as the single job's red gates today. No branch-protection configuration is introduced.
- **Trigger unchanged**: `on: push` for all branches stays as-is; the pipeline's merge-queue verification and any agent worktree pushes rely on it.
- **Feature 050 interplay**: Train A (050) and Train B (this feature) are independent per the design's Rollout section; landing order does not matter, only the absolute wall-time numbers in SC-001 shift.
- **Coordination with 052**: feature 052 will later edit this same workflow file (explicit CI `maxWorkers`, per D4). This spec deliberately keeps the backend invocation behind `npm run test:server` so 052's change lands in the npm script / jest config, not in competing workflow-file edits.
