# Implementation Plan: CI Parallel Jobs and Warm Transform Cache

**Branch**: `051-ci-parallel-jobs` | **Date**: 2026-08-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/051-ci-parallel-jobs/spec.md`

**Design ground truth**: `design/test-suite-architecture.md` (ratified 2026-08-04) — Part 1 §1.3

## Summary

Split the single sequential CI job in `.github/workflows/test.yml` into two jobs that run
concurrently with no dependency between them:

- **`backend`** — postgres (pgvector) + redis service containers, root `npm ci`, then
  `npm run test:server` with today's `DATABASE_URL` / `REDIS_HOST` / `REDIS_PORT` values.
- **`client`** — no service containers, root `npm ci` + `cd client && npm ci`, then
  `npm run test:client` and `npm run test:first-run`.

Give the backend job a warm Jest transform cache: point Jest's `cacheDirectory` at a
repo-local `.jest-cache/` (its only setting change, in the `jest` block of `package.json`),
gitignore that directory, and wrap the backend job's test step with `actions/cache` keyed on
`runner.os` + the hash of the root `package-lock.json`, with a prefix `restore-keys`
fallback — alongside (not replacing) the existing `actions/setup-node` npm cache.

Technical approach in one line: **three files change and nothing else** —
`.github/workflows/test.yml`, the `jest.cacheDirectory` key in `package.json`, and one
`.gitignore` line. The backend invocation stays behind `npm run test:server` (FR-002) so
feature 052's worker-count work lands in the npm script / jest config rather than colliding
with this workflow edit.

## Technical Context

**Language/Version**: GitHub Actions workflow YAML; `package.json` (JSON); Node.js 22 on the
runner (unchanged from today's `actions/setup-node` pin).

**Primary Dependencies**: `actions/checkout@v4`, `actions/setup-node@v4` (both already in
use), `actions/cache@v4` (new to this repo). Test runners are unchanged: Jest 29.7.0
(backend), Vitest (client, run from `client/`), `node --test` (first-run rehearsal).

**Storage**: N/A for the application. The feature introduces exactly one new on-disk
artifact: the repo-local `.jest-cache/` transform-cache directory (locally ~543MB per the
design's measurement; gitignored).

**Testing**: No test is written, moved, renamed, or altered. The three existing suites keep
their existing npm scripts and their existing LLM-friendly reporters
(`script/jest-llm-reporter.js`, `script/vitest-llm-reporter.mjs`). Verification of this
feature is the CI run itself plus a local run (see `quickstart.md`).

**Target Platform**: GitHub-hosted `ubuntu-latest` runners (unchanged). Local development
continues in the Minikube `app-dev` pod.

**Project Type**: Web application (Express/Yjs server + React client) — but this change is
CI/build infrastructure only; no application, server, client, shared, or test source file is
touched.

**Performance Goals**: SC-001 — post-install CI wall time ≈ the backend job alone, down from
~290s sequential today; the client job's ~21s of work disappears into the backend job's
window. The absolute figure is train-order dependent: pre-050 the backend job is still ~264s,
so the parallel wall time lands near that; the design's "~180s, jobs in parallel" is the
*After Part 1* row of the Expected Outcomes table and therefore assumes Train A (050) has
landed. See finding I1 in the analysis report — spec SC-001 states this the other way round.
SC-003 — a second consecutive run on an unchanged lockfile restores the Jest cache and its
test step is measurably faster than the cold run.

**Constraints**:
- FR-002 — backend invocation MUST stay `npm run test:server`; no inlined Jest flags in the
  workflow (coordination constraint with feature 052).
- FR-007 — cache is correctness-neutral: any cache state (missing, evicted, stale) may only
  change timing, never test selection or results.
- FR-009 — change scope is exactly three files.
- Constitution "Test output MUST stay LLM-friendly" — reporters stay wired for both suites.

**Scale/Scope**: 1 workflow file (63 lines → 2 jobs), 1 `package.json` key, 1 `.gitignore`
line. Suites under the split: 254 backend Jest files / 4574 tests, 72 client Vitest files /
936 tests, 31 first-run rehearsal tests. The union must be exactly the same set (SC-002).

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.2.0 before Phase 0, re-checked
after Phase 1.*

| Principle / Gate | Applies? | Assessment | Verdict |
| --- | --- | --- | --- |
| **I. Documentation Reflects Reality** | Yes (conditional) | The change alters *how* CI is structured, not *what* it runs. `README.md:243` describes CI as running "the server and client tests" and building no image; that claim's subject is unchanged by the split. A verification task re-reads that line after the change and requires a same-commit correction if the split falsified it. Note: that line already omits the first-run rehearsal suite — pre-existing drift, not introduced here; flagged, and correctable under the same task since a doc file is not an application source file under FR-009. | PASS (with verification task) |
| **II. Test-Backed Changes** | Partially | No behavioral change to application code, so there is nothing new to write a test for. The suites that would catch a regression *are* the artifacts being rescheduled: FR-004/SC-002 require executed-test parity and the feature's own verification is a full green CI run of both jobs plus a local backend run. The serial-DB clause is honored: the backend job is the only job with a database, it still runs `npm run test:server` (which carries `--runInBand`), and the client job declares no services, so the two jobs cannot share a database. | PASS |
| **III. Trunk-Based Solo Workflow** | Yes | No branch-protection layer, required checks, or review ceremony is introduced (spec Assumptions, "Gating semantics"). Gating stays what it is today: a red workflow run. No new process. | PASS |
| **IV. Collaboration-Safe Document Operations** | No | No document/CRDT/format code is touched. | N/A |
| **V. Secure by Default for Agent & User Content** | Marginally | No new ingestion surface. One supply-chain-adjacent consideration: `actions/cache@v4` is a first-party GitHub action pinned by major version exactly as the two existing actions are (`checkout@v4`, `setup-node@v4`) — consistent with the repo's established posture, no new trust boundary. The restored cache holds only Babel transform output derived from files the same run checked out, is read by Jest (which re-transforms on content mismatch), and carries no secret. | PASS |
| **VI. Design Docs Are Ground Truth** | Yes | Every element traces to `design/test-suite-architecture.md` §1.3 (two parallel jobs; backend gets the services; client + first-run need none; repo-local `cacheDirectory` cached via actions/cache keyed on `package-lock.json`, alongside the npm cache; both jobs still gate). The three design silences (cache path, key composition, per-job installs) are resolved as RATIFIED-BY-DEFAULT CN-051-01..03, not ad hoc. §1.4's perf-guard split is D2-decided out of scope and is not implemented. No design export is hand-edited. | PASS |
| **VII. Horizontally Scalable App Pods** | No | CI infrastructure; no app-tier runtime behavior, no process-local state. | N/A |
| **Dev Workflow: plan-phase Constitution Check** | Yes | This section. | PASS |
| **Dev Workflow: LLM-friendly test output** | Yes | FR-004 pins it. Both reporters ride inside the npm scripts (`--reporters=./script/jest-llm-reporter.js`, `--reporter=../script/vitest-llm-reporter.mjs`) and the scripts are invoked unchanged, so this change structurally cannot drop them. Verified explicitly by a dedicated task. | PASS |
| **Dev Workflow: `/the-pipeline` for design-driven work** | Yes | This feature is Train B of a ratified design proposal running through the pipeline. | PASS |
| **Tech constraints (Node 22, node-pg-migrate, ai-providers.js, shared/)** | No | None engaged. | N/A |

**Result**: no violations. The Complexity Tracking table below is empty by design.

**Post-Phase-1 re-check**: Phase 1 produced `data-model.md`, `contracts/ci-contract.md`, and
`quickstart.md` — documentation artifacts only. No Phase 1 decision introduced a new
dependency, a new process, a scope expansion beyond FR-009's three files, or any
application-code change. All gates above remain PASS.

## Project Structure

### Documentation (this feature)

```text
specs/051-ci-parallel-jobs/
├── spec.md                      # Feature specification (input)
├── clarifications-needed.md     # CN-051-01..03 RATIFIED-BY-DEFAULT + gaps G-051-A/B
├── checklists/
│   └── requirements.md          # Spec quality checklist (passed)
├── plan.md                      # This file
├── research.md                  # Phase 0 output — R1..R7 decisions
├── data-model.md                # Phase 1 output — configuration entities (no domain data)
├── contracts/
│   └── ci-contract.md           # Phase 1 output — workflow/npm-script/cache-path invariants
├── quickstart.md                # Phase 1 output — how to validate the split and the cache
└── tasks.md                     # Phase 2 output (/speckit-tasks — not created by /speckit-plan)
```

### Source Code (repository root)

Only three files change. The surrounding tree is listed because the plan's central claim is
what it does *not* touch.

```text
.github/
└── workflows/
    └── test.yml            # CHANGED — one job `test` becomes two jobs: `backend`, `client`

package.json                # CHANGED — one key added: jest.cacheDirectory
.gitignore                  # CHANGED — one line added: .jest-cache/

.jest-cache/                # NEW, generated + gitignored (never committed)

script/
├── jest-llm-reporter.js    # unchanged — wired via npm script, not the workflow
└── vitest-llm-reporter.mjs # unchanged — wired via npm script, not the workflow

server/, client/, shared/, test/, __tests__/   # UNCHANGED (FR-009)
```

**Structure Decision**: No source-layout decision is required — this is a build-infrastructure
change to an existing repository. The only structural addition is the top-level
`.jest-cache/` directory (CN-051-01), chosen as a repo-root dot-directory because it must be
referenced identically from three places (`<rootDir>/.jest-cache` in the jest config, a
literal `.jest-cache` path in the workflow cache step, `.jest-cache/` in `.gitignore`) and
must sit outside every existing ignore glob — notably outside `tmp/`, which deploy scripts and
scratch cleanup treat as disposable.

## Phase 0: Research

See [research.md](./research.md). Seven decisions recorded (R1–R7): job decomposition and
naming, per-job installs, cache action and key composition, cache-directory location, Jest
config placement, preservation of the setup-node npm cache, and the deliberate non-changes.

No `NEEDS CLARIFICATION` markers remain in Technical Context.

## Phase 1: Design & Contracts

- [data-model.md](./data-model.md) — this feature has no domain entities; the "model" is the
  set of configuration entities (Job, Service Container, Cache Entry, Cache Directory) and the
  invariants binding them.
- [contracts/ci-contract.md](./contracts/ci-contract.md) — the interface contract this feature
  must not break: job names, the npm-script indirection boundary (FR-002), the environment
  contract for the backend job, the three-way cache-path agreement, and the coordination
  surface reserved for feature 052.
- [quickstart.md](./quickstart.md) — runnable validation for SC-001..SC-005.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified.

*No violations. Table intentionally empty.*
