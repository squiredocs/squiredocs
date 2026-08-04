# Phase 0 Research: CI Parallel Jobs and Warm Transform Cache

**Feature**: 051-ci-parallel-jobs | **Date**: 2026-08-04 | **Plan**: [plan.md](./plan.md)

No `NEEDS CLARIFICATION` markers were carried into Technical Context. The three genuine
unknowns (cache path, cache key, per-job installs) were already resolved at spec time as
RATIFIED-BY-DEFAULT decisions CN-051-01..03 in
[clarifications-needed.md](./clarifications-needed.md); this phase confirms them against the
actual repository state and records the remaining implementation-level decisions.

Everything below was verified by reading the repository on 2026-08-04, not from priors.

---

## Baseline: what the repository actually contains today

| Fact | Evidence |
| --- | --- |
| One CI job named `test` on `ubuntu-latest`, triggered `on: push` for `'*'` branches | `.github/workflows/test.yml` |
| It declares both service containers (`pgvector/pgvector:pg15`, `redis:7`) at job level | same file |
| Steps in order: checkout → setup-node@v4 (node 22, `cache: 'npm'`) → `npm ci` → `cd client && npm ci` → server tests (with 3 env vars) → client tests → first-run tests | same file |
| Jest is configured **inline in `package.json`** under a `"jest"` key (no `jest.config.*` file exists) | `package.json` lines 100–149; `ls jest.config*` returns nothing |
| Jest 29.7.0; current effective `cacheDirectory` is `/tmp/jest_0` (the OS-tmp default) | `npx jest --showConfig`; `jest/package.json` |
| `test:server` = `REDIS_HOST=${REDIS_HOST:-localhost} jest --runInBand --forceExit --silent --reporters=./script/jest-llm-reporter.js` | `package.json` scripts |
| `test:client` = `cd client && npx vitest run --reporter=../script/vitest-llm-reporter.mjs` | same |
| `test:first-run` = `node --test test/first-run/*.test.mjs` | same |
| Neither LLM reporter imports a third-party package (node builtins only) | `script/jest-llm-reporter.js`, `script/vitest-llm-reporter.mjs` |
| `.gitignore` has no `.jest-cache` entry and no glob that would already cover it | `.gitignore` |

---

## R1 — Job decomposition and naming

**Decision**: Replace the single `test` job with two top-level jobs, `backend` and `client`,
each `runs-on: ubuntu-latest`. Neither declares `needs:`, which is what makes them run
concurrently. Service containers move from the (now removed) shared job into `backend` only.

**Rationale**: Design §1.3 states the split exactly this way ("backend (postgres + redis
services) and client plus first-run (no services needed)"). Absence of `needs:` is the whole
parallelism mechanism in GitHub Actions — no `strategy`, `matrix`, or concurrency group is
needed or wanted. FR-005's gating requirement is satisfied for free: a workflow run's
conclusion is failure if any job fails, which is precisely today's behavior generalized.

The `client` job carries the first-run rehearsal suite because that suite needs no services
and is only 3.2s — parking it beside the ~18s Vitest run keeps the client job well inside the
backend job's window (SC-001).

**Alternatives considered**:
- *Three jobs (backend / client / first-run)*: rejected. It buys ~3s of wall time at the cost
  of a third `npm ci` and a third runner, and the design names two jobs.
- *One job with a matrix*: rejected. A matrix over heterogeneous suites would force one
  step-set to cover both service-ful and service-less cases, which is more YAML and more
  conditionals than two plain jobs.
- *Keeping the job name `test` for one of the two*: rejected in favor of two new, descriptive
  names. Nothing depends on the old name — the repo has no branch-protection required-checks
  layer (spec Assumptions, "Gating semantics"), which is the only thing job-name stability
  would matter for.

---

## R2 — Per-job dependency installs

**Decision**: Confirm CN-051-03 as ratified. `backend` runs root `npm ci` only. `client` runs
root `npm ci` **and** `cd client && npm ci`.

**Rationale + verification**: `test:server` resolves entirely from root `node_modules`, so the
backend job needs nothing from `client/` — dropping that install is where the backend job's
share of the parallelism win comes from. For the client job, the client install is
non-negotiable (`npx vitest` resolves from `client/node_modules`, and `client/package.json`
has a `postinstall: patch-package --error-on-fail` that must run).

The root install in the client job was examined for removal and **deliberately kept**. The
import graph of the five files matched by `test/first-run/*.test.mjs` reaches only node
builtins, sibling helpers, and `distribution/publish.mjs` — which itself imports only node
builtins. The one first-run file that imports a root dependency (`pg`, in
`test/first-run/matrix-runner.mjs`) is *not* a `*.test.mjs` file and is not reachable from any
of them, so a static read suggests root `node_modules` may be unnecessary. That evidence is
not conclusive: `install-surfaces.test.mjs` and `publish-mechanism.test.mjs` use `spawnSync`,
and a subprocess's resolution is not visible to import-graph inspection. CN-051-03 explicitly
sets root `npm ci` as a floor that the plan phase "must not go below without proof", and this
is short of proof. Cost of keeping it is small (the setup-node npm cache makes the root
install largely a cache-restore) and it is not on the critical path — the client job has ~250s
of backend-job window to hide in.

**Alternatives considered**:
- *Root install in the client job dropped*: rejected on the evidence above; re-openable later
  as a pure optimization with a proof run, and it changes nothing about this feature's outcome.
- *Both installs in both jobs*: rejected — it wastes exactly the parallelism this feature buys
  (CN-051-03's stated failure mode).

---

## R3 — Cache action and key composition

**Decision**: `actions/cache@v4`, added to the `backend` job only, with:

- `path: .jest-cache`
- `key: jest-cache-${{ runner.os }}-${{ hashFiles('package-lock.json') }}`
- `restore-keys: jest-cache-${{ runner.os }}-`

Placed after `setup-node` and before the test step.

**Rationale**: This is CN-051-02 verbatim. `actions/cache` is GitHub's first-party action and
is what the design names ("cache it with actions/cache keyed on package-lock.json"). `v4` is
the current major and matches the pin style of the two actions already in the file. The client
lockfile is excluded because client dependencies never enter the backend transform path.

Two behaviors of `actions/cache` worth recording because they shape the outcome:

1. **Exact-key hit means no save.** If the primary key hits, the post-job save is skipped, so
   the cache for a given lockfile is written once and then frozen. As source files change, new
   and changed files simply miss in the frozen cache and get transformed normally — the large,
   stable bulk (`@ai-sdk`, `@workflow`, and the 246 fast suites) stays warm. This is a
   speed-only degradation, consistent with FR-007, and matches the design's framing of the
   cache as repeated-work elimination rather than a correctness mechanism.
2. **`restore-keys` fallback is what makes a lockfile bump cheap.** Without it, every
   dependency change would start fully cold. With it, the previous cache is restored as a
   warm start and then re-saved under the new key, satisfying US2 acceptance scenario 3.

**Alternatives considered**:
- *Including `client/package-lock.json` in the hash*: rejected — pointless cache misses
  (CN-051-02).
- *Including the Node version or a commit SHA in the key*: SHA rejected as a permanently cold
  cache; the Node version is already pinned literally in the workflow, so a version bump is a
  workflow edit that a stale cache survives harmlessly (Jest re-transforms on mismatch).
- *Caching on the client job too*: rejected — Vitest's transform cache is not the measured
  problem, and the client job is not the critical path.
- *`actions/cache/restore` + `actions/cache/save` split*: rejected as unnecessary ceremony;
  the combined action's default save-on-post behavior is exactly what is wanted.

---

## R4 — Cache directory location

**Decision**: `.jest-cache/` at the repository root, gitignored, referenced as
`<rootDir>/.jest-cache` from the Jest config.

**Rationale**: CN-051-01 as ratified, and confirmed against the actual `.gitignore`: no
existing pattern covers or collides with `.jest-cache/`. Critically it is *not* under `tmp/`,
which this repo's `.gitignore` comments mark as "Local DB backups / scratch" and which deploy
tooling treats as disposable. It is also outside `.claude/worktrees/`, which the Jest config
already excludes via `modulePathIgnorePatterns`/`testPathIgnorePatterns`.

Moving off the `/tmp/jest_0` default is a real change for local runs too: the cache becomes
repo-local, which is exactly why FR-008's `.gitignore` entry is not optional — without it,
`git status` after any local backend run would show hundreds of megabytes of untracked cache
(US3 / SC-005).

**Alternatives considered**: `tmp/jest-cache` (rejected — disposable-by-convention directory,
already gitignored, but deploy/scratch tooling clears it); `node_modules/.cache/jest`
(rejected — wiped by every `npm ci`, so it can never be warm in CI, which defeats the entire
point); keeping the OS-tmp default and caching `/tmp/jest_0` (rejected — the design explicitly
says "repo-local", and an absolute OS path is fragile across runners and unusable as a
`<rootDir>`-relative reference).

---

## R5 — Where the Jest setting goes

**Decision**: Add exactly one key, `"cacheDirectory": "<rootDir>/.jest-cache"`, to the
existing `"jest"` block in `package.json`. Do not create a `jest.config.js`.

**Rationale**: The repo has no standalone Jest config file — all Jest configuration is inline
in `package.json`, and FR-006 names that block as "the one in-scope non-workflow change".
Introducing a config file would be a structural change well outside FR-009's three-file scope
and would create a needless conflict surface with feature 052, which will also be adjusting
Jest settings.

`<rootDir>` (not a bare relative path) is used so the cache resolves to the same directory
regardless of the working directory Jest is invoked from.

**Alternatives considered**:
- *`--cacheDirectory` flag in the `test:server` npm script*: rejected. FR-006 says "via its
  config block in `package.json`", and a flag in the script is a second place the path would
  have to agree, worsening the three-way agreement problem the contract exists to manage.
- *`--cacheDirectory` flag in the workflow*: rejected outright — it violates FR-002 (no
  inlined test-runner flags in the workflow) and would make the cache CI-only, contradicting
  the local-cleanliness requirement FR-008 exists to serve.

---

## R6 — The existing setup-node npm cache stays

**Decision**: Keep `cache: 'npm'` on `actions/setup-node@v4` in **both** jobs, unchanged, with
no `cache-dependency-path` added.

**Rationale**: FR-006 says the Jest cache is added "in addition to the existing setup-node npm
cache" — they cache different things (npm's package tarball cache vs Jest's Babel transform
output) and neither substitutes for the other.

`cache-dependency-path` was considered for the client job so its npm cache would also key on
`client/package-lock.json`. **Deliberately not done**: today's single job already installs both
trees under a root-lockfile-keyed npm cache, so leaving it alone preserves current behavior
exactly. Changing it would be an unrequested optimization with its own cache-key semantics to
validate, and this feature's whole risk posture is "restructure the schedule, change nothing
else". Recorded here so a later reader sees it was a decision, not an oversight — it is
adjacent to gap G-051-B (install-time work needs a design amendment, not scope creep here).

---

## R7 — Deliberate non-changes

Recorded so that implementation and review can distinguish "not done" from "forgotten":

| Non-change | Why |
| --- | --- |
| No `test:perf` script, no perf-guard separation | Design D2, ratified: perf guards stay in the default run. Spec Out of Scope forbids it. |
| No `maxWorkers`, no `--runInBand` removal, no per-worker DB/Redis isolation | Train C / feature 052. `test:server` keeps `--runInBand` and is invoked unchanged. |
| No timeout-defect fixes | Train A / feature 050. Independent per the design's Rollout section; only SC-001's absolute numbers depend on landing order (gap G-051-A). |
| No trigger change | `on: push` for `'*'` stays; merge-queue verification and agent worktree pushes depend on it (spec Assumptions). |
| No branch protection / required checks | Constitution III; the repo has no such layer and this feature introduces none. |
| No change to any test file, reporter, npm script, or application source | FR-009. In particular `test:server`, `test:client`, `test:first-run` are invoked byte-identically to today. |
| No `concurrency:` group or run cancellation | Not requested, and cancelling in-flight runs would change gating semantics (FR-005). |
| No `timeout-minutes` on the new jobs | Not in the design or spec; adding one would introduce a new failure mode into a feature whose premise is that only the schedule changes. |

---

## Open risks carried into implementation

- **G-051-A (from the ledger)**: SC-001's "~180s" is train-order dependent. Verification must
  measure the post-split wall time against whichever backend baseline is current at merge
  time, not against the design table's single figure.
- **First live run is the verification**: the workflow change takes effect on the push that
  introduces it (spec Edge Cases), so the first post-merge run is both the deployment and the
  test. A YAML syntax error therefore surfaces as a workflow that fails to start rather than a
  test failure — hence the local YAML parse task before commit.
- **Cache warmth cannot be observed on the first run.** SC-003 requires two consecutive runs;
  the first is definitionally cold. This is a verification-sequencing note, not a defect.
