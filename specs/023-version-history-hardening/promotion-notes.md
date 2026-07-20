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

## Deploy ordering for the three migrations (rolling, no freeze — D-8)

1. **1799000000000_add-meaningful** — deploy before/with the US4 code. Old pods
   write NULL (legal); NULL reads as meaningful.
2. **1799100000000_drop-version-snapshot-data** — run ONLY after the US3 code is
   fully rolled out (old pods still INSERT snapshot_data until then; the column
   is nullable so their inserts stay legal right up to the drop).
3. **1799200000000_drop-yjs-state-vectors** — run ONLY after the US6 code is
   fully rolled out (old pods still write state vectors until then).

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
