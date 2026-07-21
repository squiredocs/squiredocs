# Tasks: Clean Hard-Break Rendering in Transcript Diffs

**Input**: Design documents from `/specs/028-clean-diff-hard-breaks/`

**Prerequisites**: plan.md, research.md, quickstart.md, spec.md (user stories), clarifications-needed.md (RBD-1..RBD-3)

**Tests**: INCLUDED — the spec mandates them (SC-007, Principle II). The feature is
test-first: the grammar predicate is pinned by unit tests before implementation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies).
- All test tasks below edit the **same** file
  (`server/mcp/__tests__/diff-postprocess.test.js`), so they are **not** mutually
  `[P]` — they are authored as independent `describe` blocks and are listed in
  dependency/priority order.

## Path Conventions

Web-service backend (single point of change):
- Logic: `server/mcp/diff-utils.js`
- Tests: `server/mcp/__tests__/diff-postprocess.test.js`

---

## Phase 1: Setup

- [X] **T001** Prepare the test harness: in `server/mcp/__tests__/diff-postprocess.test.js`,
  extend the top-of-file require to also import `stripHardBreakMarkers` from
  `../diff-utils` (it already imports `computeChatDiff` from there and the
  `diff-postprocess` exports). Confirm the worktree backend suite runs serially
  against the isolated `collab_test_db_028` (worktree jest-config workaround +
  `--forceExit`; see quickstart.md). No behavior change yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The single generation-point fix and its grammar spec. Every user story
depends on this. **CRITICAL**: complete before any story-level task.

- [X] **T002** Write the `stripHardBreakMarkers` **unit** spec (expect FAIL until T003).
  Add a `describe('stripHardBreakMarkers', ...)` block asserting input→output for every
  row of research.md R3's grammar table:
  (a) top-level poem stanza — internal `line\` markers stripped, block-final line preserved;
  (b) list-item continuation — `- a\` / `␠␠b` (content-column indent) marker stripped;
  (c) blockquote continuation — `> a\` / `> b` marker stripped;
  (d) block-final trailing `\` (RBD-1: literal end-of-paragraph AND trailing hardBreak) — **preserved**;
  (e) double backslash + continuation (edge f) — **exactly one** stripped, literal `\` kept;
  (f) code fence with a trailing-`\` content line — **preserved** (SC-002c);
  (g) diagram fence (mermaid/svg) with a trailing-`\` content line — **preserved** (SC-002d, RBD-3);
  (h) a document whose fence opens before the (hypothetical) hunk window — the full-doc
      scan keeps a mid-fence content `\` **preserved** (Edge Cases; verifies R1 whole-doc state);
  (i) heading and table-cell lines (serializer already `<br>`) pass through unchanged;
  (j) marker-only difference input pair — after cleanup the two strings are equal.

- [X] **T003** Implement `stripHardBreakMarkers(markdown)` in `server/mcp/diff-utils.js`
  and add it to `module.exports`. Line-scan the full string tracking fenced-block state
  (toggle on any line that, after stripping a leading blockquote `>`-run and indentation,
  begins with a triple-backtick fence — covers code + diagram fences, RBD-3). For a line
  outside all fences ending in `\`, strip **exactly one** trailing backslash iff line L+1
  exists and, after removing its container prefix (leading `>`-run for blockquotes, leading
  whitespace for list/task indent), is non-empty (research.md R3 predicate); otherwise leave
  the line byte-for-byte unchanged. Never remove a `\n`. Makes T002 pass.

- [X] **T004** Wire cleanup into the single generation point: in `computeChatDiff`
  (`server/mcp/diff-utils.js`), pass both inputs through `stripHardBreakMarkers` before
  `structuredPatch` (`const cleanBefore = stripHardBreakMarkers(mdBefore); const cleanAfter =
  stripHardBreakMarkers(mdAfter);`). No other line of `computeChatDiff` changes — caps,
  `hunkStarts`, `postProcessDiffLines`, and the truncation branch stay as-is (FR-005/FR-006, RBD-2).

**Checkpoint**: Both card types (modify `modify.js:512`, undo/redo `undo-service.js:77`)
now emit cleaned payloads by construction — they already route through `computeChatDiff`.

---

## Phase 3: User Story 1 — Hard-broken prose renders clean in modify-card diffs (P1) 🎯 MVP

**Goal**: The reported screenshot bug — a modify diff over hard-broken content shows zero
phantom trailing backslashes while every other diff behavior is unchanged.

**Independent Test**: `computeChatDiff(before, after)` over a hard-broken poem edit yields
`.lines` with no marker on any `-`/`+`/context row; tints/gutter/segments behave as today.

- [X] **T005** [US1] Integration test — screenshot scenario (AS1, SC-001): `computeChatDiff`
  over a poem-stanza edit → assert no `.lines` entry ends in a hard-break marker (removed,
  added, **and** context rows), and that `hunkStarts`/gutter numbering and hunk separators
  (`~~~`) are unchanged vs. the pre-cleanup line structure.

- [X] **T006** [US1] Integration test — container continuation (AS2, SC-002b): a hard break
  inside a list item and inside a blockquote → markers removed on the prefixed continuation
  forms (`- a\`/`␠␠b`, `> a\`/`> b`); container prefixes and indentation otherwise intact.

- [X] **T007** [US1] Integration test — 022 segments + format-only on cleaned text (AS3/AS4,
  SC-004): for a changed hard-broken line pair, assert no `inlineSegments` entry contains a
  marker and each row's segments concatenate exactly to that row's rendered text; and a
  formatting-only change on a hard-broken line still detects as format-only (annotation on
  the cleaned text), not a `-`/`+` pair.

**Checkpoint**: US1 fully functional and independently testable — the MVP.

---

## Phase 4: User Story 2 — Undo and redo cards get the identical treatment (P2)

**Goal**: Undo/redo cards render marker-free identically to modify cards, via the one shared path.

**Independent Test**: An undo-shaped call `computeChatDiff(preMarkdown, postMarkdown)` over
hard-broken content yields the same clean lines as the modify-shaped call.

- [X] **T008** [US2] Integration test — single generation point (AS1/AS2, SC-003): call
  `computeChatDiff` with an undo/redo-shaped `(preMarkdown, postMarkdown)` pair over
  hard-broken content and assert marker-free `.lines`; assert byte-identical output to the
  modify-direction call on the same pair — proving one shared cleanup, no divergent path.

**Checkpoint**: US2 verified — delivered by construction from Phase 2, confirmed here.

---

## Phase 5: User Story 3 — Genuine backslashes and everything else are untouched (P3)

**Goal**: Content backslashes, legacy payloads, and version-history output are all preserved exactly.

**Independent Test**: A code-block trailing-`\`, a paragraph-final literal `\`, and a
marker-only diff each behave per FR-003; version-history and word-diff suites are unchanged.

- [X] **T009** [US3] Integration test — preservation (AS1/AS2, SC-002c/d/e/f/g): `computeChatDiff`
  over an edit touching (i) a code block with a trailing-`\` content line, (ii) a mermaid/svg
  diagram fence with a trailing-`\` line, (iii) a paragraph whose text legitimately ends in `\`
  (RBD-1), (iv) a double-backslash-plus-continuation line, and (v) a mixed hunk combining
  several — assert every content backslash survives and only markers are removed; and a
  marker-only difference produces **no** hunk (FR-004).

- [X] **T010** [US3] Guard — untouched pipelines (SC-005, SC-006, FR-007/FR-008): assert (by
  test and by diff scope) that this change edits only `server/mcp/diff-utils.js` +
  its test file — `server/diff/*` (version history), `shared/diff/word-diff`,
  `server/mcp/yjs/serialization.js`, and all client code are unmodified — and that the
  existing version-history and word-diff suites pass unchanged in meaning (legacy payloads
  keep markers; no client stripping).

**Checkpoint**: US3 verified — the fix is grammar-keyed and lossless, not a substring hack.

---

## Phase 6: Polish & Cross-Cutting

- [X] **T011** Run the full serial backend suite in the worktree (`collab_test_db_028`,
  `--runInBand --forceExit`): all pre-existing `diff-postprocess.test.js` blocks
  (`stripSpanTags`/`extractPlainText`/`describeMarks`/`postProcessDiffLines`) pass unchanged
  in meaning (SC-007), and the new blocks pass. Confirm no `console.error` from the modify/
  undo best-effort diff paths. Update the manual-check status in the pipeline ledger; do NOT
  edit CLAUDE.md/README.md/docs (no user-facing behavior described there changes).

---

## Dependencies & Execution Order

- **T001** (setup) → **T002** (unit spec, RED) → **T003** (implement predicate, GREEN) →
  **T004** (wire into `computeChatDiff`). Strictly sequential — all touch the same two files.
- **T005–T010** depend on T003+T004. They share one test file, so author sequentially
  (independent `describe` blocks); none block each other logically — US1/US2/US3 can be
  verified in any order once Phase 2 is done.
- **T011** last (whole-suite gate).

## Implementation Strategy (MVP first)

Phase 2 + Phase 3 (through **T007**) is the shippable MVP: it fixes the reported screenshot
bug and proves the segment/format-only invariants. T008 (US2) and T009–T010 (US3) are
verification of behavior already delivered by the single Phase-2 fix — they convert
"works on the screenshot" into "shippable" and must pass before merge, but add no new
production code.

## MEDIUM analyze notes folded in (see analysis report)

- Fence detection must be prefix-aware (blockquote `>`-run, list/task indent) so a fenced
  block nested in a container is still recognized — encoded in **T003** and exercised by
  **T002(h)**. If the serializer never nests fences under a prefix in practice, the top-level
  cases (T002 f/g) are the load-bearing ones; the prefix-aware form is the safe superset.
