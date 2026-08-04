# Contract: CI Interface Surface

**Feature**: 051-ci-parallel-jobs | **Date**: 2026-08-04 | **Plan**: [plan.md](./plan.md)

This feature exposes no HTTP API, no CLI, and no library surface. Its "interface" is the
contract between the CI workflow and the rest of the repository — the small set of names and
paths that other things (npm scripts, the local dev loop, and feature 052) rely on. This file
states those invariants so that a later change can tell, mechanically, whether it broke one.

Each contract below is stated as an assertion that must hold after implementation, with the
requirement it derives from and how to check it.

---

## C-1 — The npm-script indirection boundary (FR-002)

**Assertion**: The workflow invokes test runners **only** through the existing npm scripts. No
Jest, Vitest, or `node --test` flag appears anywhere in `.github/workflows/test.yml`.

The three permitted invocations, byte-for-byte:

| Job | Command |
| --- | --- |
| `backend` | `npm run test:server` |
| `client` | `npm run test:client` |
| `client` | `npm run test:first-run` |

**Why it is a contract, not a preference**: this is an explicit coordination constraint with
feature 052-parallel-test-isolation, which will change backend worker settings. Keeping the
invocation behind the npm script means 052's change lands in `package.json` (script or jest
config) and cannot collide with this feature's workflow edit.

**Check**: `grep -nE 'jest|vitest|node --test|maxWorkers|runInBand|--reporters?=' <(grep 'run:' .github/workflows/test.yml)`
returns nothing — the check is scoped to `run:` lines because the cache step's key and path
legitimately contain the token `jest` (`jest-cache-...`, `.jest-cache`). Any hit on a `run:`
line is a real violation. [Scoping applied post-merge 2026-08-04 per review LOW-2; the
original unscoped grep false-alarms on the cache step mandated by C-6.]

---

## C-2 — Reporter wiring is unreachable from the workflow (FR-004, Constitution)

**Assertion**: The LLM-friendly reporters stay attached to both suites, and they stay attached
*inside the npm scripts*, where the workflow cannot detach them.

| Suite | Reporter | Attached in |
| --- | --- | --- |
| Backend (Jest) | `script/jest-llm-reporter.js` | `scripts.test:server` in `package.json` |
| Client (Vitest) | `script/vitest-llm-reporter.mjs` | `scripts.test:client` in `package.json` |

**Why**: Constitution, Development Workflow — "Test output MUST stay LLM-friendly". C-1 makes
this structurally guaranteed rather than merely intended: since the workflow may not pass
runner flags, it has no way to override `--reporters`.

**Check**: `git diff HEAD -- package.json` shows no change to any `scripts.*` entry; only the
`jest.cacheDirectory` key is added.

---

## C-3 — Backend environment contract (FR-002)

**Assertion**: The `backend` job's test step provides exactly these three variables, with
exactly these values, and the job provides the two service containers backing them with
unchanged images, ports, and health checks.

```yaml
DATABASE_URL: postgresql://postgres:postgres@localhost:5432/collab_test_db
REDIS_HOST: localhost
REDIS_PORT: 6379
```

**Check**: diff the services block and the env block against
`git show HEAD:.github/workflows/test.yml`; only indentation and placement may differ.

---

## C-4 — The client job is service-free (FR-003, Constitution II)

**Assertion**: The `client` job declares no `services:` key and sets no `DATABASE_URL`,
`REDIS_HOST`, or `REDIS_PORT`.

**Why**: beyond FR-003, this is what makes the split safe under Constitution II ("backend tests
share one database and MUST run serially"). Two jobs run concurrently; only one of them has a
database, so concurrency cannot produce two runs against the same DB.

**Check**: `grep -n 'services:\|DATABASE_URL\|REDIS_' .github/workflows/test.yml` — every hit
must fall inside the `backend` job.

---

## C-5 — Three-way cache-path agreement (FR-006, FR-008)

**Assertion**: One directory, designated identically in three files.

| File | Form | Exact text |
| --- | --- | --- |
| `package.json` (`jest` block) | `<rootDir>`-relative | `"cacheDirectory": "<rootDir>/.jest-cache"` |
| `.github/workflows/test.yml` (cache step) | repo-relative | `path: .jest-cache` |
| `.gitignore` | ignore pattern | `.jest-cache/` |

**Why it is the feature's main failure mode**: each of the three files is independently valid
with a wrong path. A mismatch between the first two silently produces a permanently cold cache
(no error, just no speedup — SC-003 fails). A missing third entry produces a dirty working
tree on every local backend run (SC-005 fails). Neither breaks a test, so neither is caught by
the suites.

**Check**: `grep -rn '\.jest-cache' package.json .github/workflows/test.yml .gitignore` returns
exactly three hits (one per file), all agreeing on the path. [Escaped-dot form applied
post-merge 2026-08-04 per review LOW-2: the unescaped pattern also matches the cache KEY
lines (`jest-cache-${{ ... }}`), yielding five hits and a false alarm.]

---

## C-6 — Cache key contract (CN-051-02)

**Assertion**:

```yaml
key: jest-cache-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
restore-keys: |
  jest-cache-${{ runner.os }}-
```

`hashFiles` references the **root** lockfile only; `client/package-lock.json` must not appear.

**Check**: the cache step matches the above; `grep -c "client/package-lock.json" .github/workflows/test.yml` is 0.

---

## C-7 — Gating contract (FR-005)

**Assertion**: The workflow run for a push is successful only if both jobs succeed. This is
GitHub Actions' default job-aggregation behavior and must not be weakened.

Forbidden in either job: `continue-on-error: true`, `if: always()` on a test step, and any
`||`-swallowing of a non-zero exit in a `run:` block.

**Check**: `grep -n 'continue-on-error\|always()' .github/workflows/test.yml` returns nothing.

---

## C-8 — Scope contract (FR-009)

**Assertion**: The implementation diff touches exactly three tracked files:

```text
.github/workflows/test.yml
package.json
.gitignore
```

Plus, conditionally and only if the split falsified a documented claim, `README.md` (Principle
I — see the plan's Constitution Check). No file under `server/`, `client/`, `shared/`,
`script/`, `test/`, or `__tests__/` changes.

**Check**: `git status --short` / `git diff --stat HEAD` lists only those paths, and
`.jest-cache/` does not appear as untracked.

---

## C-9 — Coordination surface reserved for feature 052

**Assertion**: This feature leaves the following untouched so 052 can take them without a
merge conflict against this work:

| Surface | Owner | This feature's posture |
| --- | --- | --- |
| `scripts.test:server` (incl. `--runInBand`) | 052 | not modified |
| `jest.maxWorkers` (absent today) | 052 | not added |
| `DATABASE_URL` as a *base* URL that a helper suffixes per worker | 052 | value left exactly as-is; 052 reinterprets it |
| `jest.globalSetup` (`server/__tests__/globalSetup.js`) | 052 | not modified |
| `jest.cacheDirectory` | **this feature** | added here; 052 must not relocate it without updating all three C-5 sites |

**Note for 052**: the `backend` job is where an explicit CI `maxWorkers` (design D4) will
apply. Per C-1 it must arrive via the npm script or jest config, not as a workflow flag. If
052 later parallelizes backend workers, the `.jest-cache` directory is shared across workers by
design — Jest handles concurrent access to its own cache, so no change to C-5/C-6 is implied.

---

## Contract test summary

Every assertion above is checkable by reading three files; none requires running the suite.
The implementation task list turns C-1 … C-8 into a single verification pass, and `quickstart.md`
turns SC-001 … SC-005 into runnable validation.
