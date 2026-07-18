# Promotion notes — 015-agent-presence-dedup

Merged to main 2026-07-18 (`87e7e0c`), post-merge review fixes same day
(`9856b61`..`f7874c6`). Authoritative verification on main after fixes:
172 backend suites / 2959 passed, 50 client files / 639 passed, build OK.

Red verification: after all fixes were committed, the pre-fix sources
(`git checkout 87e7e0c -- server/mcp/agent-presence.js server/mcp/presence-claim.js`)
were run against the new test set — exactly the 7 new tests failed (3
CRITICAL-1 real-awareness regressions, the HIGH-1 two-pod handoff, the
MEDIUM-1 crossed-nudge convergence, the LOW-1 successor-release, the NIT-1
colon-agentId collision) while all 11 pre-existing tests in those suites
still passed; fixed sources were then restored from HEAD and everything is
green.

## Post-merge review dispositions (2026-07-18)

| Finding | Severity | Disposition |
|---|---|---|
| Re-announce after silence is a permanent no-op: y-protocols `setLocalStateField` no-ops on a null local state, and silencing uses `setLocalState(null)` — after the first A→B→A handoff the returning pod's avatar stayed dark cluster-wide despite `claimState='holder'` | CRITICAL-1 | FIXED in `9856b61` — `_setAwareness` rebuilds the WHOLE state (user + cursor restored from session state) when the local awareness state is null, covering both re-announce paths (`_onClaimAcquired` and the `wasSilent` takeover branch in `getOrCreateSession`). Contract §A onAcquired bullet amended to prescribe the full-state rebuild. Regression tests use REAL `awarenessProtocol.Awareness` instances and assert observable state. |
| The suites verified mocks exactly where CRITICAL-1 lived (call-shape assertions can pass while the write never lands) | HIGH-1 | FIXED in `a3b88f4` — two-pod integration test: two isolated agent-presence/presence-claim module pairs + one fake Redis + two REAL Awareness objects, driving A→B→A (and B→A→B) through the real `getOrCreateSession` path, asserting exactly one non-null announcer after each settle and the returning pod's state (user + cursor) non-null after re-acquire. Fake bus gained `queueBus()`/`flushBus()` for delayed/reordered nudge delivery. |
| Crossed nudges → both instances silent; the SET NX probe cannot reclaim a key its own instance still owns, so convergence took ~TTL (15–20s), not one heartbeat | MEDIUM-1 | FIXED in `b80dec8` — third Lua command `claimAdopt` (acquire-if-free-**or-mine**) replaces the NX probe in the non-holder heartbeat branch; emulated in the fake Redis; contract §A/§B amended. Test drives the both-silent crossed-nudge state via queued bus delivery and asserts a single announcer within ONE heartbeat tick. |
| Cleanup's fire-and-forget `release` could DEL a successor session's fresh claim on the same instance (Lua owner check is per-instance, successor carries the same instance ID) | LOW-1 | FIXED in `402e5fb` — `release` re-checks, after the async hop and immediately before issuing the DEL, whether a live claim record for the key exists again (recreated by a successor) and skips the delete, logging `release skipped (successor holds the claim)`. Test settles hung fake-Redis ops in reverse to model the reordered completion. |
| `_findSessionByClaimKey` fast path could mis-resolve colon-bearing agentIds (`api-token:<id>` vs `api-token-<id>` dash collision) and silence the wrong session | NIT-1 | FIXED in `03f8204` — fast path now requires `session.claimKey === claimKey` before returning; the exact fallback scan handles non-matches. Test uses a dash-collision decoy session. |
| `server/mcp/yjs/streaming-insert.js` wrote awareness directly, bypassing the feature-015 write gate | NIT-2 | DELETED in `f7874c6` — verified dead code by grep (only self-references, no orphaned test); removed rather than routed through the gate so an ungated write path cannot be resurrected. |

## Review's verified-correct list — scrutinized and held

The review examined and explicitly upheld the rest of the feature; each was
re-scrutinized during fixing and held:

- Awareness-write gate coverage (FR-003/FR-004): every awareness write in
  `agent-presence.js` funnels through `_setAwareness`; force-writes limited to
  cleanup clearing — held.
- Cross-delete guard on cleanup (FR-014/FR-015): key-mapping ownership check
  before shared-index deletion and claim release — held.
- Fail-open discipline (FR-013/RBD-2/RBD-5): no throw reaches a tool call; ops
  raced against `AGENT_CLAIM_OP_TIMEOUT_MS`; single-transition logging — held.
- Lua owner-checked refresh/release protocol and shared-command-client usage
  (research R1/R2) — held.
- Init/subscription ordering (contract C): nudge handler registration before
  `redisPubSub.init()` is recorded, not dropped — held.
- Cursor recording while silent (research R6): `session.cursor` always updated,
  only the announce is gated — held.
- Nudge self-filter and idempotent lost/acquired handling — held.
- Disabled mode (FR-012): no `REDIS_HOST` → holder-favoring answers, zero I/O,
  zero timers, behavior identical to pre-015 — held.

## Convergence-claim correction (review finding, recorded for the ledger)

The feature's original claim that any dedup disagreement converges within one
heartbeat was WRONG for the crossed-nudge case before MEDIUM-1's fix: the
both-silent state could only converge when the stale key expired (~TTL,
15–20s at defaults). With the `claimAdopt` probe (`b80dec8`) the one-heartbeat
convergence claim is now actually true, and is enforced by test.

## Owed at/after promotion

- Deploy: prod runs the merged-but-unfixed `87e7e0c` behavior until the next
  deploy picks up these fix commits.
