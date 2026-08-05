# Promotion Notes: 052-parallel-test-isolation

What the merge queue and the reviewer need to know that the diff does not say. Written by the
implementing agent, 2026-08-05.

---

## 1. Verification owed after merge (T043)

**T043 — five consecutive green parallel backend jobs in CI — is unchecked by design.** The CI
edit is one line (`JEST_MAX_WORKERS: 4` in the backend job's `env:` block) and takes effect on
the push that introduces it, so the runs cannot exist before the merge. Everything else in the
gate was done locally and is recorded with evidence in `quickstart.md` S5.

When those runs happen, note that **CI is a 4-worker runner, not a 5-worker one**, so its
absolute times differ from the dev pod's; SC-001 is judged on the dev pod (spec Assumptions).
Per FR-018, a suite that flakes under CI contention gets its timing ceiling reviewed — the
remedy is never a lower `JEST_MAX_WORKERS`.

## 2. Relaxation taken during implementation

### R-052-1 — T018's four US1 validations ran against a test selection, not the full suite

`quickstart.md` S1 phrases three of its four checks as `npm run test:server` (a full run each).
The implementing agent ran them as targeted jest invocations
(`server/__tests__/db-isolation.test.js`, plus `server/undo/__tests__/undo-service.test.js` for
the corrupted-worker-copy check, which needs a suite that actually reads the schema).

**Why**: all four checks exercise `globalSetup`, which runs identically regardless of how many
test files follow it. Four extra full runs would have added ~12 minutes of shared-pod CPU to
prove a property that a one-file run proves exactly as well.

**Residual risk: nil.** The full-suite behavior these checks stand in for is covered several
times over by the five-run gate (T042), the serial/parallel pass-list diff (T044) and the
command matrix (T048), all of which were run in full.

**Evidence**: all four passed — provisioning (`_template` + `_w1` present, base empty), stale
copy replaced (`DROP TABLE documents` in `_w1`, next run green, table back), external base
honored as a base (`collab_test_db_qs_template` + `_w1` created, base has 0 tables), and two
concurrent worktree-style bases (`_a` / `_b`) both green with disjoint families.

## 3. Design defect found during implementation (RBD-052-7)

**Redis logical databases do not isolate pub/sub.** US2 scenario 3 — "two workers publishing on
identical channel names see only their own messages" — is not achievable by the ratified
mechanism, because Redis Pub/Sub has no relation to the keyspace and ignores database numbers.
Verified through ioredis and again through raw `redis-cli`.

`REDIS_DB` was implemented exactly as ratified and does isolate the **keyspace**. The test file
asserts that positively and pins the pub/sub limitation with an explicit `KNOWN LIMITATION`
test. The suite is safe in practice (app channels are guid-scoped, and the one fixed-name
channel carries a payload no other worker can match), and the five-run gate agrees. Full
argument and the follow-on option for Sam: RBD-052-7 in `clarifications-needed.md`.

## 4. Non-blocking observations

- **SC-001 landed inside the band without tuning.** 5 workers (50% of 10 cores), 34.6–36.3s
  across the gate runs, against a 30–50s target and a 177.2s serial baseline. Research R10
  anticipated that 5 workers might fall outside the band and require a report to Sam; it did
  not. No D4 amendment is needed.
- **Gate run 5 took 932s and stayed green.** The dev pod is shared and another agent's jest run
  had been executing for over an hour; the run was CPU-starved, not flaky. Worth knowing that
  the suite tolerates roughly a 25x contention factor without a single timing failure — which
  is the FR-018 property, demonstrated by accident.
- **The old `globalSetup` latent bug is retired, not ported.** It probed the constant
  `TEST_DB_NAME` while migrating whatever `DATABASE_URL` named (documented at
  `specs/040-restore-undo-attribution/merge-notes.md:302-303`). Everything now derives from one
  parsed URL. A practical consequence: a base database no longer needs to pre-exist for the
  probe to behave, though creating it remains the pipeline convention.
- **`docs/dev.md`'s `--runInBand` claim was stale the moment T037 landed** and was corrected in
  the same commit: the script supplies `--forceExit`, not `--runInBand`. The `--forceExit`
  hang note and the `--reporters=` positional-argument note both survive verbatim; they are
  still true and still load-bearing.
- **Two suites were fixed as suite bugs, per FR-017.** Neither was resolved by reverting to
  serial or lowering the worker count. See commit 9a3ef967 and the gate ledger.
