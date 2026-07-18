# Quickstart: Validating Log-Derived Undo/Redo (016)

Runnable scenarios proving the feature end-to-end. Prereqs: dev environment per
`docs/dev.md` (commands run in the Minikube app-dev pod), migrations applied
(`npm run migrate` — must include `1796000000000_create-agent-edits`), backend test DB
reachable. Backend tests are **serial-only** (shared DB) — never run two Jest
invocations concurrently.

## 1. Automated suites (authoritative)

```bash
# Backend (Jest, serial; LLM-friendly reporter summarizes passing suites)
npm run test:server

# Focused runs while iterating:
npx jest --runInBand server/undo/                       # inverse semantics matrix, records, legacy
npx jest --runInBand server/mcp/__tests__/integration/undo-redo-workflow.test.js
npx jest --runInBand server/mcp/__tests__/tools/modify-edit-range.test.js
npx jest --runInBand server/__tests__/undo-status-api.test.js

# Client (Vitest)
npm run test:client
```

Expected: all green. The integration suite covers SC-001..SC-011 mappings (see
tasks.md phase notes): cross-instance undo, restart survival, byte-for-byte later-edit
preservation, honest full-supersession result, ten-cycle undo/redo chain crossing a
simulated restart and instance switch, zero-session assertions, parity, log
immutability, and legacy degradation.

## 2. Manual smoke: undo outlives the session (US1/US5)

1. Start the dev stack; open a doc; ask the chat assistant to make an edit.
2. Wait past the old session lifetime (>5 min) **or** restart the server process.
3. The Undo button on the edit is still visible (undo-status now log-derived) — click
   it. The edit reverts; the diff shows "Reverted"; no agent avatar appears at any
   point (check the presence bar).
4. Click "Redo edit" — content returns byte-for-byte; marker clears.

## 3. Manual smoke: surgical semantics (US2)

1. Assistant edit → then hand-type text after (and inside) the edited region.
2. Undo the assistant edit: your typed text survives exactly; only the assistant's
   contribution reverts.
3. Delete the assistant's inserted content manually, then click Undo: expect the
   honest "nothing left to undo" message, no document change, no Reverted marker.

## 4. MCP parity (US4)

Over an MCP connection (token with `documents:write`):
`modify` → note `editRange` in the result → `undo` → `{ undone: true, clock }` (no
`cursor` field) → `redo` → `{ redone: true }`. Repeat `undo` twice after two edits to
verify LIFO stepping. A token for a different agent identity must not be able to undo
the first agent's edit. Verify `list_tools` still shows exactly 16 tools.

## 5. History invariants (SC-009)

After any undo/redo sequence: version history shows each inverse as a **new** edit
attributed to the acting identity; earlier versions/diffs render unchanged;
`SELECT count(*) FROM yjs_updates WHERE doc_guid = $1` strictly grew; no existing row
changed (compare a before/after dump of clocks + md5 of update_data).

Contracts: [contracts/http-undo-api.md](contracts/http-undo-api.md),
[contracts/mcp-undo-redo-tools.md](contracts/mcp-undo-redo-tools.md). Data model:
[data-model.md](data-model.md).
