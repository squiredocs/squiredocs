# Contract: Undo/Redo Result Additions & Verified "Reverted" Stamp (FR-014, FR-015)

## Result shape (additive — `server/undo/undo-service.js`)

Success cases only:

```jsonc
// performUndo, undone: true
{ "success": true, "undone": true, "message": "...", "clock": 123,
  "diff": { /* optional, unchanged */ },
  "undoneRecordRange": { "clockStart": 100, "clockEnd": 104 } }  // NEW: claimed row's edit_clock_start/end

// performRedo, redone: true
{ "success": true, "redone": true, "message": "...", "clock": 125,
  "redoneRecordRange": { "clockStart": 100, "clockEnd": 104 } }  // NEW: same row's ORIGINAL edit range
```

- Both fields come from the claimed `agent_edits` row's `edit_clock_start` /
  `edit_clock_end` — the ORIGINAL edit's range in both directions, because that
  is what the chat card stores (`part.output.editRange`, feature 016).
- All honest-empty results (`undone`/`redone`: false) are unchanged — no range
  field.
- MCP `undo`/`redo` tools pass the field through untouched (additive; no
  consumer breaks).

## Stamp verification (`makeUndoRedoHandler`, server/index.js)

Given a successful undo/redo with `req.body.chatId` + `req.body.toolCallId`:

1. Load the chat; locate the part with that `toolCallId` (`type` starts
   `tool-`). Part absent → skip stamp, log.
2. Read `part.output?.editRange`. Absent or malformed (missing/non-numeric
   clockStart/clockEnd) → **mismatch**: skip stamp, log. (Pre-016 cards and
   editRangePending cards are mismatches by rule — absence of evidence is not a
   pass.)
3. Compare with `result.undoneRecordRange` (undo) / `result.redoneRecordRange`
   (redo): stamp (`reverted = true` for undo, cleared for redo) ONLY on exact
   equality of both bounds. Otherwise skip + one structured warn:
   `[undo|redo] reverted-stamp skipped for <chatId>/<toolCallId>: card range A-B vs record range C-D`.
4. The HTTP response body is IDENTICAL whether the stamp applied or was skipped
   (stamping stays best-effort and invisible to the undo result), and the
   undo/redo itself is never affected.
5. A direct API call with an arbitrary `toolCallId` can therefore never mark an
   unrelated card "Reverted" (SC-008).

## Explicit non-goals (design amendment 2026-08-02 / 040 D19)
- No restore-undo revival, no offer guards, no per-chat undo scoping, no change
  to LIFO target selection, no change to `agent_edits` writes. The verification
  is a read-and-compare at the stamp site only.

## Pending-recording guard (FR-014)
`hasPendingRecording`'s newest-row probe adds `AND via_sync IS NOT TRUE`:
sync-channel rows never produce the "still being recorded — retry shortly"
refusal. NULL `via_sync` rows (pre-038, all normal writes) still count.
`GET /undo-status` and both action endpoints inherit this transparently.
