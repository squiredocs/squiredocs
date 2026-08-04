# Contract: Naming, Environment Knobs and Failure Modes

**Feature**: `052-parallel-test-isolation` | **Date**: 2026-08-04

This feature exposes no HTTP or MCP surface. Its contract is with **developers, pipeline agents and CI** — the environment variables they set, the names they can predict, the module exports suites rely on, and the errors they will see. Those are what break other people's workflows if they drift, so they are pinned here.

---

## 1. Environment variable contract

### Inputs (set by the caller)

| Variable | Read by | Meaning | Default |
|---|---|---|---|
| `DATABASE_URL` | `globalSetup`, `helpers/db.js` | **Base** URL. No longer used verbatim — a per-worker name is spliced into it. | built-in local default |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` | `helpers/db.js` | Components of the built-in default when `DATABASE_URL` is unset | `localhost` / `5432` / `$USER`\|`postgres` / *(none)* |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | `server/redis.js` | Unchanged | `localhost` / `6379` / *(absent)* |
| `JEST_MAX_WORKERS` | `package.json` `test:server` | When set, becomes `--maxWorkers=<value>`. CI's knob (D4). | unset ⇒ config default `50%` |

**Breaking-change notice for callers**: `DATABASE_URL` semantics change from "the database tests use" to "the base tests derive from". A caller that sets `DATABASE_URL=…/collab_test_db_042` now gets `collab_test_db_042_w1`, `…_w2`, … and `collab_test_db_042_template`, and the database it literally named goes unused. The pipeline's worktree convention (`createdb collab_test_db_<nnn>` + per-agent `DATABASE_URL`) keeps working unchanged and keeps providing whole-run isolation (FR-003) — the created database simply becomes the base rather than the target. CI's pre-created `POSTGRES_DB` behaves the same way.

### Outputs (set by the suite, for its own processes)

| Variable | Set by | Value | Purpose |
|---|---|---|---|
| `TEST_BASE_DATABASE_URL` | `globalSetup` | the frozen resolved base | Makes derivation idempotent; workers inherit it |
| `DATABASE_URL` | `setup.js` (per worker) | the worker's URL | Unconditionally overwritten, so raw-env readers are correct too |
| `REDIS_DB` | `setup.js` (per worker) | `String(workerId)` | Selects the worker's Redis logical database |

`REDIS_DB` is the one variable in this table that is also a **production-visible knob**. In production and development it is unset, and while unset the constructed `REDIS_CONFIG` has no `db` key at all — byte-identical to pre-feature (SC-004). An explicit `REDIS_DB=0` is honored (the string `'0'` is truthy), not silently dropped.

---

## 2. Name derivation contract

Given a base URL whose database name is `B` and a worker id `N`:

| Artifact | Name |
|---|---|
| Template database | `B_template` |
| Worker database | `B_wN` |
| Redis logical database | `N` |

Rules:

1. `B` MUST match `^[A-Za-z0-9_][A-Za-z0-9_$-]*$`; otherwise the run aborts (research R6).
2. Derived names are always interpolated into DDL **double-quoted**.
3. Derived URLs replace **only** the URL `pathname`; credentials, host, port, and query string are preserved byte-for-byte (INV-4).
4. Derivation always reads the frozen base, never a previously derived URL (INV-5), so `derive(derive(x)) === derive(x)`.
5. For the built-in default base (`collab_test_db`), the derived names are `collab_test_db_template` and `collab_test_db_w1…wN` — i.e. exactly the names design §2.1 spells out. The design's literals are the special case of this rule, not an exception to it.

---

## 3. Module export contract — `server/__tests__/helpers/db.js`

Suites depend on this module, so its surface is pinned.

**Unchanged (must keep working, same signature and semantics)**: `getDbConfig()`, `createPool()`, `createPersistence()`, `createTestUser(pool, email)`, `cleanupTestUser(pool, userId)`, `cleanupDocRows(pool, docGuid)`.

**Changed semantics, same signature**: `getTestDatabaseUrl()` — now returns the **worker-derived** URL rather than `DATABASE_URL` verbatim. Every existing caller wants exactly this, including `server/__tests__/telemetry-traces.test.js:41`, which passes the result into a spawned child's env.

**New exports**: `getBaseDatabaseUrl()`, `getWorkerDatabaseName(baseName, workerId)`, `getTemplateDatabaseName(baseName)`, `getWorkerId()`, `deriveDatabaseUrl(baseUrl, dbName)`.

**`TEST_DB_NAME`**: retained as an export for compatibility (it is the base name, not the name tests connect to). Its doc comment must say so explicitly, because the constant's meaning has narrowed and a stale reading of it is exactly how a suite would end up targeting the wrong database.

---

## 4. Command contract

| Command | Before | After |
|---|---|---|
| `npm run test:server` | serial, 1 worker | parallel, `maxWorkers` 50% (or `JEST_MAX_WORKERS`) |
| `npm run test:server -- --runInBand` | *(n/a)* | serial, worker 1 — first-class, must stay green (FR-014) |
| `npm run test:coverage` | serial | serial (keeps `--runInBand`) |
| `npm run test:server:watch` | already parallel | already parallel, now isolated |
| `npx jest <file>` | one shared DB | inherits the config default; isolated |

**Invariants across all of the above**: `./script/jest-llm-reporter.js` remains the active reporter for `test:server` in both modes, and `--forceExit` and `--silent` are preserved (FR-015). The flag order in the script must not be rearranged such that `--reporters=` is no longer last, because `docs/dev.md:361` documents that positional arguments landing after it are misparsed as custom reporters.

---

## 5. Failure-mode contract

Each of these MUST produce a specific, actionable message — never a hang, never a silent fallback.

| Condition | Behavior | Message must name |
|---|---|---|
| Effective workers > 15 | **Abort before any test runs** (FR-008, INV-10) | the requested count, the cap of 15, the reason (Redis has 16 logical DBs, DB 0 reserved), and the fix (`JEST_MAX_WORKERS` / `--maxWorkers`) |
| Base database name fails charset validation | Abort at resolution | the offending name and the accepted charset |
| Template migration fails twice (after self-heal rebuild) | Abort; re-raise the **original** error | the template name and the underlying migration error |
| `CREATE DATABASE … TEMPLATE` rejected — template in use | Abort with a wrapped error | the template name, that another connection holds it, and the one-run-at-a-time rule (D3) |
| `DROP DATABASE … WITH (FORCE)` on a worker copy fails | Abort with a wrapped error | the database name and the likely cause (leaked process from a crashed run) |
| `JEST_WORKER_ID` unset | **Not a failure** — worker 1 | *(silent; this is the serial path)* |

Postgres fails these immediately rather than hanging (`55006 object_in_use`), so the implementation wraps and re-raises; it does not add timeouts (research R5).

---

## 6. What this contract deliberately does not cover

- **Concurrent whole invocations against the same base.** Ratified D3 keeps the one-run-at-a-time operating rule; there is no mechanism, no nonce, and no lock. N-052-A records that Redis in particular has no per-agent analog to the per-agent `DATABASE_URL` base.
- **The non-Jest `test:first-run` suite.** `test/first-run/matrix-runner.mjs` reads `DATABASE_URL` directly and degrades gracefully when unset; it is not a Jest run, receives no worker-derived URL, and continues to see the unchanged base.
- **Client (Vitest) and first-run suites** — already parallel, Trains A–B territory, explicitly out of scope.
