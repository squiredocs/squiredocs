# Phase 0 Research: Parallel Test Isolation (Backend Suite)

**Feature**: `052-parallel-test-isolation` | **Date**: 2026-08-04 | **Plan**: [plan.md](./plan.md)

Every entry follows Decision / Rationale / Alternatives. All facts were verified against the working tree and `node_modules` on 2026-08-04; the verification command or file:line is given so a reviewer can re-check rather than trust.

There were **no unresolved `NEEDS CLARIFICATION` markers** entering Phase 0: the spec's five design silences were already ratified-by-default in `clarifications-needed.md` (RBD-052-1…5). This research resolves the *mechanism* questions those RBDs deliberately deferred to the plan (notably RBD-052-5), plus the technical unknowns the plan itself raised.

---

## R1 — Worker count comes from `globalConfig.maxWorkers`, not from re-deriving it

**Decision**: `globalSetup` reads its first argument's `maxWorkers` field to learn how many per-worker databases to create, and uses that same number for the Redis 15-worker fail-fast check.

**Rationale**: Jest invokes the hook as `await globalModule(globalConfig, projectConfig)` (`node_modules/@jest/core/build/runGlobalHook.js:109`), and `maxWorkers` on that object is already a resolved integer — `normalize.js:1102` calls `getMaxWorkers(argv, options)` during config normalization. Reading it means the setup can never disagree with the runner about the worker count, which is precisely the failure mode that would hand a worker a database that was never created.

The resolution order in `node_modules/jest-config/build/getMaxWorkers.js` is decisive for this feature and was read in full:

| Input | Result |
|---|---|
| `--runInBand` | `1` — **wins over everything**, including a config `maxWorkers` |
| CLI `--maxWorkers=N` or `N%` | that value (percent resolved against `os.availableParallelism()`) |
| config-file `maxWorkers` (i.e. the `"jest"` block in `package.json`) | that value |
| nothing | `numCpus - 1` (or `floor(numCpus/2)` in watch mode) |

Two consequences the plan depends on: (a) `"maxWorkers": "50%"` **is** honored from the `package.json` jest block — it is not CLI-only; (b) `--runInBand` short-circuits before the config is consulted, so serial mode stays exactly 1 worker with no extra guard needed.

**Alternatives considered**:
- *Re-derive from `os.availableParallelism()` in globalSetup* — rejected: duplicates Jest's own precedence rules, and silently drifts the moment someone passes `--maxWorkers` on the CLI.
- *Always create 15 databases* — rejected: pays 15 template copies on every serial run for no benefit.
- *Create databases lazily, per worker, on first use* — rejected: turns one serialized provisioning step into N racing `CREATE DATABASE … TEMPLATE` calls against the same template, which Postgres rejects when the template has active connections. This is the same race RBD-052-1 removed at the invocation level; re-introducing it at the worker level would be a regression.

---

## R2 — `JEST_WORKER_ID` is absent in the in-band main process; default to 1

**Decision**: worker identity is `Number(process.env.JEST_WORKER_ID || 1)`, and the `|| 1` is load-bearing, not defensive padding.

**Rationale**: `JEST_WORKER_ID` is injected by `jest-worker` only when it spawns a child — `node_modules/jest-worker/build/workers/ChildProcessWorker.js:133` (`String(this._options.workerId + 1)`, 0-indexed → 1-indexed) and the threads equivalent at `NodeThreadsWorker.js:120`. Nothing sets it in the parent process. So:

- `--runInBand` runs entirely in the main process ⇒ `JEST_WORKER_ID` undefined ⇒ worker 1. Exactly the semantics the design and FR-002 specify.
- Jest's `shouldRunInBand` heuristic (`@jest/core/build/testSchedulerHelper.js`) can *also* elect to run in the main process even when `maxWorkers > 1` (few/fast test files). That path likewise sees no `JEST_WORKER_ID` and lands on worker 1's database — which `globalSetup` always creates, since `maxWorkers >= 1`. No special case needed.

A repo-wide sweep confirmed `JEST_WORKER_ID` currently appears in **zero** lines of code, config or CI — this feature introduces the first use, so there is no existing convention to conflict with.

**Alternatives considered**: *throw when `JEST_WORKER_ID` is unset* — rejected outright; it would break `--runInBand`, which FR-014 makes first-class.

---

## R3 — Base-URL semantics via a frozen `TEST_BASE_DATABASE_URL`

**Decision**: `globalSetup` resolves the base URL once and publishes it as `process.env.TEST_BASE_DATABASE_URL`. `helpers/db.js` resolves its base as `TEST_BASE_DATABASE_URL ?? DATABASE_URL ?? <built-in default>` and derives the worker name from that. `setup.js` then pins `process.env.DATABASE_URL` to the **worker's** URL, unconditionally.

**Rationale**: this is the design's "explicit `DATABASE_URL` becomes a base URL the helper suffixes the same way" (§2.1) made idempotent. Without the frozen base, the derivation eats its own output: `setup.js` sets `DATABASE_URL` to `…_w3`, the next `getTestDatabaseUrl()` call reads it as a base, and derives `…_w3_w3`. Precedence-ordering the frozen base first makes the function a pure projection of an immutable input, so it can be called any number of times.

`globalSetup` mutations to `process.env` propagate to workers. **Verified in source, not assumed** — this is load-bearing enough that reasoning was not sufficient:

- `node_modules/@jest/core/build/runJest.js:327` awaits the `globalSetup` hook; `:367` calls `scheduler.scheduleTests(...)`, which is what creates workers. So globalSetup completes strictly before any worker exists.
- `node_modules/jest-worker/build/workers/ChildProcessWorker.js:130–136` builds each child's environment as `env: { ...process.env, JEST_WORKER_ID: … }` **at spawn time**, not from a snapshot captured at module load.

Therefore a variable set during globalSetup is present in every worker. This is also the same mechanism the existing code already relies on when it passes `env: { ...process.env, DATABASE_URL: testDbUrl }` to the migration subprocess (`globalSetup.js:37`).

Pinning `DATABASE_URL` **unconditionally** (today `setup.js` guards with `if (!process.env.DATABASE_URL)`) is what makes the isolation total rather than partial: any module that reads `process.env.DATABASE_URL` directly — rather than going through the helper — becomes correct for free. That set is not empty: `server/__tests__/helpers/otel-e2e-child.js:42` builds its pool straight from the env var in a spawned child process. Under today's CI, where `DATABASE_URL` is set, the existing guard means such consumers get the *base* database, which under parallel execution would be the unmigrated leftover.

**Alternatives considered**:
- *Keep `DATABASE_URL` as the base and add a separate `TEST_WORKER_DATABASE_URL`* — rejected: leaves every raw `process.env.DATABASE_URL` reader silently pointed at the shared base, i.e. exactly the "suites that name the database directly" hazard in the spec's Edge Cases, only harder to grep for.
- *Rewrite every consumer to call the helper* — rejected: violates FR-004's spirit (isolation delivered by setup + helper, not by touching consumers) and is unbounded work.

---

## R4 — Template freshness: migrate-forward, self-heal on failure, then fail loudly (resolves RBD-052-5)

**Decision**: three-step template lifecycle in `globalSetup`:

1. Create `<base>_template` if absent, then run `npm run migrate` against it (migrate-forward — today's behavior, preserved).
2. If migration fails for any reason, **drop the template and rebuild it from scratch once**, then migrate again.
3. If the rebuild also fails, abort the run with the original error. Never proceed to copy from a template whose migration did not complete.

**Rationale**: RBD-052-5 fixed the *invariant* (FR-005: a worker never receives a database at the wrong schema state) and explicitly left the *mechanism* to this phase as a run-time-versus-determinism trade. The measured shape of that trade:

- Migrate-forward is the cheap common path and is what the suite does today, so it inherits all existing behavior — including the two phantom-`pgmigrations` guards in `script/migrate.js` (`:15–27` duplicate-row dedupe, `:29–45` the rolled-back-008 orphan row). Those guards run wherever `npm run migrate` runs, so the template gets them automatically; this is the `rolledback-008-migration-cruft` hazard already handled, not a new one.
- Drop-and-rebuild every run is maximally deterministic but pays a full migration on every invocation, including the ordinary green one.
- The failure cases RBD-052-5 named — a template from a run on an older branch, or a crash mid-migration — both surface as a *loud migration error*, not as silent corruption: `node-pg-migrate`'s `checkOrder` throws when the recorded run-list and the on-disk migration list disagree. That makes step 2 a reliable trigger rather than a guess.

So the hybrid gets the cheap path's speed, converts the two named hazards into automatic self-healing, and still refuses to hand out a half-migrated template.

Copies are then taken with `CREATE DATABASE "<base>_wN" TEMPLATE "<base>_template"`, which is a file-level copy and fast relative to running migrations (spec Assumptions).

**Alternatives considered**:
- *Migrate-forward only (today's behavior extended)* — rejected: a template left mid-migration by a crash would be copied into all N worker databases and fail all 254 suites at once, which is the exact scenario RBD-052-5 was raised to prevent.
- *Drop-and-rebuild unconditionally* — rejected as the default (cost on every run), but note it is the fallback in step 2, so its determinism is available exactly when it is needed.
- *Checksum the migration directory against `pgmigrations` to decide* — rejected: reimplements `checkOrder` less well than `node-pg-migrate` already does.

---

## R5 — Stale worker copies are dropped with `WITH (FORCE)`; the template is not

**Decision**: per-worker databases are dropped with `DROP DATABASE IF EXISTS "<name>" WITH (FORCE)` before recreation. The **template** is dropped without `FORCE` (only in the R4 step-2 self-heal), and any failure there is surfaced with a diagnostic naming the connection holders.

**Rationale**: the two cases are genuinely different and the spec treats them differently.

- A stale `_wN` copy belongs to *us*, from a previous run of *this* suite; a leftover connection to it means a leaked process from a crashed run. Forcing the drop is decisive and correct, and prevents a zombie from wedging every subsequent run. `WITH (FORCE)` requires PostgreSQL 13+; verified available — CI runs `pgvector/pgvector:pg15` (`.github/workflows/test.yml:13`) and the local client is 15.18.
- The template is the run's shared root. If something holds a connection to it, forcing is not obviously safe, and the spec's Edge Cases are explicit: "Dropping a database that something still holds connections to must fail loudly, not hang silently."

Worth recording because it is a common misconception: plain `DROP DATABASE` and `CREATE DATABASE … TEMPLATE` **do not hang** when a connection exists — they fail immediately (`55006 object_in_use` / "source database is being accessed by other users"). So "fail loudly" is Postgres's default behavior; the implementation's job is to catch that error and re-raise it with a message that names the database and suggests the check, rather than to invent a timeout.

**Alternatives considered**:
- *`pg_terminate_backend` on the template's connections before copying* — rejected: silently kills whatever else was connected, which is precisely the "silently share / silently fix" failure class RBD-052-3 rejected elsewhere.
- *No `FORCE` anywhere* — rejected: a single leaked worker process would wedge every subsequent run with no self-service recovery.

---

## R6 — Derived names are validated and identifier-quoted before interpolation

**Decision**: derive `<base_dbname>_template` and `<base_dbname>_w<N>` (RBD-052-1), validate the base name against `^[A-Za-z0-9_][A-Za-z0-9_$-]*$`, reject anything else with a clear error, and always interpolate the result **double-quoted** into DDL.

**Rationale**: today's `CREATE DATABASE ${TEST_DB_NAME}` (`globalSetup.js:19`) interpolates a module constant, so unquoted is harmless. This feature makes the name a function of `DATABASE_URL`, i.e. of the environment — and the pipeline's worktree convention actively supplies custom bases (`collab_test_db_<nnn>`). Quoting is also functionally necessary, not just hygienic: a per-agent base containing a hyphen (`collab_test_db_agent-1`) is an invalid unquoted identifier and would fail with a confusing syntax error. Constitution Principle V applies even to test-only code paths.

**Alternatives considered**: *quote without validating* — rejected: quoting alone still admits an embedded `"` and produces baffling errors; a positive charset check gives an actionable message at the point of misconfiguration.

---

## R7 — URL splicing preserves credentials, port and query string

**Decision**: parse with `new URL(base)`, replace only `pathname` with `/<derivedName>`, and re-serialize. The admin URL (for `CREATE`/`DROP`) is the same object with `pathname = '/postgres'`.

**Rationale**: FR-003 and the spec's Edge Cases require preserving user, password, host, port and query string — CI's URL carries credentials (`postgresql://postgres:postgres@localhost:5432/collab_test_db`, `.github/workflows/test.yml:55`) and a worktree agent's may carry parameters. `new URL` handles `postgresql://` fine (it is a generic URL scheme in WHATWG parsing), keeps percent-encoded passwords intact, and — unlike the current regex approach — cannot mis-fire.

This also fixes a **live latent bug** the sweep surfaced: `globalSetup.js:14–19` probes and creates the constant `TEST_DB_NAME` while `:37` migrates whatever `DATABASE_URL` names. Under a custom `DATABASE_URL` the two disagree — already documented at `specs/040-restore-undo-attribution/merge-notes.md:302–303`. Basing everything on one parsed URL retires the bug rather than porting it forward.

**Alternatives considered**: *keep the existing regex `testDbUrl.replace(/\/[^/?]+([?#].*)?$/, '/postgres$1')`* — rejected: it is the source of the bug above and mishandles URLs whose path is absent or whose query contains a `/`.

---

## R8 — `REDIS_DB` mirrors the `REDIS_PASSWORD` pattern exactly; CI override rides an env var

**Decision (knob)**: add one conditional-spread entry to `REDIS_CONFIG` in `server/redis.js`, immediately after the password entry:

- present-and-parsed when `REDIS_DB` is set, key entirely **absent** when it is not.
- `'0'` is a non-empty string and therefore truthy in JS, so an explicit `REDIS_DB=0` is honored rather than silently dropped — the pattern needs no special-casing, but the behavior is asserted by a test so nobody "fixes" it into `Number(...)` truthiness and breaks it.

Both `new Redis(REDIS_CONFIG)` sites — the shared singleton (`server/redis.js:32`) and the pub/sub factory (`:98`) — read the same object literal, so US2 scenario 2 (all of a worker's clients on one logical database) holds by construction with no further plumbing. Verified: those are the only two Redis construction sites in server code; there is no `y-redis`, no BullMQ, no connect-redis session store, and no `.duplicate()` anywhere.

**Decision (assignment)**: `server/__tests__/setup.js` sets `process.env.REDIS_DB = String(workerId)` (RBD-052-2: worker N → logical DB N; tests never touch DB 0). `setup.js` is `setupFilesAfterEnv`, which runs before the test file is loaded, and `REDIS_CONFIG` is built at `require`-time of `server/redis.js` — which happens when the test file requires it. So the ordering is correct as-is; no new `setupFiles` entry is needed.

**Decision (CI worker count)**: `test:server` gains `${JEST_MAX_WORKERS:+--maxWorkers=$JEST_MAX_WORKERS}`, so the config-block default (50%) applies when the variable is unset and an explicit count applies when it is set. CI then supplies `JEST_MAX_WORKERS: <n>` as one entry in the backend job's **existing** `env:` block.

**Rationale**: N-052-B requires 052's CI edit to be minimal and rebase-safe against 051, which is rewriting `.github/workflows/test.yml` concurrently. The backend job invokes `npm run test:server` with no arguments; an env var means 052 never touches the `run:` line, the services, or the job structure — the entire CI delta is one line in a block 051 will have already created. It also satisfies D4 literally (percentage locally, explicit count in CI).

**Alternatives considered**:
- *`npm run test:server -- --maxWorkers=4` in CI* — rejected: edits the `run:` line 051 owns (rebase friction), and `docs/dev.md:361` already documents that argument pass-through to this script is fragile because the positional lands after `--reporters=`.
- *A separate `test:server:ci` script* — rejected: two scripts drift, and CI would stop exercising the command developers actually run.
- *`keyPrefix` instead of a logical database* — rejected: it is not what the design ratified (§2.2 says `REDIS_DB`), and `keyPrefix` does not isolate pub/sub channel names in ioredis, so it would not deliver US2 scenario 3 at all.

---

## R9 — The coherence sweep covers four sites, not two (extends RBD-052-4)

**Decision**: the amendment commit updates **four** surviving assertions of the old serial mandate, not the two the spec enumerated.

| # | Site | Current text | In FR-011? |
|---|---|---|---|
| 1 | `.specify/memory/constitution.md` Development Workflow gate | "affected tests pass (serially for backend)" | yes |
| 2 | `.claude/skills/the-pipeline/SKILL.md:64` | "Within one DB, backend tests are serial-only (`--runInBand` is already wired in; don't defeat it)" | yes |
| 3 | `.claude/skills/the-pipeline/SKILL.md:46` | merge-queue step: "backend is serial-only — never overlap another backend run on the same DB" | **no — found by sweep** |
| 4 | `docs/dev.md:372–375` | "Backend tests are serial-only against one database — never run two suites concurrently against the same `DATABASE_URL`…" | **no — found by sweep** |

Site 3 deserves care rather than deletion: its *second* clause ("never overlap another backend run on the same DB") remains **true** under ratified D3, which keeps the one-run-at-a-time rule for whole invocations. Only the "serial-only" framing is falsified. Site 4 is the same shape — its per-worktree-database advice survives verbatim; its serial-only sentence does not.

Two further sites were checked and need **no** edit: `ReadMe.md` (swept — asserts nothing about serial backend execution) and the ~15 historical `specs/0NN/**` files that mention `--runInBand`, which are completed-feature records, not governing text.

**Rationale**: RBD-052-4 already ratified the *principle* — "the same commit that amends Principle II updates the secondary references" — on the grounds that stale governing text is a defect under Principle I. It enumerated the two sites its author had found. Applying that ratified principle to the complete set is a mechanical consequence, not a new decision; but per Principle VI it is recorded here rather than silently widened. Leaving sites 3–4 would have the pipeline skill instructing every implementer agent to defeat the new default, which is the precise failure RBD-052-4 exists to prevent.

**Alternatives considered**: *restrict to the two enumerated sites and file the rest as follow-on* — rejected: it would ship a constitution that contradicts the skill agents actually read, and SC-007 demands **zero** surviving claims.

---

## R10 — 50% of cores is 5 workers here, not the design table's "6–8"

**Decision**: implement D4 as ratified (`maxWorkers: "50%"` locally) and measure SC-001's 30–50 s band at whatever worker count that yields. Do not tune the percentage to hit "6–8".

**Rationale**: measured on the reference machine — `os.availableParallelism() === 10`, and `getMaxWorkers`'s percent branch computes `Math.floor(0.5 * 10) = 5`. So the ratified knob yields **5** workers on the 10-core dev pod, while the design's Expected Outcomes table labels its 30–50 s row "(6-8 workers)" and SC-001 repeats that label.

These are two different kinds of statement and the design says so itself: "The table totals are reference-machine expectations (the 10-core dev pod), not merge gates; the gates are the per-defect criteria in Verification." D4 is a ratified decision; the worker-count parenthetical is an illustrative projection. Where they disagree, the ratified decision governs — and the Verification section's gates (five green runs, empty pass-list diff) contain no worker-count term at all.

Practical consequence to watch during Phase D: if 5 workers land outside the 30–50 s band, that is a measurement to report to Sam alongside the timing at other counts — **not** licence to change the percentage unilaterally, and not a reason to lower the worker count (FR-018 forbids that as a flake remedy). A one-line change from `50%` to a higher percentage is a D4 amendment, which is Sam's call.

**Alternatives considered**:
- *Set `"maxWorkers": "75%"` to reach 7 workers and match the table* — rejected: overrides a ratified decision on the strength of a parenthetical.
- *Silently treat SC-001 as unmeasurable* — rejected: the band is the feature's headline outcome; it gets measured and reported either way.

---

## Resolved unknowns summary

| Unknown entering Phase 0 | Resolved by | Answer |
|---|---|---|
| How does setup learn the worker count? | R1 | `globalConfig.maxWorkers`, pre-resolved by Jest |
| What is `JEST_WORKER_ID` under `--runInBand`? | R2 | Unset; default to 1 |
| How is base-URL derivation kept idempotent? | R3 | Frozen `TEST_BASE_DATABASE_URL` published by globalSetup |
| Template refresh mechanics (RBD-052-5 deferral) | R4 | Migrate-forward → self-heal rebuild → fail loudly |
| Drop semantics for stale databases | R5 | `WITH (FORCE)` for worker copies; loud failure for the template |
| Are derived DDL identifiers safe? | R6 | Validate charset + always double-quote |
| How to splice names into a credentialed URL? | R7 | `new URL`, replace `pathname` only |
| Where does `REDIS_DB` go, and how does CI set workers? | R8 | Conditional spread in `REDIS_CONFIG`; `JEST_MAX_WORKERS` env var |
| How many docs assert the old serial mandate? | R9 | Four, not two |
| Does 50% give the design's 6–8 workers? | R10 | No — 5 on the 10-core pod; ratified knob wins |
