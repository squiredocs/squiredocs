# Data Model: Block-Aligned Merge Pre-Pass (055)

All entities are transient in-memory structures inside one `applySyncPush`
call (no storage, no migrations). Shapes below are the implementation contract
for tasks; field names are binding unless a task records a deviation.

## Existing entities (consumed, unchanged)

### Baseline block (source-map block)
From `toMarkdownWithSourceMap(...).sourceMap.blocks` (serialization.js:558):

| Field | Type | Meaning |
|---|---|---|
| `mdStart`, `mdEnd` | int | extent [start, end) in the baseline canonical markdown |
| `blockIndex` | int | top-level child index in the fragment |
| `blockNode` | Y.XmlElement\|Y.XmlText | live node on the fork — collaboration identity |

Invariant: extents are disjoint, ordered, and byte-consistent with the
canonical string (serializer-owned; 055 never computes extents by hand).

### Pushed block (NEW use of the same shape)
Same source-map block shape, produced by serializing the canonicalization
scratch fragment with `toMarkdownWithSourceMap` (research R1). Only
`mdStart`/`mdEnd` are meaningful downstream (the scratch `blockNode` is
destroyed with the scratch doc); the canonical block string is
`pushedMd.slice(mdStart, mdEnd)`.

### Hunk
`{ oldStart, oldEnd, newText }` in baseline coordinates — unchanged. 055 adds
one optional tag (see ForcedHunk).

### Plan
`planPush` output — shape frozen (054's `blocksChanged` builder and
`pushTouchedBlocks` read it):

```js
{
  textBlocks:      [{ block, hunks: [hunk+{segments}] }],   // op kind: text
  reconcileBlocks: [{ block, textNode, targetDelta }],      // op kind: reconcile
  structural:      [ hunk + { blocks: [baselineBlock...] } ],// op kind: structural
  counts:          { textHunks, structuralHunks },
}
```

## New entities

### BlockAlignment
Output of the pre-pass over `baseMds` / `pushedMds` (canonical block strings):

| Field | Type | Meaning |
|---|---|---|
| `anchors` | `[{ baseIdx, pushedIdx }]` | exactly-equal blocks matched by the block LCS (`diffArrays`); strictly increasing on both sides |
| `pairs` | `[{ baseIdx, pushedIdx, sim, degraded }]` | similarity-matched gap pairs, `sim ≥ SIMILARITY_THRESHOLD`; strictly increasing on both sides (order-preserving); `degraded: true` when the in-pair diff tripped `MAX_EDIT_LENGTH` (pair becomes a forced replace) |
| `residualRuns` | `[ResidualRun]` | leftovers, see below |

Determinism invariant: identical `(baseMds, pushedMds)` inputs yield an
identical alignment (RBD-055-2, FR-003, FR-011).

### Gap
Implicit intermediate: between consecutive LCS anchors (and at the document
edges), `N ≥ 0` baseline blocks × `M ≥ 0` pushed blocks. Pairing runs per gap:
max-similarity order-preserving DP when `N·M ≤ MAX_GAP_DP_CELLS`, else
positional pairing (research R4).

### SimilarityScore
Pure function, not stored: `sim(a, b) ∈ [0, 1]` per research R3's bounded
ladder (exact-equal → 1; either side > `PAIR_INPUT_MAX` → 0; length upper
bound < threshold → 0; diff cap tripped → 0; else Dice `2C/(|a|+|b|)`).
Deterministic and symmetric.

### ResidualRun
A maximal run of unmatched blocks between two pairing landmarks (gap edge or
matched pair) inside one gap:

| Field | Type | Meaning |
|---|---|---|
| `baseIdxs` | `[int]` | D contiguous unmatched baseline blocks (may be empty) |
| `pushedIdxs` | `[int]` | I contiguous unmatched pushed blocks (may be empty) |

Emission (research R6): D > 0 → one forced replace hunk over the D blocks with
`newText` = joined pushed strings (I = 0 → delete); D = 0, I > 0 → one
insertion hunk (single hunk per run — anchor-ordering requirement), anchored
on the nearest preceding *surviving* baseline block, or folded into a
preceding forced replace (anchor-folding rule).

### ForcedHunk
A hunk emitted by the aligner, not by a character diff:

| Field | Type | Meaning |
|---|---|---|
| `oldStart`, `oldEnd` | int | union extent of the covered baseline blocks (insertions: `oldStart === oldEnd` at the anchor point, inside the inter-block separator or 0) |
| `newText` | string | pushed block strings joined with `\n\n` (`''` for delete) |
| `forced` | `true` | tag: `planPush` routes to `plan.structural` without `classifyRange` |
| `blocks` | `[baselineBlock]` | resolved covered blocks (`[]` for insertions) |

Invariant (FR-005): forced hunks cover whole baseline block extents only, and
their `newText` is a whole-pushed-block concatenation — never a partial block
on either side.

## State transitions

```text
(baseMds, pushedMds)
  → BlockAlignment (anchors → gaps → pairs + residual runs)     [pure]
  → hunks: in-pair char hunks (untagged) + ForcedHunks          [pure]
  → Plan (planPush: forced → structural; rest via classifyRange)[pure]
  → fork mutations (applyHunks, inside one transaction)          [unchanged]
  → pushUpdate → store-then-apply                                [unchanged]
```

Failure/degradation transitions (all local, RBD-055-6):
- pair similarity uncomputable (size cap / diff cap) → pair below threshold →
  ResidualRun → forced replace;
- matched pair's in-pair diff trips `MAX_EDIT_LENGTH` → `degraded: true` →
  forced replace of that pair only;
- gap exceeds `MAX_GAP_DP_CELLS` → positional pairing for that gap only.
No transition leads to a whole-document fallback.

## Named constants (implementation-tunable, not protocol surface)

| Constant | Value | Status |
|---|---|---|
| `SIMILARITY_THRESHOLD` | 0.5 | new (RBD-055-1, boundary-tested per FR-011) |
| `PAIR_INPUT_MAX` | 16 * 1024 | rename of `COARSE_CLUSTER_MAX`, same value |
| `MAX_EDIT_LENGTH` | 10000 | unchanged |
| `COALESCE_DISTANCE` | 3 | unchanged |
| `MAX_GAP_DP_CELLS` | 10_000 | new (R4 pairing-cost bound) |
| `COARSE_INPUT_THRESHOLD` | — | **deleted** with the coarse path (RBD-055-5) |
