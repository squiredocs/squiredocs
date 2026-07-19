# Quickstart — Validating 020 Undo/Redo Diffs

## Prerequisites

- Implementation base: post-018 main **with feature 019 merged** (sequencing pin).
- Backend tests: Jest against the shared `collab_test_db` — **serial only** (never run two
  backend suites concurrently). Run inside the app-dev pod (see `docs/dev.md`) or via the
  local stack (pg+pgvector+redis + env).
- Client tests: Vitest in `client/`.

## Automated validation

```bash
# 1. Inverse capture + service attach (DB-backed, serial)
npx jest server/undo/__tests__/inverse.test.js --runInBand
npx jest server/undo/__tests__/undo-service.test.js --runInBand

# 2. Both surfaces end-to-end (MCP tool results + HTTP endpoints, supersession honesty)
npx jest server/mcp/__tests__/integration/undo-redo-workflow.test.js --runInBand

# 3. Persistence round-trip (FR-007)
npx jest server/__tests__/chat-store.test.js --runInBand

# 4. Modify-path untouched guard (SC-007): the modify/diff suites pass with zero edits
npx jest server/__tests__/diff-service.test.js server/mcp --runInBand

# 5. Client render gate (FR-008/RBD-4) — from client/
cd client && npx vitest run src/components/__tests__/AiChatMessages.test.jsx
```

Expected: all green; the only edited test files are the five suites named in
[plan.md](plan.md) Project Structure.

## Manual E2E (browser, dev pod)

1. **US1 / SC-001**: In the doc chat, ask the assistant to make a visible edit (modify card
   shows a diff), then ask it to undo. The "Undoing in *Doc* ✓" card renders a DiffView
   directly beneath the label — same colors/hunks/annotations as the modify card above it,
   content inverted. Ask it to redo → redo card shows the re-application diff.
2. **US2 / SC-002**: Edit A inserts two paragraphs; edit B (you, in the editor) rewrites one
   of them; assistant undoes A. The undo diff shows only the surviving paragraph being
   removed — the rewritten one appears nowhere in the diff.
3. **SC-003**: With nothing left to undo, ask the assistant to undo → label + honest message
   only; no diff area.
4. **US3 / SC-004**: Reload the page, reopen the chat → the undo/redo cards re-render their
   diffs identically from the persisted transcript.
5. **RBD-1**: Click the Undo button on a modify card → behavior unchanged (toggle, dimmed
   original diff, no new diff rendered); the network response visibly contains `diff`.
6. **SC-005 (external MCP)**: From an external MCP client (e.g. Claude Code), call `undo` on
   a doc with a revertable edit → result JSON has `success/undone/message/clock` (016
   semantics) plus `diff` in modify's shape.

## Expected outcomes reference

Shapes and invariants: [contracts/undo-redo-result.md](contracts/undo-redo-result.md);
field tables: [data-model.md](data-model.md).
