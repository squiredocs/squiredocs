# Feature Specification: Sync Feedback Hardening (Repo-Sync Trust Pack)

**Feature Branch**: `054-sync-feedback-hardening`

**Created**: 2026-08-11

**Status**: Draft

**Input**: User description: "054-sync-feedback-hardening: repo-sync trust pack from agent field feedback (staleness signal, dryRun, per-block change report, ordered-list start attribute, guidance split)"

**Design ground truth**:
- `design/markdown-import-two-way-sync.md` — "Amendment (2026-08-11) — sync hardening from agent field feedback (features 054, 055)" (items 1–4 of this spec)
- `design/agent-surface-mcp.md` — "Amendment (2026-08-11) — the channel rule gains a targeted-edit clause (feature 054)" (item 5, guidance only)
- Source feedback: [coding-agent field report](https://squiredocs.com/d/01999aaa-2d15-438d-acc6-d8a2f078091a) (context only; the amendments are authoritative)

## Overview

A heavy real-world agent session (~a dozen sync round-trips, one live-edited doc) showed
that agents cannot *trust* the two-way markdown sync channel: a stale baseline looks
identical to a fresh one, the only way to verify what a push changed is a re-export-and-grep
round trip, there is no way to preview a push before applying it, and every export flattens
ordered-list numbering (breaking human citations and generating spurious diffs on the next
push). Separately, the channel rule as taught pushes agents toward whole-file sync even for
one-paragraph edits to a live-edited doc — the exact case that stresses the merge engine.

This feature makes sync trustworthy (staleness signal, dry run, per-block change report),
fixes ordered-list numbering fidelity, and states the whole-file-vs-targeted-edit guidance
split at every surface that teaches the channel rule. The merge engine's block-alignment
pre-pass is the sibling feature 055 and is explicitly out of scope here.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Staleness is visible on every sync receipt (Priority: P1)

An agent pushes repo edits with `mode=sync` against a baseline exported earlier. Today, a
baseline that is 32 clock ticks behind the live doc is indistinguishable from a fresh one
(the validator computes the doc's current clock and discards it), and overlap warnings only
fire on block intersection — so a stale push can return a clean-looking receipt while
silently merging over other people's edits. After this feature, every sync response tells
the agent exactly how stale its baseline was, and an opt-in strict mode refuses to apply a
push when the doc changed since the baseline.

**Why this priority**: This is the trust core of the pack. Silent stale merges are the
scenario that can lose a human collaborator's work without anyone noticing; every other
item builds on the agent being able to see doc state honestly.

**Independent Test**: Export a doc, edit the doc through another session, push a sync with
the old baseline — the receipt reports the gap; repeat with `strict=true` — the push is
rejected with the re-export remedy. Deliverable value without any other story.

**Acceptance Scenarios**:

1. **Given** a doc unchanged since export, **When** an agent pushes `mode=sync`, **Then**
   the receipt includes `baselineClock`, `currentClock`, `clockGap: 0`, and
   `docChangedSinceBaseline: false`, and the push applies normally.
2. **Given** a doc that changed after export (any actor), **When** an agent pushes
   `mode=sync` without `strict`, **Then** the push applies as today (advisory default) and
   the receipt reports `clockGap > 0` and `docChangedSinceBaseline: true`.
3. **Given** a doc that changed after export, **When** an agent pushes `mode=sync` with
   `strict=true`, **Then** the request is rejected with HTTP 409, error code
   `sync_baseline_stale`, a remedy instructing re-export (fresh baseline) before retrying,
   and the staleness fields so the agent can reason about the gap; nothing is applied and
   no version entry is created.
4. **Given** a doc unchanged since export, **When** an agent pushes with `strict=true`,
   **Then** the push applies normally (strict only bites when the doc changed).
5. **Given** a noop sync (file identical to doc), **When** pushed, **Then** the staleness
   fields are still present on the noop receipt.

---

### User Story 2 - Per-block change report (Priority: P2)

An agent that just pushed a sync needs to verify what actually changed. Today the receipt
reports bare hunk counts (`operations: { textHunks, structuralHunks }`), so verification
requires a re-export and a grep of the returned markdown. After this feature, the receipt
carries a `blocksChanged` list — for each changed block: its index, block type, a short
excerpt, and the kind of operation (`text` | `reconcile` | `structural`) — so the agent can
confirm the push did what it intended from the receipt alone.

**Why this priority**: Removes the most expensive part of every sync round trip
(re-export-and-grep verification) and is the payload that makes the dry run (US3) useful.

**Independent Test**: Push a sync that edits one paragraph, restructures one list, and
overlap-reconciles one live-edited block; assert the receipt's `blocksChanged` names all
three blocks with correct index, type, excerpt, and op kind.

**Acceptance Scenarios**:

1. **Given** a sync that changes text inside two paragraphs, **When** the receipt returns,
   **Then** `blocksChanged` has one entry per changed block with op kind `text`, the block's
   index and type, and an excerpt identifying it.
2. **Given** a sync whose plan includes a structural change (block inserted, deleted, or
   replaced wholesale), **When** the receipt returns, **Then** the affected positions appear
   with op kind `structural`.
3. **Given** a sync where a block overlapped concurrent live edits and was reconciled,
   **When** the receipt returns, **Then** that block's entry carries op kind `reconcile`
   (and the existing `overlaps` warnings still appear).
4. **Given** a noop sync, **Then** `blocksChanged` is an empty list.

---

### User Story 3 - Dry run: preview a sync without applying it (Priority: P2)

Before pushing against a live-edited doc, an agent wants to see what the push *would* do.
`PUT ?mode=sync&dryRun=true` computes the full plan — overlaps, change report, staleness
fields — and returns it without mutating the doc, writing any update, or creating a version
entry. The plan is already fully computed before the first mutation in the existing engine,
so this is compute-and-return, not a new engine path.

**Why this priority**: Directly enables the "check before you touch a live doc" workflow
the field report asked for; depends on US2's change report for its full value but is
independently testable against the existing receipt fields.

**Independent Test**: Push `dryRun=true` for a sync with known changes; assert the response
matches the plan, then re-export the doc and assert it is byte-identical to the
pre-dry-run export and no version entry was added.

**Acceptance Scenarios**:

1. **Given** a valid sync push with `dryRun=true`, **When** the request completes, **Then**
   the response contains the full plan (overlaps, `blocksChanged`, staleness fields,
   operation aggregates) and is clearly marked as a dry run.
2. **Given** the same push repeated without `dryRun`, **Then** the applied changes match
   what the dry run reported.
3. **Given** a dry-run push, **Then** the document content, its clock, its version history,
   and its live viewers' screens are all unchanged — no presence announcement, no
   content fan-out, no temporary selection.
4. **Given** `dryRun=true` combined with `strict=true` against a stale baseline, **Then**
   the response is the same 409 `sync_baseline_stale` a real push would get (the dry run
   faithfully predicts the real call).
5. **Given** `dryRun=true` on a non-sync mode (`append`, `replace`, create), **Then** the
   request is rejected as an invalid parameter combination.
6. **Given** a dry-run response, **Then** it is not usable as a new sync baseline (no new
   baseline receipt is produced) and says so.

---

### User Story 4 - Ordered lists keep their numbering (Priority: P2)

A doc contains an ordered list starting at 11 (e.g. "pressure points 11–15"). Today every
export flattens the list to `1.`, which breaks human citations ("see pressure point 11")
and, worse, makes the renumbering itself diff as content on the next sync push — a
spurious change the agent never made. After this feature the exporter honors the list's
start number, the strict parser preserves it on import, and the round-trip invariant covers
it, so numbering survives the full repo round trip.

**Why this priority**: A correctness defect in export fidelity that actively generates
false diffs, undermining the trust signals delivered by US1–US3.

**Independent Test**: Create a doc with an ordered list starting at 11; export; assert the
markdown numbers from 11; re-import/push the unchanged file; assert a noop receipt.

**Acceptance Scenarios**:

1. **Given** a doc with an ordered list whose start attribute is 11, **When** it is
   exported, **Then** the markdown items are numbered 11., 12., 13., …
2. **Given** exported markdown with a list starting at 11, **When** it is pushed back
   unchanged via `mode=sync`, **Then** the receipt is a noop (no spurious diff).
3. **Given** markdown with a list starting at n, **When** imported via the strict parser
   (sync path), **Then** the resulting document preserves start = n — matching the
   tolerant parser, which already preserves it.
4. **Given** any document, **Then** the plain export and the source-map export remain
   byte-identical (the two serializer copies must not diverge, or source maps desync).
5. **Given** the registry-driven round-trip suite, **Then** it covers ordered lists with
   non-default start values (Constitution Principle II: format changes extend the
   round-trip suite).

---

### User Story 5 - Guidance split: whole-file sync vs targeted edits (Priority: P3)

An agent needs to change one paragraph of a doc a human is actively editing. The channel
rule as taught pushes it toward a whole-file sync — the exact operation that stresses the
merge engine. The ratified split becomes contract at every surface that teaches the rule:
**whole-file byte-channel sync is for authoring, importing, and bulk updates; XPath-targeted
modify is for small targeted edits, and is the preferred tool when the document is being
actively edited or a specific node is damaged.** Guidance only — no tool behavior changes,
and the channel rule itself (bytes never retyped through model context) is unchanged.

**Why this priority**: Docs-only; prevents the failure mode rather than reporting it, but
delivers no runtime capability.

**Independent Test**: Grep every listed surface for the split; run the pinned
trigger-surface tests (byte budget + trigger phrase) green.

**Acceptance Scenarios**:

1. **Given** the MCP server instructions CHANNEL RULE sentence
   (`server/mcp/index.js`), **When** the split is added, **Then** the instructions remain
   ≤ 1,536 UTF-8 bytes and keep the pinned trigger phrase "to sync/import an existing
   file" (both test-pinned in
   `server/mcp/__tests__/tools/trigger-surfaces.test.js`).
2. **Given** each of the other teaching surfaces — the `rest_api` tool documentation
   (channel-rule block *and* sync section), the `modify` tool description's sync-redirect
   paragraph, the `import_markdown_file` tool description, the distribution sources
   (`distribution/shared/skill.md`, `distribution/shared/onboard.md` — plugin copies are
   GENERATED, only sources are edited), the Kiro Power steering files, the published
   `agents.md` (`client/public/agents.md`), the README's sync documentation, and the
   in-app chat prompt (`server/api/chat.js`) — **Then** each states the split in terms
   consistent with the ratified sentence.
3. **Given** all surface edits, **Then** existing description byte-budget tests (e.g.
   `modify` ≤ 2,048 bytes) stay green.

---

### Edge Cases

- **Baseline ahead of the doc**: a doc restored to an earlier version, or a corrupted
  baseline, could present `baselineClock > currentClock`. `clockGap` is clamped at 0 and
  `docChangedSinceBaseline` is defined by inequality (doc state differs from baseline
  claim), not by sign — see Assumptions.
- **strict without a usable baseline**: the existing `sync_baseline_missing` rejection is
  unchanged and takes precedence; `strict` only governs the stale case.
- **strict/dryRun parameter parsing**: values parse with the same conventions as existing
  boolean query params on the import routes; unknown values are not silently truthy.
- **Concurrent edit landing between dry run and real push**: the dry run is advisory — the
  real push recomputes everything; the staleness fields on the real receipt are what count.
  The dry-run response must not be mistaken for an applied receipt (explicit marker, no
  baseline-receipt markdown).
- **Change report size on huge syncs**: a replace-heavy push touching hundreds of blocks
  must not balloon the receipt — excerpts are capped (see Assumptions); entry count equals
  changed-block count (no pagination in v1).
- **Ordered list with non-sequential source numbering** (1., 1., 1. or 3., 7., 9.):
  canonicalized to sequential-from-start on the round trip, as CommonMark semantics only
  honor the first number. Byte-identity of the round-trip invariant applies to canonical
  exports, as today.
- **`start` = 0 or negative**: values outside meaningful range are treated as the default
  (1), matching HTML `ol[start]` practice.
- **Sync receipts written back to the repo file**: the staleness fields and change report
  are response-level; the receipt markdown's frontmatter baseline contract is unchanged
  (see Assumptions), so existing written-back receipts remain valid baselines.

## Requirements *(mandatory)*

### Functional Requirements

**Staleness signal**

- **FR-001**: Every `mode=sync` response (applied, noop, and overlap cases alike) MUST
  include `baselineClock` (the clock the push's baseline claimed), `currentClock` (the
  doc's clock at validation time — already computed and currently discarded at
  `server/markdown-sync.js` `validateSyncBaseline`), `clockGap` (non-negative difference),
  and `docChangedSinceBaseline` (boolean).
- **FR-002**: `docChangedSinceBaseline` MUST be true exactly when the document has changed
  since the baseline export (currentClock ≠ baselineClock), regardless of which actor
  changed it — including changes that produce no block overlap.
- **FR-003**: Staleness MUST remain advisory by default: without `strict`, behavior of the
  push (apply, merge, overlap warnings) is unchanged from today.
- **FR-004**: With `strict=true` (query param) and `docChangedSinceBaseline` true, the push
  MUST be rejected with HTTP 409, machine-readable error code `sync_baseline_stale`, a
  human/agent-readable remedy directing a re-export to refresh the baseline, and the
  staleness fields; the document, its history, and its viewers MUST be untouched.
- **FR-005**: With `strict=true` and an unchanged doc, the push MUST proceed normally.
  The existing `sync_baseline_missing` rejection MUST take precedence over staleness
  evaluation and is unchanged.

**Dry run**

- **FR-006**: `PUT ?mode=sync` MUST accept `dryRun=true`. The full plan — overlap
  warnings, per-block change report (FR-009), operation aggregates, staleness fields
  (FR-001), noop determination — MUST be computed and returned exactly as a real push
  would report it, with **nothing applied**: no document mutation, no stored update, no
  version entry, no clock advance.
- **FR-007**: A dry-run response MUST be unambiguously distinguishable from an applied
  receipt (an explicit dry-run marker) and MUST NOT produce a new sync-baseline receipt;
  it MUST NOT trigger the observable side effects of a real import (no agent presence
  announcement, no live content fan-out, no temporary selection).
- **FR-008**: `dryRun=true` MUST honor `strict=true` identically to a real push (409 on
  stale), and MUST be rejected as invalid on non-sync modes and on the create route.

**Per-block change report**

- **FR-009**: Sync responses MUST carry a `blocksChanged` list superseding bare hunk counts
  as the verification signal. Each entry MUST identify: the block's index (document
  position), its type (paragraph, heading, ordered list, …), a short excerpt sufficient to
  recognize the block, and the operation kind — `text` (in-place text change), `reconcile`
  (block merged against concurrent live edits), or `structural` (block inserted, deleted,
  or replaced as a unit). The engine's existing touched-block computation
  (`pushTouchedBlocks`, `server/markdown-sync.js`) is the natural source.
- **FR-010**: A noop sync MUST report an empty `blocksChanged`. Excerpts MUST be capped in
  length (see Assumptions) so receipts stay bounded on large pushes.
- **FR-011**: Existing receipt fields consumed by current tooling (docId, mode, noop,
  clock, markdown receipt, overlaps, images, operation aggregates) MUST remain present so
  previously written baselines and existing consumers keep working (see Assumptions for
  the retained-aggregates default).

**Ordered-list numbering**

- **FR-012**: The markdown serializer MUST honor the ordered-list `start` attribute,
  numbering items sequentially from it — in **both** serializer copies (`toMarkdown` and
  `toMarkdownWithSourceMap`, `server/mcp/yjs/serialization.js`), which MUST remain
  byte-identical for identical input (source-map integrity).
- **FR-013**: The strict parser (`shared/markdown/strict-parser.js`) MUST preserve the
  source list's start number instead of hardcoding 1, matching the tolerant parser's
  existing behavior (`shared/markdown/tolerant/block-parser.js`).
- **FR-014**: The round-trip invariant MUST be extended: a document containing ordered
  lists with non-default start values exports, re-imports, and re-exports byte-identically,
  and an unchanged exported file syncs back as a noop. Coverage MUST land in the
  registry-driven round-trip suite (Constitution Principle II).

**Guidance split (docs-only)**

- **FR-015**: The ratified split sentence — whole-file byte-channel sync for authoring,
  importing, and bulk updates; XPath-targeted modify for small targeted edits, preferred
  when the document is actively edited or a specific node is damaged — MUST be stated, in
  surface-appropriate wording, at every surface that teaches the channel rule:
  1. MCP server-instructions CHANNEL RULE (`server/mcp/index.js`)
  2. `rest_api` tool documentation — both the channel-rule block and the two-way-sync
     section (`server/mcp/tools/tool-documentation/export-api.js`)
  3. `modify` tool description's sync-redirect paragraph (`server/mcp/tools/modify.js`)
  4. `import_markdown_file` tool description (`server/mcp/tools/import-markdown-file.js`)
  5. Distribution sources `distribution/shared/skill.md` and
     `distribution/shared/onboard.md` (plugin copies are GENERATED — edit sources only)
  6. Kiro Power steering files (`distribution/kiro-power/steering/`)
  7. Published agent guide `client/public/agents.md`
  8. README's sync/agent documentation
  9. In-app chat system prompt (`server/api/chat.js`)
- **FR-016**: The server-instructions edit MUST keep the pinned contract: ≤ 1,536 UTF-8
  bytes total and the literal trigger phrase "to sync/import an existing file"
  (test-pinned in `server/mcp/__tests__/tools/trigger-surfaces.test.js`); all other pinned
  byte budgets on edited descriptions MUST stay green. No tool behavior changes; the
  channel rule itself (bytes never retyped through model context) is unchanged.

### Key Entities

- **Sync receipt**: the `mode=sync` response contract — gains staleness fields and
  `blocksChanged`; its markdown/frontmatter baseline role is unchanged.
- **Staleness signal**: `baselineClock` / `currentClock` / `clockGap` /
  `docChangedSinceBaseline` — derived from the baseline validation the engine already
  performs.
- **Dry-run plan**: a receipt-shaped preview with an explicit dry-run marker and no side
  effects; never a baseline.
- **Change-report entry**: {block index, block type, excerpt, op kind ∈ text | reconcile |
  structural}.
- **Ordered-list start attribute**: already first-class in the document model and tolerant
  parser; this feature carries it through the strict parser and both serializer copies.
- **Teaching surfaces**: the nine documentation surfaces of FR-015, several with pinned
  byte budgets.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From a single sync response, an agent can determine whether the doc changed
  since its baseline and by how many clock ticks — zero additional round trips.
- **SC-002**: With strict mode on, 100% of pushes against a changed doc are refused with
  the `sync_baseline_stale` remedy; zero silent stale merges are possible on the strict
  path.
- **SC-003**: A dry run leaves no trace: across noop, overlap, stale, and large-change
  cases, document bytes, clock, version-history length, and viewer-visible state are
  identical before and after; the dry-run plan matches the subsequent real push's receipt.
- **SC-004**: Post-push verification needs no re-export: every block the engine changed
  appears in `blocksChanged` with enough identity (index, type, excerpt) to locate it, and
  no unchanged block appears.
- **SC-005**: A doc whose ordered list starts at 11 exports numbered from 11, and pushing
  the unchanged export back is a noop — zero spurious numbering diffs.
- **SC-006**: Plain and source-map exports remain byte-identical across the whole test
  corpus (source maps never desync).
- **SC-007**: All nine teaching surfaces state the guidance split; the pinned
  server-instructions budget (≤ 1,536 bytes) and trigger phrase, and all other pinned
  description budgets, hold.
- **SC-008**: Existing sync consumers are unbroken: previously written baseline receipts
  still validate, and the full backend + round-trip suites pass.

## Out of Scope

- **Feature 055 — block-aligned merge**: the `computeHunks` block-alignment pre-pass
  (block-level LCS, per-block character diffing, atomic structural fallbacks) is the
  sibling feature `specs/055-block-aligned-merge`, specced in parallel. **This feature
  must not respecify or modify hunk computation / merge alignment.** The change report
  (FR-009) reads the plan the engine already produces; when 055 changes how the plan is
  computed, the report contract here is unchanged.
- Any change to the channel rule's substance (byte-faithfulness, no retyping) — the split
  is additive guidance only.
- Making strict mode the default, or any automatic rebase/retry on staleness.
- Dry run for `append`/`replace`/create modes.
- Receipt pagination or diff-content payloads beyond excerpts.
- UI surfaces (the trust pack is an agent/API-facing contract).

## Assumptions

Defaults chosen without user interaction are recorded (with rationale) in
`specs/054-sync-feedback-hardening/clarifications-needed.md` as RATIFIED-BY-DEFAULT
(Sam pre-authorized, 2026-08-11). Summary:

- **Staleness comparison is clock-based**: `docChangedSinceBaseline` = (currentClock ≠
  baselineClock), with `clockGap` clamped to ≥ 0; content-hash comparison is out of scope.
- **strict + dryRun**: strict is evaluated identically under dryRun (409 on stale) so the
  dry run predicts the real call.
- **Dry run side-effect boundary**: no presence announcement, no fan-out, no temporary
  selection, no version entry; the dry-run response carries no baseline receipt markdown.
- **dryRun on non-sync modes**: rejected as invalid rather than silently ignored.
- **Operation aggregates retained**: `blocksChanged` supersedes hunk counts as the
  verification signal, but the existing `operations` aggregate fields remain in the
  receipt for compatibility (non-breaking reading of the amendment's "replace").
- **Excerpt cap**: block excerpts are single-line and capped (~120 characters with
  ellipsis).
- **Receipt frontmatter unchanged**: staleness fields and `blocksChanged` live in the JSON
  response; the written-back receipt frontmatter baseline contract is untouched.
- **Ordered-list canonicalization**: non-sequential source numbering canonicalizes to
  sequential-from-start (CommonMark semantics); `start` < 1 is treated as 1.
- **Boolean param conventions**: `strict` / `dryRun` parse like existing boolean query
  params on the import routes (`server/api/docs-import.js`).
- The `server/markdown-sync.js` file contains NUL bytes; tooling that greps it must use
  `grep -a` or read it directly (plain grep reports it as binary — this has misled agents
  before).
