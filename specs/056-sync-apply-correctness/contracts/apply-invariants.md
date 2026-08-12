# Contract: Apply-Layer Invariants (internal)

**Feature**: 056-sync-apply-correctness
**Scope**: internal engine contract for `server/markdown-sync.js`
(`classifyRange`, `planPush`, `applyHunks`, `buildChangeReport`,
`applySyncPush`) and its DB-free replay harness. Companion to
`sync-receipt-v3.md` (the external surface). Preserved upstream contracts:
054 `sync-receipt-v2.md`, 055 `planner-invariants.md` — both frozen.

## I1 — Marks are plan data (FR-001/002/003)

- Every text-lane hunk carries plan-recorded mark attributes
  (`segments[*].attrs`), sampled at classification time from the resolved
  mapped run in the pristine baseline fork.
- Resolution order is UNCHANGED (RBD-056-5, load-bearing for normal typing):
  1. offset strictly inside a run → that run;
  2. offset at a preceding run's mapped end → that (left) run — the
     left-preference branch, preserved verbatim (FR-003);
  3. offset at a following run's mapped start → that (following) run — the
     comma-after-link rule (FR-002);
  4. otherwise (inside syntax, between blocks) → structural.
- Replacements record the first replaced character's run attrs: replacement
  text takes the replaced text's marks.
- `applyHunks` formats inserted text with the recorded attrs **only**. It
  MUST NOT read `toDelta()` of the live/fork document to choose marks; the
  `at - 1` anchor probe is removed, not conditionalized.

## I2 — Lane exclusivity / fold-together (FR-004, RBD-056-7)

- Post-plan invariant: a source-map block appears in at most one lane of
  `{ textBlocks, reconcileBlocks, structural }`.
- If any non-forced structural hunk claims a block, ALL of that block's
  hunks are in the structural lane, and the rebuild string for the block's
  group is composed from all of them in `oldStart` order.
- Non-triggers: forced (055 aligner) hunks — they already carry full block
  content and must not be folded into or doubled by anything; edge-block
  insertions (`blocks: []`) — insertions beside a block, not edits of it.
- Receipt view: a folded block reports once, `op: 'structural'`; its hunks
  count as `structuralHunks`.

## I3 — Bracket syntax classification (FR-005/006)

- A hunk is not plain text if its `newText` contains any of the existing
  inline-syntax class **or `[` or `]`**, or if its replaced baseline slice
  contains `[`, `]`, `\[`, or `\]`.
- Non-plain hunks route through whole-block reparse lanes (reconcile →
  structural). Consequence (FR-006): the engine never composes a rebuild
  string from a subset of a block's edits, and never emits raw `](` or
  stray unmatched brackets as literal text where the pushed file had a
  well-formed construct.

## I4 — Apply results are the reporting source (FR-007)

- `applyHunks` returns the apply result (see `data-model.md`): performed-op
  counts + per-outcome applied/skipped flags. `plan.counts` is planning
  telemetry only and never reaches a receipt.
- Every skip path is counted, none is silent: replaced-block guards
  (defense-in-depth post-I2), unresolvable block node, empty insertion
  parse, and any future skip path added to apply MUST register an outcome.
- A replacement rebuild parsing to zero nodes is a deletion (applied), not
  a skip.
- `blocksChanged` is filtered by outcomes: only apply-changed blocks appear.

## I5 — `converged` (FR-008/009/010/012)

- Single mechanism: byte equality of the fork's post-apply canonical
  serialization (push flavor) with the pushed canonical markdown. Computed
  fork-side on every branch (applied / already-applied noop / dry run);
  canonical-equal noop is `true` by definition.
- No auto-retry, fallback, or rollback on `false` (RBD-056-4). The push
  stands as applied and the receipt tells the truth.

## I6 — Convergence properties (FR-013/014/017)

- Corpus convergence: every scenario in the committed verification corpus
  converges on the first push (SC-001).
- Repair convergence: for any engine-reachable document state, a push of
  desired markdown against a freshly re-exported baseline converges in that
  one push (SC-002). A no-progress push is impossible to misread: it
  reports `converged: false` with zero-effect counts.
- Round-trip: `import(export(doc))` remains a no-op; unchanged exported
  files sync as canonical-equal noops with `converged: true`.

## I7 — Frozen surfaces (FR-011/016)

- 055 alignment layer: no changes to `alignBlocks`, `blockSimilarity`,
  forced-hunk emission, thresholds, or caps; forced hunks still skip
  classification.
- 054 receipt fields: names, types, semantics unchanged; additions per
  `sync-receipt-v3.md` only.
- No schema/migrations; no serializer changes; no new dependencies.
- Constitution IV note: structural block replacement remains the
  design-sanctioned bounded exception (055 RBD-055-4/-5); 056 does not
  widen when it triggers for previously-converging text edits except where
  correctness requires it (fold-together, bracket hunks) — and the corpus
  suite is the check that this widening never breaks convergence or CRDT
  identity of untouched blocks.
