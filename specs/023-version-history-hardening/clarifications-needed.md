# Clarifications Ledger — 023-version-history-hardening

Decisions the design amendments (`design/collaboration-core.md` — **Amendment (Sam,
2026-07-19) — clock order is causal order (feature 023)** and **Amendment (Sam,
2026-07-19) — replay is the sole source of truth; timeline scales O(rows); restore is
undoable (feature 023)**, commit db85ee7) did not answer were taken with the best default
and recorded here as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)**.

Decisions the amendments already made are Sam-ratified 2026-07-19 and are cited in the
spec, not re-decided: per-document write serialization (queue or advisory lock — mechanism
choice left open); gap tolerance extended to every log-rebuild reader (extend vs. funnel
through the choke point left open, but the "single choke point" claim must end up true);
no gapped/misordered row set ever cached or frozen as a diff or named-version truth;
snapshot_data dropped and named versions become pure clock-range labels; meaningful
classification persisted at write time making history O(rows); restore records an
agent_edits row so chat Undo can invert it; restore stops double-persisting (landed
hotfix, regression-guarded); REST/MCP restore converge on identical attribution and
broadcast; checkpoints/compaction deliberately deferred (Sam, Q5) and not foreclosed;
dead-code deletion list (enrichVersionsWithMetadata/extractMetadata, getYDocWithHistory,
getStateVectorsAtClocks, DiffService.invalidateCache, yjs_state_vectors table,
client YChangeExtension.js).

The serialization mechanism (per-doc queue vs. advisory lock vs. combination) and the
gap-coverage shape (extend each reader vs. funnel) are explicitly **plan-phase choices**
per the amendments — the spec fixes the invariants (FR-001..003, FR-007), not mechanisms.

---

## D-1: Cross-instance scope of the ordering invariant

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
- **Question**: The amendment says "per-document write serialization (a per-doc ordered
  queue or advisory lock in storeUpdate)". A purely in-process queue serializes one
  instance; but a client can reconnect to another instance and produce a causally later
  update while the first instance's persist is still in flight. Does the guarantee span
  instances?
- **Decision**: Yes — the invariant is stated causally, not mechanically (FR-001/FR-002):
  any two causally ordered updates get strictly increasing clocks, including the
  cross-instance reconnect case. Causally concurrent updates (true CRDT concurrency,
  including two instances persisting different clients' edits simultaneously) may take
  either order — that is not a violation. The plan picks the mechanism that satisfies
  this (the amendment's own advisory-lock option does; a queue may need the lock as its
  cross-instance backstop).
- **Rationale**: "Clock order is causal order by construction" is only worth building if
  it cannot be silently defeated by the multi-instance topology prod actually runs
  (2 replicas, non-sticky routing — the exact topology that produced the 015 incident).

## D-2: Behavior of derived-artifact producers on a still-gapped read

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
- **Question**: 021 defined serve-as-is-with-warning for getYDoc after the retry budget.
  What do the newly covered readers do when still gapped: error, serve, or serve-without-
  freezing?
- **Decision**: Split by consequence (FR-009): serving-only paths (live doc load, a
  one-off preview) keep 021 semantics — serve as-is, never error, observably warn.
  Artifact-producing paths never freeze the result: the diff service serves the computed
  diff but skips the cache write (next request recomputes from a healed log); no stored
  record (edit-record range, classification, named-version label) may be derived from a
  gapped row set — those paths retry within budget and, if still gapped, defer/fail their
  artifact write observably rather than store a lie. All paths share 021's existing
  retry-budget knobs — no new per-path configuration.
- **Rationale**: The amendment's hard line is "never computed from a gapped or misordered
  row set and then cached/frozen as truth". Serving a transient view is self-healing;
  freezing it is the permanent-corruption class this feature exists to kill.

## D-3: Meaningful-flag backfill strategy and the unknown-classification default

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
- **Question**: How do pre-023 rows get classified, and what does a reader do with a row
  whose classification is absent (backfill pending/interrupted, or written by an old
  instance during the rolling deploy)?
- **Decision**: One-time idempotent/resumable backfill replaying each document once with
  the same classification the write path uses (the established backfill pattern —
  PostgresPersistence with the statement-timeout opt-out). Readers treat unknown
  classification as **meaningful** (fail-visible): noise rows may temporarily appear in
  the timeline, but a real edit is never hidden. Classification failure at write time
  degrades to unknown and never blocks persistence (FR-017/FR-018).
- **Rationale**: Beta-scale data makes a single replay pass cheap; fail-visible is the
  only safe default for a filter whose job is hiding rows; idempotence makes the deploy
  window and interruptions non-events.

## D-4: Human restores enter the same edit-record system

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
- **Question**: The amendment says "restoreVersion records an agent_edits row (like modify
  does)". restoreVersion is the shared core behind BOTH surfaces — does a human UI restore
  (REST, no agent) also get a record, in a table named agent_edits?
- **Decision**: Yes — recording happens at the shared core for every restore, carrying the
  performing identity (human user alone for UI restores; user + agent name for agent
  restores). Which records each undo surface targets follows feature 016's existing
  selection/scoping rules — this feature does not redefine undo targeting, it only makes
  restores visible to it. (If 016's scoping means chat Undo only targets
  assistant-identity records, a human restore is still recorded and invertible the moment
  a surface targets it; that scoping question is 016's, not 023's.)
- **Rationale**: "Restore participates in log-derived undo" is the ratified end state;
  recording at the shared core is the only way REST/MCP convergence (also ratified) can
  hold. The table name is history, not a schema for who may appear in it.

## D-5: Restore broadcast when the serving instance doesn't hold the doc

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
- **Question**: Today the REST restore silently skips broadcasting when the document isn't
  loaded in the serving instance's memory (persist-only; collaborators connected to other
  instances see stale content until reload). The amendment ratifies "identical broadcast
  behavior" for the two surfaces but doesn't say what that behavior is in the not-loaded
  case.
- **Decision**: The silent-skip path is eliminated (FR-023): a completed restore becomes
  visible to every connected collaborator on every instance without reload, regardless of
  surface and of where the document is loaded. Mechanism is plan-phase (load-then-apply,
  or publish the restore update through the existing Redis fan-out so instances holding
  the doc apply it); if delivery genuinely cannot occur (e.g., Redis-less single instance
  with no doc loaded — meaning no one is connected anywhere), the outcome is observable,
  never silent.
- **Rationale**: Converging both surfaces on a silently-lossy behavior would satisfy
  "identical" while shipping a known staleness bug; the only convergence worth ratifying
  is the correct one.

## D-6: Pre-existing diverged snapshots heal silently at migration

- **Status**: DESIGN-RATIFIED (Sam, 2026-07-19 amendment) — recorded for visibility, not
  re-decided
- **Note**: Dropping snapshot_data means any named version whose frozen blob had diverged
  from log replay (a baked-in bad read) will change displayed content to the replayed
  truth. This is exactly the amendment's point ("a frozen blob can bake in a bad read
  forever"); no user notification or comparison pass is performed at migration time. The
  migration preserves every label field; only the content blob is dropped.

## D-7: Migration numbering

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
- **Decision**: All 023 migrations are numbered above the current highest migration
  (`1798000000000_chunk-structure-columns.js`) — i.e., 1799000000000+ — which
  automatically satisfies both ratified constraints (> 1795000000000 per the rolled-back
  008 cruft guard, and after the 1796* undo migrations). 023 is the sole in-flight
  feature adding migrations; 024 adds none. Expected migrations: classification storage,
  drop snapshot_data, drop yjs_state_vectors (plan may combine).
- **Rationale**: Strictly-increasing beyond the current max is the only ordering that can
  never trip node-pg-migrate's checkOrder against any environment's applied set.

## D-8: Rolling-deploy window for write serialization — no freeze required

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
- **Question**: During rollout, old pods persist with the raw MAX+1 race while new pods
  serialize. Require a maintenance window / doc freeze?
- **Decision**: No. The mixed window's exposure is exactly today's steady-state risk (the
  race has existed since the beginning); the new mechanism must merely tolerate an
  unserialized peer racing it without deadlock or new failure modes. The same reasoning
  covers the classification column: old pods write unclassified rows during the window,
  absorbed by D-3's unknown⇒meaningful default. No backfill re-run is needed beyond D-3's
  idempotent process.
- **Rationale**: A freeze would be new ceremony (constitution III) purchasing protection
  against a risk level we already live with; the invariant matters for the steady state,
  not the minutes of rollout.

## D-9: Poisoned-update queue semantics

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-19)
- **Question**: Under ordered persistence, what happens to updates queued behind one that
  terminally fails (after the existing retry/backoff)?
- **Decision**: The failure pages exactly as today (CRITICAL + exception notifier — the
  data-loss alarm), and subsequent updates proceed in order (FR-004). The document is not
  wedged: Yjs reads tolerate a missing update (021 machinery treats it as a permanent gap
  at that clock — observable, and the alarm already fired). Holding the queue forever
  would convert one lost update into losing every subsequent edit silently.
- **Rationale**: Fail-loud-and-continue preserves both the alarm semantics operators
  already rely on and the append-only log's self-healing posture.
