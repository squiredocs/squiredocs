# Quickstart: Validating the CI Split and the Warm Cache

**Feature**: 051-ci-parallel-jobs | **Date**: 2026-08-04 | **Plan**: [plan.md](./plan.md)

How to prove this feature works. Split into what can be checked **before** the commit (local,
cheap, catches every failure mode that would otherwise surface as a broken workflow) and what
can only be checked **after** the push (the CI run itself is the deployment — spec Edge Cases).

Prerequisites: the Minikube `app-dev` pod (see `docs/dev.md`), and for the post-push half, the
GitHub Actions run list for the pushed branch.

---

## Part A — Before committing (local)

### A1. The workflow file is valid YAML with the expected shape

```bash
node -e "const y=require('js-yaml'),f=require('fs');const w=y.load(f.readFileSync('.github/workflows/test.yml','utf8'));const j=Object.keys(w.jobs);console.log('jobs:',j);console.log('needs:',j.map(k=>k+'='+JSON.stringify(w.jobs[k].needs||null)).join(' '));console.log('services:',j.map(k=>k+'='+Object.keys(w.jobs[k].services||{}).join(',')).join(' '));"
```

Expected: `jobs: [ 'backend', 'client' ]`, both `needs=null`, `backend` has
`postgres,redis`, `client` has none.

`js-yaml` is already a root dependency, so no install is needed. This matters more than it
looks: a YAML error would otherwise show up as a workflow that never starts, on the very push
that introduces it.

### A2. The contract checks (all of `contracts/ci-contract.md`)

```bash
# C-1: no runner flags in the workflow
grep -nE 'jest|vitest|node --test|maxWorkers|runInBand|--reporters?=' .github/workflows/test.yml || echo "C-1 OK"

# C-4: every services/DB/Redis mention lives in the backend job
grep -n 'services:\|DATABASE_URL\|REDIS_' .github/workflows/test.yml

# C-5: exactly three cache-path references, all agreeing
grep -rn 'jest-cache' package.json .github/workflows/test.yml .gitignore

# C-6: client lockfile is not in the cache key
grep -c 'client/package-lock.json' .github/workflows/test.yml   # expect 0

# C-7: nothing swallows a failure
grep -n 'continue-on-error\|always()' .github/workflows/test.yml || echo "C-7 OK"

# C-2 + C-8: package.json changed in exactly one key; scope is three files
git diff HEAD -- package.json
git diff --stat HEAD
```

### A3. Jest actually resolves the new cache directory (SC-005, C-5)

```bash
npx jest --showConfig 2>/dev/null | grep -i cacheDirectory
```

Expected: an absolute path ending in `/local-dev/.jest-cache` — **not** `/tmp/jest_0`. If it
still shows the tmp default, the `package.json` edit did not take effect and the CI cache step
would silently cache an empty directory forever.

### A4. A local backend run is unchanged and leaves the tree clean (US3, SC-005)

```bash
rm -rf .jest-cache
npm run test:server 2>&1 | tail -20
ls -d .jest-cache && du -sh .jest-cache
git status --short
```

Expected: the same reporter output shape and the same pass/fail result as before the change;
`.jest-cache/` exists and is populated; **`git status --short` shows no `.jest-cache` entry**
(FR-008). Seeing `?? .jest-cache/` means the `.gitignore` line is missing or misspelled.

### A5. Local warm-cache sanity (previews SC-003)

```bash
time npm run test:server >/dev/null 2>&1   # second run, cache now warm
```

Expected: faster startup than the cold run in A4, same result. This is indicative only — the
authoritative SC-003 measurement is two CI runs (B3).

### A6. Executed-test parity (SC-002)

Capture the suite inventory before and after; they must be identical.

```bash
npm run test:client 2>&1 | tail -5
npm run test:first-run 2>&1 | tail -5
```

Since no npm script changed, parity is structural — but record the totals (backend 4574,
client 936, first-run 31 per the design's measurement) so the post-push comparison in B2 has
a baseline.

---

## Part B — After pushing (CI)

### B1. Two jobs, running concurrently (US1, FR-001, SC-001)

Open the workflow run for the push. Expected:

- Two jobs listed: `backend` and `client`.
- Their start times are within seconds of each other — neither waits for the other.
- Post-install wall time for the run ≈ the `backend` job's own duration.

Record the number against the **current** backend baseline, not the design table's `~180s`:
that figure assumes feature 050 has landed (gap G-051-A in the ledger). Pre-050 the honest
comparison is "~290s sequential → roughly the backend job alone".

### B2. Nothing gained, nothing lost (FR-004, SC-002)

Compare the suite lists in the two jobs' logs against the last pre-split run's single job.
The union must match exactly, and both LLM reporters must be visibly in use (one-line
summaries for passing suites; only failures expanded).

### B3. The cache warms on the second run (US2, SC-003)

1. First post-merge run: the `backend` job's cache step reports a **miss** (expected — nothing
   was ever saved under this key). Suite passes.
2. Push again without touching `package-lock.json`. The cache step now reports a **restore**
   from the primary key, and the `Run server tests` step is measurably faster.
3. Bump the lockfile (any dependency change) and push. Expected: a primary-key miss, a
   `restore-keys` prefix **hit**, a green run, and a fresh save under the new key (US2
   scenario 3).

At every step the pass/fail result must be identical — the cache may only move the clock
(FR-007, invariant K1).

### B4. Both jobs gate (FR-005, SC-004)

On a scratch branch, push a deliberately failing test — once in a backend suite, once in a
client suite — and confirm the **workflow run** is red each time, with the failure attributed
to the correct job and the other job's result still independently visible. Revert; do not
merge.

### B5. Documentation still true (Constitution I)

Re-read `README.md` around line 243 (the CI note). It describes what CI runs and that CI
builds no image — the split changes neither. If the post-split reality falsifies it, correct
it in the same commit. Note the pre-existing omission there (the first-run rehearsal suite is
not mentioned); correcting it is in bounds under this task, since a doc file is not an
application source file under FR-009.

---

## Success-criteria coverage

| Criterion | Validated by |
| --- | --- |
| SC-001 — wall time ≈ backend job alone | B1 |
| SC-002 — identical executed-test set | A6 + B2 |
| SC-003 — warm cache is measurably faster, restore visible in logs | B3 (A5 previews it) |
| SC-004 — a failing test in either job reddens the run | B4 |
| SC-005 — local run unchanged, `git status` clean | A3 + A4 |

## If something goes wrong

| Symptom | Most likely cause |
| --- | --- |
| Workflow does not start at all | YAML error — A1 would have caught it |
| Cache step always misses, even on repeat pushes | `path:` and `jest.cacheDirectory` disagree (C-5), or Jest is still writing to `/tmp/jest_0` (A3) |
| `git status` dirty after a local run | `.gitignore` entry missing or misspelled (C-5) |
| Backend job fails at startup | Service health check — same failure mode as today, now scoped to one job |
| Client job fails on a missing module | The root `npm ci` was dropped from the client job; CN-051-03 sets it as a floor (R2) |
| Backend job is slower than expected | Not necessarily a defect: an exact-key cache hit means the entry is never re-saved, so files changed since it was written are transformed each run (R3) |
