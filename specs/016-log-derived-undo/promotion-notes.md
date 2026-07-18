# Feature 016 — Post-Merge Review Dispositions (promotion notes)

Adversarial review of merge `2cb685f` (log-derived agent-edit undo/redo).
Fixes landed on main the same pass, one commit per finding, each new test
first shown red against the pre-fix code (method: per-finding test-first —
the failing assertions were run against the unmodified sources before each
fix was applied; the L6 collision was additionally reproduced directly:
`'sandbox-exec-' + Date.now()` minted twice in one millisecond compares
equal).

The review's verified-correct list (everything not below) held — no
regressions were found in re-verification while fixing.

## Fixed

| Finding | Disposition | Commit |
|---|---|---|
| **H1** — applyToLiveDoc never fanned the committed inverse out cross-instance from a connection-less pod: the redis update handler is attached only in the WS connection handler, so a doc reached via getSharedDoc on the undo path published nothing and remote editors went silently stale | FIXED — explicit `publishUpdate` when (and only when) the shared doc has no `_redisUpdateHandler` (or does not exist); a connected doc already publishes because `ORIGIN_INVERSE_APPLY` is not on the handler's skip-list, so no double-send. `redisPubSub` injectable via deps. Tests: publish-once without handler / no publish with handler / restart posture / disabled redis / redo parity | `7244d98` |
| **M1** — a recorded edit's spanning `[min,max]` range reverted interleaved same-identity rows from a concurrent call (A: 10,12; B: 11,13 — undoing A also reverted 11) | FIXED — `agent_edits.undo_target_clocks int[]` (migration `1796500000000`, deliberately between 016's `1796…` and 017's reserved `1797…`; the applied `1796…` migration untouched). awaitDurableRange returns the exact covering clock set; recordEdit persists it; redo claims rewrite it to `[c']`; computeInverse tracks exactly those clocks; null set (legacy first-undo inserts, pre-migration rows) keeps the spanning fallback. Tests: interleaved-calls inverse unit test + DB-threaded double-undo byte-for-byte | `43bb4e3` |
| **M2** — an undo during the editRangePending window (RBD-8) honored nextUndoTarget and silently undid the WRONG (older) edit while the newest was still being recorded | FIXED — `hasPendingRecording` probe: an acting-identity log row newer than every clock the records account for (edit ranges + undo/redo targets, i.e. chain inverses) and younger than `EDIT_RANGE_BACKGROUND_WAIT_MS` triggers the honest refusal "your latest edit is still being recorded — retry shortly". Rows older than the bound can never be recorded and never wedge undo. Tests: refusal + older edit untouched / proceeds once recorded / orphaned-row non-wedge | `e2c2926` |
| **M3** — claim TOCTOU: the state-only CAS let an inverse computed from a stale read of the target range commit | FIXED — claims CAS on state AND range: undo `WHERE id AND state='active' AND undo_target_start=$ AND undo_target_end=$`, redo symmetric on `redo_target_*`; `finalizeClaim` requires `targetRange` for undo/redo modes and undo-service passes the range it computed from. Test: mismatched-range undo and redo claims both refused, nothing transitioned or appended | `61470ac` |
| **L3** — deriveLegacyRange accepted a run starting at the first row of the bounded 100-row window, where the run's true start is unprovable | FIXED — refuse when the derived run begins at the window head unless that row is clock 0 (the log provably begins there); applies to both the anchorless and baseline-anchored paths | `8e1353f` |
| **L4** — the anchorless legacy freshness threshold (10s gap) was below the 60s background recording bound, so a still-recording 016 edit could be mis-derived as legacy | FIXED — `LEGACY_FRESHNESS_MS = EDIT_RANGE_BACKGROUND_WAIT_MS` (constant now shared from `server/mcp/yjs/edit-range.js`); guard uses `max(gapMs, freshnessMs)` | `8e1353f` |
| **L6** — `sandboxOrigin = 'sandbox-exec-' + Date.now()` collides for executions starting in the same millisecond; colliding origins merge two executions into one rollback stack item, so an error in one reverts the other's updates | FIXED — monotonic per-process sequence suffix (`makeSandboxOrigin`), uniqueness pinned by test | `d65b045` |
| **Nits** — chat.js `CHAT_AGENT_ID`/`buildChatAgentToken` comments still described the retired session-Y.UndoManager coupling; inverse.test.js `LogBuilder.applyRow` ignored its `identity` param and never appended the row | FIXED — comments now describe the 016 log-derived identity coupling; applyRow records the attributed row as documented | `0502038` |

## Accepted / Owed (no code change this pass)

- **L1 — ACCEPTED**: the inverse's `yjs_updates` row commits in the claim
  transaction before the live apply; a crash inside that same-millisecond
  window leaves a durable inverse row that a doc reload replays (the restore
  posture, research R3/RBD-9). The store-then-apply ordering is the
  deliberately chosen pole of the RBD-9 ledger decision — the reverse order
  risks an applied-but-unpersisted inverse, which is worse. Accepted with
  this RBD-9 note.
- **L2 — ACCEPTED (improve-later candidate)**: under a multi-instance persist
  race, log clock order can invert causal order (an identity row persisted
  with a LOWER clock than a foreign row it depends on). The scratch rebuild
  then integrates the tracked row inside a later untracked transaction and
  the undo reports a misleading "superseded" no-op. Honest-empty is the safe
  failure pole (nothing is corrupted, nothing wrong is reverted); fixing it
  properly means dependency-aware replay ordering. Noted as an
  improve-later candidate.
- **L5 — ACCEPTED for beta**: an undo on a pod with no WS connection for the
  doc creates a WSSharedDoc via getSharedDoc that nothing tears down (the
  cleanup path hangs off connection close). Bounded: one doc instance per
  undone doc per pod, reclaimed on process restart/deploy. Revisit if
  connection-less undo volume grows.
- **L7 — OWED**: RBD-10's baselineClock-anchored legacy mode is dead code —
  no caller passes `baselineClock` (the chat parts that persisted it were
  retired before 016 shipped), so the anchored branch of deriveLegacyRange
  is unreachable in production. This is a capability gap versus the ledger's
  RBD-10 description: either wire the persisted baseline through the chat
  undo path or amend RBD-10 to retire the anchored mode. Owed to Sam's next
  ledger pass. (The L3 guard was still applied to the branch so it is safe
  if ever wired.)
