# Tasks: Undo/Redo Results Carry Diffs

**Input**: Design documents from `/specs/020-undo-redo-diffs/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/undo-redo-result.md, quickstart.md

**Tests**: REQUIRED and tests-first — the constitution (Principle II) makes the suite the only reviewer, and every FR below is pinned by a test before its implementation task.

**Sequencing pins (spec — non-negotiable)**: implementation starts only after feature 019 merges, on post-018 main. NO migrations. Do NOT touch `specs/016-*` through `specs/019-*`. Backend suites run SERIALLY against the shared test DB. FR-011 wording is measured against 019's dieted descriptions, never pre-019 text.

**Organization**: Grouped by user story (US1 chat diff rendering, US2 supersession honesty, US3 persistence + MCP surface).

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

**Purpose**: Confirm the pinned implementation base — no code changes.

- [X] T001 Verify preconditions on the implementation base: current main includes feature 019's merge (dieted `server/mcp/tools/undo.js` and `server/mcp/tools/redo.js` descriptions) and feature 018; then run the baseline suites green before touching anything — `npx jest server/undo server/mcp/__tests__/integration/undo-redo-workflow.test.js server/__tests__/chat-store.test.js --runInBand` and `cd client && npx vitest run src/components/__tests__/AiChatMessages.test.jsx`. If 019 is not merged, STOP (sequencing pin).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The pre/post markdown capture inside the inverse computation (plan D1/D2, RBD-3) — every story consumes it.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Extend `server/undo/__tests__/inverse.test.js` (tests FIRST — must fail against current code): (a) a successful `computeInverse` returns `preMarkdown`/`postMarkdown` strings that bracket the pop — `preMarkdown` equals the scratch doc's markdown including the live-doc merge, `postMarkdown` equals `preMarkdown` with the inverse applied (assert against `toMarkdown` of an equivalently-built doc); (b) fully-superseded target still returns `null` overall (unchanged 016 semantics); (c) when markdown serialization throws (mock `toMarkdown` from `server/mcp/yjs/serialization.js` to throw), `computeInverse` still returns `inverseUpdate` with `preMarkdown`/`postMarkdown` as `null` — the inverse is never lost to serialization failure.
- [X] T003 Implement capture in `server/undo/inverse.js`: import `toMarkdown` from `../mcp/yjs/serialization` (precedent: `server/diff-service.js:18`); inside `computeInverse`, after the live-doc merge and immediately before `undoManager.undo()`, capture `preMarkdown = toMarkdown(fragment)` in a try/catch; after a successful pop capture `postMarkdown` the same way; on any serialization throw set the pair to `null` and continue; return `{ inverseUpdate, preMarkdown, postMarkdown }`. All `null`-return paths and the inverse mechanics are byte-for-byte unchanged. T002 tests now pass.

**Checkpoint**: `computeInverse` exposes the race-free markdown bracket; 016 inverse tests still green.

---

## Phase 3: User Story 1 — Chat user sees what an assistant undo reverted (Priority: P1) 🎯 MVP

**Goal**: Successful undo/redo results carry modify-shape `diff` (FR-001..006 mechanics), and undo/redo tool cards render it with the existing DiffView (FR-008, RBD-4).

**Independent Test**: quickstart.md Manual E2E #1 and #3 — assistant edit → undo shows the inverse diff on the undo card; nothing-to-undo stays label-only.

### Tests for User Story 1 (write FIRST, ensure they FAIL)

- [ ] T004 [P] [US1] Extend `server/undo/__tests__/undo-service.test.js` — diff parity shape + empty-family absence: (a) a successful `performUndo` result carries `diff` deep-equal to `computeChatDiff(preMarkdown, postMarkdown)` for that revert, with only `{ lines, hunkStarts, formatAnnotations?, truncatedByServer? }` members and non-empty `lines` (contract C1/C2/C5); (b) same for `performRedo` (`redone: true`); (c) every honest-empty variant reachable in this suite — nothing recorded, pending-recording refusal (M2 seed), concurrent loser (M3/H1 patterns) — has NO `diff` own-property (`'diff' in result === false`), and `{ success, undone|redone, message, clock }` keep exact 016 values (FR-003/FR-004); (d) a formatting-only revert (undo of a mark-only agent edit) still yields a `diff` whose annotated `-`/`+` pair flows through the shared post-processing (`formatAnnotations` present) — it must NOT be dropped by the non-empty-lines guard (spec edge case, RBD-4).
- [ ] T005 [P] [US1] Extend `server/undo/__tests__/undo-service.test.js` — best-effort failure: with `computeChatDiff` mocked to throw (`jest.spyOn(require('../../mcp/diff-utils'), 'computeChatDiff')` — works only because T008 calls it via the module namespace, see T008), `performUndo` still returns `undone: true` with no `diff` key, and the inverse is actually applied/stored (revert stands sans diff — FR-006, RBD-3).
- [ ] T006 [P] [US1] Extend `server/undo/__tests__/undo-service.test.js` — truncation bounds: seed an agent edit whose revert diff exceeds 50,000 chars; `performUndo` returns `undone: true`, `diff.truncatedByServer === true`, `diff.lines.length <= 200`, and the document state is actually reverted (FR-005, SC-006). No new limit constants introduced anywhere.
- [ ] T007 [P] [US1] Extend `client/src/components/__tests__/AiChatMessages.test.jsx` — render gate: (a) a `tool-undo` part (`state: 'output-available'`, `output: { success, undone: true, message, clock, diff }`) renders the DiffView inside `.ai-diff-wrap` beneath the card label; (b) same for a `tool-redo` part; (c) a `tool-undo` part with honest-empty output (`undone: false`, no `diff`) renders label-only — no `.ai-diff-wrap`, no `.ai-diff-format-only`; (d) an undo/redo card NEVER renders the "Formatting changes only" branch regardless of output contents (RBD-4); (e) existing modify-card assertions (diff render, `isFormatOnly`, UndoEditButton) pass unchanged (FR-010).

### Implementation for User Story 1

- [ ] T008 [US1] Implement diff attach in `server/undo/undo-service.js` (depends on T003): in both `performUndo` and `performRedo`, after `finalizeClaim` returns `claimed`, compute the diff inside try/catch, skipping when either markdown is `null`. Import the module namespace — `const diffUtils = require('../mcp/diff-utils');` — and call `diffUtils.computeChatDiff(inverse.preMarkdown, inverse.postMarkdown)` (NOT a destructured import: a destructured function reference cannot be spied for T005's failure injection); attach `diff` to the success result ONLY when computation succeeded and `diff.lines.length > 0` (spread-conditional so the key is absent otherwise — plan D2/D3); log-and-continue on failure (modify's pattern, `server/mcp/tools/modify.js:517-521`). No change to any honest-empty return, to `applyToLiveDoc`, or to result field meanings. T004–T006 now pass.
- [ ] T009 [US1] Implement the render-gate extension in `client/src/components/AiChatMessages.jsx` (plan D4/R6): add `const isUndoRedo = toolName === 'undo' || toolName === 'redo';` in `ToolCard` and widen the line-476 gate to `((isModify || isUndoRedo) && isComplete && part.output?.diff) || null`; leave `isFormatOnly` (line 477), the DiffView block (512-516), `UndoEditButton` (517-525), and all `reverted` handling untouched. T007 now passes.

**Checkpoint**: MVP complete — undo/redo cards show honest diffs; empties stay label-only; serial backend + client suites green.

---

## Phase 4: User Story 2 — The diff shows post-supersession reality (Priority: P2)

**Goal**: Prove the honesty pin — the diff is what the inverse actually did, never the original edit's mirror (FR-002).

**Independent Test**: quickstart.md Manual E2E #2 — partial supersession shows only the surviving revert.

### Tests for User Story 2 (mechanism ships in US1 — this phase pins it)

- [ ] T010 [US2] Extend `server/mcp/__tests__/integration/undo-redo-workflow.test.js` — partial-supersession honesty: agent edit A inserts two distinct paragraphs; a DIFFERENT identity's edit B replaces one of them; undo A → `undone: true` and the `diff` `-` lines contain the surviving paragraph's text while the superseded paragraph's original text and B's replacement text appear in NO diff line (SC-002; reuse the suite's existing supersession seeding helpers).
- [ ] T011 [P] [US2] Extend the suite's existing fully-superseded case in `server/mcp/__tests__/integration/undo-redo-workflow.test.js`: assert the `undone: false` "Nothing left to undo" result additionally has no `diff` own-property (spec US2 acceptance 2; FR-003), and the legacy-fallback undo path test (pre-016 derived range) asserts its success result DOES carry a `diff` by the same mechanism (spec edge case: no special case for legacy).

**Checkpoint**: Supersession honesty pinned end-to-end through the real handler.

---

## Phase 5: User Story 3 — Diffs persist and reach external agents (Priority: P3)

**Goal**: The diff rides the persisted tool part (FR-007) and the MCP/HTTP surfaces additively (FR-004, FR-009, SC-005).

**Independent Test**: quickstart.md Manual E2E #4–#6 — reload re-renders; external MCP client sees `diff`; button path unchanged.

### Tests for User Story 3

- [ ] T012 [US3] Extend `server/mcp/__tests__/integration/undo-redo-workflow.test.js` — additive contract on both surfaces: (a) `executeTool('undo', …)` / `executeTool('redo', …)` success results carry `diff` alongside `{ success, undone|redone, message, clock }` with unchanged 016 values; (b) the supertest `POST /api/docs/:docId/undo` flow (existing test around line 555-568) asserts `res.body.diff` is present on success in modify's shape and that the response is otherwise identical to 016's (FR-009 — carried, not rendered); (c) update any existing 016 assertions ONLY if they assert absence of extra result keys (per SC-005) — document each such edit in the test comment.
- [ ] T013 [P] [US3] Extend `server/__tests__/chat-store.test.js` — persistence round-trip: `saveChat` then `loadChat` of a message containing a `tool-undo` part whose `output.diff` is a representative payload (lines + hunkStarts + formatAnnotations + truncatedByServer) returns the part with `output.diff` deep-equal (verbatim persistence, FR-007).
- [ ] T014 [P] [US3] Extend `client/src/components/__tests__/AiChatMessages.test.jsx` — reload path: render messages in the exact persisted-and-reloaded shape (complete `tool-undo`/`tool-redo` parts with `output.diff`, no transient state) and assert the DiffView renders identically to the live-stream case (SC-004).

**Checkpoint**: All three stories independently verified; contract file C1–C10 each covered by at least one test.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T015 [P] FR-011/RBD-2 decision (post-019 baseline): measure `Buffer.byteLength(description, 'utf8')` for the merged, dieted `server/mcp/tools/undo.js` and `server/mcp/tools/redo.js` with one short RETURNS line added (e.g. "diff: what the revert changed — same shape as modify's diff"); add the line only where the total stays ≤ 2048 bytes, otherwise omit entirely; record the measured byte counts and the add/omit outcome as a comment beside the description and in the implementation notes.
- [ ] T016 [P] Documentation (Principle I): update `README.md` where it describes the chat's undo/redo cards or the undo/redo tool results (add the diff-carrying behavior); confirm `docs/dev.md` needs no change; do NOT touch `design/` exports (amendment already landed via sync).
- [ ] T017 Full verification per `specs/020-undo-redo-diffs/quickstart.md`: run all backend suites SERIALLY (`--runInBand`, one suite at a time per the shared-DB rule), the modify/diff guard suites (SC-007 — zero edits to modify path files: `server/mcp/tools/modify.js`, `server/mcp/diff-utils.js` must show no diff in `git status`), and the client suite; then the Manual E2E checklist #1–#6 in the dev pod.

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → Phase 3**: strictly serial gates (T001 blocks all; T002 before T003; T003 blocks T008).
- **US1 (Phase 3)**: T004–T007 in parallel (different files / independent test additions) after T003; T008 after T004–T006; T009 after T007. US1 alone is the MVP.
- **US2 (Phase 4)**: needs T008 (mechanism) — T010 then T011 ([P] with T010 only if edits touch different test blocks; same file, so prefer serial).
- **US3 (Phase 5)**: T012 needs T008; T013 is independent after T001; T014 needs T009. T013/T014 parallel with T012.
- **Polish**: T015 anytime post-019 (independent of code phases); T016 after US1; T017 last.
- **File-collision note**: T004/T005/T006 share `undo-service.test.js` and T010/T011/T012 share `undo-redo-workflow.test.js` — [P] there means independent content; a single implementer should just write them in order. Backend test RUNS are always serial regardless.

## Implementation Strategy

MVP = Phases 1–3 (T001–T009): ship the mechanism + render gate, validate quickstart E2E #1/#3. Then US2 (honesty pins), US3 (surfaces/persistence), Polish. Requirement→task map: FR-001/FR-005 → T004/T006/T008; FR-002 → T010; FR-003 → T004/T007/T011; FR-004 → T004/T012; FR-006 → T005; FR-007 → T013; FR-008 → T007/T009/T014; FR-009 → T012(b); FR-010 → T007(e)/T017 guard; FR-011 → T015. SC-001→T007/E2E#1, SC-002→T010, SC-003→T004(c)/T007(c), SC-004→T014, SC-005→T012, SC-006→T006, SC-007→T007(e)/T017.
