# Promotion Notes: 051-ci-parallel-jobs

What the merge queue and the reviewer need to know that the diff does not say. Written by the
implementing agent, 2026-08-04.

---

## 1. Verification owed after merge (T021–T024)

This feature deploys itself: the workflow change takes effect on the push that introduces it,
so the first post-merge run is simultaneously the deployment and the test. Four tasks are
therefore **unchecked by design**, not forgotten:

| Task | What it needs | Why it cannot be done pre-merge |
| --- | --- | --- |
| T021 | The first live run | Confirms two concurrent jobs and post-install wall time ≈ backend alone (SC-001). Measure against T001's recorded baseline (511s total, 443s sequential post-install: server 320s, client 121s, first-run 2s) — **not** the design table's `~180s`, which assumes feature 050 has landed (gap G-051-A). |
| T022 | The first live run | Executed-test parity across both jobs (SC-002), and both LLM reporters visibly in use. |
| T023 | Three consecutive runs | The cache is definitionally cold on run 1. Run 2 (unchanged lockfile) must show a primary-key restore and a faster `Run server tests`; run 3 (bumped lockfile) must show a primary miss, a `restore-keys` hit, and a fresh save. |
| T024 | A throwaway branch with deliberately failing tests | FR-009 forbids touching any test file on this branch. Must be done on a scratch branch and reverted, never merged. |

Everything checkable without a runner **was** checked and passed — see the "Local validation
results" table in `tasks.md`.

## 2. Relaxation owed at promotion

### R-051-1 — Backend suite verified structurally, not by execution

`tasks.md` T002 and T013 call for a full `npm run test:server`. The implementing agent ran a
**targeted** jest invocation instead, plus `npx jest --listTests` for the file inventory
(254 files, matching the design baseline exactly).

**Why**: backend tests share one database and are serial-only (Constitution II). A full run
from an agent worktree against the shared `collab_test_db` can corrupt it for any other agent
running concurrently. The targeted runs used a dedicated `collab_test_db_051`.

**Residual risk: low.** No npm script, no test file, and no jest `testMatch` /
`testPathIgnorePatterns` entry changed, so the executed set cannot have moved. The only jest
config change is `cacheDirectory`, which selects a storage location and cannot change test
selection.

**Owed**: T022 on the first live run closes this — the `backend` job runs the full suite on a
private, per-run database.

### R-051-2 — One targeted run hit the shared test database

Before the per-agent database existed, a single targeted jest run executed against the shared
`collab_test_db` (jest's `globalSetup` ran migrations there). The run was one pure unit suite
(`shared/diff/__tests__/word-diff.test.js`, 22 tests, no writes) and the migration step was a
no-op on an already-migrated database, so the expected impact is nil. Recorded for
completeness; all subsequent runs used `collab_test_db_051`. **No action owed** — flagging it
only so that any unexplained shared-DB oddity dated 2026-08-04 has a candidate explanation.

## 3. Contract-text defect found during implementation (no code change needed)

`contracts/ci-contract.md` C-1 and C-5 are **literally contradictory** once the cache step
lands, and a reviewer running the greps verbatim will see apparent failures:

- **C-1** asserts the token `jest` appears nowhere in `.github/workflows/test.yml`. But **C-6**
  mandates a cache key literally named `jest-cache-${{ runner.os }}-...`, and **C-5** mandates
  `path: .jest-cache`. So C-1's grep necessarily hits three lines.
- **C-5** asserts `grep -rn 'jest-cache' package.json .github/workflows/test.yml .gitignore`
  returns "exactly three hits". It returns five, because the cache **key** and `restore-keys`
  lines contain the same substring as the cache **path**.

Both contracts hold on intent, and both were verified with refined greps:

```bash
# C-1 intent: no test-runner invocation or flag. The only run: test commands are
#   npm run test:server | npm run test:client | npm run test:first-run
grep -n 'run:' .github/workflows/test.yml

# C-5 intent: exactly one designation of the directory .jest-cache per file
grep -rn '\.jest-cache' package.json .github/workflows/test.yml .gitignore   # 3 hits
```

**Suggested amendment** (documentation only, deferred rather than done here to keep the diff
inside FR-009's three files): scope C-1's grep to `run:` lines, and scope C-5's grep to
`\.jest-cache` (leading dot) so it matches the path and not the key prefix.

## 4. Non-blocking observations

- **The measured baseline is worse than the spec's.** Spec SC-001 says "~290s sequential"; the
  last green pre-split run actually spent **443s** post-install. The split's headline saving is
  therefore larger than advertised (~123s of client work disappears into the backend window),
  not smaller. Nothing to fix — just do not let the discrepancy read as a regression.
- **Cache step placement.** `actions/cache@v4` sits immediately after `Set up Node.js` and
  before `Install dependencies`, which satisfies T011's "after setup-node and before the test
  step". `npm ci` between restore and use is harmless: it only removes `node_modules`.
- **Nothing carries the old job name `test`.** Both jobs are new names. The repo has no
  branch-protection required-checks layer (spec Assumptions), so nothing depended on it — but
  if such a layer is ever added, it must reference `backend` and `client`, not `test`.

## 5. Post-merge review dispositions (2026-08-04, review verdict CLEAN, 2 LOW)

- **LOW-1 (merge message overstates live-verification closure)**: no code action. When Sam
  runs the owed live-CI verification, the FIRST green push closes only T021/T022 — T023 needs
  three consecutive runs (cold / warm / lockfile-bump) and T024 needs a deliberately red
  throwaway branch. Do not tick T023/T024 off a single green run.
- **LOW-2 (contract greps C-1/C-5 self-contradictory verbatim)**: FIXED same-day — the checks
  in contracts/ci-contract.md now scope C-1 to `run:` lines and escape the dot in C-5, both
  verified against the merged tree (C-1: zero hits; C-5: exactly three).
