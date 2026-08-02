# Contract: Range-Scoped Version Metadata (FR-001..004)

Consumers: REST `GET /api/docs/:docId/history`, `GET /api/docs/:docId/history/updates`,
MCP `list_document_versions`. Response SHAPES are unchanged; SEMANTICS tighten.

## Timeline versions (`/history` → `versions[]`)

For every returned version `v` (named, plain auto, or split fragment):

1. **Authors from own range only**: every entry in `v.authors` has ≥1 update row
   with `v.clockStart <= clock <= v.clockEnd`; no author whose rows fall only
   outside the range appears. Applies identically to both fragments of a split
   (BIDIRECTIONAL — ledger N-041-1: Alice's fragment never shows Bob and vice
   versa) and to the named range itself.
2. **Provenance from own range only**: `v.onBehalfOf` / `v.onBehalfOfMore`
   aggregate only in-range rows (same dedupe/cap as before).
3. **Meaningful rule**: authors/provenance derive from rows with
   `meaningful !== false` (NULL kept). Noise-only-range fallback: if all
   in-range rows are noise, derive from the unfiltered in-range rows (R16);
   `authors: []` only for a range with no rows at all; unattributed rows
   collapse to the single Unknown-author entry (040 FR-008, unchanged).
4. **Named-version timestamp**: `original_timestamp` → last in-range row's
   `createdAt` → `created_at`, in that order. No dependency on a matching
   auto-version existing (A7).
5. **Creator badge**: `createdBy` unchanged (named versions only).

## Drill-down (`/history/updates` → `subversions[]`)

1. Grouping input = in-range rows with `meaningful !== false` (same predicate as
   the timeline).
2. `updateCount` = number of surviving rows grouped into that sub-version
   (never clock arithmetic).
3. Invariant with the timeline: for the same range, Σ subversion counts equals
   the number of rows the timeline counts for it; a noise-only sub-group is
   never emitted (unknown-classified groups ARE — fail-visible).
4. `previousClock` baseline semantics unchanged.

## Non-goals
- Version BOUNDARIES (grouping by `created_at` gaps) unchanged — A6 deferred
  (RBD-041-6).
- No API field added or removed.
