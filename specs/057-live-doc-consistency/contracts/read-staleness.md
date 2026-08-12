# Contract: read_document one-source clock & staleness (FR-001, FR-002, RBD-057-1/6)

Surface: MCP tool `read_document` (current-content path only; version reads
unchanged — they already build at a fixed clock).

## Guarantees

1. **Label honesty**: the response `clock` is the highest clock N such that
   every durable row ≤ N is provably integrated into the *served content*
   (state-vector coverage of the served doc — the agent-session doc, not the
   registry doc). It is impossible for `clock` to claim a row the content
   did not integrate. The field-report shape (label 9, content {1, 5–9})
   labels 1.
2. **Staleness indicator**: iff this call's own durable-clock observation
   exceeds the verified clock after verification, the response additionally
   carries `newestClock`, `stale: true`, and `stalenessNote`. A current copy
   carries none of these (including a doc read milliseconds after a fresh
   bind, and a pod made current by fan-out — verification proves currency,
   preventing spurious markers).
3. **Repair trigger**: a stale serve fire-and-forgets a reconcile pass for
   the doc; it never awaits it (no added read latency). A subsequent read
   after reconciliation labels the newest clock with no staleness fields.
4. **Additive only**: no existing field changes meaning, type, or presence
   rules beyond `clock` becoming honest. Callers ignoring the new fields get
   strictly safer behavior (baselines never overclaim).

## Cost bounds

- Verified == newest: zero queries beyond what the read already performs.
- Behind: exactly one `getUpdatesInRange(verified+1, …, includeData)` fetch
  of the unverified suffix + per-row SV decode. Never a full-log rebuild,
  never a lock, never a wait on repair.

## Test obligations

- US1 acceptance 1–3 (current / lagging / torn-interior shapes) under fault
  injection; SC-001 (label never exceeds integrated contiguous clock, by
  construction, asserted over injected tears).
- Spurious-marker edge cases: fresh bind; fan-out-current pod.
- Stale serve increments `collab.read.stale_serves` and triggers reconcile.
