# Data Model — 054 Sync Feedback Hardening

**No database changes.** This feature adds no tables, columns, indexes, or migrations. Every
entity below is a **response-shape** entity — computed per request from state the engine
already holds. `yjs_updates` is read (`MAX(clock)`), never written differently.

The written-back **receipt markdown and its frontmatter are untouched** (RBD-054-7): the
`squire:` block keeps exactly today's fields, so every previously written baseline file stays
a valid baseline.

---

## 1. Staleness signal

Attached to **every** `mode=sync` response — applied, noop, idempotent-noop, dry run — and to
the `sync_baseline_stale` rejection body.

| Field | Type | Source | Rules |
|---|---|---|---|
| `baselineClock` | integer ≥ 0 | `validateSyncBaseline` → the resolved baseline (explicit `?baselineClock` param, else frontmatter `squire.clock`) | Always present on an accepted push |
| `currentClock` | integer ≥ 0 | `readCurrentClock` at **validation** time (`markdown-sync.js:1034`) | Not the re-export clock; see research R1 |
| `clockGap` | integer ≥ 0 | `Math.max(0, currentClock - baselineClock)` | Clamped — never negative (RBD-054-1) |
| `docChangedSinceBaseline` | boolean | `currentClock !== baselineClock` | **Inequality**, not `>`. A baseline *ahead* of the doc (version restore, corrupted file) is also not a faithful baseline (RBD-054-1) |

**Invariant**: `docChangedSinceBaseline === false` implies `clockGap === 0`. The converse does
not hold — `clockGap === 0` with an ahead-baseline is possible only if `baselineClock >
currentClock`, which `validateSyncBaseline` already rejects as `sync_baseline_invalid`
(`:1035`). So in practice the two agree; the asymmetric definitions are belt-and-braces
against a future relaxation of that check.

**Not derived from content.** Clock inequality only (RBD-054-1); a doc edited and reverted to
identical bytes reports `docChangedSinceBaseline: true`. That is the honest answer to
"has anyone touched this since you looked", which is the trust question.

## 2. Change-report entry (`blocksChanged[]`)

One entry per baseline block the push would change, plus one per boundary insertion. Ordered
by `blockIndex` ascending, then insertions after their anchor. Empty array on a noop (FR-010).

| Field | Type | Rules |
|---|---|---|
| `blockIndex` | integer ≥ 0 | The **baseline** document position of the block (from `sourceMap.blocks[i].blockIndex`). For an insertion, the anchor block's index |
| `blockType` | string | `blockNode.nodeName` (`paragraph`, `heading`, `orderedList`, `table`, …); `'text'` for a bare text node — same derivation as overlap flags (`markdown-sync.js:906`) |
| `excerpt` | string, ≤ 120 chars | `blockExcerpt(baselineMd.slice(mdStart, mdEnd))` — whitespace-collapsed, single line, ellipsis on truncation (R6). For an insertion, an excerpt of the **inserted** text |
| `op` | enum | `text` \| `reconcile` \| `structural` |
| `position` | enum, **insertions only** | `after` (anchored on `blockIndex`) or `start` (inserted at the head of the document, no anchor) |

### `op` derivation

| Plan source | `op` | Note |
|---|---|---|
| `plan.textBlocks[].block` | `text` | In-place character splice inside one block |
| `plan.reconcileBlocks[].block` | `reconcile` | Whole-inline-delta reconciliation of a live-edited block |
| `structuralOps().replacements` → each index in `first..last` | `structural` | Includes wholesale replace **and** delete (`newText === ''`) |
| `structuralOps().insertions` | `structural` | Carries `position`; no baseline block of its own |

`reconcile` is a **reporting-only** distinction. It does not exist in the overlap contract:
`pushTouchedBlocks` deliberately labels reconcile blocks `text` for `pushSide`, and that stays
(research R4). A block can therefore appear as `op: "reconcile"` in `blocksChanged` and
`pushSide: "text"` in `overlaps` in the same receipt — intentional, documented in the contract.

**Relationship to `operations`**: `operations: { textHunks, structuralHunks }` remains in
every receipt (RBD-054-5). It counts **hunks**; `blocksChanged` counts **blocks**. The two do
not have to agree — several hunks inside one block yield one entry, and one coalesced
structural group spans several entries.

## 3. Dry-run plan

A receipt-shaped object that is **never** a baseline.

| Field | Value under `dryRun=true` |
|---|---|
| `dryRun` | `true` — the explicit marker (FR-007). Absent (not `false`) on real receipts |
| `docId`, `mode` | As a real push |
| `noop` | The real determination (both short-circuits are reachable under dry run) |
| `clock` | The document's **current** clock. No advance occurred; this is not a receipt clock |
| `markdown` | **Omitted.** A dry run produces no baseline (FR-007). Its absence is what makes a dry-run response unusable as a baseline even if the marker were ignored |
| `overlaps`, `overlapsUnavailable` | As a real push |
| `blocksChanged`, `operations`, `images` | As a real push |
| staleness fields | As a real push |

**Two independent guards** so a client cannot mistake a preview for an applied receipt: the
`dryRun: true` marker, and the missing `markdown` (a client that blindly writes
`receipt.markdown` back over its file gets `undefined`, not a stale baseline).

**Side-effect boundary** (FR-006/FR-007, RBD-054-3): no `storeUpdate`, no version entry, no
clock advance, no `applyLiveUpdate` fan-out, no `searchIndexer.markDirty`, no presence session,
no temporary selection. **Disclosed exception** (RBD-054-11): the staged image pass still runs,
so a dry run may rehost an external image to S3 or copy a cross-doc image — storage-side only,
invisible in the document, its history, and its viewers.

## 4. Ordered-list `start`

Not a new entity — an attribute already first-class in the schema
(`shared/prosemirror-schema.js:62-63`, `attrs: { start: { default: 1 } }`) and already stored
by the tolerant parser. This feature carries it through the two places that drop it.

| Property | Rule |
|---|---|
| Domain | Integer ≥ 1. `0`, negatives, non-numeric, and absent → **1** (RBD-054-8, HTML `ol[start]` practice) |
| Wire type | `Y.XmlElement` attribute; may arrive as number *or* string — coerce with `Number()` and `Number.isFinite` (research R7) |
| Export | Items numbered `start, start+1, start+2, …` — sequential from `start`, in both serializer copies |
| Import | First item's literal number becomes `start`; subsequent items' numbers are **ignored** (CommonMark) |
| Canonicalization | `3.` `7.` `9.` → `start: 3` → exports `3.` `4.` `5.`. Per-item eccentricity was never representable and is not preserved (RBD-054-8) |
| Round trip | Byte-identity holds for **canonical** exports, as today |

## 5. Teaching surfaces

Documentation entities with machine-enforced constraints. Enumerated with their pinned budgets
in `contracts/guidance-split.md`.
