# Phase 1 Data Model: CI Parallel Jobs and Warm Transform Cache

**Feature**: 051-ci-parallel-jobs | **Date**: 2026-08-04 | **Plan**: [plan.md](./plan.md)

This feature has **no domain entities**: it stores no user data, defines no database table,
and adds no migration. Nothing in `server/`, `client/`, or `shared/` changes.

What follows is the configuration model — the entities that exist in the CI/build
configuration, their fields, the relationships between them, and the invariants that must hold
across the three files that change. It exists so that the implementation and the later review
have one place to check "do these three files still agree?".

---

## Entity: Workflow

The single GitHub Actions workflow that gates every push.

| Field | Value | Changed? |
| --- | --- | --- |
| File | `.github/workflows/test.yml` | yes (restructured) |
| `name` | `Test` | no |
| Trigger | `on: push` with `branches: ['*']` | no (FR-001, spec Assumptions) |
| Jobs | `backend`, `client` | **yes** — was a single `test` job |
| Run conclusion | failure if **any** job fails | no (FR-005) |

**Invariants**
- W1. The trigger is byte-identical to today's.
- W2. Exactly two jobs, neither declaring `needs:` on the other (this is what makes them
  parallel — FR-001).
- W3. No `concurrency:` group, no `timeout-minutes`, no matrix (R7).

---

## Entity: Job

Two instances.

### Job `backend`

| Field | Value |
| --- | --- |
| `runs-on` | `ubuntu-latest` |
| `needs` | *(absent)* |
| Service containers | `postgres`, `redis` (see below) |
| Installs | root `npm ci` only |
| Caches | setup-node npm cache (`cache: 'npm'`) **and** the Jest transform cache entry |
| Test steps | one: `npm run test:server` |
| Step env | `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT` |

### Job `client`

| Field | Value |
| --- | --- |
| `runs-on` | `ubuntu-latest` |
| `needs` | *(absent)* |
| Service containers | **none** (FR-003) |
| Installs | root `npm ci`, then `cd client && npm ci` (CN-051-03, R2) |
| Caches | setup-node npm cache only |
| Test steps | two: `npm run test:client`, then `npm run test:first-run` |
| Step env | none |

**Invariants**
- J1. Each job runs `actions/checkout@v4` then `actions/setup-node@v4` with `node-version: '22'`
  and `cache: 'npm'` — same versions and settings as today (R6).
- J2. Neither job consumes an artifact produced by the other (FR-010). There is no
  `upload-artifact` / `download-artifact` pair anywhere in the workflow.
- J3. `backend` is the only job that may declare services or database/Redis environment
  values. `client` declaring either is a defect (FR-003) — and, per Constitution II, is what
  keeps the two jobs from ever sharing a database.
- J4. The union of test steps across both jobs is exactly `{test:server, test:client,
  test:first-run}` — the same three today's job runs, in the same invocation form (FR-004,
  SC-002).

---

## Entity: Service Container

Declared on `backend` only. Both are lifted from today's job unchanged — same images, same
env, same ports, same health-check options.

| Name | Image | Env | Ports | Health check |
| --- | --- | --- | --- | --- |
| `postgres` | `pgvector/pgvector:pg15` | `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=postgres`, `POSTGRES_DB=collab_test_db` | `5432:5432` | `pg_isready`, interval 10s, timeout 5s, retries 5 |
| `redis` | `redis:7` | *(none)* | `6379:6379` | `redis-cli ping`, interval 10s, timeout 5s, retries 5 |

**Invariants**
- S1. Images, env values, ports, and health-check parameters are unchanged from the pre-split
  job (FR-002). A diff of this block against `git show HEAD:.github/workflows/test.yml` must
  show only indentation/placement changes.
- S2. If a health check never passes, the `backend` job fails at startup rather than running
  the suite without services — unchanged failure mode, now scoped to one job (spec Edge Cases).

---

## Entity: Test Environment Contract

The three environment values the backend test step receives. Unchanged in name and value.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/collab_test_db` |
| `REDIS_HOST` | `localhost` |
| `REDIS_PORT` | `6379` |

**Invariants**
- E1. These are set on the *test step*, matching today's shape (not promoted to job-level env),
  so the diff stays minimal and 052's later edits have a stable anchor.
- E2. `test:server` already defaults `REDIS_HOST` to `localhost` internally; the explicit value
  is kept anyway because removing it would be an unrequested change (FR-002 names all three).

---

## Entity: Cache Directory

| Field | Value |
| --- | --- |
| Path (repo-relative) | `.jest-cache/` |
| Referenced in jest config as | `<rootDir>/.jest-cache` |
| Referenced in workflow `path:` as | `.jest-cache` |
| Referenced in `.gitignore` as | `.jest-cache/` |
| Producer / consumer | Jest 29.7.0 (writes and reads; re-transforms on content mismatch) |
| Prior value | `/tmp/jest_0` (Jest's OS-tmp default) |
| Typical size | ~543MB locally (design §1.3 measurement) |

**Invariants**
- C1. **Three-way agreement**: the jest config path, the workflow `path:`, and the `.gitignore`
  entry all designate the same directory. Changing one without the other two is the primary
  failure mode this feature can introduce (see `contracts/ci-contract.md`).
- C2. The directory is never committed. `git status` after a local backend run must be clean
  (FR-008, SC-005).
- C3. The directory is not inside `tmp/`, `coverage/`, `node_modules/`, or
  `.claude/worktrees/` (R4).

---

## Entity: Cache Entry (actions/cache)

| Field | Value |
| --- | --- |
| Action | `actions/cache@v4` |
| Scope | `backend` job only |
| `path` | `.jest-cache` |
| `key` | `jest-cache-${{ runner.os }}-${{ hashFiles('package-lock.json') }}` |
| `restore-keys` | `jest-cache-${{ runner.os }}-` |
| Position | after `setup-node`, before the test step |

**State transitions**

| Prior state | Restore outcome | Test run | Post-job save |
| --- | --- | --- | --- |
| No cache (first run ever, or evicted) | miss | cold, all transforms computed | saves under primary key |
| Same lockfile as a saved entry | exact hit | warm | skipped (key already exists) |
| Lockfile changed, prior entry exists | prefix hit via `restore-keys` | mostly warm | saves under the new primary key |
| Restored entry stale for some files | partial hit | Jest re-transforms the mismatched files | per rows above |

**Invariants**
- K1. **Correctness neutrality** (FR-007, US2 scenario 2): every row above must produce an
  identical pass/fail result and an identical executed-test set. Only duration differs.
- K2. The cache holds only derived Babel transform output from files checked out by the same
  run. No secret, no credential, no test result is cached.
- K3. The Jest cache entry is *additional to*, never a replacement for, the setup-node npm
  cache (FR-006, R6).

---

## Relationship summary

```text
Workflow (test.yml)
├── Job: backend                       ── needs ──▶ (nothing)
│   ├── Service: postgres (pgvector/pgvector:pg15)
│   ├── Service: redis (redis:7)
│   ├── Cache Entry ──── path ────▶ Cache Directory (.jest-cache/)
│   └── Step: npm run test:server ──▶ jest ──▶ Cache Directory
│                                      ▲
└── Job: client                        │ path configured by
    ├── Step: npm run test:client      │
    └── Step: npm run test:first-run   │
                                       │
package.json  jest.cacheDirectory ─────┘
.gitignore    .jest-cache/  ──── must designate the same directory
```

The only cross-file coupling in the whole feature is the dashed three-way agreement on
`.jest-cache` (C1). Everything else is self-contained within `test.yml`.
