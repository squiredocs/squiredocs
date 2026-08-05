# Quickstart & Validation: Parallel Test Isolation (Backend Suite)

**Feature**: `052-parallel-test-isolation` | **Date**: 2026-08-04 | **Plan**: [plan.md](./plan.md)

Runnable procedures that prove the feature works, ending with the **verification gate** that governs whether the serial default may be dropped. Run everything inside the Minikube `app-dev` pod (`docs/dev.md`).

> **Precondition**: 050 and 051 are merged to `main`. Verify before starting:
> ```bash
> git -C /local-dev log --oneline main | grep -E '05[01]-' | head
> ```

---

## S0 — Baseline capture (do this FIRST, before any code change)

The pass-list diff (SC-003) needs a pre-change reference, and SC-001 needs a before number. Both are unrecoverable once the default flips.

```bash
cd /local-dev
time npm run test:server 2>&1 | tee /tmp/052-baseline-serial.log
```

Record: wall time (expect ~175 s post-Train-A) and the pass list. Extract a canonical, order-independent pass list:

```bash
npx jest --runInBand --silent --listTests | sort > /tmp/052-testfiles.txt
npx jest --runInBand --json --outputFile=/tmp/052-serial.json --silent >/dev/null 2>&1
node -e '
  const r=require("/tmp/052-serial.json");
  console.log(r.testResults.flatMap(f=>f.assertionResults.map(a=>`${a.status}\t${f.name.replace(/^.*\/local-dev\//,"")}\t${a.fullName}`)).sort().join("\n"))
' > /tmp/052-passlist-serial.txt
wc -l /tmp/052-passlist-serial.txt
```

Sorting is essential: parallel runs emit results in nondeterministic order, so an unsorted diff is pure noise.

---

## S1 — Postgres isolation (US1)

**Derivation unit checks** — fast, no database needed:

```bash
npx jest server/__tests__/db-isolation.test.js --runInBand
```

Asserts INV-1…INV-6: distinct workers → distinct names; `--runInBand` → worker 1; credentials/port/query preserved through splicing; `derive(derive(x)) === derive(x)`; distinct bases → disjoint families; invalid base name rejected with the charset message.

**Provisioning actually happened**:

```bash
npm run test:server 2>&1 | tail -5
psql -l | grep collab_test_db
# expect: collab_test_db (base, unused) + collab_test_db_template + collab_test_db_w1..wN
```

**Stale copies are replaced** (US1 scenario 2):

```bash
psql -c 'DROP TABLE IF EXISTS documents CASCADE' -d collab_test_db_w1   # corrupt a worker DB
npm run test:server                                                     # must be green anyway
```

**External base is honored as a base** (US1 scenario 4, FR-003):

```bash
createdb collab_test_db_qs
DATABASE_URL=postgresql://$USER@localhost:5432/collab_test_db_qs npm run test:server
psql -l | grep collab_test_db_qs
# expect collab_test_db_qs_template + collab_test_db_qs_w1..wN; the base itself stays empty
```

**Two concurrent worktree-style bases don't collide** (US1 scenario 5, RBD-052-1):

```bash
createdb collab_test_db_a; createdb collab_test_db_b
DATABASE_URL=postgresql://$USER@localhost:5432/collab_test_db_a npm run test:server &
DATABASE_URL=postgresql://$USER@localhost:5432/collab_test_db_b npm run test:server &
wait   # both green; disjoint template + worker families
```

**Fixed-key collision is now impossible** (US1 scenario 6): run two fixed-key suites concurrently and confirm both pass — covered by `db-isolation.test.js`'s cross-worker case plus the full-suite runs below.

---

## S2 — Redis isolation (US2)

**Byte-identity with the knob unset** (SC-004, INV-7) — the single most important non-test assertion in the feature:

```bash
npx jest server/__tests__/db-isolation.test.js -t 'REDIS_DB' --runInBand
```

The test must assert the **absence of the `db` key** (`('db' in config) === false`), not `db === 0`. Those are different objects and only the former is byte-identical.

It must also assert that an explicit `REDIS_DB=0` **is** honored — the string `'0'` is truthy, so the conditional-spread pattern handles it correctly, and the test exists so nobody later "corrects" the check into a numeric truthiness test and silently drops it.

**All of a worker's clients share one logical DB** (US2 scenario 2):

```bash
npx jest server/__tests__/redis-pubsub-integration.test.js --runInBand
```

**Cross-worker pub/sub silence** (US2 scenario 3): two workers publishing on identical channel names see only their own messages — asserted in `db-isolation.test.js`.

**Cap fail-fast** (US2 scenario 4, FR-008, INV-10):

```bash
JEST_MAX_WORKERS=16 npm run test:server; echo "exit=$?"
# expect: non-zero exit, message naming 16, the cap of 15, DB 0 reservation, and the fix.
# expect: NO test output at all — it must abort before any suite runs.
```

**Spawned-child inherits the assignment**:

```bash
npx jest server/__tests__/telemetry-traces.test.js --runInBand
```

---

## S3 — Documentation coherence (US3, SC-007)

```bash
cd /local-dev
grep -rn "serially for backend" .specify/memory/constitution.md
grep -rn "serial-only" .claude/skills/the-pipeline/SKILL.md docs/dev.md
grep -rn "share one database and MUST run serially" .specify/memory/constitution.md
```

All four MUST return nothing (research R9 enumerates the four sites). Then confirm positively:

- Principle II's replacement text is **character-for-character** the design §2.3 block quoted in FR-009. Diff it, do not eyeball it.
- The constitution's version was bumped and its Sync Impact Report updated (Governance).
- `helpers/db.js`'s `cleanupDocRows` convention comment still mandates the convention, with the within-worker rationale and no claim of a shared serial database.
- `the-pipeline/SKILL.md:64` still requires a per-agent `DATABASE_URL`, now described as a base.
- `the-pipeline/SKILL.md:46`'s "never overlap another backend run on the same DB" survives as the D3 one-run-at-a-time rule (it is still true) — only the "serial-only" framing goes.

---

## S4 — Parallel default (US4)

```bash
time npm run test:server        # multiple workers; expect 30–50 s band (SC-001)
```

Confirm the worker count actually used (`50%` of 10 cores = **5** on the dev pod; see research R10 — 5, not the design table's 6–8, is the ratified-knob outcome and is not a defect).

```bash
time npm run test:server -- --runInBand      # still green, reporter output unchanged (SC-006)
npm run test:server 2>&1 | head -3           # LLM reporter format present in BOTH modes (FR-015)
```

---

## S5 — THE VERIFICATION GATE

**Nothing about dropping the serial default may proceed until every box below is checked.** This is FR-016 / SC-002 / SC-003, taken verbatim from the design's Verification section. It is a gate, not a smoke test.

### Gate part 1 — five consecutive green parallel runs, locally

```bash
cd /local-dev
for i in 1 2 3 4 5; do
  echo "=== local parallel run $i ==="
  npm run test:server > /tmp/052-parallel-$i.log 2>&1 \
    && echo "RUN $i GREEN" \
    || { echo "RUN $i RED — counter resets to zero"; break; }
done
```

**Consecutive** is literal: any red run resets the count to zero. Fix the offending suite (FR-017 — it is a suite bug, never a reason to revert to serial; FR-018 — a contention-flaky suite gets its timing ceiling reviewed, never a lower worker count), then start again from run 1.

### Gate part 2 — five consecutive green parallel runs in CI

Five consecutive green backend jobs on the post-051 workflow with `JEST_MAX_WORKERS` set. Push five times or re-run the job five times; record the run URLs.

### Gate part 3 — serial vs parallel pass-list diff is empty (SC-003)

```bash
cd /local-dev
npx jest --runInBand --json --outputFile=/tmp/052-final-serial.json --silent >/dev/null 2>&1
npx jest --json --outputFile=/tmp/052-final-parallel.json --silent >/dev/null 2>&1

passlist() { node -e '
  const r=require(process.argv[1]);
  console.log(r.testResults.flatMap(f=>f.assertionResults.map(a=>`${a.status}\t${f.name.replace(/^.*\/local-dev\//,"")}\t${a.fullName}`)).sort().join("\n"))
' "$1"; }

passlist /tmp/052-final-serial.json   > /tmp/052-final-serial.txt
passlist /tmp/052-final-parallel.json > /tmp/052-final-parallel.txt
diff /tmp/052-final-serial.txt /tmp/052-final-parallel.txt && echo "PASS LISTS IDENTICAL"
```

An empty diff is the proof that no suite's outcome depends on execution mode. A non-empty diff names the mode-dependent suites; fix them and re-run the gate from part 1.

### Gate ledger (filled in 2026-08-05, base `collab_test_db_052`, 10-core dev pod)

| Gate item | Evidence | Status |
|---|---|---|
| 5 consecutive green local parallel runs | `/tmp/052-parallel-1..5.log`, all `255 suites, 4593 passed`: run 1 34.6s, run 2 34.8s, run 3 36.3s, run 4 45.7s, run 5 932.5s. No red run, so the counter never reset. | ☑ |
| 5 consecutive green CI backend jobs | **Owed post-merge** — the `JEST_MAX_WORKERS: 4` line takes effect on the push that introduces it, so the runs cannot exist pre-merge. See promotion-notes.md §1. | ☐ |
| Serial vs parallel pass-list diff empty | `diff /tmp/052-final-serial.txt /tmp/052-final-parallel.txt` → **no output**, 4593 lines each. No suite's outcome depends on execution mode. Against the pre-change baseline (`/tmp/052-passlist-serial.txt`, 4574 lines) the only delta is the 19 new `db-isolation.test.js` tests — every pre-existing test still passes. | ☑ |
| SC-001 timing measured on the 10-core pod | **5 workers** (`50%` of `availableParallelism() === 10`, confirmed by globalSetup's own log line). Parallel **34.6–36.3s** on an unloaded pod vs a **177.2s** serial baseline — inside the 30–50s band, so no D4 amendment is needed (research R10 anticipated it might not be). Serial mode measured at 166.6s and stays green. | ☑ |
| Coupling failures fixed as suite bugs (list them) | Commit `9a3ef967`. (1) `redis-auth.test.js` asserted the exact pre-feature `REDIS_CONFIG` key set while controlling only `REDIS_PASSWORD`, so the runner's new `REDIS_DB` leaked into its "no stray additions" check — it now clears every optional knob it asserts about. (2) `search-indexer-gating.test.js`'s `healStragglers` covered only two of `reindexStale`'s three branches; a leftover document with **no index row at all** was still repair-eligible and cost a full embed cycle each, giving 26 calls against an expected 2 — the heal now covers the `si.doc_id IS NULL` branch. Neither was resolved by reverting to serial (FR-017) or by lowering the worker count (FR-018). | ☑ |

**Run 5's 932.5s is contention, not flakiness**: the dev pod is shared and another agent's jest
run had been executing for over an hour. The run was green, with no timing failures at roughly
a 25x contention factor — which is the property FR-018 asks for, demonstrated by accident.

---

## S6 — Cleanup after validation

```bash
dropdb --if-exists collab_test_db_qs_template
for n in $(seq 1 15); do dropdb --if-exists collab_test_db_qs_w$n; done
dropdb --if-exists collab_test_db_qs
# same for collab_test_db_a / collab_test_db_b if the concurrency check was run
```

The suite's own `_template` / `_wN` databases are intentionally **left in place** (see data-model.md §4) — the next run drops and recreates them.
