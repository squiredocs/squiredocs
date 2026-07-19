# Quickstart: Validating Version History Hardening (023)

Prerequisites: the local backend test stack (pg + pgvector + redis + env — see
memory note "Local backend test stack" / docs/dev.md). Backend tests are
**serial-only** against the shared test DB — never run suites concurrently.

## 1. Migrations

```bash
node migrate.js up          # applies 1799000000000, 1799100000000, 1799200000000
node migrate.js down 3      # verify downs are clean
node migrate.js up
```

Expected: `document_versions.snapshot_data` gone (labels intact),
`yjs_updates.meaningful` present (nullable), `yjs_state_vectors` absent.
All three numbers exceed 1798000000000 (FR-027 — checkOrder-safe everywhere).

## 2. Backend suites (SC-001..SC-005, SC-007)

```bash
# serially, in the app-dev pod or the local stack:
npx jest server/__tests__/postgres-persistence.test.js
npx jest server/__tests__/version-history.test.js
npx jest server/__tests__/diff-service.test.js
npx jest server/undo/__tests__
npx jest __tests__/integration
npx jest            # full backend, once, serial
```

Key scenario → test mapping:
- **SC-001 ordering stress**: postgres-persistence suite — N fire-and-forget
  `storeUpdate` calls issued in production order without awaiting settle to zero
  clock inversions across repeated runs; plus the claim-transaction composition
  test (concurrent ordinary writes vs `finalizeClaim` holding its transaction —
  no deadlock, ordering holds) and the poisoned-update test (slot rejects →
  later updates persist in order, notifier fires).
- **SC-002 gap matrix**: inject a clock gap (delete/delay one mid-row) and hit
  each covered reader: `getYDocAtClock` serves+warns; diff computes but writes
  **no** cache entry (assert Redis key absent); undo aborts pre-claim; backfill
  skips the doc. Gap-free paths byte-identical to pre-023 outputs.
- **SC-003 O(rows) timeline**: fixture doc with a large log — timeline request
  performs **zero** `getYDocAtClock`/replay calls (spy) and no per-update
  serialization; classification read from rows; NULL rows surface as meaningful.
  (The 10k-row order-of-magnitude wall-clock check is a manual/perf run, below.)
- **SC-004 restore-undo**: restore via core with agent identity → agent_edits row
  (identity + `[newClock]`); undo inverts it (fresh), partial and full
  supersession behave per 016; redo chain works; human restore records `''`
  identity. Single-persist regression: exactly one yjs_updates row per restore.
- **SC-005 replay == named version**: create named version (no snapshot stored),
  preview/diff/restore reproduce replay-at-clock_end, including a pre-migration
  row fixture whose (dropped) blob had diverged — replay wins.
- **SC-007 dead code**: `grep -rn "getYDocWithHistory\|getStateVectorsAtClocks\|invalidateCache\|enrichVersionsWithMetadata\|extractMetadata\|YChangeExtension\|yjs_state_vectors" server/ client/src/ shared/` → only migration files (and this spec) may match.

## 3. Frontend suite (US6 deletion)

```bash
cd client && npx vitest run
```

Expected: green with `client/src/extensions/YChangeExtension.js` deleted (no
imports existed).

## 4. Backfill (FR-017)

```bash
node server/scripts/backfill-meaningful-classification.js           # full run
node server/scripts/backfill-meaningful-classification.js           # rerun → no-op (idempotent)
```

Expected: `SELECT COUNT(*) FROM yjs_updates WHERE meaningful IS NULL` → 0 after
run (except docs skipped for gaps, which report); interrupting mid-run and
rerunning converges; classifications match the old replay filter on a fixture
doc (parity test in the suite).

## 5. Multi-instance / broadcast checks (SC-006 — manual, staging)

1. Two server instances + Redis; client connected to instance B with the doc
   open; restore via REST against instance A **without** the doc loaded on A.
   Expected: B's client shows restored content < 2s (Redis fan-out path); log on
   A shows the publish, never a silent skip.
2. Same restore via MCP tool — identical row, record, and broadcast behavior.
3. Rolling-deploy sanity: one old-image pod + one new-image pod writing the same
   doc — no errors, no deadlock; NULL-classification rows from the old pod render
   as meaningful and are swept by the next backfill run.

## 6. Single-writer latency (FR-005, SC-007)

Compare `DB_PERSIST` perf-log durations for a single-editor session before/after
(same doc size): must be within noise. The uncontended overhead is one map
lookup + `BEGIN`/advisory-lock/`COMMIT` on the same connection.
