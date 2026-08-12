# Contract: Sync Receipt v3 — converged, apply-derived reporting

**Feature**: 056-sync-apply-correctness
**Amends**: `specs/054-sync-feedback-hardening/contracts/sync-receipt-v2.md`
(which amends the base `specs/004-two-way-sync/contracts/sync-push.md`).
**Design authority**: `design/markdown-import-two-way-sync.md`, Amendment
(2026-08-11) — apply correctness and honest receipts (feature 056).

This document defines **only the delta**. Transport, auth, staleness fields,
`strict`, `dryRun` mechanics, `blocksChanged` entry shape, overlaps, images,
and the `markdown` re-export rule are unchanged and still governed by the
004 + 054 contracts. Additive throughout: no field is removed, renamed, or
retyped (FR-011, SC-006).

---

## `converged` — on every sync receipt

Present on **every** `mode=sync` 200 response: applied, canonical-equal noop,
already-applied noop, and dry run. Absent from rejection bodies (they are not
receipts) and from `mode=append`/`mode=replace`/create receipts (out of
scope).

```json
{ "converged": true }
```

**Definition** (RBD-056-1, fork-side): the engine's post-apply fork
serialization — canonical markdown in the push's flavor, the same
canonical form the diff runs on — is **byte-identical** to the pushed
canonical markdown. `converged: true` implies the pushed file's content was
fully realized by the engine (FR-008).

Per-branch determination:

| Branch | Value |
|---|---|
| Applied push | fork result vs pushed file, computed before the store |
| Canonical-equal noop (file == baseline) | `true` — nothing to apply |
| Already-applied noop | the recomputed fork result vs pushed file — a diverged doc reads **`false`** (FR-010) |
| Dry run | identical determination to a real push, computed fork-side with no durable write (FR-012, RBD-056-6) |
| Net-zero apply | `false` — fork == baseline ≠ pushed (FR-009) |

**What it does NOT measure**: live-document divergence from concurrent edits.
That remains the 054 staleness quartet's job
(`docChangedSinceBaseline` etc.). An apply-correct push over a concurrently
edited doc reads `converged: true` + `docChangedSinceBaseline: true` —
deliberately distinct signals (RBD-056-1; ledger design gap 1).

**The repair signal**: `noop: true, converged: false` means "your file and
the doc disagree; re-pull and repair" — `noop: true` alone no longer
certifies success. The engine performs no auto-retry, fallback, or rollback
on `converged: false` (RBD-056-4); the client-side remedy is a fresh-baseline
push, which FR-014 guarantees converges.

## `operations.skipped` — and truthful aggregates

```json
{ "operations": { "textHunks": 4, "structuralHunks": 1, "skipped": 0 } }
```

- `textHunks` / `structuralHunks` keep their 054 names and "work performed"
  meaning — now guaranteed: they count operations the apply layer actually
  performed, derived from the apply result, never from the plan (FR-007).
- `skipped` (**new**): operations the apply layer declined (unresolvable
  block node, empty insertion parse, any future skip path). **`0` on every
  healthy push** — the fold-together rule designs the known skip paths out;
  the counter is defense in depth (RBD-056-2). `skipped > 0` on a receipt is
  an anomaly alarm, always accompanied by honest aggregates.
- Noop receipts keep zero counts (`textHunks: 0, structuralHunks: 0,
  skipped: 0`) — a noop performs nothing *now*; `converged` carries the
  divergence alarm.

## `blocksChanged` — applied blocks only

Entry shape, vocabulary (`text | reconcile | structural`), ordering, excerpt
rules, and insertion `position` semantics are unchanged from v2. Two
semantic tightenings:

- The list contains **only blocks the apply layer actually changed** — an
  entry is never emitted for an operation apply skipped (FR-007). No
  entry-level "skipped" rows exist (RBD-056-2): `operations.skipped` +
  `converged` are the alarm; the `markdown` re-export is ground truth.
- A block whose hunks were folded into a structural rebuild (FR-004) appears
  **exactly once**, with `op: "structural"`; its former text/reconcile hunks
  count toward `structuralHunks`, not `textHunks` (RBD-056-7).

## Engine behavior guarantees surfaced by this contract

These are engine-side rules v3 receipts are the witness for (spec FR-001..006):

- Inserted text's marks are decided at plan time by the resolved mapped run
  (following-run rule at closing-syntax boundaries; left-preference at run
  ends preserved unchanged); apply never probes document neighbors.
- A block's hunks travel together into any structural rebuild — no partial
  rebuilds, no silently dropped edits.
- Unbalanced square brackets classify as mark syntax; the engine does not
  emit raw link syntax (`](`, stray unmatched brackets) as literal text
  where the pushed file had a well-formed construct.
- Corpus + repair convergence: a push of desired content against a freshly
  re-exported baseline converges in one push (`converged: true`) for any
  engine-reachable state (FR-013/014).

## Compatibility summary (FR-011, SC-006)

| Field | Status |
|---|---|
| Every v2 field (`docId`, `mode`, `noop`, `clock`, `markdown`, `overlaps`, `overlapsUnavailable`, `operations.textHunks`, `operations.structuralHunks`, `blocksChanged`, `images`, staleness quartet, `dryRun` marker) | Unchanged names, types, and meaning |
| `converged` | **Added** — every `mode=sync` receipt |
| `operations.skipped` | **Added** — every `mode=sync` receipt |
| `operations` / `blocksChanged` derivation | Now apply-derived (truthful); shapes unchanged |
| Receipt markdown frontmatter / baseline validity | Unchanged — previously written baselines remain valid push inputs |
| Error codes | Unchanged — no new rejections |
