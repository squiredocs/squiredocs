# Contract: Sync Planner Invariants (055)

055 changes no REST/API surface, no receipt field, no overlap-flag shape, no
serializer output, and no source-map contract (spec Out of Scope). Its
contract is internal: what the planner guarantees to its consumers —
`applyHunks`, the overlap detector, and feature 054's `blocksChanged` report
builder — plus the invariants tests pin.

## 1. Planner entry points (module-internal surface, `server/markdown-sync.js`)

```js
// Extended (was (baselineMd, pushedMd)):
computeHunks(baselineMd, pushedMd, baseBlocks, pushedBlocks) → [hunk]
//   baseBlocks:   sourceMap.blocks of the baseline fork (node identity + extents)
//   pushedBlocks: block extents of the pushed canonical markdown (R1)
//   Output hunks are baseline-anchored { oldStart, oldEnd, newText },
//   optionally tagged { forced: true, blocks: [...] } (data-model ForcedHunk).

// Unchanged signature; new routing rule:
planPush(hunks, sourceMap, baselineMd) → plan
//   h.forced === true  → plan.structural verbatim (NO classifyRange)
//   otherwise          → existing classification, contracts unchanged.

// canonicalizePushed / canonicalizePushedStaged additionally return the pushed
// block extents (exact return shape pinned in tasks.md; callers that only
// want the string keep working or migrate mechanically).
```

These are exported for tests (as today) but are not protocol surface.

## 2. Guarantees to downstream consumers

### To `applyHunks` / `structuralOps` (consumed unchanged)
- Every non-forced hunk classifies as before; forced hunks arrive in
  `plan.structural` with resolved `blocks` arrays and whole-extent coverage.
- At most ONE insertion hunk per anchor position (apply-order requirement).
- No insertion hunk is anchored on a baseline block covered by a FORCED
  replace in the same plan (anchor-folding rule, research R6). That is the
  whole class the PLANNER can close, and stating it as "any replace" was
  wrong (055 review HIGH-1): whether a *classifier-derived* structural entry
  ends up replacing its block — a heading level change, a paragraph → list
  change, a declined reconciliation — is not decidable at plan time. So the
  remaining case is closed at apply time instead: `applyHunks` records what
  each replacement group leaves behind and resolves a missed insertion anchor
  positionally through it (after the group's last new node; failing that,
  after the nearest preceding baseline block that still resolves; document
  start as the floor). An insertion anchor therefore never falls to the end
  of the document, whatever removed its anchor node.
- Adjacent forced replaces may merge in `structuralOps` (existing
  `first ≤ prev.last + 1` rule); a matched (character-diffed) block between
  two replaces can never be absorbed — index adjacency makes it impossible.

### To the overlap detector (`pushTouchedBlocks`, consumed unchanged)
- `plan.textBlocks` / `plan.reconcileBlocks` entries carry baseline `block`
  refs → flagged side `text`.
- `plan.structural` entries carry `blocks` + `newText` (`'' ` → `deleted`,
  else `structural`).
- FR-007: a doc-side-edited baseline block deleted by the push (move,
  wholesale delete) still surfaces as an overlap flag with
  `pushSide: 'deleted'`.

### To feature 054's `blocksChanged` report (dependency, assumed on main)
- Op-kind vocabulary is exactly `text | reconcile | structural`, derived from
  the three plan lists (design amendment; 054 FR-009). 055 changes WHICH
  entries appear (atomic replaces become visible as `structural`), never the
  vocabulary or the plan shape.
- `counts: { textHunks, structuralHunks }` aggregates retained (054 keeps
  them alongside the report).

## 3. Pinned behavioral invariants (test-enforced)

Implementation note (2026-08-11): the "Enforced by" column names the tests as
shipped. `alignment` = `server/__tests__/markdown-sync.alignment.test.js`,
`overlap` = `server/__tests__/markdown-sync.overlap.test.js`, `route` =
`__tests__/integration/sync-push.route.test.js`.

| # | Invariant | Enforced by |
|---|---|---|
| I1 | No character-level edit spans more than one baseline block; none combines content of two pushed blocks (FR-002) | `assertNoCrossBlockSplice` in *alignment*, asserted in every scenario there (~25 plans) including both decoy regressions |
| I2 | Forced ops cover whole blocks only (FR-005); a below-threshold rewrite is ONE structural replace, no char ops | *alignment* "just below the threshold replaces atomically, with zero character ops", "AS1: a wholesale rewrite is ONE replace…", plus the forced-op clause of `assertNoCrossBlockSplice` |
| I3 | Round-trip no-op: canonically-equal push → all-exact anchors, zero hunks, zero ops, no version entry (FR-009) | `format-roundtrip` "push(export) is a no-op" corpus (both flavors), replay "no-op detection" describe, *route* "byte-identical re-push is a no-op" / "blocksChanged: []" — all unchanged |
| I4 | Convergence: push ≡ offline Yjs client for in-pair edits, incl. concurrent disjoint edits and clock-equal (SC-007) | `markdown-sync.convergence.test.js`, assertions unchanged (call-site migration only) |
| I5 | Threshold boundary: sim just ≥ 0.5 → char-diffed pair; just < 0.5 → atomic replace; metric deterministic (FR-011) | *alignment* "the threshold is inclusive: exactly 0.5…", "just below the threshold…", "metric determinism across repeated calls" |
| I5b | The metric separates real prose: unrelated/rewritten paragraphs score below the threshold, edited ones above, with a gap between the two populations (RBD-055-1 amendment A1) | *alignment* "the metric separates real prose" describe — per-fixture scores plus "the two populations do not overlap" |
| I6 | Size parity: identical logical edit in ~1KB and >64KB docs → identical plan classification and report (FR-008/SC-004) | *alignment* US3 describe — one parity test per op kind (text edit, heading rename, wholesale rewrite) |
| I7 | Bounds degrade one pair/gap only; no whole-document fallback path exists (RBD-055-6) | *alignment* "a cap-tripping pair degrades alone…", "an oversized single block degrades alone…", "over MAX_GAP_DP_CELLS the gap degrades to positional pairing…"; replay "a wholesale huge rewrite degrades per block…" |
| I8 | Decoy-heading regression: rename of "Deployment" with "Deployment Notes" present lands on the renamed block only (FR-006/SC-001) | *alignment* US1 describe (both the below- and above-threshold rename shapes); *route* "US1: renaming one heading leaves a similarly worded decoy untouched" |
| I9 | Overlap flags stay advisory and never gate (F4) | *overlap* suite and *route* "overlap detector failure does not gate the push", unchanged |
| I10 | Duplicate blocks align by sequence position; edits land on the aligned duplicate | *alignment* "duplicate identical blocks align by sequence position", "ambiguous duplicates still align deterministically and in order" |
| I11 | A boundary insertion lands at its anchor's position whatever replaced the anchor block; the applied result equals the pushed markdown (055 review HIGH-1) | *alignment* "insertion anchors survive the replacement of their anchor block" describe — heading level change, paragraph → list, declined reconciliation, deleted run, first block |
| I12 | Candidate scoring never runs a character diff, and a gap's cost is bounded in WORK as well as in cells (055 review HIGH-2, RBD-055-6 amendment A2) | *alignment* "scoring never runs a character diff", "gap pairing is bounded in WORK, not just in cells" describe (budget degrade + the 20 × 2KB rewrite perf bound) |

## 4. Explicitly unchanged surfaces (regression fence)

- Receipt shape (`docId, mode, noop, clock, markdown, overlaps, operations,
  images` + 054's staleness/`blocksChanged`/dryRun fields).
- Overlap flag shape `{ blockIndex, blockType, excerpt, docSide, pushSide }`.
- `validateSyncBaseline` rejection vocabulary and ordering.
- Synthetic clientID derivation, idempotency short-circuit, store-then-apply,
  live fan-out, search-dirty marking, presence.
- `toMarkdown` / `toMarkdownWithSourceMap` byte-equality and the source-map
  `runs`/`blocks` shape (serializer not modified).
- Flavor-aware mark preservation (`CLEAR_ATTRS_PORTABLE`) on reconcile.
