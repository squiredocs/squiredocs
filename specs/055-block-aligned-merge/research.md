# Research: Block-Aligned Merge Pre-Pass (055)

All unknowns from the Technical Context resolved against the shipped engine
(`server/markdown-sync.js`, verified line-by-line 2026-08-11 — NOTE: the file
contains NUL bytes; plain `grep` reports it as binary. Use `grep -a` or read it
directly). Decisions below are plan-phase choices inside the envelope fixed by
spec RBD-055-1..7; none alters a ratified decision.

---

## R1 — Pushed-side block extents come from the source-map serializer

**Decision**: Obtain the pushed document's block extents by serializing the
canonicalization scratch fragment with `toMarkdownWithSourceMap` (already
exported from `server/mcp/yjs/serialization.js`, `sourceMap.blocks` =
`[{ mdStart, mdEnd, blockIndex, blockNode }]`) instead of `toMarkdownNodes`,
inside `canonicalizePushed` / `canonicalizePushedStaged`. Only the `blocks`
array is kept for the pushed side (runs/textNodes are irrelevant there; the
scratch doc is destroyed). The two functions gain `blocks` in their return
value; `canonicalizePushed` keeps returning a string by default and gains a
sibling that returns `{ markdown, blocks }` (exact shape pinned in tasks) so
existing test call sites migrate mechanically.

**Rationale**: Block extents must byte-agree with the canonical string.
Splitting canonical markdown on `\n\n` by hand fails inside fenced code blocks
(the only construct whose canonical form can contain a blank line) and would
create a second, drift-prone notion of "block" — the spec explicitly says to
reuse the engine's existing alignment notion, and the serializer already owns
block extents. The source-map variant is contractually byte-identical to
`toMarkdown` (design amendment 2026-08-11, ordered-list bullet, and existing
tests), so the canonical string is unchanged.

**Alternatives considered**: (a) hand-rolled fence-aware text splitter —
rejected: second source of truth for block boundaries, must exactly reproduce
the serializer's `\n{3,}`-collapse/trim assembly; (b) re-parse the pushed
markdown a second time to get extents — rejected: double work and same drift
risk.

## R2 — Block-level LCS via `diffArrays` over canonical block strings

**Decision**: The alignment anchor pass is `diffArrays(baseMds, pushedMds)`
from the already-imported `diff` package, where `baseMds[i] =
baselineMd.slice(blocks[i].mdStart, blocks[i].mdEnd)` — exactly the block-LCS
the overlap detector (`docSideChanges`, markdown-sync.js:843) already uses.
Unchanged (`common`) runs are exact anchors; a `removed` run followed by an
optional `added` run forms one **gap** (N baseline blocks, M pushed blocks;
either may be 0).

**Rationale**: Spec Assumptions pin this ("the pre-pass is expected to reuse
that approach, not invent a second alignment notion"). `diffArrays` compares
strings by value, handles duplicate blocks stably by sequence position (the
spec's duplicate-blocks edge case), and is near-linear for the mostly-equal
common case.

**Alternatives considered**: custom Myers over hashes — no benefit, new code.

## R3 — Dice similarity computed with bounded `diffChars` + sound pre-filters

**Decision**: `sim(a, b) = 2·C / (|a| + |b|)` where C = total length of the
unchanged parts of `diffChars(a, b, { maxEditLength: MAX_EDIT_LENGTH })`
(RBD-055-1). Bounded-work ladder, evaluated in order, each step deterministic:

1. `a === b` → sim 1 (no diff run).
2. Either side longer than the per-pair input cap (`PAIR_INPUT_MAX`, the
   existing 16 * 1024 constant, today named `COARSE_CLUSTER_MAX`) → sim 0
   without diffing (RBD-055-6).
3. Length upper bound: `2·min(|a|,|b|) / (|a|+|b|) < SIMILARITY_THRESHOLD` →
   sim 0 without diffing. Sound because C ≤ min(|a|,|b|), so the true Dice
   score cannot reach the threshold.
4. `diffChars` with `maxEditLength`; a `null`/undefined result (cap tripped)
   → sim 0 (RBD-055-6: cap-exceeded pairs are below threshold).
5. Otherwise sum unchanged-part lengths → C → Dice.

`SIMILARITY_THRESHOLD = 0.5`, a named module constant (FR-011), not protocol
surface.

**Rationale**: Reuses the exact diff machinery already in the module; every
step is deterministic for identical inputs (FR-011); the pre-filters make the
common "obviously different blocks" case free.

**Alternatives considered**: bigram-multiset Dice (cheaper) — rejected:
RBD-055-1 pins C as "common characters per a bounded character LCS";
Levenshtein ratio — rejected for the same reason.

## R4 — Gap pairing: order-preserving max-similarity DP, positional fallback over a cell cap

**Decision**: Within one gap (N base blocks × M pushed blocks), compute the
similarity matrix with R3, treating scores below `SIMILARITY_THRESHOLD` as
unpairable (score 0, never matched). Then choose the **order-preserving
matching that maximizes total similarity** with the standard O(N·M) alignment
DP (`dp[i][j] = max(dp[i-1][j], dp[i][j-1], dp[i-1][j-1] + sim(i,j) if
sim(i,j) ≥ threshold)`), with a fixed deterministic tie-break during traceback:
prefer the diagonal (match), then advancing the baseline side, then the pushed
side. Result: matched pairs (all ≥ threshold, mutually order-preserving), plus
residual unmatched blocks on both sides.

**Bound (new named constant `MAX_GAP_DP_CELLS`, proposed 10_000 cells)**: when
`N·M > MAX_GAP_DP_CELLS`, degrade the gap to **positional pairing** — pair
i-th base with i-th pushed block, leftovers unmatched — with R3 similarity
still deciding matched vs below-threshold per positional pair. Deterministic,
order-preserving, O(max(N, M)) similarity computations. No whole-document
fallback exists at any size (RBD-055-6).

**Rationale**: RBD-055-2 pins determinism + order preservation + similarity
preference and leaves "small DP vs greedy" to the plan. DP is the only option
that is simultaneously optimal-within-order and trivially deterministic;
greedy best-first needs crossing-pair rejection logic and still isn't optimal.
The cell cap keeps the worst case (a wholesale rewrite of a many-hundred-block
document = one giant gap) bounded; positional degradation there is acceptable
because a document-wide rewrite is atomic-replace territory anyway.

**Alternatives considered**: greedy best-pair-first with crossing filter —
rejected (more code, worse results, same cost); windowed/banded DP — rejected
(band width is a new arbitrary knob; positional fallback is simpler and only
engages on degenerate inputs).

## R5 — Forced whole-block ops ride the existing hunk/plan pipeline as tagged hunks

**Decision**: `computeHunks` keeps its name and its output type (array of
baseline-anchored hunks `{ oldStart, oldEnd, newText }`) but gains the
alignment pre-pass and a signature extension (baseline blocks from the source
map + pushed blocks from R1). It emits two kinds of hunks:

- **In-pair hunks** (untagged): per matched pair, `diffChars(baseBlockStr,
  pushedBlockStr, { maxEditLength })` run on the block strings, offsets
  rebased by the pair's baseline `mdStart`, then the existing
  `COALESCE_DISTANCE` within-block coalescing. If the in-pair diff trips the
  cap, that pair alone degrades to a forced replace (RBD-055-6). These flow
  through `classifyRange`/`planPush` **unchanged** — text / reconcile /
  structural classification, edge-of-block insertion, heading-level decline in
  `reconcileBlockPlan` (RBD-055-4) all keep their current contracts (FR-004,
  FR-010).
- **Forced structural hunks** (tagged `forced: true`, carrying the resolved
  baseline block objects): whole-block replace (`oldStart/oldEnd` = the
  covered baseline blocks' extent, `newText` = the pushed block strings joined
  with `\n\n`), whole-block delete (`newText: ''`), and boundary insertion
  (`oldStart === oldEnd` at the anchor position, `blocks: []`). `planPush`
  routes `forced` hunks straight into `plan.structural` without calling
  `classifyRange` — this is what makes FR-005 hold by construction: a
  below-threshold paragraph rewrite must NOT be re-classified into a giant
  text/reconcile op even though its whole extent is mapped text.

Downstream, `structuralOps` and `applyHunks` steps 3/4 consume these without
change: replace/delete hunks carry `blocks`, land in `replacements` (adjacent
forced replaces merge exactly as today — and the merge rule `first ≤ prev.last
+ 1` provably cannot absorb a matched block sitting between two replaces, the
spec's adjacent-replaces invariant); insertion hunks have `blocks: []`, land in
`insertions`, anchored by the existing `mdEnd ≤ oldStart` scan.

**Rationale**: Keeps one plan object shape (`textBlocks` / `reconcileBlocks` /
`structural` + `counts`), which is what 054's `blocksChanged` report reads —
055 changes which entries appear, not the shape, so 054's report code (assumed
merged first) keeps working with zero reconciliation. Overlap detection
(`pushTouchedBlocks`) also reads the same shape unchanged.

**Alternatives considered**: a new plan-level op list bypassing hunks —
rejected: would fork `applyHunks`, `pushTouchedBlocks`, and 054's report
builder into two input shapes.

## R6 — Gap emission rules (residual runs, insertion anchoring)

**Decision**: Per gap, matched pairs (order-preserving) segment the gap into
residual runs of D consecutive unmatched baseline blocks and I consecutive
unmatched pushed blocks. Emission rules:

1. **D > 0** (with or without I): one forced replace hunk covering the D
   contiguous baseline blocks, `newText` = the I pushed blocks joined with
   `\n\n` (I = 0 → `''`, a pure delete). This subsumes "below-threshold pair"
   (D = I = 1), block merge (D = 2, I = 0 residue), and wholesale rewrites.
2. **D = 0, I > 0**: one insertion hunk for the whole run (single hunk, blocks
   joined with `\n\n` — REQUIRED, because two insertion hunks at the same
   anchor would apply in reverse order through `applyHunks` step 4's
   `pos + 1` insert), anchored at the `mdEnd` of the nearest preceding
   baseline block that **survives replay** (an exact LCS anchor or a matched
   pair's baseline block whose pair did not degrade), or position 0 at doc
   start.
3. **Anchor-folding rule**: if the nearest preceding baseline block is covered
   by a forced replace (including a cap-degraded pair), do not emit a separate
   insertion — append the inserted text to that replace hunk's `newText`
   (`... + '\n\n' + insertedText`). Rationale: `applyHunks` applies
   replacements (step 3) before insertions (step 4) and resolves insertion
   anchors by node identity; a replaced node is gone by step 4 and the
   insertion would silently fall to document end. All degradations (cap-trip)
   are known at plan time, so this rule is statically enforceable.

Empty-side cases fall out: empty baseline → single insertion hunk anchored at
0; empty pushed → forced replaces with `newText: ''` for every block.

**Rationale**: Every rule reuses an existing `applyHunks` behavior; rule 3
closes the one real ordering hazard the pre-pass would otherwise expose.
(An insertion anchored on a block that `planPush` itself later routes to
structural — via classifier decline inside a matched pair — remains a
pre-existing engine characteristic, unchanged in scope by 055; noted for the
implementer, not expanded here.)

## R7 — Coarse path retirement (RBD-055-5)

**Decision**: Delete the top-level `COARSE_INPUT_THRESHOLD` branch, the
whole-document `diffChars` call, and `coarseDiff` (plus the now-unused
`diffLines` import). Surviving constants, renamed to their new (per-pair)
meaning, values unchanged: `MAX_EDIT_LENGTH` (10000, in-pair diff + similarity
cap), `COARSE_CLUSTER_MAX` → `PAIR_INPUT_MAX` (16 * 1024, per-pair similarity
input cap), `COALESCE_DISTANCE` (3, within-pair hunk coalescing). No
whole-document character comparison remains at any size (FR-008); the block
LCS itself is line…block-level and near-linear on mostly-equal inputs.

**Ledger note**: clarifications-needed.md gap #3 — if implementation
falsifies "one path" (it is not expected to), the design doc must be amended
per Constitution VI before merging a kept fallback.

## R8 — Test strategy and the convergence-generator audit

**Decision**: New unit suite `server/__tests__/markdown-sync.alignment.test.js`
(pure planner: alignment, Dice, threshold boundaries, gap pairing, forced-op
emission, FR-002 invariant helper) + targeted extensions to the four existing
sync suites and the replay suite's performance-guard describe (size parity).
Existing suites must pass **unchanged in what they assert** (FR-009/FR-012);
their `computeHunks`/`planPush` call sites update mechanically to the new
signatures (e.g. convergence's `makePushUpdate`, markdown-sync.replay.test.js,
order-independence, overlap suites).

**Convergence audit (performed at plan time)**: the seed-fixed generator's
edit vocabulary (small inserts/deletes ≤ 4 chars, mark toggles, block appends;
`markdown-sync.convergence.test.js:170-186`) keeps every edited block far
above Dice 0.5 (worst case observed ≈ 0.71), and concurrent edits are always
in a *different* block — so no generated case crosses into the atomic-replace
regime and the property "push ≡ offline client" continues to hold verbatim.
Risk retired; recorded so a future generator extension knows the boundary:
below-threshold rewrites with a concurrent edit in the SAME block have a
different (design-table) outcome by design and belong in dedicated
deterministic tests, not the equivalence property.

**FR-002 invariant helper**: a test helper asserting, for any plan, that (a)
every `textBlocks`/`reconcileBlocks` hunk's `[oldStart, oldEnd)` lies within a
single baseline block extent, and (b) every structural entry covers whole
blocks exactly (extent-aligned). Reused across the new suite's scenarios and
the decoy-heading regression.
