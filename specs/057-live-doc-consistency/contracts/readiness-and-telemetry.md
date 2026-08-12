# Contract: readiness gate & telemetry (FR-009, FR-010, FR-012, RBD-057-5)

## Readiness (server/mcp/agent-presence.js)

1. **Arm**: at gate-arm time capture `C` = newest durable clock for the doc.
   No rows (`C` null) ⇒ resolve immediately (empty-doc edge case; counted=1
   docs resolve on that update's verified integration like any other).
2. **Resolve**: only when (stage 1) the pod's registry doc has verified
   integration through `C` (`_verifiedClock >= C` — set by bind or advanced
   by reconcile), and then (stage 2) the session doc's state vector
   dominates the registry doc's state vector captured at that moment. Later
   edits can only over-satisfy the condition (monotone; no starvation, no
   deadlock).
3. **Timeout unchanged**: the existing 10s wait (and 2s DB-error fallback)
   keeps today's duration and on-timeout resolve semantics — only the
   meaning of "ready" changes (SC-007).
4. **No first-event resolution**: the gate never resolves merely because an
   update event fired.

## Telemetry (server/telemetry/metrics.js; precedent recordBindRefusal)

| Counter | Labels | Contract |
|---|---|---|
| `collab.read.gapped_serves` | `gap.reason` ∈ {gap, short-tail, gap+short-tail} | one increment per still-incomplete serve, recorded centrally in the 021 choke point's incomplete branch (`_fetchRowsWithGapRetry`, today console.warn-only) so EVERY log-rebuild reader is covered, not just read_document |
| `collab.read.stale_serves` | — | one increment per staleness-marked read_document serve |
| `collab.bind.refusals` | `refusal.reason` ∈ {load-error, incomplete-load} | existing counter; reason label distinguishes 041 DB-health canary from 057 incomplete loads |
| `collab.reconcile.repairs` | — | one increment per pass that applied a previously-uncovered row |

- All recorders swallow their own failures (metrics faults never propagate).
- Bounded cardinality: no docGuid/user labels.
- Each counter has a fault-injection test proving it increments (SC-006),
  via the on-demand metric reader harness.

## Supersession annotation (FR-012)

`specs/039-diff-cache-integrity/contracts/read-completeness.md` §
Non-consumers gains a short annotation: its "serving-only readers self-heal
on the next read" premise is superseded for memoized/bound readers by the
2026-08-11 design amendment and this feature. Annotation only — the 039
contract otherwise stands.
