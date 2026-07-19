---
description: "Task list for feature 022 — word-level two-tier inline diff highlighting"
---

# Tasks: Word-Level Two-Tier Inline Diff Highlighting

**Input**: Design documents from `/specs/022-inline-diff-highlighting/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: INCLUDED — the spec's Success Criteria (SC-003/SC-004/SC-008) and both design
amendments require test coverage; constitution II mandates test-backed changes and
round-trip coverage for new marks.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 (chat), US2 (history), US3 (backward-compat/themes)
- All paths are repo-root-relative to `/local-dev`.

## Conventions

- Backend Jest is **serial-only** (`--runInBand`); shared DB (constitution II).
- Client tests are Vitest under `client/`.
- Stay on branch `main`; do NOT commit (parallel-agent override — implement/merge agents own commits).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Directory scaffolding for the two new files. No new dependencies (`diff`
^8.0.4 already installed); no migrations.

- [X] T001 [P] Create the `shared/diff/` and `server/diff/` directories (new files land here in later phases). No other setup — verify `diff` ^8.0.4 is present in `package.json` (it is).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The one shared word-segmentation helper that BOTH surfaces consume. Nothing
in US1 or US2 can be built until this exists and is correct (FR-001, SC-003).

**⚠️ CRITICAL**: Blocks US1 and US2.

- [X] T002 [US-shared] Write the failing unit test `shared/diff/__tests__/word-diff.test.js` (or the nearest existing shared test location) per [contracts/word-diff-helper.md](./contracts/word-diff-helper.md): faithfulness (segments rejoin to input), one-word change isolates the changed word on both sides, identical inputs yield no `changed:true` segments, whitespace-only change yields a `changed:true` whitespace segment, adjacent same-flag coalescing.
- [X] T003 Implement `shared/diff/word-diff.js` exporting `computeWordSegments(before, after)` using `diffWordsWithSpace` from `diff`: `.removed`→before/`changed:true`, `.added`→after/`changed:true`, neither→both/`changed:false`; coalesce adjacent same-flag segments per side. Make T002 pass.

**Checkpoint**: Shared helper green — US1 and US2 can proceed in parallel.

---

## Phase 3: User Story 1 - Chat user sees which words a tool edit changed (Priority: P1) 🎯 MVP

**Goal**: The chat modify/undo/redo diff card strongly highlights only the changed words
on each `-`/`+` row, over the existing row tint.

**Independent Test**: Ask the assistant to replace one word in a paragraph; the modify
card's diff shows row tint + a strong highlight on exactly the replaced word on both rows.

### Tests for User Story 1

- [X] T004 [P] [US1] Extend `server/mcp/__tests__/diff-postprocess.test.js`: a word-changed `-`/`+` pair yields `inlineSegments` keyed by output line index with the correct before/after segments (prefix-stripped); format-only annotated pairs yield NO segments; pure add-only / remove-only blocks yield NO segments; unequal `-`/`+` counts pair up to `min(del,add)` and leave surplus lines segment-free (FR-002/FR-003, edge cases).
- [X] T005 [P] [US1] Extend `server/mcp/__tests__/diff-postprocess.test.js` (or `diff-utils` coverage): on the `truncatedByServer` branch, `inlineSegments` keys are filtered to `< MAX_DIFF_LINES` (200), mirroring `formatAnnotations`; no key references a truncated-away line (FR-005).
- [X] T006 [P] [US1] Extend `client/src/components/__tests__/AiChatMessages.test.jsx` (reuse/extend the `diffOutput` fixture ~L609): `DiffView` given `inlineSegments` renders `.ai-diff-word` spans on exactly the changed words with the prefix char preserved; a payload WITHOUT `inlineSegments` renders the plain `{entry.line}` identically (FR-006, SC-004).

### Implementation for User Story 1

- [X] T007 [US1] In `server/mcp/diff-postprocess.js` (`postProcessDiffLines`, non-format-only paired branch ~L161-169): pair del/add lines by index up to `min(delCount, addCount)`, call `computeWordSegments` on each pair's prefix-stripped text, and record `inlineSegments[delOutIdx]=segments.before` / `inlineSegments[addOutIdx]=segments.after` keyed by the `result`/`lines` output index. Return `inlineSegments` (an object, or `undefined` when empty) alongside `lines`/`hunkStarts`/`formatAnnotations`.
- [X] T008 [US1] In `server/mcp/diff-utils.js` (`computeChatDiff` ~L40-52): thread `processed.inlineSegments` into the return value on the normal branch, and on the `truncatedByServer` branch filter its keys to `Number(k) < MAX_DIFF_LINES` (mirroring the `formatAnnotations` filter). Depends on T007.
- [X] T009 [US1] In `client/src/components/AiChatMessages.jsx` (`DiffView` ~L271-345): read `const inlineSegments = diff.inlineSegments || {}`; when `inlineSegments[String(i)]` exists, render the prefix char (`entry.line[0]`) then the segments — unchanged as plain text, `changed` wrapped in `<span className="ai-diff-word">`; otherwise render `{entry.line}` unchanged. Leave row tint, gutter, hunk separators, `formatAnnotation`, expand/collapse, and truncation notice untouched (FR-006). Depends on T008.
- [X] T010 [US1] In `client/src/components/AiPanel.css`: add `.ai-diff-row--added .ai-diff-word` / `.ai-diff-row--removed .ai-diff-word` strong-highlight rules off the existing `--success`/`--danger` families (non-subtle token at moderate alpha, `border-radius: 2px`) so the word reads stronger than the row tint; light + dark both work because the tokens are theme-aware (FR-013).

**Checkpoint**: US1 fully functional and testable — MVP deployable without touching version history. Undo/redo cards inherit the treatment for free (020 shares the renderer — verified in US3-T021).

---

## Phase 4: User Story 2 - Version history shows which words changed between versions (Priority: P2)

**Goal**: The version-diff preview keeps the subtle whole-line insert/delete tint and
adds strong emphasis on only the changed words, via two new service-only marks.

**Independent Test**: One-word edit → version boundary → Version History with "Highlight
changes" on shows subtle line-level marks + strong emphasis on only the changed word.

### Tests for User Story 2

- [ ] T011 [P] [US2] Extend `server/__tests__/diff-service.test.js`: a single-word change in a line produces `diffDeleteWord`/`diffInsertWord` on ONLY the changed word and subtle `diffDelete`/`diffInsert` on the rest; lone-added / lone-removed / unchanged / format-only-at-region-level paths still hold (FR-007). Include a case where a changed word carries inline formatting (bold) and confirm the formatting mark survives the split alongside the diff mark (FR-010).
- [ ] T012 [P] [US2] Extend `server/__tests__/diff-service.test.js` with a fault-injection case: when refinement throws for a region, the region degrades to today's line-level marks and `computeMarkdownDiff` does NOT throw and does NOT cache an error result (FR-012 / RBD-3).
- [ ] T013 [P] [US2] Extend `server/__tests__/format-roundtrip.test.js` so `diffInsertWord`/`diffDeleteWord` get bidirectional round-trip coverage (constitution II — registry-driven suite).
- [ ] T014 [P] [US2] Update the assertion in `server/__tests__/markdown-strict-characterization.test.js` (~L69) from `'v7'` to `'v8'` (FR-011).

### Implementation for User Story 2

- [ ] T015 [P] [US2] Register `diffInsertWord`/`diffDeleteWord` marks in `shared/prosemirror-schema.js` (~L412-424, next to `diffInsert`/`diffDelete`), rendered/parsed as `<ins class="diff-word">` / `<del class="diff-word">` (schema validation + round-trip). No input rules/shortcuts (FR-009). See [contracts/version-diff-marks.md](./contracts/version-diff-marks.md).
- [ ] T016 [P] [US2] Define `DiffInsertWord`/`DiffDeleteWord` TipTap marks in `client/src/extensions/editorExtensions.js` (~L80-90, alongside `DiffInsert`/`DiffDelete`) rendering `ins.diff-word`/`del.diff-word`, and add both to the `getBaseExtensions` list (~L120-121) so `VersionPreview` renders them. Diff-service provenance only — no input rules/shortcuts (FR-009).
- [ ] T017 [US2] Implement `server/diff/apply-word-marks.js` per [contracts/version-diff-marks.md](./contracts/version-diff-marks.md): parse both region sides UNMARKED, concatenate text-node text (blocks joined by `'\n'`), `computeWordSegments` on the plain text, walk PM text nodes tracking char offset, split at segment boundaries, stamp strong marks on changed ranges / subtle marks elsewhere, preserving existing formatting marks; skip the inter-block `'\n'` offset. Wrap the whole region in try/catch → fall back to line-level `markdownToPm(removedMd,'diffDelete')`+`markdownToPm(addedMd,'diffInsert')`, log at most once (FR-012). Depends on T003. Does NOT modify `shared/markdown/strict-parser.js` (CN-2 / FR-008).
- [ ] T018 [US2] In `server/diff-service.js` `computeMarkdownDiff` (~L194-212): detect a replace region (a `removed` part immediately followed by an `added` part) and route it through `apply-word-marks`; lone-added→`diffInsert`, lone-removed→`diffDelete`, unchanged→`null` stay exactly as today. Depends on T017.
- [ ] T019 [US2] In `server/diff-service.js` bump `CACHE_VERSION` `'v7'`→`'v8'` (L22) so stale line-level diffs aren't served from Redis (FR-011). Pairs with T014.
- [ ] T020 [P] [US2] Add strong CSS tokens `--canvas-diff-add-bg-strong`/`--canvas-diff-del-bg-strong` in `client/src/index.css` in the light `:root` block (~L130-131) AND every dark block (~L209-210, ~L272-273, ~L295-296); add `.version-preview ins.diff-word`/`del.diff-word` rules in `client/src/components/VersionPreview.css` (after the base `ins`/`del` rules ~L55-66) using those tokens, keeping the base `text-decoration` behavior (FR-013, SC-007).

**Checkpoint**: US1 and US2 both work independently; both surfaces emphasize the same words (SC-003, shared helper).

---

## Phase 5: User Story 3 - Existing content and both themes stay correct (Priority: P3)

**Goal**: No regression — pre-feature chats render identically, live editing never
produces the new marks, and the two-tier read is legible in light + every dark variant.

**Independent Test**: Open a pre-feature chat (diffs unchanged, no errors); toggle themes
on both surfaces (strong highlight distinguishable, text readable).

### Tests for User Story 3

- [ ] T021 [P] [US3] Add/extend a test asserting the undo/redo card path (`server/undo-service.js` → `computeChatDiff`) carries `inlineSegments` by construction, so undo/redo cards get word emphasis with no undo-specific code (spec US1 scenario 4, Dependencies).
- [ ] T022 [P] [US3] Add a backward-compat test (extend `AiChatMessages.test.jsx`): a persisted tool part WITHOUT `inlineSegments` renders its diff byte-identically to the pre-feature output and logs no error (SC-004, FR-006).
- [ ] T023 [P] [US3] Add a guard test that the two new marks have no input-rule / keyboard-shortcut / editing path — a normal edit round-trips through save/load without producing `diffInsertWord`/`diffDeleteWord` (SC-009, FR-009). Prefer asserting via the schema/extension config (no `addInputRules`/`addKeyboardShortcuts` on these marks) plus a round-trip of a plain edited doc.

### Manual verification for User Story 3 (real app, per quickstart.md)

- [ ] T024 [US3] Manual: open a chat from before the feature — diffs render unchanged, no console errors (SC-004). (Owner: Sam / deploy-time.)
- [ ] T025 [US3] Manual: on BOTH surfaces, in light mode and every dark variant, confirm the strong highlight is distinguishable from the subtle tint and highlighted text stays readable (SC-007). (Owner: Sam / deploy-time.)

**Checkpoint**: All three stories independently functional; backward-compat and theming protected.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T026 Run the full targeted suite serially and confirm green: `npx jest server/mcp/__tests__/diff-postprocess.test.js server/__tests__/diff-service.test.js server/__tests__/markdown-strict-characterization.test.js server/__tests__/format-roundtrip.test.js --runInBand` and `cd client && npx vitest run src/components/__tests__/AiChatMessages.test.jsx` (+ the shared word-diff test) — quickstart.md automated section (SC-008).
- [ ] T027 [P] Sanity-check no unrelated diff/format suites regressed (broader `npx jest server/__tests__ server/mcp/__tests__ --runInBand`); confirm the cache bump did not break any other CACHE_VERSION-coupled assertion.
- [ ] T028 Run the quickstart.md manual validation end to end (chat one-word edit, undo/redo card, version-history one-word edit, format-only + pure-add sanity) — SC-001/SC-002/SC-006. (Owner: Sam / deploy-time.)

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (T001)**: no dependencies.
- **Foundational (T002-T003)**: the shared helper — BLOCKS US1 and US2.
- **US1 (T004-T010)** and **US2 (T011-T020)**: both depend only on Foundational; can run in parallel (separate files/paths).
- **US3 (T021-T025)**: protective/verification; T021-T022 depend on US1, T023 depends on US2 (marks registered).
- **Polish (T026-T028)**: after the stories under test are complete.

### Within-story ordering

- US1: T007 → T008 → T009 (server produces the field before the client reads it); T010 (CSS) is parallel; tests T004-T006 authored first (TDD) and pass after implementation.
- US2: T015/T016 (marks) parallel; T017 (helper, depends T003) → T018 (integration) → T019 (cache bump); T020 (CSS) parallel; tests T011-T014 authored first.

### Parallel opportunities

- T004, T005, T006 (US1 tests) together.
- T011, T012, T013, T014 (US2 tests) together.
- T015, T016, T020 (schema / extension / CSS — different files) together.
- Once Foundational is green, an implementer can take US1 while another takes US2.

---

## Parallel Example: User Story 1

```bash
# US1 tests together (author failing first):
Task: "Extend diff-postprocess.test.js — inlineSegments on word-changed pairs (T004)"
Task: "Extend diff-postprocess/diff-utils — truncation filter (T005)"
Task: "Extend AiChatMessages.test.jsx — .ai-diff-word render + fallback (T006)"
```

---

## Implementation Strategy

### MVP first (US1 only)

1. T001 setup → T002-T003 shared helper (CRITICAL gate).
2. T004-T010 US1 chat path.
3. STOP and validate: chat one-word edit shows word emphasis; pre-feature payloads unchanged.
4. Deploy/demo — US1 stands alone.

### Incremental delivery

1. Foundational helper → US1 (MVP) → US2 (history) → US3 (protection) → Polish.
2. US2 requires the cache bump (T019) + characterization update (T014) to ship together, else stale line-level diffs are served.

---

## Notes

- [P] = different files, no incomplete-task dependency.
- The strict markdown parser (`shared/markdown/strict-parser.js`) is FROZEN (CN-2) — no task touches it.
- Refinement is fail-open on both surfaces (RBD-3) — T012 is the history fault-injection guard; the chat path degrades to the plain-line fallback by the same posture.
- Legacy `ychange` path is out of scope — untouched.
- Do NOT commit (parallel-agent override).
