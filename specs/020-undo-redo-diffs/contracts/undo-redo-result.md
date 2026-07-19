# Contract: Additive `diff` on Undo/Redo Results

Applies to every surface producing an undo/redo result — all fed by the one shared core
(`server/undo/undo-service.js`):

1. MCP tools `undo` / `redo` (tool result JSON, external agents included)
2. Chat HTTP endpoints `POST /api/docs/:docId/undo` and `POST /api/docs/:docId/redo`
   (response body — carried, not rendered, in v1 per RBD-1)
3. Persisted chat tool parts `tool-undo` / `tool-redo` (`part.output`, FR-007)

Baseline: the 016 contract (see `specs/016-*/contracts/`, notably `http-undo-api.md`)
remains byte-for-byte compatible — no field renamed, removed, re-typed, or re-meaninged
(FR-004).

## Shape

```jsonc
// Successful undo (redo: replace "undone" with "redone")
{
  "success": true,
  "undone": true,                    // 016 meaning unchanged
  "message": "Edit undone. …",       // 016 meaning unchanged
  "clock": 42,                        // 016 meaning unchanged (inverse's new log clock)
  "diff": {                           // NEW — optional, additive
    "lines": ["-Removed line", "+Restored line", " context", "~~~", "…"],
    "hunkStarts": [{ "index": 0, "oldStart": 3, "newStart": 3 }],
    "formatAnnotations": { "4": { /* format-only pair annotation */ } },  // optional
    "truncatedByServer": true                                             // optional
  }
}
```

```jsonc
// Honest-empty (all variants: nothing recorded, pending recording,
// fully superseded, concurrent loser) — NO diff key, ever
{
  "success": true,
  "undone": false,
  "message": "Nothing left to undo: …",
  "clock": 41
}
```

## Rules

| # | Rule | Source |
|---|---|---|
| C1 | `diff` present only on `undone: true` / `redone: true` results | FR-001, FR-003 |
| C2 | `diff` payload shape is exactly modify's (`computeChatDiff` output: `lines`, `hunkStarts`, `formatAnnotations?`, `truncatedByServer?`) — no new fields | FR-001 |
| C3 | `diff` derives from the pre/post markdown bracketing the applied inverse (post-supersession reality), never the original edit's stored diff | FR-002, RBD-3 |
| C4 | A success result MAY lack `diff` (best-effort computation failure); consumers MUST NOT treat absence as failure of the revert | FR-006 |
| C5 | When present, `diff.lines` is non-empty (server-side no-empty-diff guarantee) | FR-003, plan D3 |
| C6 | Bounds: shared limits 50,000 chars / 200 lines; overflow → `truncatedByServer: true`, `lines.length <= 200`; the revert itself is never blocked by size | FR-005 |
| C7 | `success`, `undone`/`redone`, `message`, `clock` keep exact 016 semantics and presence on every path | FR-004 |
| C8 | HTTP button responses carry `diff` identically; the v1 client ignores it (no render, nothing persisted for button actions) | FR-009, RBD-1 |
| C9 | Chat tool parts persist `output.diff` verbatim; a reloaded chat re-renders it identically | FR-007, SC-004 |
| C10 | Modify's own result contract is untouched | FR-010, SC-007 |

## Client render contract (FR-008, RBD-4)

Undo/redo tool cards render `part.output.diff` with the existing `DiffView`, gated solely on
presence of the field (`state === 'output-available'` and `output?.diff` truthy). No
`isFormatOnly`-style branch, no empty-diff placeholder, no new diff processing or styling.
