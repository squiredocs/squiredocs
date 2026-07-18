# Contract: Chat undo/redo HTTP endpoints (016)

All three endpoints exist today (`server/index.js:1287-1369`); this contract pins what
changes and what must not. Auth: session cookie (`requireAuth`). Role: editor required
for undo/redo; viewer/none → the responses below. **No endpoint may create, extend, or
consult an agent presence session** (FR-008, FR-019, FR-025; SC-006).

## POST /api/docs/:docId/undo

Request body (both optional, unchanged): `{ chatId, toolCallId }` — used only for
best-effort persistence of the `reverted` flag on the identified chat tool part.

Behavior: targets the chat-assistant identity's (user + `CHAT_AGENT_NAME`) most recent
still-undoable edit resolved from `agent_edits` (legacy fallback per research R7);
derives and applies the log-derived inverse (research R1/R3/R6).

Responses:
- `200` success, applied: `{ success: true, undone: true, message, clock }` — `clock`
  = the inverse's new log clock (RBD-5). Server also sets `reverted: true` on the tool
  part when `chatId`+`toolCallId` were provided (best-effort, unchanged).
- `200` honest empty (nothing recorded / fully superseded / already undone by a
  concurrent request / legacy unidentifiable): `{ success: true, undone: false,
  message, clock }` — explicit message; **no log append, no reverted flag** (FR-011,
  FR-021, FR-028).
- `403` `{ error }` — viewer or no access (unchanged).
- `500` `{ error }` — unchanged.

## POST /api/docs/:docId/redo

Symmetric: targets the identity's most-recently-undone edit (`last_undone_at` DESC),
inverts its recorded inverse range. `{ success: true, redone: true|false, message,
clock }`; on success clears `reverted` on the tool part (best-effort, unchanged).
Redo of a pre-016 undo (no recorded inverse) is the honest `redone: false` (RBD-2).

## GET /api/docs/:docId/undo-status

Response (shape unchanged): `{ canUndo: boolean, canRedo: boolean }`.

- Derived from `agent_edits` (+ legacy log derivation fallback) for the chat-assistant
  identity — **cheap availability** (RBD-6): `canUndo` = latest edit exists, has a
  usable identifier, `state='active'`; `canRedo` = an `'undone'` record exists.
  `canUndo: true` does not guarantee a non-empty inverse; full supersession surfaces
  at action time as the honest `undone: false`.
- No session dependency: availability survives session expiry and restarts for as long
  as the edit is genuinely undoable (FR-019, SC-007).
- Viewer role, no access, or any error: `{ canUndo: false, canRedo: false }`
  (unchanged).
- Must stay cheap enough for the existing 30 s per-open-chat poll (SC-007).

## Client contract (`UndoEditButton`, `client/src/components/AiChatMessages.jsx`)

- Keeps: poll `undo-status` every 30 s while latest, POST undo/redo with
  `{ chatId, toolCallId }`, flip local `reverted` on `undone`/`redone` true, re-fetch
  status after every action.
- Changes: the button's visibility is now governed by the log-derived status (no
  session-lifetime disappearance — US5); an `undone/redone: false` response surfaces
  its `message` to the user (honest nothing-left) instead of silently doing nothing;
  stale comments describing the in-memory UndoManager lifetime are rewritten.
