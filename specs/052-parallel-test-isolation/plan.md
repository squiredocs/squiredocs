# Implementation Plan: Parallel Test Isolation (Backend Suite)

**Feature**: `052-parallel-test-isolation` (planned in parallel on `main`; no branch created)

**Date**: 2026-08-04 | **Spec**: [spec.md](./spec.md) | **Ledger**: [clarifications-needed.md](./clarifications-needed.md)

**Design ground truth**: `design/test-suite-architecture.md` Part 2 (§2.1–2.4), Expected Outcomes, Verification, Open Decisions D1–D4 (all ratified 2026-08-04).

**Input**: Feature specification from `/specs/052-parallel-test-isolation/spec.md`

> **Sequencing gate (hard)**: implementation MUST NOT begin until **050-test-timeout-defects** and **051-ci-parallel-jobs** are merged to `main`. 051 rewrites `.github/workflows/test.yml`, the one file this feature also touches. Planning is independent of that gate; implementation is not. See [Rebase-on-051 protocol](#rebase-on-051-protocol).

---

## Summary

Give every Jest worker its own PostgreSQL database and its own Redis logical database, then switch the backend suite's default from `--runInBand` to parallel workers behind a five-green-runs gate.

The technical approach is four thin, separable changes plus a governance amendment:

1. **`server/__tests__/globalSetup.js`** builds one fully migrated **template** database per base URL (`<base>_template`), then creates one `<base>_w<N>` per worker from it via `CREATE DATABASE … TEMPLATE`, dropping stale copies first. Worker count comes from `globalConfig.maxWorkers`, which Jest resolves and passes to `globalSetup` as its first argument — so the setup always creates exactly as many databases as the run can use, and `--runInBand` resolves to 1.
2. **`server/__tests__/helpers/db.js`** stops returning `DATABASE_URL` verbatim and instead treats it as a **base**, splicing a worker-derived database name into it while preserving credentials, host, port and query string. A frozen base is published by `globalSetup` as `TEST_BASE_DATABASE_URL` so the derivation is idempotent even after per-worker `DATABASE_URL` is pinned.
3. **`server/redis.js`** gains a `REDIS_DB` knob added to `REDIS_CONFIG` by the same conditional-spread pattern the existing `REDIS_PASSWORD` knob uses, so the constructed config is byte-identical when unset. Both `new Redis(REDIS_CONFIG)` call sites (shared singleton and pub/sub factory) inherit it for free. `server/__tests__/setup.js` pins `REDIS_DB = JEST_WORKER_ID` per worker.
4. **`package.json`** drops `--runInBand` from `test:server`, adds `"maxWorkers": "50%"` to the Jest config block, and makes the worker count CI-overridable through a `JEST_MAX_WORKERS` env var — so 052's CI edit is a **one-line addition to an existing `env:` block**, which is what keeps the rebase onto 051 trivial.

Plus: Constitution Principle II is amended verbatim from design §2.3, with a coherence sweep across **four** surviving serial-mandate assertions (one more than the spec enumerated — see [Constitution Check](#vi-design-docs-are-ground-truth) and [research R9](./research.md)).

No test suite changes its own code to gain isolation (FR-004). The expected short tail of hidden cross-suite coupling is fixed as suite bugs, and the five-green-runs gate is the mechanism that forces those fixes before the serial default is dropped.

---

## Technical Context

**Language/Version**: Node.js 22+, CommonJS (backend). No TypeScript in the touched paths.

**Primary Dependencies**: `jest@29.7.0` (verified — *not* 30, despite a stray `@jest/test-sequencer@^30.2.0` devDependency that nothing references), `pg`, `ioredis`, `node-pg-migrate` (via `script/migrate.js`), `babel-jest`.

**Storage**: PostgreSQL 15 (`pgvector/pgvector:pg15` in CI; client 15.18 locally) with pgvector; Redis 7, stock 16 logical databases.

**Testing**: Jest backend suite — 254 files, 4,574 tests. Config lives **only** in the `"jest"` key of `package.json` (lines ~107–160); there is no `jest.config.*` file. `globalSetup` → `server/__tests__/globalSetup.js`; `setupFilesAfterEnv` → `server/__tests__/setup.js`. No `globalTeardown`, no `setupFiles`, no `reporters`, no `maxWorkers` today. Reporter is CLI-only: `./script/jest-llm-reporter.js`.

**Target Platform**: Linux. Reference machine = Minikube `app-dev` pod, 10 cores (`os.availableParallelism() === 10`). CI = GitHub-hosted `ubuntu-latest`.

**Project Type**: Node web service monorepo (repo root = backend; `client/` = Vitest frontend, out of scope).

**Performance Goals**: SC-001 — full backend suite green in **30–50 s** on the 10-core dev pod (from ~175 s post-Train-A serial).

**Constraints**:
- Redis ships 16 logical databases; DB 0 is reserved for non-test consumers (RBD-052-2) ⇒ hard cap of **15 workers**, enforced by failing fast (FR-008).
- With `REDIS_DB` unset the Redis config must be **byte-identical** to pre-feature (SC-004) — production/dev behavior provably unchanged.
- `--runInBand` stays first-class (FR-014); the LLM reporter stays active in both modes (FR-015, Constitution "Development Workflow").
- Implementation queued behind 050 + 051 merges (spec Assumptions; N-052-B).

**Scale/Scope**: 254 backend suites; up to 15 isolatable workers; 5 workers at the ratified 50% default on the reference machine.

### Verified current-code facts this plan is built on

Checked 2026-08-04 against the working tree:

| Fact | Location |
|---|---|
| `getTestDatabaseUrl()` returns `DATABASE_URL` verbatim when set | `server/__tests__/helpers/db.js:19` |
| `TEST_DB_NAME = 'collab_test_db'` is the only hardcoded DB name in test code | `server/__tests__/helpers/db.js:11` |
| `globalSetup` probes/creates `TEST_DB_NAME` but migrates whatever the URL names — a live bug under a custom `DATABASE_URL` | `server/__tests__/globalSetup.js:14–19` vs `:37` |
| `REDIS_CONFIG` has no `db` key; `REDIS_PASSWORD` sets the conditional-spread precedent | `server/redis.js:9–19`, `:18` |
| Exactly two `new Redis(REDIS_CONFIG)` sites, both reading the one config object | `server/redis.js:32`, `:98` |
| `setup.js` already pins `DATABASE_URL` — but only `if (!process.env.DATABASE_URL)` | `server/__tests__/setup.js` (last block) |
| `test:server` = `jest --runInBand --forceExit --silent --reporters=./script/jest-llm-reporter.js` | `package.json:14` |
| `test:coverage` also uses `--runInBand`; `test:server:watch` is already parallel | `package.json:15–16` |
| `globalSetup(globalConfig, projectConfig)` — `maxWorkers` is pre-resolved to an integer | `node_modules/@jest/core/build/runGlobalHook.js:109` |
| `getMaxWorkers`: `--runInBand` → 1; CLI `--maxWorkers` > config `maxWorkers` > `numCpus-1` | `node_modules/jest-config/build/getMaxWorkers.js` |
| `JEST_WORKER_ID` is set **only** in worker children — undefined in the in-band main process | `node_modules/jest-worker/build/workers/ChildProcessWorker.js:133` |
| `JEST_WORKER_ID` currently appears in **zero** lines of repo code | repo-wide sweep |
| Phantom-`pgmigrations` guards live in `script/migrate.js` and run on every `npm run migrate` | `script/migrate.js:15–27` (dupes), `:29–45` (rolled-back 008 row) |
| CI is still the pre-051 single job; `POSTGRES_DB: collab_test_db`, explicit `DATABASE_URL`, `run: npm run test:server` | `.github/workflows/test.yml:18`, `:55`, `:58` |
| Two test helpers construct connections outside the shared helper | `server/__tests__/helpers/otel-e2e-child.js:42–43` (spawned child), `server/__tests__/ping-pool-release.test.js:39` (deliberate bad URL) |

---

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Both passes recorded below.*

> **This feature AMENDS Principle II.** Per the constitution's own Governance section, an amendment is a sole-maintainer commit to `main` that updates the file, bumps the version, and updates the Sync Impact Report. Design decision **D1 ratified the amendment on 2026-08-04**, so the amendment is authorized policy, not a violation to be justified.
>
> **Accordingly, the gate below is evaluated against the AMENDED Principle II text** (design §2.3, quoted in FR-009), not against the text currently in `.specify/memory/constitution.md`. This is stated explicitly because checking against the current text would produce a false FAIL: the current Principle II *forbids* US4. Against the current text this feature is a deliberate, ratified replacement; against the amended text it is compliant by construction. A row for each reading is given where they differ.

| Principle | Verdict | Notes |
|---|---|---|
| **I. Documentation Reflects Reality** | **PASS (with required work)** | The change falsifies documented behavior in four places, all of which MUST be updated in the same commit: `docs/dev.md:372–375` ("Backend tests are serial-only against one database"), `.claude/skills/the-pipeline/SKILL.md:64` (worktree guidance) and `:46` (merge-queue verification note), and the constitution's Development Workflow gate ("serially for backend"). `ReadMe.md` was swept and asserts nothing about serial execution — no edit needed there. Tasks T032–T036 carry this. |
| **II. Test-Backed Changes** *(amended text)* | **PASS** | Amended text requires exactly what this feature builds: per-worker database + Redis logical database derived from `JEST_WORKER_ID`, no sharing between runs or workers, fixed-key rows scoped to their creating suite. Every behavioral change here is itself test-backed (derivation unit tests, byte-identity test, cap fail-fast test, cross-worker isolation test). No format/serialization change ⇒ the round-trip registry suite is untouched. |
| **II. Test-Backed Changes** *(current text)* | **AMENDED, not violated** | Current text ("Backend tests share one database and MUST run serially") is replaced verbatim per ratified D1/FR-009 under the Governance amendment procedure. Recorded here for the record; not a Complexity Tracking entry. |
| **III. Trunk-Based Solo Workflow** | **PASS** | No new ceremony. The one added gate (five green runs + pass-list diff) is not invented here — it is the design's own Verification section, and it prevents a concrete, named failure (shipping a parallel default that hides mode-dependent suites). |
| **IV. Collaboration-Safe Document Operations** | **N/A** | No document-mutating code paths, no Yjs tree operations, no format-registry surface. |
| **V. Secure by Default** | **PASS (with a hardening requirement)** | No product surface changes. But this feature makes database names **derived from an environment variable** and interpolated into DDL — today's `CREATE DATABASE ${TEST_DB_NAME}` (`globalSetup.js:19`) interpolates a constant; derived names must be validated against a strict charset **and** quoted as identifiers before interpolation (T007, research R6). Test-only code, but the rule is the rule. |
| **VI. Design Docs Are Ground Truth** | **PASS** | Principle II replacement is used **verbatim** from design §2.3. D1–D4 taken at ratified defaults. Five design silences are recorded as RATIFIED-BY-DEFAULT (RBD-052-1…5) and two as flagged notes (N-052-A/B) — none resolved silently. **One extension flagged by this plan**: RBD-052-4 enumerated two secondary references; the sweep found **four** (adding `docs/dev.md:372–375` and `the-pipeline/SKILL.md:46`). This is the same mechanical consequence RBD-052-4 already ratified, applied to the complete set — recorded in research R9 rather than silently widened. |
| **VII. Horizontally Scalable App Pods** | **PASS** | Test-infrastructure only; no app-tier correctness surface. The one production-visible artifact is the `REDIS_DB` knob, which is **absent in production** (SC-004 byte-identity) and, if ever set, selects a logical database uniformly across every pod — it cannot make correctness replica-dependent. |

**Gate result — Phase 0 entry**: PASS. No unjustified violations.

**Gate result — post-Phase-1 re-evaluation**: PASS, unchanged. Phase 1 introduced no new dependency, no new service, no new persistent artifact beyond per-worker test databases (ephemeral, recreated each run), and no change to any production code path other than the byte-identity-preserving `REDIS_DB` knob.

---

## Project Structure

### Documentation (this feature)

```text
specs/052-parallel-test-isolation/
├── spec.md                      # Input (complete)
├── clarifications-needed.md     # RBD-052-1..5, N-052-A/B (complete)
├── checklists/requirements.md   # Spec quality gate (passed)
├── plan.md                      # This file
├── research.md                  # Phase 0 — R1..R10 decisions
├── data-model.md                # Phase 1 — naming/derivation entities + invariants
├── contracts/
│   └── naming-and-env.md        # Phase 1 — derivation + env-knob contract, failure modes
├── quickstart.md                # Phase 1 — validation + the five-green-runs gate procedure
└── tasks.md                     # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
package.json                                  # jest config block: maxWorkers 50%; test:server drops --runInBand
server/
├── redis.js                                  # + REDIS_DB knob in REDIS_CONFIG (conditional spread)
└── __tests__/
    ├── globalSetup.js                        # template + per-worker DB provisioning; worker-cap fail-fast
    ├── setup.js                              # per-worker DATABASE_URL + REDIS_DB pinning
    ├── helpers/
    │   ├── db.js                             # base-URL semantics, name derivation, cleanup-convention rationale
    │   └── otel-e2e-child.js                 # honor REDIS_DB in the spawned child
    ├── telemetry-traces.test.js              # pass REDIS_DB into the spawned child env
    ├── pg-pool-limits.test.js                # stale "serial runner shares process.env" comment
    └── (new) db-isolation.test.js            # derivation, cap, cross-worker isolation, byte-identity
server/undo/__tests__/undo-service.test.js    # stale "serial only (shared collab_test_db)" comment
.github/workflows/test.yml                    # POST-051: one env line (JEST_MAX_WORKERS) on the backend job
.specify/memory/constitution.md               # Principle II amendment + Development Workflow coherence
.claude/skills/the-pipeline/SKILL.md          # worktree guidance (:64) + merge-queue note (:46)
docs/dev.md                                   # serial-only paragraph (:372–375)
```

**Structure Decision**: Existing monorepo layout, unchanged. This is an infrastructure feature: the entire mechanism lands in four existing backend files plus the Jest config block, with one new test file. No new directory, no new dependency, no new service, no schema migration.

### Parallel-agent authoring constraints honored by this plan

Per the pipeline's parallel-agent overrides, this planning pass stayed on `main`, created no branch, committed nothing, and did **not** run `setup-plan.sh` / `setup-tasks.sh`: both call `get_feature_paths` *without* `--no-persist`, which would have overwritten `.specify/feature.json` — currently pinned to `specs/050-test-timeout-defects` by a concurrently running agent. The plan template was staged manually instead. `CLAUDE.md`, `ReadMe.md`, `docs/dev.md` and the constitution were **read but not edited**; every edit to those files is scheduled as implement-phase work (T032–T036).

---

## Implementation Phases

### Phase A — Postgres isolation (US1, FR-001…FR-005)

Delivered by `helpers/db.js` + `globalSetup.js`. Independently valuable: even under `--runInBand` it upgrades every run to a fresh-from-template database, which kills cross-*run* orphan accumulation immediately.

Order: derivation helpers (pure, unit-testable) → globalSetup provisioning → `setup.js` pinning → hardcoded-name sweep.

### Phase B — Redis isolation (US2, FR-006…FR-008)

`server/redis.js` knob first (with the byte-identity test), then per-worker assignment in `setup.js`, then the spawned-child fix (`otel-e2e-child.js` + `telemetry-traces.test.js`), then the >15 fail-fast in `globalSetup`.

### Phase C — Policy and documentation coherence (US3, FR-009…FR-012)

The constitution amendment (verbatim §2.3 text + version bump + Sync Impact Report) and the four-site coherence sweep. No code risk; unblocks Phase D.

### Phase D — Parallel default, behind the gate (US4, FR-013…FR-018)

Config + script change, then the fix-the-tail loop, then the gate: five consecutive green parallel runs locally, five in CI, and an empty serial-vs-parallel pass-list diff. **Phase D's final task — dropping the serial default — is the last thing that lands, and only after the gate is recorded green.**

### Rebase-on-051 protocol

052's CI change is deliberately designed to be one line, so the rebase is mechanical:

1. Confirm 050 and 051 are merged to `main` (`git log --oneline main` shows both merge commits).
2. Re-read `.github/workflows/test.yml` as 051 left it; locate the backend job's test step and its existing `env:` block.
3. Add exactly one entry, `JEST_MAX_WORKERS: <count sized to the runner>`, to that block. Do **not** touch the `run:` line, the services, or the client job.
4. If 051 changed `POSTGRES_DB` or the `DATABASE_URL` value, treat it as the new **base** — no further edit needed, base-URL derivation handles it by construction.
5. If 051 introduced sharding or a matrix on the backend job, stop and re-plan: concurrent shards are concurrent whole invocations against one base, which D3's one-run-at-a-time rule does not cover. (Not expected — 051's design scope is a two-job split, not sharding.)

---

## Risks and Mitigations

| Risk | Handling |
|---|---|
| Hidden cross-suite coupling surfaces on the first parallel runs | Expected and bounded (design §2.4). Each is a suite bug fixed in-feature (FR-017); the five-green gate cannot be satisfied until the tail is fixed, which is the forcing mechanism. Never revert to serial. |
| Timing-sensitive suites flake under CPU contention | Review the suite's timing ceiling, never the worker count (FR-018). |
| A stale/corrupt template poisons all 254 suites at once | Migrate-forward with a self-healing drop-and-rebuild fallback, then fail loudly if the rebuild also fails (research R4). |
| `CREATE DATABASE … TEMPLATE` fails because something holds a connection to the template | Postgres errors immediately (it does not hang); the error is caught and re-raised with the connection-holder diagnostic (research R5). |
| Two concurrent whole invocations against the same base collide | Ratified D3: one-run-at-a-time rule for whole invocations. Worktree agents are Postgres-safe via per-agent bases (RBD-052-1); their Redis exposure is unchanged-or-better vs today (N-052-A). |
| `--maxWorkers` 50% yields 5 workers on the 10-core pod, not the design table's "6–8" | Known artifact reconciliation, not a defect: D4 (50%) is the ratified knob and the design states its Expected Outcomes table is reference expectation, not a merge gate. Recorded in research R10; SC-001's 30–50 s band is what gets measured. |
| Non-Jest `test:first-run` reads raw `DATABASE_URL` | Out of scope (not a Jest run, degrades gracefully when unset); it continues to see the unchanged base. Noted so it is not mistaken for a regression. |

---

## Complexity Tracking

*Fill ONLY if Constitution Check has violations that must be justified.*

**No entries.** The Constitution Check produced no unjustified violations. The single deviation from the constitution *as currently written* is the Principle II amendment itself, which is ratified design decision D1 executed through the constitution's own Governance procedure — a governed amendment, not an unjustified violation, and therefore not a Complexity Tracking row.

For the record, the three heavier alternatives the design considered and rejected (per-test transaction rollback; a container per worker via testcontainers; a per-run nonce in database names) are all *more* complex than the chosen approach; the plan adds no complexity beyond the ratified design. See [research.md](./research.md) R1 and R7.
