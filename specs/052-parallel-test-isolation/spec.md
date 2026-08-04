# Feature Specification: Parallel Test Isolation (Backend Suite)

**Feature Branch**: `052-parallel-test-isolation` (spec authored in parallel on `main`; no branch created)

**Created**: 2026-08-04

**Status**: Draft

**Input**: Train C of the test-suite architecture proposal: make the backend Jest suite parallel-safe via per-worker database and Redis isolation, amend Constitution Principle II accordingly, and switch the default run from `--runInBand` to parallel workers — gated on a five-green-runs verification.

**Design ground truth**: `design/test-suite-architecture.md` (ratified 2026-08-04 by Sam), specifically **Part 2 (sections 2.1–2.4)**, **Expected Outcomes**, **Verification**, and the **Open Decisions table (D1–D4, all ratified at their stated defaults)**: D1 the Principle II amendment proceeds as written; D2 the perf guards stay in the default run; D3 the one-run-at-a-time rule is kept, no per-run nonce; D4 `maxWorkers` 50% locally, explicit `maxWorkers` in CI sized to the runner. The design doc wins over this spec, over code, and over any model prior. Material silences in the design are recorded in `clarifications-needed.md` as flagged gaps with ratified-by-default answers — never resolved silently. D1–D4 are ratified and are **not** re-opened there.

---

## The problem (from the design contract)

The backend Jest suite (254 files, 4,574 tests) runs serially under a constitutional mandate, because all suites share one database (`collab_test_db`) and some use fixed-key rows — concurrent runs corrupt each other. That sharing has already produced a named flake class (`reindexStale` orphans: rows one suite leaves behind surface as failures in an unrelated suite on CI) and a suite-cleanup convention in `server/__tests__/helpers/db.js` that exists only to manage it. After Train A's defect fixes the suite is ~175 seconds of serial wall time while using about a quarter of one core on a 10-core machine.

This feature removes the root cause instead of managing it: each Jest worker (and each concurrent invocation) gets its own database and its own Redis logical database, derived from `JEST_WORKER_ID`. With isolation in place, parallelism is turned on. Expected end state per the design: backend suite at **30–50 seconds with 6–8 workers**, and the shared-database flake class eliminated by construction — which the design values as much as the speed.

**Dependency note**: implementation is sequenced after features 050 (Train A, timeout defects) and 051 (Train B, CI split) merge — 051 rewrites the same CI workflow file (`.github/workflows/test.yml`) this feature must touch, so 052's CI change applies to the post-051 backend job. Spec and plan work for 052 is independent of that sequencing; only implementation queues behind it.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every Jest worker owns its own database (Priority: P1)

Sam or a pipeline agent runs the backend suite. Setup builds one fully migrated **template** database, then gives each Jest worker its own database copied from that template, replacing any stale copy left by a previous run. Every test in a worker sees a complete, freshly migrated, exclusively owned database. Two workers can never see each other's rows, so fixed-key suites and `reindexStale`-style orphan coupling become physically impossible across workers. Serial runs (`--runInBand`) are just the one-worker case and keep working unchanged; the existing CI and worktree conventions of pointing the run at an explicit database URL keep working, with that URL now naming the *base* the per-worker names derive from.

**Why this priority**: it is the load-bearing half of the feature. Nothing else — Redis isolation, the policy amendment, the parallel default — matters until two workers can run against the database layer without corrupting each other. It is also independently valuable on its own: even under serial execution it upgrades every run to a fresh-from-template database, which kills the cross-*run* orphan accumulation the cleanup convention exists to fight.

**Independent Test**: run the full suite serially (worker 1 only) and confirm it is green against its derived database; then run two Jest workers concurrently on suites that use fixed-key rows and confirm both pass and that each worker's rows exist only in its own database.

**Acceptance Scenarios**:

1. **Given** a machine where the template and per-worker databases do not yet exist, **When** the backend suite starts, **Then** setup creates and migrates the template once, creates one database per worker from the template, and every suite passes against its worker's database.
2. **Given** stale per-worker databases left behind by a previous (possibly crashed) run, **When** the suite starts, **Then** the stale copies are dropped and recreated from the current template before any test runs.
3. **Given** a serial `--runInBand` run, **When** tests execute, **Then** the whole run uses worker 1's database and behaves exactly as today apart from the database name.
4. **Given** CI's explicitly provided database URL, **When** the suite runs there, **Then** that URL is treated as a base and each worker derives its own database name from it the same way as locally.
5. **Given** a pipeline worktree agent running with its own per-agent base database URL, **When** two such agents run their suites concurrently, **Then** neither agent's run touches the other's databases (per-agent bases derive disjoint template and worker names — see RBD-052-1).
6. **Given** two workers each inserting the *same* fixed-key row their suites have always used, **When** they run concurrently, **Then** both suites pass, because the rows live in different databases.

---

### User Story 2 - Every Jest worker owns its own Redis logical database (Priority: P2)

The same run isolates Redis: each worker is assigned its own Redis logical database derived from `JEST_WORKER_ID`, so pub/sub fan-out, presence state, and any keyed data written by one worker are invisible to every other worker. Production and development behavior is untouched: when the new knob is not set, the Redis connection configuration is byte-identical to today's.

**Why this priority**: without it, parallel workers still share Redis database 0 and cross-talk through pub/sub channels and shared keys — database isolation alone does not make the suite parallel-safe. It ranks below US1 only because fewer suites touch Redis than touch Postgres, and because it is meaningless until US1 exists to parallelize against.

**Independent Test**: with the knob unset, diff the effective Redis connection configuration against today's and confirm byte-identity; then run two workers concurrently where each publishes on the same channel name, and confirm each worker's subscriber sees only its own worker's messages.

**Acceptance Scenarios**:

1. **Given** the new Redis logical-database setting is unset, **When** the server builds its Redis configuration (production, dev, or anywhere), **Then** the configuration is byte-identical to the configuration produced before this feature — the knob's key is absent, not present-with-default.
2. **Given** a test worker, **When** it opens the shared Redis client *and* any dedicated pub/sub clients, **Then** all of them land on the same logical database assigned from that worker's `JEST_WORKER_ID`, so within-worker pub/sub suites keep passing.
3. **Given** two workers publishing and subscribing on identical channel names concurrently, **Then** neither worker's subscribers receive the other worker's messages.
4. **Given** a requested worker count that exceeds the number of isolatable workers (Redis ships 16 logical databases, capping workers at 15), **When** the suite starts, **Then** the run fails fast with a clear error instead of silently sharing a logical database (see RBD-052-3).
5. **Given** a serial `--runInBand` run, **When** tests execute, **Then** the run uses worker 1's logical database and all Redis-dependent suites pass.

---

### User Story 3 - The written rules match the new reality (Priority: P2)

The project constitution and the test-helper documentation stop mandating what is now false and start mandating what actually matters. Constitution Principle II's serial mandate is replaced — exactly as ratified in design section 2.3 (D1) — by the isolation invariant: every worker and every concurrent invocation gets its own database and Redis logical database; two runs or workers never share one; fixed-key rows stay scoped to the suite that creates them. The suite-cleanup convention in `helpers/db.js` **stays** (within one worker, suites still run in sequence against one database, so deleting what you created still protects suite ordering), but its documented rationale is updated: the cross-suite orphan flake class disappears by construction, and the convention's remaining job is within-worker hygiene.

**Why this priority**: Principle II as written *forbids* US4. The amendment is a hard precondition for switching the default, and stale rule text is a defect in this project (agents take the docs literally). It carries no code risk of its own, so it ranks below the isolation mechanics but ahead of the switch it unblocks.

**Independent Test**: read the amended constitution and confirm the Principle II text is verbatim the design-2.3 replacement; read `helpers/db.js` and confirm the cleanup convention survives with a rationale that no longer claims a shared serial database; grep the constitution and pipeline docs for surviving assertions of the old serial mandate.

**Acceptance Scenarios**:

1. **Given** the amended constitution, **When** Principle II is read, **Then** the serial-mandate sentence is replaced by exactly the ratified replacement text from design section 2.3, and the amendment is recorded per the constitution's own Governance section (sole-maintainer commit to main, version bump per its rules).
2. **Given** the amended constitution, **When** the rest of the document is read, **Then** no other clause still asserts the old shared-database serial mandate (the Development Workflow gate's "serially for backend" wording is made coherent — see RBD-052-4).
3. **Given** `helpers/db.js` after the change, **When** the suite-cleanup convention comment is read, **Then** the convention (delete your `yjs_updates` rows by `doc_guid` in `finally`/`afterAll`) still stands, and its stated reason is within-worker suite ordering — not a shared serial database.
4. **Given** the pipeline skill's worktree guidance, **When** it is read, **Then** its per-agent database instruction reflects base-URL derivation and no longer asserts serial-only as a constitutional mandate (see RBD-052-4).

---

### User Story 4 - The suite runs parallel by default, and earns it first (Priority: P3)

With isolation in place and the constitution amended, the default backend run switches from `--runInBand` to parallel workers: 50% of cores locally, an explicit worker count in CI sized to the runner (D4). `--runInBand` remains fully supported for bisecting failures serially, and the LLM-friendly reporter stays wired in both modes (constitution requirement). The switch is **gated**: the serial default is dropped only after five consecutive full parallel runs are green both locally and in CI, and after a serial run and a parallel run produce identical pass lists — proving no suite depends on execution mode. The first parallel runs are expected to surface a short tail of hidden cross-suite coupling; each such failure is a suite bug to fix within this feature, never a reason to revert to serial. A suite that flakes under CPU contention gets its timing ceiling reviewed, never the worker count reduced.

**Why this priority**: it is the payoff — the 264s→30–50s outcome — but it is only safe as the last step, and it is the one story that is explicitly verification-gated rather than merely tested.

**Independent Test**: run the default backend command and confirm multiple workers execute; run the five-consecutive-green gate locally and in CI; diff serial vs parallel pass lists; run `--runInBand` and confirm it is green with reporter output unchanged.

**Acceptance Scenarios**:

1. **Given** the new default local command, **When** the backend suite runs on the 10-core dev pod, **Then** Jest uses 50% of cores as workers and the full suite completes green in the design's expected 30–50 second band at 6–8 workers.
2. **Given** the post-051 CI backend job, **When** it runs the suite, **Then** it passes an explicit worker count sized to the CI runner (not a percentage), and the job is green.
3. **Given** a developer bisecting a failure, **When** they run the suite with `--runInBand`, **Then** the run executes serially as worker 1, passes, and produces the same LLM-reporter output format as today.
4. **Given** any default or serial run, **When** it completes, **Then** the LLM-friendly reporter was the active reporter (never silently dropped by the script change).
5. **Given** the verification gate, **When** the serial default is proposed for removal, **Then** five consecutive full parallel runs have been green locally and five in CI, and a serial run's pass list diffed against a parallel run's pass list shows no difference.
6. **Given** a first-parallel-run failure caused by one suite depending on another suite's leftover rows, **When** it is triaged, **Then** the resolution recorded is a fix to the offending suite's own setup/cleanup — the isolation and the parallel default stay.
7. **Given** a suite that starts flaking under 6–8-worker CPU contention, **When** it is triaged, **Then** its timing ceiling is reviewed and adjusted (as the perf guards already are), and the worker count is not lowered to accommodate it.

---

### Edge Cases

- **Serial is the one-worker case, everywhere**: `--runInBand` sets worker id 1, so serial runs derive worker 1's names for both the database and the Redis logical database. Every other consumer of the serial path (`test:coverage` also runs `--runInBand`; manual bisecting) inherits this for free and must keep working, and non-serial entry points (`test:server:watch`, which already runs parallel workers) gain isolation the same way.
- **Crashed previous runs**: stale per-worker databases (and a stale template) may exist, possibly at an older migration state. Setup must replace stale worker copies before tests run, and must never hand a worker a database whose schema is not the current template's (see RBD-052-5). Dropping a database that something still holds connections to must fail loudly, not hang silently.
- **Base URLs with credentials or query parameters**: the derived per-worker name must be spliced into the database segment of the URL, preserving user, password, host, port, and any query string (CI's URL carries credentials today).
- **Worker count above the Redis cap**: 16 logical databases cap workers at 15; a run configured beyond that fails fast with a clear message (RBD-052-3). At 50% of cores this is unreachable on any current runner (a 30-core machine would be needed), so the guard is a tripwire, not a daily path.
- **Concurrent whole invocations**: two simultaneous invocations against the *same* base derive the same worker names — for Postgres and Redis alike. Per ratified D3 the answer is the one-run-at-a-time rule for whole invocations, not a per-run nonce; worktree agents are concurrent-safe for Postgres because their per-agent base URLs derive disjoint names (RBD-052-1), and their Redis exposure is governed by the same D3 rule and is no worse than today's everyone-on-database-0 status quo (noted in `clarifications-needed.md`, N-052-A).
- **Suites that name the database directly**: any suite or helper that hardcodes `collab_test_db` instead of going through the shared helper will silently target the wrong (base) database under parallel runs; the implementation must sweep for and fix such call sites.
- **Pub/sub inside one worker**: suites that assert real fan-out across a publisher and a subscriber client must keep passing — both clients sit in the same worker and therefore the same logical database (US2 scenario 2 guards this).
- **CI service bootstrap**: CI's Postgres service pre-creates the base database; the run must additionally be able to create the template and per-worker databases there (the service user can), and the pre-created base simply goes unused by tests.
- **First-parallel-run failure tail**: expected, bounded, and spec'd as suite bugs (US4 scenarios 6–7); the gate (five consecutive greens) cannot be satisfied until the tail is fixed, which is the mechanism that forces the fixes.

## Requirements *(mandatory)*

### Functional Requirements

**Per-worker database isolation (US1)**

- **FR-001**: Backend test global setup MUST create and fully migrate a single template database, then create one database per Jest worker from that template, dropping any stale per-worker copy first, before any test runs.
- **FR-002**: The shared test-database helper (`getTestDatabaseUrl()`) MUST derive the database name from the worker identity (`JEST_WORKER_ID`), such that distinct workers always resolve distinct databases and a `--runInBand` run resolves worker 1's database.
- **FR-003**: An externally supplied `DATABASE_URL` (CI, pipeline worktrees) MUST be honored as a **base** URL: the helper derives the per-worker name from it the same way as from the built-in default, preserving all other URL components. The existing worktree convention — per-agent isolation via a per-agent `DATABASE_URL` — MUST keep providing whole-run isolation under the new scheme (disjoint derived names per base; RBD-052-1).
- **FR-004**: No test suite may require changes to *its own* code to gain database isolation: isolation is delivered entirely by setup and the shared helper. (Suites found to bypass the helper are fixed to use it — see Edge Cases.)
- **FR-005**: A worker MUST never be handed a database whose schema does not match the current, fully migrated template state (stale copies are replaced; the template is never used mid-migration; RBD-052-5).

**Per-worker Redis isolation (US2)**

- **FR-006**: The server's Redis configuration MUST gain a logical-database setting (`REDIS_DB`) that defaults to logical database 0 and — when unset — leaves the constructed configuration byte-identical to the pre-feature configuration (the key absent, matching the precedent set by the existing password knob).
- **FR-007**: Test setup MUST assign each worker a Redis logical database derived from `JEST_WORKER_ID` (mapping per RBD-052-2), and **both** the shared Redis client and every dedicated pub/sub client MUST honor the assignment.
- **FR-008**: The run MUST fail fast with a clear error if the effective worker count exceeds the number of isolatable Redis logical databases (15 workers against 16 databases; RBD-052-3).

**Policy and documentation coherence (US3)**

- **FR-009**: Constitution Principle II's serial mandate MUST be replaced with the ratified design-2.3 text, verbatim: "Backend test runs MUST be isolated: each Jest worker (and each concurrent invocation) gets its own database and Redis logical database, derived from JEST_WORKER_ID. Two runs or workers MUST never share a database. Suites must not assume they own the only database; fixed-key rows stay scoped to the suite that creates them." The amendment follows the constitution's own Governance section (sole-maintainer commit to main, versioning rules).
- **FR-010**: The suite-cleanup convention in the shared DB helper MUST be retained, with its documentation rewritten to the new rationale: within-worker suite ordering still depends on it; the cross-suite orphan flake class is eliminated by construction and must no longer be cited as the live threat.
- **FR-011**: Remaining assertions of the old shared-database serial mandate in governing documents MUST be updated to be coherent with the amended Principle II (RBD-052-4). Four sites (enumerated per analyze M1, 2026-08-04): the constitution's Development Workflow gate wording; the `helpers/db.js` suite-cleanup convention comment; the pipeline skill's worktree test guidance (SKILL.md:64 area); and `docs/dev.md:372-375`'s serial-only paragraph.
- **FR-012**: The one-run-at-a-time rule for whole invocations MUST be kept as the answer to concurrent-invocation collisions; no per-run nonce is added to database names (ratified D3).

**Parallel default and verification gate (US4)**

- **FR-013**: The default backend test command MUST run Jest in parallel with `maxWorkers` at 50% of cores locally; the CI backend job MUST pass an explicit `maxWorkers` value sized to its runner (ratified D4).
- **FR-014**: `--runInBand` MUST remain a fully supported first-class mode (green suite, used for serial bisection), and the perf-guard suites stay in the default run (ratified D2).
- **FR-015**: The LLM-friendly reporter MUST remain the active reporter in both parallel and serial modes (constitution requirement); the script change must not drop or reorder it.
- **FR-016**: The serial default MUST NOT be dropped until the verification gate passes: five consecutive full parallel runs green locally, five consecutive green in CI, and a serial-vs-parallel pass-list diff showing no suite depends on execution mode.
- **FR-017**: Failures surfaced by first parallel runs that trace to cross-suite coupling MUST be fixed as bugs in the offending suites within this feature; reverting to serial execution is not an acceptable resolution.
- **FR-018**: Suites that become timing-flaky under parallel CPU contention MUST have their timing ceilings reviewed and adjusted; reducing the worker count is not an acceptable resolution.

### Key Entities

- **Template database**: a fully migrated, test-data-free database built once per run by global setup; the sole source per-worker databases are copied from. Never written to by tests.
- **Per-worker database**: a worker-exclusive copy of the template, named by deriving from the base database name plus the worker identity; dropped and recreated across runs; the only database a worker's suites ever touch.
- **Base database URL**: the connection URL the run starts from — the built-in local default, CI's explicit URL, or a worktree agent's per-agent URL — from which template and per-worker names are derived while credential/host/port/query components are preserved.
- **Worker identity**: Jest's `JEST_WORKER_ID` (1-based; always 1 under `--runInBand`), the single value from which both the database name and the Redis logical database are derived.
- **Redis logical database**: one of Redis's 16 numbered keyspaces; each worker is assigned one, shared by all of that worker's clients (shared and pub/sub) and by nothing else.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The full backend suite completes green in **30–50 seconds** on the 10-core dev pod at 6–8 workers (design Expected Outcomes; from ~175s serial after Train A — a further ~4–5x).
- **SC-002**: **Five consecutive** full parallel runs are green locally and five consecutive are green in CI before the serial default is dropped (design Verification; this is the gate, not an aspiration).
- **SC-003**: A serial run and a parallel run of the same tree produce **identical pass lists** (diff is empty) — no suite's outcome depends on execution mode.
- **SC-004**: With the Redis logical-database setting unset, the constructed Redis connection configuration is **byte-identical** to the pre-feature configuration — production and development behavior provably unchanged.
- **SC-005**: The shared-database flake class is eliminated by construction: rows created by one worker are unobservable from any other worker's database, so `reindexStale`-orphan and fixed-key-collision failures can no longer cross suites that run on different workers, and cannot cross runs at all (fresh-from-template).
- **SC-006**: `--runInBand` bisection still works end to end: a serial run is green and its reporter output format is unchanged.
- **SC-007**: All four FR-011 sites (the constitution, the DB-helper convention comment, the pipeline worktree guidance, and `docs/dev.md`) contain **zero** surviving claims of the old shared-database serial mandate. [Widened from three named sites per analyze M1, 2026-08-04.]

## Assumptions

- **Sequencing**: features 050 and 051 merge before 052's implementation begins; 051 will have split `.github/workflows/test.yml` into parallel backend and client jobs, and 052's CI edits (explicit `maxWorkers`, any service tweaks) land on that post-051 backend job. This spec is written against the design's post-051 shape, not the current single-job file.
- **Baseline**: the ~175s post-Train-A serial baseline and the 30–50s target are the design's measured/projected numbers on the 10-core dev pod; CI absolute times will differ, and SC-001 is judged on the dev pod.
- **Verified current-code facts this spec builds on** (checked 2026-08-04): `server/__tests__/helpers/db.js` currently returns `DATABASE_URL` verbatim when set (FR-003 changes this to base-URL semantics); `server/redis.js` has no logical-database knob and its password knob establishes the byte-identical-when-unset pattern FR-006 mirrors; `server/__tests__/globalSetup.js` creates and migrates only the single fixed `collab_test_db`; `package.json` `test:server` is `--runInBand` with `./script/jest-llm-reporter.js` as sole reporter; the pipeline skill instructs worktree agents to hand-create per-agent databases and export per-agent `DATABASE_URL` (kept working per FR-003; guidance text updated per FR-011).
- **Environment**: Redis is the stock configuration with 16 logical databases; the CI Postgres service user may create databases and use templates; the local/dev-pod Postgres user likewise. Template-copy database creation is fast relative to running migrations (Postgres `TEMPLATE` copy is a file-level copy).
- **Concurrency discipline**: the one-run-at-a-time rule for whole invocations (D3) is a kept operating rule, not enforced by mechanism; the pipeline merge queue is already serial, and worktree agents' Postgres isolation comes from per-agent base URLs.
- **Out of scope**: client (Vitest) and first-run suites (already parallel/fast; Trains A–B territory); moving perf guards out of the default run (D2 ratified: they stay); any per-run nonce scheme (D3 ratified: rejected); testcontainers or per-test transaction rollback (design 2.1 rejected both).
