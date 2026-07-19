# Implementation Plan: Undo/Redo Results Carry Diffs

**Branch**: `020-undo-redo-diffs` | **Date**: 2026-07-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/020-undo-redo-diffs/spec.md`

**Design ground truth**: `design/in-app-ai-assistant.md` → Amendment (Sam, 2026-07-18) — undo/redo results carry diffs (feature 020), commit e3874c6. Clarifications ledger: [clarifications-needed.md](clarifications-needed.md) (RBD-1..RBD-4, all RATIFIED-BY-DEFAULT).

## Summary

Successful undo/redo results (`undone: true` / `redone: true`) from the one shared 016 core (`server/undo/undo-service.js`) gain an additive `diff` field in modify's exact payload shape, computed by the shared `computeChatDiff` from the markdown states immediately bracketing the inverse application inside `computeInverse`'s gc-off scratch rebuild (RBD-3 — race-free, honest post-supersession). The chat client extends its existing diff render gate so undo/redo tool cards render the persisted diff with the existing `DiffView` (presence-of-diff only, RBD-4). Honest-empty results carry no diff; diff computation is best-effort; modify's own path is untouched; the button path carries the field in its HTTP response but does not render it (RBD-1). No migrations, no new limits, no new client diff machinery.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server), React 18 client (Vite)

**Primary Dependencies**: yjs (`Y.UndoManager` scratch rebuild in `server/undo/inverse.js`), `diff` (via existing `server/mcp/diff-utils.js` `computeChatDiff`), existing `toMarkdown` (`server/mcp/yjs/serialization.js`), existing `DiffView` (`client/src/components/DiffView.jsx`)

**Storage**: N/A — no schema changes. The diff rides the existing chat tool-part output persistence (`server/chat-store.js`, stores tool outputs verbatim today)

**Testing**: Jest for backend (`server/undo/__tests__/`, `server/mcp/__tests__/integration/undo-redo-workflow.test.js`, `server/__tests__/chat-store.test.js`) — serial only, shared `collab_test_db`; Vitest for client (`client/src/components/__tests__/AiChatMessages.test.jsx`)

**Target Platform**: Existing Express server + browser SPA; MCP tool surface + chat HTTP endpoints

**Project Type**: Web application (existing `server/` + `client/` layout)

**Performance Goals**: Diff cost comparable to modify's (two `toMarkdown` serializations of the scratch fragment + one bounded `computeChatDiff`), inline on the undo/redo request path (spec Assumptions)

**Constraints**: Diff bounded by shared limits (`MAX_DIFF_CHARS` 50,000 / `MAX_DIFF_LINES` 200, `truncatedByServer`); best-effort — a diff failure never fails or rolls back the revert (FR-006/RBD-3); additive-only result contract (FR-004); zero change to modify's path (FR-010/SC-007)

**Scale/Scope**: SMALL — 2 server files touched (`server/undo/inverse.js`, `server/undo/undo-service.js`), 1 client gate extension (`client/src/components/AiChatMessages.jsx`), conditional one-line tool-description mention (FR-011, post-019), test extensions to existing 016 suites

**Sequencing**: Implementation starts only after feature 019 merges (019 diets `server/mcp/tools/undo.js`/`redo.js` prose; FR-011 wording is measured against the dieted baseline), on post-018 main. Do NOT touch `specs/016-*` through `specs/019-*`.

## Constitution Check

*GATE: evaluated against constitution v1.1.1 before Phase 0; re-checked after Phase 1.*

| Principle | Verdict | Notes |
|---|---|---|
| I. Documentation Reflects Reality | PASS (with task) | Behavior change is user-visible (undo/redo cards now show diffs; tool results gain a field). Polish task updates `README.md` if it describes undo/redo cards or result shape; `docs/dev.md` unaffected. |
| II. Test-Backed Changes | PASS | Tests-first tasks extend the existing 016 suites (undo-service, inverse, workflow integration, chat-store, AiChatMessages). Backend suites run serially (shared DB). No format/serialization change → no round-trip suite impact. |
| III. Trunk-Based Solo Workflow | PASS | Pipeline feature branch/worktree per `/the-pipeline`; no new ceremony. |
| IV. Collaboration-Safe Document Operations | PASS | Zero change to document mutation: the inverse application is untouched; this feature only *reads* the scratch doc's markdown before/after the pop. Attribution and CRDT identity paths unchanged. |
| V. Secure by Default | PASS | No new ingestion surface, endpoint, or auth path. Diff content derives from document content already stored past the write-boundary sanitizers, rendered by the existing `DiffView` path modify uses. |
| VI. Design Docs Are Ground Truth | PASS | Amendment e3874c6 is the pinned source; the four unpinned decisions are ledgered as RBD-1..4 (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-18). No new gaps found during planning. |

**Post-Phase-1 re-check**: PASS — the design adds no schema, no new dependency, no new endpoint; Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/020-undo-redo-diffs/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions R1..R6
├── data-model.md        # Phase 1 — payload/result/part shapes (no DB entities)
├── quickstart.md        # Phase 1 — validation guide
├── contracts/
│   └── undo-redo-result.md  # The additive result contract (both surfaces)
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
server/
├── undo/
│   ├── inverse.js                 # MODIFY: capture pre/post markdown bracketing the pop (RBD-3)
│   ├── undo-service.js            # MODIFY: compute + attach `diff` on success results (both ops)
│   └── __tests__/
│       ├── inverse.test.js        # EXTEND: markdown-pair capture, failure posture
│       └── undo-service.test.js   # EXTEND: parity shape, empty-family absence, best-effort, truncation
├── mcp/
│   ├── diff-utils.js              # UNCHANGED (shared computeChatDiff — reused)
│   ├── tools/
│   │   ├── undo.js                # CONDITIONAL: one RETURNS line iff ≤2KB post-019 (FR-011)
│   │   ├── redo.js                # CONDITIONAL: same
│   │   ├── modify.js              # UNTOUCHED (FR-010)
│   │   └── undo-redo-handler.js   # UNCHANGED (diff attaches in the service beneath it)
│   └── __tests__/integration/
│       └── undo-redo-workflow.test.js  # EXTEND: MCP + HTTP additive contract, supersession honesty
├── __tests__/
│   └── chat-store.test.js         # EXTEND: tool-part output.diff round-trip (FR-007)
└── index.js                       # UNCHANGED (button endpoints pass the service result through)

client/src/components/
├── AiChatMessages.jsx             # MODIFY: extend diff render gate to undo/redo (presence-only)
├── DiffView.jsx                   # UNCHANGED
└── __tests__/
    └── AiChatMessages.test.jsx    # EXTEND: undo/redo card gate, label-only empties, reload render
```

**Structure Decision**: Existing web-app layout (`server/` + `client/`); no new files except the feature's own docs. The single attach point is `undo-service.js` — beneath both surfaces (MCP tools via `undo-redo-handler.js`, chat endpoints via `executeTool`), so FR-004/FR-009 hold by construction.

## Architecture Decisions (summary — details in research.md)

- **D1 (RBD-3)**: Pre/post states are captured inside `computeInverse` — `toMarkdown(fragment)` immediately before `undoManager.undo()` (after the live-doc merge) and immediately after a successful pop. This is the only race-free bracket of exactly the popped inverse.
- **D2**: `computeInverse` returns `{ inverseUpdate, preMarkdown, postMarkdown }` (markdown pair best-effort, `null` on serialization failure); `undo-service.js` computes `computeChatDiff(preMarkdown, postMarkdown)` in a `try/catch` after the claim succeeds and attaches `diff` only to success results. Keeps chat-diff knowledge out of the CRDT module, and one attach point serves both surfaces.
- **D3**: Server-side guarantee of "no empty diff": `diff` is attached only when computation succeeded AND `lines.length > 0`. The client gate stays presence-only (RBD-4).
- **D4**: Client change is exactly one gate extension in `ToolCard` (`AiChatMessages.jsx:476`): `(isModify || isUndoRedo) && isComplete && part.output?.diff`. `isFormatOnly` (line 477) and `UndoEditButton` (lines 517-525) remain modify-only; no `reverted` dimming semantics change.
- **D5 (RBD-1)**: Button path: zero client change — the HTTP response carries `diff` by construction and the client ignores it.
- **D6 (RBD-2/FR-011)**: Tool-description mention is a measured decision at implementation time: `Buffer.byteLength(description, 'utf8') ≤ 2048` with the added RETURNS line, against 019's merged dieted text; omit otherwise.

## Complexity Tracking

> No constitution violations — table intentionally empty.
