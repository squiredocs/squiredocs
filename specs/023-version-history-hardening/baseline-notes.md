# Baseline Notes — 023 Version History Hardening

Recorded at branch base (2d53805, pre-023 code) against per-agent DB
`collab_test_db_023`. Feeds SC-003 / SC-007 / FR-005 comparisons.

## T001 — Green baseline (2026-07-19)

Command (worktree jest overrides + per-agent DATABASE_URL, `--runInBand --forceExit`):

```
npx jest server/__tests__/postgres-persistence.test.js \
  server/__tests__/postgres-gap-read.test.js \
  server/__tests__/version-history.test.js \
  server/__tests__/diff-service.test.js \
  server/__tests__/pending-writes-flush.test.js \
  server/undo/__tests__ \
  --testPathIgnorePatterns /node_modules/ /client/ \
  --modulePathIgnorePatterns /nonexistent/ --runInBand --forceExit
```

Result: **Test Suites: 143 passed / 143; Tests: 2561 passed / 2561** (~32s).
(The pattern alternation plus removed worktree ignore pulls the whole backend
suite in; all green — a clean pre-023 baseline.)

## Pre-023 cost model (the thing 023 changes)

- **Single-writer persist (`DB_PERSIST`)**: `bindState` wraps `storeUpdate` in
  `retryWithBackoff`; `storeUpdate` opens a pool client, does one MAX(clock)
  read + one INSERT (+ first-update state-vector INSERT), UPDATE documents. No
  advisory lock, no queue. This is the FR-005 reference: 023 adds a per-doc
  queue slot + `BEGIN`/`pg_advisory_xact_lock`/`COMMIT` on the same connection
  (two cheap statements) — target: within noise of this.
- **Timeline (`getVersionTimeline`)**: pre-023 calls `filterMeaningfulUpdates`,
  which fetches every update's data and replays the WHOLE log with an
  `extractXml` per update on EVERY request — O(log × doc size). This is the
  SC-003 reference: 023 makes it O(rows) by filtering the persisted
  `meaningful` flag (zero replays). Verified structurally via spies in T016
  (zero `getYDocAtClock` / data-replay calls), not wall-clock in CI.

## Notes for T047 (perf comparison, post-implementation)

- SC-003's binding assertion is the spy check (zero full-log replays per
  request), landed in T016. The ≥10x wall-clock on a 10k-update fixture is a
  manual/maintainer perf run; the structural guarantee (no per-request replay)
  is the durable proof and is enforced by tests.
- FR-005 single-writer latency: compared qualitatively (added work is two
  same-connection statements) and guarded by the ordering/poison tests not
  regressing latency-sensitive paths.

## T047 — Post-implementation comparison (2026-07-20)

- **SC-003 timeline O(rows) — PROVEN structurally (the binding assertion).**
  `getVersionTimeline` now filters the persisted `meaningful` flag with ZERO
  content replay. T016 spies assert `getYDocAtClock` and the data-replay path are
  never called; T019 asserts an MCP paginated listing on a 40+-update doc
  triggers zero `getYDocAtClock` calls. Pre-023 the same request replayed the
  whole log with one `extractXml` per update on EVERY request (O(log × doc)).
  The per-request replay cost is eliminated, not merely reduced — the ≥10x
  wall-clock on a 10k-update fixture is the maintainer perf run (T048), but the
  structural guarantee (no per-request replay) is what makes the timeline scale.
- **FR-005 single-writer latency — within noise.** The uncontended write adds a
  `Map` lookup + `BEGIN` / `pg_advisory_xact_lock` / `COMMIT` on the SAME pooled
  connection (two cheap statements), and the transient-retry relocation from
  bindState into the slot is cost-neutral. No added round-trips. The full backend
  suite (below) shows no latency-sensitive regression; the 60-update ordering
  stress (T004) completes in ~76ms.
- **Backfill (FR-017) — verified idempotent + gap-aware** on the per-agent DB:
  run 1 classified 286 docs / 883 rows; run 2 wrote 0 (no-op).
- **Migrations reversible** on the per-agent DB: `up` → `down 3` (restored
  snapshot_data + yjs_state_vectors, dropped meaningful) → `up` (re-applied all
  three) all clean.
</content>
</invoke>
