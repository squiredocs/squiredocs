# Promotion Notes — 023 Version History Hardening

Items owed at/after the serial merge stage. The implement worktree is server-only
plus the single ratified client deletion (YChangeExtension.js); all 46 in-scope
tasks (T001–T044, T046, T047) are complete and verified. Two tasks are
deliberately not done here:

## Owed at the serial merge stage

- **T045 — README version-history section (SKIPPED here, merge-stage owned).**
  The parallel-agent override forbids README edits in this worktree
  (constitution I). The merge/implement stage must update README.md's
  version-history description for: per-document serialized writes (clock order =
  causal order), replay-only named versions (snapshot_data dropped), persisted
  meaningful classification + the backfill script, restore-as-undoable-edit on
  both surfaces, and the dropped `yjs_state_vectors` table. Left unchecked in
  tasks.md.

## Maintainer-owed (Sam)

- **T048 — staging multi-instance validation (quickstart §5).** Two instances +
  Redis: a restore via REST against an instance that does NOT hold the doc must
  appear on a client connected to the OTHER instance in < 2s (Redis fan-out),
  and the same via the MCP tool — identical row/record/broadcast. Plus a
  rolling-deploy mixed-window sanity pass (one old-image pod + one new-image pod
  writing the same doc: no deadlock; old-pod NULL-classification rows render as
  meaningful and are swept by the next backfill). Left unchecked in tasks.md;
  record the outcome in the feature ledger.

## Deploy ordering for the three migrations — reality of one-shot migrate (D-8, D-10)

**What actually happens:** `npm run migrate` applies ALL pending migrations in a
single shot BEFORE the pods are replaced. It cannot stage individual migrations
around code rollout. So all three 023 migrations land together, up front:

1. **1799000000000_add-meaningful** — additive; old and new pods both write legal
   rows (old pods write NULL, which reads as meaningful — D-3).
2. **1799100000000_drop-version-snapshot-data** — drops the (nullable) snapshot column.
3. **1799200000000_drop-yjs-state-vectors** — drops the write-once state-vectors table.

**Accepted drain-window risk (D-10 — flagged for Sam's ratification below).** Between
migrate finishing and the OLD-image pod actually stopping, the old pod is still
serving on a schema where those two tables/columns are gone. The old code paths that
touch them then fail:

- old-pod `storeUpdate` first-update branch INSERTs into the dropped
  `yjs_state_vectors` → its retries all fail → **the first update of a NEWLY CREATED
  doc on the draining old pod is lost** for the window;
- old-pod `createNamedVersion` INSERTs `snapshot_data` → **version naming on the
  draining old pod fails** for the window.

This is ACCEPTED on the current single-replica cluster (seconds-long window; affects
only doc-creation / version-naming on the draining old pod; existing docs and all
reads are unaffected). The already-deployed old code cannot be softened — there is no
code fix that closes this. **The only real mitigation is deploy-time: drain the old
pod quickly** (short terminationGracePeriod / prompt rollout) to minimize the window.
Full reasoning and the rejected two-stage-deploy alternative are in
`clarifications-needed.md` D-10.

## Post-merge review dispositions (adversarial review — NEEDS FIXES verdict)

The architecture stands; the write-path defects below were fixed same-day (this
commit series), each with a regression test. Backend suite serial-only.

- **F1 (HIGH) — FIXED (5d2fdb0).** The `documents.updated_at` stamp no longer runs
  swallowed INSIDE the write transaction (a swallowed error there aborted the txn →
  the COMMIT silently ran as ROLLBACK → storeUpdate returned success while the
  yjs_updates row never committed = silent edit loss). Pool path: COMMIT the durable
  insert first, then stamp updated_at post-commit as advisory metadata (a post-commit
  stamp failure is logged, never undoes the committed row). External-client (016 claim)
  path: the stamp stays inside the caller's txn but its error now PROPAGATES (no
  swallow), so a failing stamp rolls the claim back cleanly. Regression: an injected
  server-side stamp failure → storeUpdate still reports success AND exactly one
  yjs_updates row exists (ground-truth row count).
- **F2 (HIGH) — FIXED (5d2fdb0).** `_runStoreSlot` now acquires AND releases a FRESH
  pool client per attempt (was: one client for all 3 attempts, so a connection that
  died mid-INSERT made every retry fail instantly). Regression: a first-attempt
  connection-death client → the retry acquires a fresh working client → success, one row.
- **F3 (MEDIUM) — FIXED (637e25c).** `restoreVersion` now threads the gap indicator
  out of BOTH its reads (`getVersionContent`→`getYDocAtClock`, and `getYDoc`, via a new
  `{ withGap }` option) and REFUSES fail-closed on a still-gapped read — the same posture
  undo uses — via a typed `DocumentSyncingError` (REST → HTTP 503; MCP → teaching-error
  string). No restore row and no agent_edits record are written on refusal. Regression:
  a torn log (clocks 0,1,3) → restore refuses; ground-truth zero new rows.
- **F5 (MEDIUM) — FIXED (05dda64 guard + 637e25c bindState wiring).** Write-path classification no longer serializes the
  ENTIRE doc via `extractXml` on every update unconditionally. A cheap O(1) running-size
  guard (`classificationDisabled`, threshold `MAX_CLASSIFY_DOC_BYTES = 500KB`, exported
  from `update-classifier.js`) accumulates applied-update byte sizes on the ydoc; once a
  doc crosses the ceiling, classification AND its extractXml baseline are permanently
  disabled for that doc's in-memory lifetime and updates persist `meaningful=null`
  (unknown ⇒ meaningful, fail-visible D-3). Chosen mechanism: accumulated update-byte
  proxy (monotone; the one big db-load snapshot trips an already-large doc on load) +
  a `_classifyDisabled` stamp. Regression: an oversized doc → classifier skipped,
  `meaningful` stays null, extractXml spy never called.
- **F4 (MEDIUM) — DECISION D-10 recorded** (above + clarifications-needed.md), **flagged
  for Sam's explicit ratification.** Accept the one-shot-migrate drain window; mitigate
  by draining the old pod fast.
- **LOW (live-apply unreachable branch) — ACCEPTED as cosmetic.** No behavioral change.
- **Reviewer test-honesty notes.** (1) The pre-existing transient-retry test
  deliberately keeps the client usable — that is intentional and left as-is; the NEW F2
  test covers the connection-death class beside it. (2) The diff-service gap-skip test
  mocks the gap — acceptable: the real gap choke point (`_fetchRowsWithGapRetry`) is
  exercised against a real torn DB log by the postgres-gap-read suite.

## Operator-run after deploy

- **Backfill:** `node server/scripts/backfill-meaningful-classification.js`
  (idempotent, resumable, gap-aware). Classifies historical rows; rerun until
  `SELECT COUNT(*) FROM yjs_updates WHERE meaningful IS NULL` is 0 except docs it
  reports as gapped (a later run heals those). Verified locally: run 1 classified
  286 docs / 883 rows, run 2 wrote 0 (no-op).

## Behavioral heads-up

- **Diff cache version bumped v8 → v9.** Pre-023 diff cache entries (which could
  have been computed from a gap-tolerant-but-still-gapped row set) are abandoned
  under the new key and expire on their existing 3600s TTL. No action required.
- **Pre-023 diverged named-version snapshots heal to replay (D-6).** Any named
  version whose dropped blob had diverged from log replay will now display the
  replayed (correct) content. Ratified; no notification performed.

## Ratified-by-default ledger

`clarifications-needed.md` D-1..D-9 are RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-07-19). No new open questions arose during implementation; every plan-phase
default (advisory-lock + queue mechanism, funnel shape, `''` human-agent
sentinel, unknown⇒meaningful, etc.) matches the recorded ledger.
