---

description: "Task list for feature 027-read-only-highlights"
---

# Tasks: Read-Only Highlights — Position Math Never Writes

**Input**: Design documents from `/specs/027-read-only-highlights/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: REQUIRED for this feature. The spec is invariant-enforcement and Constitution
Principle II makes the test suite the only reviewer; every user story's acceptance IS a
test. Tasks are test-first.

**Design ground truth**: `design/agent-surface-mcp.md`, "Amendment (Sam, 2026-07-21) —
reads never write" (commit 6bacaf7).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 mapping to spec.md user stories
- Exact file paths included

## Test harness note (applies to every test/run task)

Backend suites are **serial-only** against a shared DB (Constitution II). Run in the
implementer's worktree against dedicated DB `collab_test_db_027`; jest config ignores
`/.claude/worktrees/`, so use a temp jest config or `rootDir` override plus `--forceExit`
(MEMORY: local-backend-test-stack, backend-test-db-serial-only). Purely in-memory yjs
unit tests (boundary/parity/text-path) need no DB.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Test environment + capture the pre-fix baseline the regression guard needs.

- [X] T001 Configure the worktree test env: create/seed DB `collab_test_db_027`, add a temp jest config (or `rootDir` override) that reaches into the worktree despite the `/.claude/worktrees/` ignore, and confirm `npx jest --runInBand --forceExit` runs a trivial `server/mcp/__tests__/yjs` test green. Document the exact command in the worktree (not in repo docs).
- [X] T002 [P] Capture the FR-005/SC-004 text-path baseline: with the CURRENT (pre-fix) `server/mcp/yjs/cursor-operations.js`, serialize positions for a corpus of text-bearing inputs (single paragraph, nested list item, heading, multi-child block; via both `createCursorPosition` and `createCursorPositionFromPath` at several offsets incl. past-end) and save the JSON to `server/mcp/__tests__/fixtures/cursor-textpath-baseline.json`. MUST be captured before any edit to the helper.

**Checkpoint**: env green; text-path baseline frozen.

---

## Phase 2: Foundational (Shared Fix + Gating Tests) — BLOCKS all user stories

**Purpose**: The single shared change that makes the invariant true on every path, plus
the go/no-go resolver-parity gate. All three user stories verify this one fix through
different lenses, so it is foundational and unavoidably prerequisite.

**⚠️ CRITICAL**: No user-story acceptance task can pass until this phase is complete.

- [X] T003 [P] Write failing unit tests `server/mcp/__tests__/yjs/cursor-operations-boundary.test.js`: for empty paragraph, image, horizontalRule, a nested empty container (empty list item / blockquote / table cell), and an empty document — assert `createCursorPosition` and `createCursorPositionFromPath` (a) write **zero** bytes (`Y.encodeStateAsUpdate` delta === 0), (b) create **no** child in the target element, and (c) return a position that resolves **non-null** via `Y.createAbsolutePositionFromRelativePosition`. Include the D-4 case: a nonzero offset into a text-less element clamps to the boundary and does not throw.
- [X] T004 [P] Write the resolver-parity gate `server/mcp/__tests__/yjs/cursor-operations-resolver-parity.test.js`: build a live replica (second `Y.Doc` synced from the first) with a real ProseMirror `EditorState` + y-prosemirror `ySyncPlugin` binding over the app schema; for boundary-anchored anchor/head positions on each text-less block, assert `relativePositionToAbsolutePosition(yDoc, yXmlFragment, relPos, binding.mapping)` returns a non-null number (FR-004/SC-003). This test is the go/no-go decision procedure for the construction (research R-3).
- [X] T005 Apply the element-boundary fix in `createCursorPosition` (`server/mcp/yjs/cursor-operations.js`, the text-less branch at lines ~68–72): remove `new Y.XmlText()` + `block.insert(0, …)`; return `Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(block, 0))`.
- [X] T006 Apply the identical fix in `createCursorPositionFromPath` (`server/mcp/yjs/cursor-operations.js`, text-less branch at lines ~595–599): remove `new Y.XmlText()` + `currentElement.insert(0, …)`; return `Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(currentElement, 0))`. (Same file as T005 — sequential, not [P].)
- [X] T007 Run T003 + T004. If the resolver-parity gate (T004) is red for any shape, switch the construction to the fragment-index anchor (`createRelativePositionFromTypeIndex(xmlFragment, blockIndex)`) or the assoc-tuned form per research R-3, re-edit T005/T006, and re-run until both green.
- [X] T008 Re-pin the latent-behavior test `server/mcp/__tests__/yjs/cursor-operations-empty-blocks.test.js`: the six tests asserting `children.length === 1` / `children[0] instanceof Y.XmlText` after a position call (e.g. lines 41–43, 66–73, 124–129, 182–187) now assert **no child is created** and the returned position resolves at the boundary. Rewrite the assertions honestly to the new invariant; do NOT delete them (SC-006, research R-5).
- [X] T009 Run the text-path regression guard: add `server/mcp/__tests__/yjs/cursor-operations-textpath-regression.test.js` that re-serializes the T002 corpus with the fixed helper and asserts byte-identical equality to `fixtures/cursor-textpath-baseline.json` (FR-005/SC-004). Must be green — the text-less branch is the only behavior that changed.

**Checkpoint**: position helpers are pure on every path; text-bearing output unchanged; construction validated against the client resolver.

---

## Phase 3: User Story 1 - Reading a document leaves zero trace (Priority: P1) 🎯 MVP

**Goal**: A read over any document shape persists zero update-log rows, does not advance
the clock, and never adds the agent as an author.

**Independent Test**: Run `integration/read-zero-writes.test.js` alone against
`collab_test_db_027`.

- [X] T010 [P] [US1] Write `server/mcp/__tests__/integration/read-zero-writes.test.js`: build a doc containing an empty paragraph + image + horizontal rule; record update-log row count (`getRecentUpdatesWithUsers`), doc clock, and version-history author set (`recentAuthors` / `getCurrentSessionAuthors`); perform (a) a whole-document `read_document` and (b) an xpath read targeting the empty paragraph, the image, and the hr individually; assert row count unchanged, clock unchanged, and no new agent author for each (SC-001/SC-002, acceptance scenarios 1,2,5).
- [X] T011 [US1] Add the empty-document edge to the same file: a completely empty doc (zero blocks) and a doc whose only block is text-less — a read succeeds, surfaces no error to the agent, emits no highlight where none is possible, and persists zero updates and does not throw (spec edge cases; acceptance scenario 3). Run the file green against `collab_test_db_027`.

**Checkpoint**: reads provably write nothing — MVP delivered.

---

## Phase 4: User Story 2 - Text-less blocks still get a visible highlight (Priority: P2)

**Goal**: Every block in a read sweep — including image/hr/empty-paragraph — gets a
boundary-anchored highlight that resolves non-null on a live replica; none are dropped.

**Independent Test**: Run the sweep-fidelity test alone.

- [ ] T012 [P] [US2] Write `server/mcp/__tests__/yjs/cursor-operations-sweep-fidelity.test.js`: for a whole-document read over a doc mixing text blocks and text-less blocks, assert `createExpandingBlockHighlights(fragment, 0, n)` covers every block with no gaps/dropped steps and every emitted anchor/head resolves non-null under the client resolution semantics (reuse the T004 replica harness) — SC-003, acceptance scenario 2.
- [ ] T013 [US2] In the same file, assert `createNodeSelection` and `createBlockRangeSelection` over an image, an hr, and an empty paragraph each return a non-null `{anchor, head}` (not null-dropped), with both endpoints resolvable — acceptance scenarios 1,3. Confirm the read path (`server/mcp/tools/read-document.js` xpath branch) therefore emits a highlight for a text-less node rather than skipping it.

**Checkpoint**: text-less blocks get visible, resolvable highlights — no silent fidelity regression.

---

## Phase 5: User Story 3 - Mutation cursor sweeps stop inserting placeholders too (Priority: P3)

**Goal**: A mutation whose sweep crosses text-less blocks persists only its intended
content edits — no placeholder insertions — while sweep coverage is unchanged.

**Independent Test**: Run the mutation-purity test alone against `collab_test_db_027`.

- [ ] T014 [P] [US3] Write `server/mcp/__tests__/integration/mutation-sweep-purity.test.js`: run a modify that edits two paragraphs with an image between them (sweep crosses the image); assert the persisted update set equals exactly the two paragraph edits — no insertion into the image block — while the aggregated sweep spans still cover the image (SC-005, acceptance scenario 1). Exercises `createOperationSelection` via `server/mcp/sandbox/bridge.js` + `server/mcp/mutation-aggregator.js`.
- [ ] T015 [US3] Add a focused assertion that `createOperationSelection(fragment, op)` for an operation whose path targets a text-less element writes zero bytes to the doc (acceptance scenario 2) — verifying the mutation path shares the pure helper with no write-allowed flag (D-3).

**Checkpoint**: the invariant holds on the mutation path too — bug cannot resurface via mutations.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T016 [P] Run the full existing presence/highlight suite unchanged: `server/mcp/__tests__/yjs/cursor-operations-hierarchy.test.js`, `server/mcp/__tests__/mutation-aggregator.test.js`, `server/mcp/__tests__/tools/read-document.test.js`, `server/__tests__/xpath-highlight.test.js`, `server/mcp/__tests__/agent-presence.test.js`. All pass unchanged except the re-pinned empty-blocks file (SC-006). Investigate any other failure as a real regression.
- [ ] T017 Run the `quickstart.md` "Reproduce the bug" one-liner and confirm it now prints `bytes written: 0` / `child count: 0`, then run the full `quickstart.md` validation block.
- [ ] T018 [P] Diff-guard (FR-007): confirm the change set touches no client code, no DB migration, and no MCP tool/API contract — `git diff --name-only` shows only `server/mcp/yjs/cursor-operations.js` plus test/fixture files under `server/mcp/__tests__` and `server/__tests__`; no `client/`, no `migrations/`, no tool descriptions.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no deps. T002 MUST run before any helper edit (captures pre-fix baseline).
- **Foundational (Phase 2)**: depends on Setup. Contains the shared fix (T005/T006) and its gates — **BLOCKS all user stories**.
- **User Stories (Phase 3–5)**: each depends only on Foundational completion; independently testable thereafter.
- **Polish (Phase 6)**: depends on all desired stories complete.

### Within Foundational

- T003, T004 (tests, different files) before T005/T006 (edit) — tests-fail-first.
- T005 → T006 are the SAME file (`cursor-operations.js`): sequential, not parallel.
- T007 (run + fallback decision) after T005/T006. T008, T009 after the fix is green.

### User Story Independence

- US1 (T010–T011), US2 (T012–T013), US3 (T014–T015) touch separate test files and can be
  written/run in parallel once Phase 2 is done. The production change they all verify is
  the single Phase-2 fix.

### Parallel Opportunities

- T002 ∥ nothing-else-yet (setup).
- T003 ∥ T004 (different new test files).
- Across stories once Phase 2 done: T010 ∥ T012 ∥ T014 (different files).
- Polish: T016 ∥ T018.

---

## Parallel Example: after Foundational

```bash
# Independent per-story acceptance tests (different files):
Task: "US1 zero-writes  → server/mcp/__tests__/integration/read-zero-writes.test.js"
Task: "US2 sweep fidelity → server/mcp/__tests__/yjs/cursor-operations-sweep-fidelity.test.js"
Task: "US3 mutation purity → server/mcp/__tests__/integration/mutation-sweep-purity.test.js"
```

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (the fix) → 3. Phase 3 US1 → **STOP & VALIDATE**
zero-writes. This is the bug fix and the invariant; it is shippable on its own.

### Incremental

Add US2 (highlight fidelity is the guard against the cheap skip-the-block regression),
then US3 (close the mutation path), then Polish (full-suite + diff-guard).

### Notes

- The whole feature is one production edit (two branches in one file) plus tests; the
  phasing reflects verification lenses, not separable production deltas.
- Verify each new test FAILS before T005/T006, then passes after.
- Never introduce a write-allowed flag for the mutation path (D-3) — the helper is simply pure.
- Fail-observational everywhere: a position that cannot be computed skips the highlight; it never writes (FR-009).
