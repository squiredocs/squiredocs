# Data Model: Sync Apply Correctness and Honest Receipts (056)

No database entities — no schema change, **no migrations** (hard constraint:
if one appears necessary, STOP and report). Every entity below is an in-memory
value inside one `applySyncPush` run (or its DB-free replay equivalent), plus
the receipt payload. Frozen upstream shapes (054 receipt fields, 055 planner
invariants) are referenced, not restated.

## Mapped run (existing — becomes the mark authority)

`{ mdStart, mdEnd, textNode, textOff }`, built by
`toMarkdownWithSourceMap` (`server/mcp/yjs/serialization.js`). Invariant
(pre-existing, now load-bearing): a run is a maximal same-marks span, so one
sampled character's attributes are THE run's attributes. 056 adds no field to
the run itself; it makes the run the sole source of inserted-text marks
(FR-001).

## Hunk (existing — gains plan-recorded attribution)

Baseline-vs-pushed diff edit: `{ oldStart, oldEnd, newText, forced? }`.
After classification a text-lane hunk carries `segments` (existing); 056
extends the segment record:

- `segments[i].attrs` — **new**: the resolved run's mark attributes, sampled
  at plan time from the baseline fork (R1). For an insertion
  (`oldStart === oldEnd`) the single zero-length segment's `attrs` is the
  run chosen by the resolution order (inside → left → following); for a
  replacement, `segments[0].attrs` is the first replaced character's run.
- Validation: attrs is a plain attributes object (possibly `{}`); apply never
  recomputes it and never probes the document for it.

Classification gains the bracket rule (FR-005): a hunk whose `newText` OR
whose replaced baseline slice contains `[`/`]` (incl. escaped forms) is not
plain text.

## Push plan (existing — gains the lane-exclusivity invariant)

`{ textBlocks, reconcileBlocks, structural, counts }` from `planPush`.

**New invariant (FR-004)**: a source-map block appears in AT MOST ONE lane.
If any non-forced structural hunk claims a block, every hunk of that block is
in `structural` (fold-together, R2). Forced hunks and edge-block insertions
are outside the invariant's trigger (they are not "edits of" the claimed
block's interior). `counts` remains the plan-side view; it is no longer what
receipts report (see Apply result).

State transitions of a block group through planning:

```
classified text hunks ──(no structural claim)──▶ allPlain? ─yes─▶ textBlocks
        │                                            └─no─▶ reconcileBlocks ─(declined)─▶ structural (all hunks)
        └──(block claimed by structural hunk)──▶ FOLD ──▶ structural (all hunks)
```

## Apply result (NEW — sole source for receipt op reporting)

Returned by `applyHunks` (replaces the `{ ...plan.counts }` echo):

```js
{
  textHunks: int,        // text-lane hunks whose ops actually ran (054 name, now truthful)
  structuralHunks: int,  // structural hunks realized by an applied rebuild/insertion (054 name)
  skipped: int,          // NEW — operations apply declined; 0 on every healthy push
  outcomes: {
    reconciled:   [{ blockNode, applied: bool }],
    textBlocks:   [{ blockNode, applied: bool }],
    replacements: [{ first: int, last: int, applied: bool }],  // structural groups
    insertions:   [{ afterBlock: blockObj|null, applied: bool }],
  },
}
```

Skip paths that set `applied: false` + increment `skipped`: replaced-block
guards (dead post-fold, kept as defense), unresolvable block node
(`indexOf === -1`), insertion whose markdown parses to zero nodes. A
replacement whose rebuild parses to zero nodes is a legitimate whole-block
deletion — `applied: true`, not a skip.

Count provenance (FR-011): `textHunks` keeps 054's meaning, which INCLUDES
reconcile-lane hunks (`planPush` counts `bh.length` for both text and
reconcile branches today). `reconcileBlockPlan`'s return therefore gains a
`hunkCount` field (the folded group's `bh.length`) so an applied reconcile
contributes its hunks to `textHunks`; a skipped reconcile contributes them
to `skipped`. Structural groups already carry `g.hunks` (count available);
boundary insertions count 1 hunk each.

## Sync receipt v3 (receipt payload — additive over 054's v2)

All 054 fields unchanged in name and meaning (FR-011): `docId`, `mode`,
`noop`, `clock`, `markdown` (re-export ground truth; still omitted only under
`dryRun`), `overlaps`/`overlapsUnavailable`, `operations` aggregates,
`blocksChanged` (same `text | reconcile | structural` vocabulary, same entry
shape), `baselineClock`/`currentClock`/`clockGap`/`docChangedSinceBaseline`,
`dryRun` marker rules, `images`.

Additions (contract: `contracts/sync-receipt-v3.md`):

- `converged: bool` — on EVERY `mode=sync` receipt (applied, both noop
  shapes, dry run). Definition (RBD-056-1): the fork's post-apply
  serialization byte-equals the pushed canonical markdown. Derivations per
  branch in research R5.
- `operations.skipped: int` — additive key inside the existing aggregate.
- `operations`/`blocksChanged` now DERIVE from the apply result: skipped work
  is never reported as applied; `blocksChanged` lists only blocks apply
  actually changed; a folded block appears once as `structural` (RBD-056-7).

Truth table for the honesty pair:

| Situation | noop | converged | skipped |
|---|---|---|---|
| healthy applied push | false | true | 0 |
| canonical-equal noop (file == baseline) | true | true | 0 |
| already-applied re-push, doc matches file | true | true | 0 |
| already-applied re-push, doc diverged (field S1) | true | **false** | 0 |
| net-zero apply (doc == baseline ≠ file) | false | **false** | 0 |
| any apply-skip survivor path | false | false (unless coincidental) | >0 |

## Verification corpus (NEW — committed test data)

The ~40 scenarios of `specs/056-sync-apply-correctness/repro/repro{1..4}.js`,
encoded as scenario tables in
`server/__tests__/markdown-sync.apply-correctness.test.js` (R7). Families:
boundary insertions at link/bold edges (repro1: L1–L7, B1–B5), mixed and
structural link edits (repro2: U1–U4, D1–D2, M1, A1, C1–C3, W1, MB1–MB3),
mark-inheritance repair loops + stale-baseline noop emulation (repro3:
P1–P4, S1), link fuzz (repro4: F1–F10). Each scenario asserts convergence,
repair convergence, receipt honesty, and leak-freedom per research R7. The
repro scripts themselves stay committed unchanged as the executable seed
record.
