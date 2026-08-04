# Phase 1 Data Model: Parallel Test Isolation (Backend Suite)

**Feature**: `052-parallel-test-isolation` | **Date**: 2026-08-04 | **Plan**: [plan.md](./plan.md)

This feature adds no schema, no table and no migration. Its "data model" is a **naming and derivation model**: the set of runtime identities a run computes, the rules that relate them, and the invariants that must hold between them. Those are the things tests can assert, so they are modelled here as first-class entities.

---

## Entities

### 1. Base Database URL

The connection URL a run starts from. Everything else is derived from it.

| Field | Source | Notes |
|---|---|---|
| `raw` | `TEST_BASE_DATABASE_URL` → `DATABASE_URL` → built-in default | First non-empty wins (research R3) |
| `dbName` | `new URL(raw).pathname` minus the leading `/` | The **base name**; all derivation keys off this |
| `credentials`, `host`, `port`, `query` | the rest of the parsed URL | Preserved verbatim in every derived URL (FR-003) |

Built-in default (unchanged from today): `postgresql://<auth>@<DB_HOST|localhost>:<DB_PORT|5432>/collab_test_db`, where `<auth>` is `user` or `user:password`.

**Validation**: `dbName` MUST match `^[A-Za-z0-9_][A-Za-z0-9_$-]*$`. A base that fails validation aborts the run with a message naming the offending value and the accepted charset (research R6).

**Immutability**: once `globalSetup` resolves it, the base is frozen into `TEST_BASE_DATABASE_URL` and is never re-derived from a mutated `DATABASE_URL`. This is what makes derivation idempotent.

---

### 2. Worker Identity

| Field | Value |
|---|---|
| `workerId` | `Number(process.env.JEST_WORKER_ID \|\| 1)` |
| Range | `1 … maxWorkers`, capped at 15 |
| Serial case | `--runInBand` ⇒ variable unset ⇒ `1` (research R2) |

`workerId` is the **single** value from which both the database name and the Redis logical database are derived. There is no second identity source, and deliberately so: one derivation input means the two isolations can never disagree about which worker they belong to.

---

### 3. Template Database

| Field | Value |
|---|---|
| `name` | `<dbName>_template` (RBD-052-1: derived per base, not a global literal) |
| Lifetime | Created/refreshed once per invocation by `globalSetup`; survives between runs |
| Contents | Fully migrated schema, **zero** test data |
| Written by | `script/migrate.js` only. Never by a test. |
| Read by | `CREATE DATABASE … TEMPLATE` copies only |

**State machine**:

```
absent ──create──▶ created ──migrate──▶ ready ──(copied N times)──▶ ready
                      │                   ▲
                      │ migrate fails     │ migrate succeeds
                      ▼                   │
                  dropped ──recreate──────┘        (self-heal, once)
                      │
                      │ second migrate fails
                      ▼
                  ABORT RUN (original error re-raised)
```

Resolves RBD-052-5: the invariant is that a copy is only ever taken from the `ready` state (research R4).

---

### 4. Per-Worker Database

| Field | Value |
|---|---|
| `name` | `<dbName>_w<workerId>` |
| `url` | base URL with `pathname` replaced by `/<name>` |
| Lifetime | Dropped (`WITH (FORCE)`) and recreated from the template at every run start |
| Owner | Exactly one worker, for the duration of one invocation |
| Teardown | **None** — deliberately left in place after the run (see below) |

**No `globalTeardown` is added.** Leaving the databases behind is the design choice, for two reasons: a failed run's state stays inspectable for post-mortem debugging, and correctness does not depend on cleanup succeeding — the next run drops and recreates unconditionally, so a crash mid-teardown could never leave a stale database in play. Disk cost is bounded (schema-only copies, at most `maxWorkers` of them per base).

---

### 5. Redis Logical Database

| Field | Value |
|---|---|
| `db` | `workerId` verbatim — worker 1 → DB 1, … worker 15 → DB 15 (RBD-052-2) |
| DB 0 | Reserved for non-test consumers (dev server, Minikube's shared Redis). Tests never use it. |
| Carrier | `process.env.REDIS_DB`, read at `require`-time into `REDIS_CONFIG` |
| Scope | Every client the worker opens — shared singleton and every pub/sub client |
| Cap | 16 logical databases − DB 0 = **15 workers** |

---

## Relationships

```
Base Database URL  ──derives──▶  Template Database        (<dbName>_template)
        │                               │
        │                               │ CREATE DATABASE … TEMPLATE
        │                               ▼
        └──derives──▶  Per-Worker Database × maxWorkers    (<dbName>_w1 … _wN)
                                        ▲
                        Worker Identity ─┘
                                        │
                                        └──derives──▶  Redis Logical Database (db = workerId)
```

Two invocations with **different** bases produce two entirely disjoint families — different template, different worker databases. This is what makes concurrent pipeline worktree agents safe on the Postgres side (RBD-052-1) and why the template name could not be a global literal.

Two invocations with the **same** base produce colliding families, for Postgres *and* Redis alike. Ratified D3 answers this with the one-run-at-a-time operating rule rather than a per-run nonce; N-052-A records that Redis has no per-agent analog.

---

## Invariants

| ID | Invariant | Enforced by | Traces to |
|---|---|---|---|
| **INV-1** | Distinct workers always resolve distinct databases | name includes `workerId` | FR-002 |
| **INV-2** | `--runInBand` resolves worker 1 for both Postgres and Redis | `\|\| 1` default | FR-002, FR-014 |
| **INV-3** | A worker's database schema always equals the current migrated template | template `ready` gate + unconditional drop/recreate | FR-001, FR-005 |
| **INV-4** | Derived URLs preserve credentials, host, port and query | `new URL`, `pathname` replaced only | FR-003 |
| **INV-5** | Derivation is idempotent — deriving from an already-derived URL is impossible | frozen `TEST_BASE_DATABASE_URL` precedence | FR-003 |
| **INV-6** | Distinct bases yield disjoint {template, worker} families | template name derived per base | FR-003, RBD-052-1 |
| **INV-7** | With `REDIS_DB` unset, `REDIS_CONFIG` is byte-identical to pre-feature | conditional spread; key absent | FR-006, SC-004 |
| **INV-8** | All of a worker's Redis clients share one logical database | both `new Redis` sites read one config object | FR-007 |
| **INV-9** | Tests never touch Redis DB 0 | mapping starts at 1 | RBD-052-2 |
| **INV-10** | A run with > 15 workers aborts before any test executes | `globalSetup` cap check | FR-008 |
| **INV-11** | Every identifier interpolated into DDL is charset-validated and double-quoted | derivation helper | Principle V, research R6 |
| **INV-12** | No test suite changes its own code to gain isolation | delivered by `globalSetup` + `setup.js` + helper | FR-004 |

---

## Retained convention (not an entity, but governed here)

The suite-cleanup convention `cleanupDocRows(pool, docGuid)` in `server/__tests__/helpers/db.js` **stays** (FR-010). What changes is only its documented rationale:

- **Was**: the shared serial database means orphaned `yjs_updates` rows outlive their suite and surface as `reindexStale` failures in unrelated suites.
- **Becomes**: within one worker, suites still run sequentially against one database, so a suite that leaves rows behind can still disturb a later suite **on the same worker**. That is the convention's remaining job. The cross-suite orphan flake class between *different* workers is eliminated by construction, and cross-*run* accumulation is eliminated entirely by fresh-from-template creation — neither may still be cited as the live threat.
