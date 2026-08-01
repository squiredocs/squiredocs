# Clarifications — 038-attribution-integrity

Decisions Sam has not explicitly answered, resolved with best defaults per the
parallel-pipeline protocol. Each is **RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-08-01)** and encoded in spec.md; flag at review if any default is wrong.

---

## D1 — No backfill of `via_sync` for pre-existing rows; `null` means "unknown" and behaves as "not sync"

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01)** — spec FR-009, SC-003, Assumptions.

- **Question**: Should existing `yjs_updates` rows be backfilled (e.g. all set to `false`), and how should consumers treat `null`?
- **Why it came up**: The design amendment specifies a *nullable* boolean but does not address historical data. A `false` backfill would falsely assert "known live edit" for rows that may in fact have been step2 re-supplies.
- **Rationale for default**: Historical step2 rows are indistinguishable after the fact, so any backfill would fabricate certainty. `null` = honest "channel unknown"; consumers treating `null` like `false` preserves exact current behavior for old data (no retroactive change to undo eligibility or guardrail output). This also matches the amendment's framing ("nullable via_sync flag") and keeps the migration trivial/reversible.

## D2 — Undo treats `via_sync = true` rows as foreign (run-breaking), not transparent

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01)** — spec FR-013, SC-004, edge case "identity run whose range contains only via_sync rows".

- **Question**: When log-derived undo's `deriveLegacyRange` "excludes via_sync rows from identity runs", does a flagged row (a) break the contiguous identity run like a foreign user's row (→ honest refusal), or (b) get skipped transparently so the run continues across it?
- **Why it came up**: "Excludes from identity runs" (design amendment + audit F2) is compatible with both readings, and they differ in user-visible undo behavior.
- **Rationale for default**: Foreign-row semantics are the conservative, already-established refusal model in `server/undo/legacy.js` (a run that cannot be pinned refuses honestly). Skipping transparently would let an undo range stitch across a re-supply and invert updates that causally interleave with relayed content — exactly the class of surprise this feature exists to prevent. Worst case of the default is an honest "nothing left to undo", never wrongly inverted content.

## D3 — Guardrail annotation is informational only; paging decisions unchanged

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01)** — spec FR-014, SC-005.

- **Question**: When the collab guardrail's triggering update is sync-sourced, should the annotation also suppress (or downgrade) the page, since the "author" is a relay?
- **Why it came up**: "Annotates pages whose trigger was sync-sourced" (design amendment) doesn't say whether annotation affects alerting; a re-supplied mass-deletion is plausibly *less* alarming (replay) or *more* alarming (the 021 incident shape).
- **Rationale for default**: The guardrail exists to make silent data loss visible (021 amendment); suppressing on via_sync would create a blind spot for precisely the "client-side mechanism masquerading as a user" incidents it was built for. Annotate-only is reversible later with data in hand; suppression is a policy change Sam should make explicitly.

## D4 — Blocked viewer step2 frames: silent drop, connection stays open, no client-side notification, no escalation

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01)** — spec FR-002/FR-003, Assumptions ("repeated-violation policy unchanged").

- **Question**: Should a viewer connection that sends step2 frames be disconnected, throttled, or notified — or should frames be silently dropped like blocked update frames today?
- **Why it came up**: F1 prescribes dropping the frame and emitting `WS_STEP2_BLOCKED`, but not the connection-lifecycle policy for a peer that is, by definition, either running stale client code or attempting a bypass.
- **Rationale for default**: Mirrors the existing `WS_EDIT_BLOCKED` policy exactly (drop, log, stay open) — legitimate stale/edge-case clients keep their read-only session, and honest clients never send upstream step2 content they'd miss. The distinct event name makes bypass attempts countable so an escalation/anomaly policy (cf. the 034 detector follow-on) can be added deliberately later.

## D5 — `false` writes to `via_sync` are permitted but not required; consumers must treat `null` ≡ `false`

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01)** — spec FR-009.

- **Question**: Should the persistence path write `false` explicitly for live-edit rows going forward, or leave non-step2 rows `null`?
- **Why it came up**: A three-state column invites divergent consumer interpretations unless the contract is pinned.
- **Rationale for default**: Leaving non-step2 rows `null` keeps the write path minimal (only the step2 window ever sets the column) and keeps one uniform read rule — "only `true` means sync" — that is valid for both historical and new rows. Requiring consumers to treat `null` ≡ `false` forecloses accidental "null means suspicious" logic. Explicit `false` remains allowed if a future path wants positive channel assertions.
