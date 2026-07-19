# Feature Specification: Word-Level Two-Tier Inline Diff Highlighting

**Feature Branch**: `022-inline-diff-highlighting`

**Created**: 2026-07-19

**Status**: Draft

**Input**: User description: "Word-level, two-tier inline diff highlighting across BOTH diff surfaces: the version-history diff (VersionPreview, server diff-service — line-level today via diffInsert/diffDelete marks) and the chat tool-output diff (DiffView on modify/undo/redo tool cards, fed by computeChatDiff — whole-line +/- rows today). Word granularity via jsdiff's diffWordsWithSpace; two-tier visual = keep the existing whole-line add/remove tint and layer a stronger highlight on just the changed words (GitHub-style)."

**Design ground truth**:

- `design/document-model-format-pipeline.md` → **Amendment (Sam, 2026-07-19) — word-level two-tier diff highlighting (feature 022)** in the "Version diffs" section, plus the schema marks list naming `diffInsertWord`/`diffDeleteWord` ("the word-emphasis tier, 022"). The amendment pins: replace regions (a removed run immediately followed by an added run in the line-diff output) get a word-level refinement pass; both sides parsed unmarked by the frozen strict parser; plain text word-diffed with `diffWordsWithSpace` (whitespace-preserving — the right granularity for prose); text nodes split so changed words carry the new strong marks while unchanged words on the same line keep the subtle `diffInsert`/`diffDelete`; refinement is post-processing over the parser's output — the characterization-frozen parser is untouched; degrades to plain line-level marks when the region doesn't align; the two word marks are produced only by the diff service, never by user editing; diff cache version bumps v7→v8; the same shared word-segmentation helper drives the chat diff.
- `design/in-app-ai-assistant.md` → **Amendment (Sam, 2026-07-19) — word-level two-tier diff highlighting (feature 022)**. The amendment pins: the transcript diff (modify and undo/redo cards alike) highlights what changed within a line; the server pairs adjacent -/+ lines in the diff post-processing pass and attaches word-level segments via the shared helper; the chat DiffView renders changed words as a stronger highlight layered over the existing line tint (two-tier, GitHub-style); the payload field is additive (`inlineSegments`); persisted tool parts from before the feature render exactly as before; unpaired wholly-added/removed lines carry no word emphasis.

An approved implementation plan exists (`/root/.claude/plans/i-d-like-to-add-warm-feigenbaum.md`, mechanics validated against the code); where this spec cites concrete mechanics, they come from that plan or the amendments and are not open questions.

## Overview

Both diff surfaces in Squire Docs today highlight only at line granularity. In the version history, a changed line renders as a fully-struck removed line plus a fully-tinted added line (`diffInsert`/`diffDelete` marks → `<ins>`/`<del>`); in the chat transcript, a modify or undo/redo card renders whole `-`/`+` rows with a subtle background tint. When one word changes in a long prose line — the normal case in a document app — the reader must scan both lines and spot the difference manually.

This feature adds the GitHub-style two-tier treatment to both surfaces at once, backed by one shared word-segmentation helper so the two surfaces can never disagree about what "the changed words" are:

- **Tier 1 (unchanged)**: the whole changed line keeps its existing subtle add/remove tint.
- **Tier 2 (new)**: only the words that actually changed get a visibly stronger highlight layered on top.

Word segmentation is whitespace-preserving (`diffWordsWithSpace` from the already-installed jsdiff), which is the correct granularity for prose: whitespace edits are real edits in a document. Both diffs remain computed server-side, as today; the chat payload grows one additive field (`inlineSegments`) with a full backward-compatible fallback, and the version diff grows two new marks (`diffInsertWord`/`diffDeleteWord`) that only the diff service ever produces. The characterization-frozen strict markdown parser (CN-2) is not modified — word refinement post-processes its output.

No schema migrations, no new dependencies, no change to where diffs are computed or to endpoint shapes beyond the additive field and richer marks.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Chat user sees which words a tool edit changed (Priority: P1)

Sam asks the assistant to change one word in a paragraph. The modify tool card's "Changes" diff still shows the `-`/`+` row pair with its familiar red/green row tint — but now the single word that differs carries a clearly stronger highlight on both rows, so the change is legible at a glance without reading either line. Undo/redo cards (which reuse the same diff rendering since 020) get the identical treatment for free.

**Why this priority**: The transcript diff is the most frequently generated diff in the product — every assistant edit renders one — and it is the simpler of the two paths, so it is the natural standalone MVP. It also exercises the shared segmentation helper end to end.

**Independent Test**: In the chat, ask the assistant to replace one word in an existing paragraph. The modify card's diff shows the row tint as today plus a stronger highlight on exactly the replaced word (old word on the `-` row, new word on the `+` row). Deployable and demonstrable without touching version history.

**Acceptance Scenarios**:

1. **Given** a document containing a long paragraph, **When** the assistant modifies one word and the tool card renders its diff, **Then** the `-` row strongly highlights only the removed word and the `+` row strongly highlights only the added word, while both rows keep their existing whole-row tint, prefix character, and gutter numbering.
2. **Given** an edit where several separated words on one line change, **When** the diff renders, **Then** each changed word (or contiguous run of changed words) is strongly highlighted and the unchanged words between them are not.
3. **Given** an edit that only inserts wholly new lines (or only deletes lines), **When** the diff renders, **Then** those rows show only the row tint — no word-level emphasis (there is nothing to compare against).
4. **Given** a successful undo (or redo) whose card carries a diff, **When** it renders, **Then** paired changed lines get the same word-level emphasis as modify cards.
5. **Given** a formatting-only change (same text, different formatting), **When** the diff renders its annotated `-`/`+` pair, **Then** the pair renders exactly as today — annotation, no word-level emphasis (the plain text is identical; the annotation already tells the story).

---

### User Story 2 - Version history shows which words changed between versions (Priority: P2)

Sam opens Version History with "Highlight changes" on. A version that edited one word in a long paragraph previously showed the entire old line struck-through and the entire new line tinted. Now the whole line still reads as removed/inserted (subtle tint, as today), and the specific changed words additionally carry the stronger highlight — the same two-tier read as the chat.

**Why this priority**: Version history is the deliberate review surface, but it is viewed less often than the transcript diff and is the more involved path. It builds on the shared helper delivered by US1.

**Independent Test**: Make a one-word edit to a document, create a version boundary, open Version History with highlighting on. The preview shows subtle line-level insert/delete plus strong emphasis on only the changed word on each side.

**Acceptance Scenarios**:

1. **Given** two adjacent versions differing by one word in one paragraph, **When** the diff preview renders, **Then** the removed paragraph shows the subtle deletion treatment on the whole line with strong deletion emphasis on only the old word, and the inserted paragraph shows the subtle insertion treatment with strong insertion emphasis on only the new word.
2. **Given** a replace region whose changed words carry inline formatting (bold, color, links…), **When** the refined diff renders, **Then** that formatting is preserved on the split segments — word emphasis is layered on, formatting is not lost.
3. **Given** a version range where a line was purely added (no adjacent removal) or purely removed, **When** the preview renders, **Then** those lines render exactly as today — subtle line-level marks only.
4. **Given** a version diff the user viewed before this feature shipped (previously cached), **When** they view it again after the feature ships, **Then** they see the word-refined rendering — never a stale line-level result.
5. **Given** a replace region that does not align well (e.g. a paragraph completely rewritten, or refinement hits an unexpected structure), **When** the preview renders, **Then** the result is never worse than today's line-level marking.

---

### User Story 3 - Existing content and both themes stay correct (Priority: P3)

Nothing that exists today regresses: chats persisted before the feature render exactly as they always did; live editing never produces the new marks; and the two-tier treatment is legible in light mode and every dark-theme variant.

**Why this priority**: Pure protection — it delivers no new capability but converts the feature from "works in a demo" to "shippable". Both amendments pin the backward-compatibility halves explicitly.

**Independent Test**: Open a chat from before the feature ships and confirm its diffs render unchanged; toggle dark mode on both surfaces and confirm the strong highlight is distinguishable from the row tint and the text stays readable.

**Acceptance Scenarios**:

1. **Given** a persisted tool part created before this feature (no `inlineSegments` field), **When** its chat re-renders, **Then** the diff renders exactly as before the feature — plain line text, no errors, no visual change.
2. **Given** a user editing a document normally (typing, pasting, formatting), **When** they use any editor affordance, **Then** the strong word marks never appear in a live document — they are produced exclusively by the diff computation.
3. **Given** either diff surface in light mode or any dark-theme variant, **When** a two-tier diff renders, **Then** the strong word highlight is clearly distinguishable from the subtle row/line tint and the highlighted text remains readable.

### Edge Cases

- **Unequal `-`/`+` counts in a chat change block** (e.g. 2 removed lines, 3 added): lines are paired by position up to the shorter count and refined; the leftover unpaired lines carry no word emphasis — the row tint already says "wholly new/gone" (per the assistant-design amendment).
- **Format-only pairs (chat)**: the existing format-only detection wins; annotated pairs get no word segments (their plain text is identical — word-diffing would highlight markup noise, not content).
- **Server-truncated chat diffs**: when the diff exceeds the existing size limits and is cut to the line cap, word segments are kept only for surviving lines (mirroring how format annotations are filtered today). No segment may reference a truncated-away line. The limits themselves do not change.
- **Whitespace-only change within a line** (e.g. double space → single space): the whitespace-preserving segmentation reports it, and the changed whitespace run gets the strong highlight like any other changed segment — a background highlight is exactly what makes an invisible edit visible (RBD-1).
- **Line completely rewritten**: when no words survive between the paired lines, the strong highlight legitimately covers the whole line content. No similarity threshold suppresses refinement in v1 (RBD-2).
- **Multi-line replace regions with unequal line counts (version history)**: refinement operates on the whole region's plain text (both sides concatenated block-wise), so a 2-line → 3-line rewrite is refined as one word-diff — no per-line pairing is required on this surface.
- **Refinement failure (both surfaces)**: word refinement is strictly best-effort. Any error segmenting, splitting, or stamping falls back to today's line-level presentation for that region/pair; it never fails the version-diff request or the tool call, and never blocks the edit itself (RBD-3).
- **Replace region whose sides have identical plain text (version history)**: formatting-only at region level — segmentation finds no changed words, so the region renders with subtle line-level marks only (correct: the text didn't change).
- **Inline formatting spanning a word boundary (version history)**: splitting a text node at a segment boundary preserves the node's existing marks on every resulting piece; a bold phrase half-changed shows bold throughout with strong emphasis on only the changed half.
- **Non-prose blocks in a replace region** (headings, list items, code blocks, table cells): refined uniformly — no block-type carve-outs in v1 (RBD-4).
- **Stale caches / stale clients**: previously cached version diffs are never served in the old shape (cache version bump); a client rendering a payload without the new field falls back to today's rendering (additive-field contract).
- **Empty or blank-line pairs**: a paired line whose content is empty after the prefix produces no changed segments worth emphasizing; rendering degrades to today's behavior (no zero-width highlight artifacts).

## Requirements *(mandatory)*

### Functional Requirements

**Shared segmentation**

- **FR-001**: One shared word-segmentation helper MUST be the single source of truth for "what changed within a line/region" for both surfaces. Given a before-text and an after-text it returns ordered segments for each side, each segment flagged changed or unchanged; segmentation is word-level and whitespace-preserving (`diffWordsWithSpace` semantics); unchanged runs appear on both sides; adjacent segments with the same changed-flag are coalesced. Both surfaces MUST consume this helper — neither may implement its own tokenization.

**Chat tool-output diff (modify and undo/redo cards)**

- **FR-002**: The server diff post-processing MUST, for each non-format-only change block, pair removed and added lines by position up to the shorter side's count, segment each pair's prefix-stripped text with the shared helper, and attach the results as an `inlineSegments` map keyed by the output line index (removed line index → before-segments, added line index → after-segments).
- **FR-003**: Unpaired surplus removed/added lines, format-only annotated pairs, and context lines MUST carry no word segments. Format-only detection and its annotations are unchanged.
- **FR-004**: `inlineSegments` is strictly additive to the chat diff payload: `lines`, `hunkStarts`, `formatAnnotations`, and `truncatedByServer` keep their exact existing meanings; the field is absent when no pair produced segments; and every producer of the payload (modify and the shared undo/redo handler alike) carries it by construction.
- **FR-005**: When the server truncates an oversized diff, `inlineSegments` MUST be filtered to keys within the surviving line range, exactly as format annotations are filtered today. Existing size limits are reused; no new limits.
- **FR-006**: The chat diff view MUST render a row that has segments as: the prefix character, then the segments in order — unchanged segments as plain text, changed segments wrapped in a stronger-highlight span — with the row's existing tint, gutter, hunk separators, format annotations, expand/collapse, and truncation notice all unchanged. A row without segments (including every row of a pre-feature persisted payload) MUST render byte-identically to today.

**Version-history diff**

- **FR-007**: The version diff computation MUST detect replace regions — a removed run immediately followed by an added run in the line-diff output — and apply word refinement to them: both sides parsed unmarked, their plain text segmented by the shared helper, and the resulting parsed text nodes split at segment boundaries so changed ranges carry the strong marks (`diffDeleteWord`/`diffInsertWord`) and unchanged ranges within the region keep the subtle marks (`diffDelete`/`diffInsert`). Lone added runs, lone removed runs, and unchanged runs are processed exactly as today.
- **FR-008**: The characterization-frozen strict markdown parser MUST NOT change (constitution-adjacent freeze CN-2, pinned by the design amendment). Refinement is post-processing over the parser's output only.
- **FR-009**: Two new marks, `diffInsertWord` and `diffDeleteWord`, MUST be registered in the shared document schema and the editor's extension set, rendering as the insert/delete elements with a distinguishing word-tier class. They are produced exclusively by the diff service — no input rules, keyboard shortcuts, or editing path may create them — and their presence in the schema MUST NOT alter any live-document behavior.
- **FR-010**: Splitting a text node at segment boundaries MUST preserve the node's existing formatting marks (bold, italic, color, link, …) on every resulting piece; in a refined region every text range carries exactly one diff-tier mark (subtle or strong) — the tiers never nest.
- **FR-011**: The server diff cache version MUST be bumped (v7 → v8) so no previously cached line-level diff is ever served after the feature ships.

**Cross-cutting**

- **FR-012**: Word refinement on both surfaces MUST be best-effort and fail-open: any refinement error degrades that pair/region to today's line-level presentation, is at most logged, and never fails the diff request, the tool call, or the underlying edit (RBD-3).
- **FR-013**: The visual treatment is two-tier on both surfaces: the existing subtle whole-line/row tint is retained unchanged, and the strong word highlight MUST be clearly distinguishable from it — derived from the existing theme-aware add/remove color families (no new hue) — in light mode and in every dark-theme variant, with highlighted text remaining readable in all of them.
- **FR-014**: Diff computation stays server-side on both surfaces, and no endpoint, payload, or persisted shape changes beyond the additive `inlineSegments` field and the two new marks. The legacy unused ychange path is out of scope and untouched.

### Key Entities

- **Word segment**: an ordered piece of one side of a changed line/region — `{ text, changed }` — produced by the shared helper; the unit both renderers consume. Character-faithful: concatenating a side's segments reproduces that side's text exactly.
- **`inlineSegments`** (chat payload): optional map from output line index → that line's segment list; additive to the existing diff payload; absent = render as today.
- **Strong diff marks** (version diff): `diffInsertWord`/`diffDeleteWord` — the word-emphasis tier alongside the existing subtle `diffInsert`/`diffDelete`; diff-service-only provenance.
- **Strong highlight tokens**: theme-aware stronger add/remove background colors defined alongside the existing subtle diff tint tokens, present in the light block and every dark block.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a one-word edit in a long paragraph, a reader can identify the changed word on the chat diff card without reading either full line — the strong highlight covers only that word (plus, at most, adjoining changed whitespace) on both the removed and added rows.
- **SC-002**: The same one-word edit viewed in Version History with highlighting on shows the identical two-tier read: whole lines subtly marked, only the changed words strongly emphasized, on both sides.
- **SC-003**: Segmentation parity: for the same before/after text, both surfaces emphasize the same words (single shared helper, verified by tests exercising both paths on shared fixtures).
- **SC-004**: Zero regression for pre-existing content: a chat persisted before the feature renders its diffs pixel-identically to today, and no error is logged rendering payloads without the new field.
- **SC-005**: A version diff viewed before the feature shipped shows word-level refinement when re-viewed after — stale cached line-level results are never served.
- **SC-006**: Purely added lines, purely removed lines, and format-only pairs render exactly as today on both surfaces (row/line tint and annotations only — no word emphasis).
- **SC-007**: In light mode and every dark-theme variant, the strong highlight is visually distinguishable from the subtle tint and highlighted text remains readable (manual visual check on both surfaces in both themes).
- **SC-008**: All existing diff-related test suites pass unchanged in meaning (the cache-version characterization assertion updates to the new version); refinement failures in fault-injection tests degrade to line-level output rather than erroring.
- **SC-009**: Live documents never contain the strong word marks: no editing action can produce them, and documents round-trip through save/load/export unaffected by the schema addition.

## Dependencies & Sequencing

- **Design ground truth first**: both 2026-07-19 amendments are already exported to `design/` (RATIFIED); this spec converges to them and cites them rather than re-deciding.
- **Feature 020 (undo/redo diffs) is merged substrate**: undo/redo cards reuse the modify diff payload and renderer, so they inherit word emphasis by construction — no undo-specific work beyond tests.
- **Frozen parser (CN-2)**: the strict parser's characterization freeze is a hard constraint; refinement is designed as post-processing precisely to honor it.
- **No new dependencies**: jsdiff (`diff` ^8.0.4) is already installed and already powers both existing diff computations; `diffWordsWithSpace` comes from it.
- **No migrations**: no database schema changes; the chat field rides existing tool-part persistence, and the version-diff marks ride the existing document JSON shape.
- **Cache coherency**: the version-diff cache version bump is part of the feature, not a deploy afterthought — shipping the code without the bump would serve stale line-level diffs.

## Assumptions

- The shared helper lives with other shared client/server logic (constitution: shared logic belongs under `shared/`) and is consumed server-side by both paths; no client-side diff computation is introduced.
- Segmentation cost is negligible relative to the existing per-diff work (both surfaces already run full line diffs and markdown parses server-side); no new performance budget is needed beyond the existing chat-diff size caps and version-diff caching.
- The chat renderer and the version preview are the only consumers of the two payloads; external MCP clients that read modify/undo/redo results treat `inlineSegments` as an ignorable additive field (standard additive-contract behavior, same posture as 020's `diff` field).
- The version-preview surface renders whatever marks the server document carries; adding the strong marks to the schema and extension set is sufficient for it to render them — no preview-side diff logic exists or is added.
- Because the refinement word-diffs the exact plain text the strict parser emitted, character offsets between the segment stream and the parsed text nodes align by construction; the inter-block newline used when concatenating block text belongs to no text node and is skipped by the offset walk.
- "Every dark block" for the strong tokens means every place the existing subtle diff tint tokens are themed today; the feature adds no new theming surface.
