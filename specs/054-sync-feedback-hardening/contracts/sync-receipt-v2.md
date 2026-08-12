# Contract: Sync Receipt v2 — staleness, dry run, change report

**Feature**: 054-sync-feedback-hardening
**Amends**: `specs/004-two-way-sync/contracts/sync-push.md` (the base sync-push contract).
**Design authority**: `design/markdown-import-two-way-sync.md`, Amendment (2026-08-11).

This document defines **only the delta**. Transport, auth, payload limits, image policy,
baseline resolution, doc identity, the `markdown` re-export rule, and the overlaps contract are
unchanged and still governed by the 004 contract. Additive throughout: no field is removed or
retyped, so every existing consumer and every previously written baseline file keeps working
(FR-011, SC-008).

---

## Request

```
PUT /api/docs/:docId/import?mode=sync[&baselineClock=<int>][&strict=<bool>][&dryRun=<bool>]
```

| Param | Default | Meaning |
|---|---|---|
| `strict` | `false` | Refuse the push when the document changed since the baseline (FR-004) |
| `dryRun` | `false` | Compute and return the full plan; apply nothing (FR-006) |

**Boolean parsing** (FR-004/FR-008, RBD-054-9) — identical to the route's existing
`?frontmatter` convention (`server/api/docs-import.js:242-260`):

- accepted true: `true`, `1`
- accepted false: `false`, `0`
- anything else → **400**, body
  `{ "error": "Unsupported strict value: yes. Accepted values: true, false, 1, 0" }`

Unknown values are never silently falsy. `strict=1` works; `strict=yes` is an error, not a
quiet no-op.

**Mode gate** (FR-008, RBD-054-4): `dryRun` is accepted **only** on `mode=sync`. On
`mode=append`, `mode=replace`, or `POST /api/docs/import` (create) it is a **400**:

```json
{ "error": "dryRun is only supported with mode=sync on PUT /api/docs/:docId/import" }
```

`strict` is likewise sync-only and rejected the same way. Fail closed: silently ignoring a
preview request and applying the change is the worst possible failure for a trust feature.

## Staleness fields — on every sync response

Present on **every** `mode=sync` response: applied, noop, idempotent-noop, dry run, and the
`sync_baseline_stale` rejection body (FR-001, acceptance scenario 5).

```json
{
  "baselineClock": 1475,
  "currentClock": 1507,
  "clockGap": 32,
  "docChangedSinceBaseline": true
}
```

- `currentClock` is read at **baseline-validation** time, not at re-export time. It is
  therefore ≤ the top-level `clock` of an applied receipt. These are different numbers
  answering different questions and both are reported.
- `clockGap` = `max(0, currentClock - baselineClock)` — never negative (RBD-054-1).
- `docChangedSinceBaseline` = `currentClock !== baselineClock` — **inequality**, not `>`.
- Clock-based only. A doc edited and reverted to identical bytes still reports `true`.

**Advisory by default** (FR-003): without `strict`, apply/merge/overlap behavior is
byte-for-byte what it is today. The fields are pure addition.

## `strict=true` — the stale rejection

When `strict=true` **and** `docChangedSinceBaseline` is true, before anything is applied:

```
HTTP/1.1 409 Conflict
```

```json
{
  "error": "sync_baseline_stale",
  "message": "The document changed since your baseline (32 clock ticks). Strict mode refuses to merge over changes you have not seen.",
  "guidance": "Re-export the document to get a fresh baseline, re-apply your edits on top of it, and push again. Or drop strict=true to merge with advisory overlap warnings.",
  "baselineClock": 1475,
  "currentClock": 1507,
  "clockGap": 32,
  "docChangedSinceBaseline": true
}
```

- The document, its clock, its version history, and its viewers are **untouched** — the check
  runs in the route immediately after baseline validation, before the presence session opens
  and before the engine is entered (FR-004).
- **Precedence** (FR-005): the existing rejections are evaluated first and unchanged —
  `sync_doc_mismatch` (409), `sync_baseline_missing` (400), `sync_baseline_invalid` (400),
  `sync_baseline_unavailable` (410). `strict` governs *only* the stale case.
- With an unchanged doc, `strict=true` is a no-op and the push proceeds normally.

## `blocksChanged` — the per-block change report

Supersedes bare hunk counts **as the verification signal** (FR-009). `operations` is retained
(RBD-054-5) — it counts hunks; `blocksChanged` counts blocks; they need not agree.

```json
{
  "blocksChanged": [
    { "blockIndex": 3,  "blockType": "paragraph",   "excerpt": "Retries use fixed 5s intervals with jitter.", "op": "text" },
    { "blockIndex": 7,  "blockType": "orderedList", "excerpt": "11. Check the queue depth before scaling", "op": "structural" },
    { "blockIndex": 12, "blockType": "heading",     "excerpt": "Failure modes", "op": "reconcile" },
    { "blockIndex": 12, "blockType": "paragraph",   "excerpt": "New closing note.", "op": "structural", "position": "after" }
  ]
}
```

| Field | Rule |
|---|---|
| `blockIndex` | **Baseline** document position. For an insertion, the anchor block it lands after |
| `blockType` | Node name (`paragraph`, `heading`, `orderedList`, …), or `text` for a bare text node — same derivation as `overlaps[].blockType` |
| `excerpt` | Whitespace-collapsed single line, ≤ 120 chars, ellipsis on truncation |
| `op` | `text` (in-place character splice) \| `reconcile` (whole-block in-place re-render of inline formatting in a single-text block — chosen by edit shape, unrelated to concurrency) \| `structural` (block inserted, deleted, or replaced as a unit) |
| `position` | **Insertions only**: `after` (anchored on `blockIndex`) or `start` (document head) |

- Ordered by `blockIndex` ascending; an insertion follows its anchor.
- A noop returns `[]` (FR-010).
- No pagination and no diff-content payload in v1 — excerpts are the bound.

**Deliberate asymmetry with `overlaps`**: `op: "reconcile"` exists only here. The overlap
contract's `pushSide` keeps its shipped vocabulary (`text|structural|deleted`) and continues to
label reconciled blocks `text`. The same block may therefore read `op: "reconcile"` in
`blocksChanged` and `pushSide: "text"` in `overlaps` within one receipt.

**Stability across feature 055**: this contract describes the plan the engine produces. Feature
055 changes *how* that plan is computed (a block-alignment pre-pass in `computeHunks`); the
shape above does not change.

## `dryRun=true` — the preview

Returns **200** with a receipt-shaped plan and applies nothing.

```json
{
  "docId": "b6edb804-...",
  "mode": "sync",
  "dryRun": true,
  "noop": false,
  "clock": 1507,
  "overlaps": [ ... ],
  "blocksChanged": [ ... ],
  "operations": { "textHunks": 4, "structuralHunks": 1 },
  "images": { "rehosted": [], "copied": [], "degraded": [], "rejected": [] },
  "baselineClock": 1475,
  "currentClock": 1507,
  "clockGap": 32,
  "docChangedSinceBaseline": true
}
```

- **`dryRun: true`** is the explicit marker (FR-007). It is **absent** — not `false` — on real
  receipts, so `'dryRun' in receipt` is a reliable test.
- **`markdown` is omitted.** A dry run produces no baseline (FR-007). This is the second,
  independent guard: a client that blindly writes `receipt.markdown` back over its file gets
  `undefined` rather than a stale baseline.
- `clock` is the document's current clock. Nothing advanced it.
- `noop` is the real determination — both noop short-circuits are reachable under dry run.

### Guaranteed absent (FR-006/FR-007, RBD-054-3)

No stored update. No version-history entry. No clock advance. No live content fan-out. No
agent presence announcement. No temporary selection. No search-index dirty mark.

### Disclosed exception (RBD-054-11)

A dry run runs the **same staged image pass** as a real push, because that pass is what
produces the canonical string the plan is diffed against — skipping it would make the preview
predict a different plan than the real call. Consequently a dry run **may rehost an external
image to S3 or copy a cross-document image**, and reports them in `images` exactly as a real
push would. These effects are storage-side: the document, its clock, its history, and its
viewers remain untouched.

### `strict` under `dryRun` (RBD-054-2)

Evaluated identically. `dryRun=true&strict=true` against a stale baseline returns the same
**409 `sync_baseline_stale`** a real push would — the dry run predicts the real call. An agent
wanting the full plan for a stale baseline simply omits `strict`; the staleness fields are
present regardless.

### Advisory only

A dry run is a snapshot. A concurrent edit landing between the preview and the real push means
the real push recomputes everything; the staleness fields on the **real** receipt are what
count.

## Compatibility summary (SC-008)

| Field | Status |
|---|---|
| `docId`, `mode`, `noop`, `clock`, `markdown`, `overlaps`, `overlapsUnavailable`, `operations`, `images` | Unchanged. `markdown` omitted **only** under `dryRun` |
| `baselineClock`, `currentClock`, `clockGap`, `docChangedSinceBaseline` | Added — all responses |
| `blocksChanged` | Added — all sync responses |
| `dryRun` | Added — dry-run responses only |
| Receipt **markdown frontmatter** | **Unchanged** (RBD-054-7). Previously written baselines still validate |
| `sync_baseline_stale` | New error code, `strict` path only |
