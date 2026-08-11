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
- No insertion hunk is anchored on a baseline block covered by any forced
  replace in the same plan (anchor-folding rule, research R6).
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

| # | Invariant | Enforced by |
|---|---|---|
| I1 | No character-level edit spans more than one baseline block; none combines content of two pushed blocks (FR-002) | FR-002 invariant helper across the alignment suite + decoy regression |
| I2 | Forced ops cover whole blocks only (FR-005); a below-threshold rewrite is ONE structural replace, no char ops | alignment suite (US2 scenarios) |
| I3 | Round-trip no-op: canonically-equal push → all-exact anchors, zero hunks, zero ops, no version entry (FR-009) | existing no-op + round-trip property suites, unchanged |
| I4 | Convergence: push ≡ offline Yjs client for in-pair edits, incl. concurrent disjoint edits and clock-equal (SC-007) | existing convergence suite, unchanged assertions (R8 audit: generator stays above threshold) |
| I5 | Threshold boundary: sim just ≥ 0.5 → char-diffed pair; just < 0.5 → atomic replace; metric deterministic (FR-011) | boundary tests, new |
| I6 | Size parity: identical logical edit in ~1KB and >64KB docs → identical plan classification and report (FR-008/SC-004) | parity tests, new |
| I7 | Bounds degrade one pair/gap only; no whole-document fallback path exists (RBD-055-6) | cap-degradation tests, new |
| I8 | Decoy-heading regression: rename of "Deployment" with "Deployment Notes" present lands on the renamed block only (FR-006/SC-001) | new regression test (unit + through `applySyncPush`) |
| I9 | Overlap flags stay advisory and never gate (F4) | existing overlap/rejection suites, unchanged |
| I10 | Duplicate blocks align by sequence position; edits land on the aligned duplicate | alignment suite, new |

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
