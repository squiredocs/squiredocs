# 040-restore-undo-attribution — owed follow-on work

Work this feature deliberately does not deliver, filed so it is not lost. Written at plan time
(2026-08-01) from the F1 analysis; decided by Sam the same day (option (c)).

---

## OWED-1 — A user-facing way to undo a restore (document-level undo affordance)

**Status**: not delivered by 040. Deliberate, ratified deferral — **not** an oversight.

### What 040 does and does not deliver

040 makes a human web-UI restore a genuine, invertible tracked edit **at the endpoint contract**:
`POST /api/docs/:docId/restore` records it under the chat-assistant identity in both stores,
`GET /api/docs/:docId/undo-status` reports `canUndo: true`, `POST /api/docs/:docId/undo` inverts
it exactly, and `/redo` re-applies it (US1, FR-001–FR-002, SC-001).

040 does **not** deliver any control a user can click to do that. After 040 ships, a user who
restores a version and regrets it still has no button.

### The F1 finding this deferral rests on (verified against `main` @ `e448a579`)

1. **The only client caller of `/undo` is bound to a chat card.** `UndoEditButton`
   (`client/src/components/AiChatMessages.jsx:599`) is rendered only under
   `isModify && isComplete && part.output?.changed && docGuid` (`:541-547`), and its own
   `showButton` requires `isLatest`, i.e. `part === lastModifyPart` (`:544`, `:658`). A restore
   performed from the version-history panel creates **no chat tool part**, so with no recent
   assistant `modify` in the current chat there is no undo control anywhere in the product.
2. **`MobileActionBar` is not a second path.** Its Undo/Redo (`MobileActionBar.jsx:12`, `:95`)
   drive the editor's local `yUndoPlugin` (`@tiptap/y-tiptap`), not the server's log-derived
   undo. Unrelated mechanism.
3. **The endpoint ignores `toolCallId` for target selection.** `makeUndoRedoHandler`
   (`server/index.js`) calls `performUndo({docGuid, userId, agentName})` — identity-LIFO via
   `nextUndoTarget` — and uses `req.body.toolCallId` **only** to stamp the `reverted` flag on a
   chat part. This is what makes the mislabeling in (4) possible.
4. **Hence the honesty problem 040 must solve anyway.** Once restores enter the queue, pressing
   "Undo edit" on the assistant's card would invert the **restore** and mark the **modify**
   "Reverted". 040 closes that with the FR-016/FR-017/FR-018 offer guard (US6) — the button stops
   offering when it is not the next target. That keeps a lie off the screen; it does not add the
   missing affordance.

### What building OWED-1 needs

- **A document-level undo control**, most naturally in the version-history panel (next to the
  restore action that created the undoable edit) or in the document header — not another
  chat-bound control. Driven by `GET /api/docs/:docId/undo-status`, which is already log-derived,
  session-free, and survives restarts, and which after 040 also carries each direction's target
  `edit_clock_start` (FR-016) so the control can name what it will act on.
- **Its own design pass**: placement, disabled/empty states, and what the control says when the
  next target is an assistant edit rather than a restore (the honest generic case), plus how it
  coexists with the chat card's control so the two never both claim the same target.
- **A mobile/touch pass**, per feature 024's precedent for version-history surfaces (reachable,
  unclipped, touch-dismissible).
- **Copy decisions** that the revised D7 explicitly leaves open: whether the control names its
  target ("Undo restore" vs. a generic "Undo"). 040's D7 permits only the structural guard.
- Probably its own spec: it is a user-facing feature with design surface, not a bug fix.

### Why it was deferred rather than folded in

- It is a **new UI surface with a design and mobile pass**, which is a different kind of work
  from 040's server-side correctness fixes and would have roughly doubled the feature's blast
  radius, in a client file (`AiChatMessages.jsx`) whose only sanctioned 040 touch is the offer
  guard.
- The mechanism must exist first regardless — an affordance with no invertible record behind it
  is not buildable. 040 is the prerequisite, and it is independently valuable: the two stores
  become consistent, the dead-row class is closed, and the design amendment of 2026-07-19 stops
  being false.
- The immediate harm (a control that would misreport what it did) is fully closed by 040's US6
  guard. The residual gap is a **missing** capability, not a wrong one — the honest failure mode.

---

## OWED-2 — Manual validation owed to Sam (cannot be run in the pipeline worktree)

- **Browser walk**: restore a version from the version-history panel with an assistant `modify`
  card visible in the chat; confirm the card's Undo control disappears (US6 scenario 1) and that
  version history attributes the restore to "Squire Docs Assistant (<name>)" (FR-003/SC-004).
  Then confirm the control returns once the modify is the next target again (US6 scenario 2).
- **MCP walk**: `restore_document_version` then `undo` on the same agent token — the restore
  inverts and is attributed to the agent, not to the assistant (US2/SC-003).
- **Deploy** stays with the maintainer, as always.
