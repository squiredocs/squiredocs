# 042-version-history-simplification — promotion notes

## Review dispositions (Fable adversarial review of ee52edd3, 2026-08-02)

Verdict: FR-001 substantially true; ~90% of the diff verifiably
behavior-preserving; all five 041 review fixes and all seven source-regex pins
survived; deletions verified safe. Findings:

- **F1 (HIGH, fixed same-day)**: the shared restore flow moved the header's
  restore from live-at-confirm to captured-at-open semantics — a contract C7
  violation, user-visible when the 10s poll re-splits history mid-dialog. Fix:
  `useRestoreFlow` gained `confirmWith(liveTarget)`; the header confirms with
  the live selection from a per-render closure (null → no-op, dialog stays
  open); the row menu keeps captured-at-open `confirm()`. Pinned by the new
  `useRestoreFlow.test.js`; the misleading EditorView comment corrected.
- **F2 (MEDIUM, fixed same-day)**: the shared backoff consolidation widened the
  store slot's retry scope to include `pool.connect()` (pre-042: acquire
  failures threw un-retried; ~5s → ~15s+ FIFO-slot hang under pool
  exhaustion). Fix: `retryWithBackoff` gained a `retryOn` predicate; the store
  slot marks acquire failures non-retryable. Fresh-client-per-attempt for
  critical-section failures (genuine pre-042 behavior) preserved. Both pinned
  in `postgres-persistence.test.js` ("042-review F2" describe).
- **F3 (LOW, no action)**: `getClockRange` answers range checks without the
  gap-retry delay table — timing-only, values identical in every state.
- **DEC-14 adjudicated ACCEPTABLE**: `loadContentAtClock` deletion (zero
  consumers) took its same-day fixer test; the property holds a fortiori and
  the live sibling's coverage is intact.
- **DEC-16 adjudicated ACCEPTABLE with caveat recorded**: the defaulted fourth
  `computeMarkdownDiff` parameter narrows the 039 arity pin from "no fourth
  parameter" to "no required fourth parameter" — documented openly, not gamed.

## Owed / deferred (from implementation + merge rulings)

- **DEC-13**: diff cache-version fingerprint automation descoped (conflicts
  with three frozen 039 pin assertions under FR-001). Owed to the post-train
  convergence round, where updating those pins is a deliberate, contract-level
  act. Until then the pins force a conscious bump decision on every pipeline
  edit. SC-006 unmet by design.
- **DEC-15**: SC-002 judged met on the renegotiated basis (−512 net excluding
  the three plan-mandated new test files; −51 production-only; ~900 gross dead
  lines removed).
- **T058/T059 (Sam)**: manual browser walk; two-instance convergence run (the
  static half — no ROOT_CAUSE block remains, apply-error log intact — is
  verified).
