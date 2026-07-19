# Research — 020 Undo/Redo Results Carry Diffs

No NEEDS CLARIFICATION markers existed in the Technical Context; the four product-level
unknowns were already decided in `clarifications-needed.md` (RBD-1..4). Research below
verifies the mechanism against the working tree (2026-07-18) and fixes the implementation
decisions the spec leaves open.

## R1 — Source of the pre/post states

- **Decision**: Capture markdown inside `computeInverse` (`server/undo/inverse.js`):
  `preMarkdown = toMarkdown(fragment)` immediately before `undoManager.undo()` — i.e. after
  the full-log rebuild AND the live-doc merge (`inverse.js:113-116`) — and
  `postMarkdown = toMarkdown(fragment)` immediately after a successful pop.
- **Rationale**: RBD-3 pins the qualifying states as "the document's markdown immediately
  before and immediately after the inverse application" and names the gc-off scratch rebuild
  as the race-free source. The scratch doc's pop IS the inverse the service later applies;
  bracketing it there can never include concurrent in-flight edits, and the live-doc merge
  happening before the bracket means supersession is already reflected in `preMarkdown`.
- **Alternatives rejected**:
  - *Serialize the live shared doc before/after `applyToLiveDoc`*: racy (concurrent editor
    keystrokes between the two reads would pollute the diff) and unavailable when the doc
    isn't loaded on this instance.
  - *Mirror/replay the original edit's stored diff*: explicitly forbidden (FR-002, the
    amendment's honesty pin).

## R2 — Layering: who computes the chat diff

- **Decision**: `computeInverse` returns the raw markdown pair
  (`{ inverseUpdate, preMarkdown, postMarkdown }`); `undo-service.js` calls
  `computeChatDiff(preMarkdown, postMarkdown)` (from `server/mcp/diff-utils.js`) inside
  `try/catch` and attaches `diff` to the success result in both `performUndo` and
  `performRedo`, after `finalizeClaim` succeeds.
- **Rationale**: `inverse.js` is a pure CRDT module — importing chat-diff post-processing
  there would tangle layers (it already must import `toMarkdown`; precedent:
  `server/diff-service.js` imports the same serializer). `undo-service.js` is the ONE core
  both surfaces converge on (016), so attaching there makes FR-004/FR-009 true by
  construction with zero handler/endpoint changes. Computing after the claim avoids wasted
  diff work on the concurrent-loser path (which returns `undone:false`, no diff — FR-003).
- **Alternatives rejected**:
  - *Compute inside `inverse.js`*: drags `diff-utils` into the CRDT module.
  - *Compute in `undo-redo-handler.js` or the HTTP handler*: two attach points (or a missed
    surface); the handler doesn't have the scratch states.

## R3 — Failure posture and the no-empty-diff guarantee

- **Decision**: Two independent best-effort layers: (a) in `inverse.js`, each `toMarkdown`
  call is guarded — on throw, the markdown pair is `null` and the inverse is still returned;
  (b) in `undo-service.js`, `computeChatDiff` is wrapped in `try/catch` (modify's exact
  pattern, `modify.js:517-521`) and skipped when the pair is `null`. `diff` is attached only
  when computation succeeded AND `diff.lines.length > 0`.
- **Rationale**: FR-006/RBD-3 — the revert must stand sans diff on any diff failure. The
  `lines.length > 0` guard makes FR-003's "no empty diff area" a server-side invariant, so
  the client gate can stay presence-only (RBD-4) with no defensive client logic. (A popped
  inverse always changes the doc, so an empty diff is not expected — the guard is defensive.)
- **Alternatives rejected**: failing the undo on diff error (violates FR-006); client-side
  empty-diff filtering (new client logic, against RBD-4).

## R4 — Cost

- **Decision**: Accept two extra `toMarkdown` serializations of the scratch fragment + one
  bounded `computeChatDiff` per successful inverse, inline on the request path.
- **Rationale**: Same order as modify's own diff work (`modify.js:417,499,518`); the scratch
  doc is already fully built for the inverse; output is bounded by the shared 50,000-char /
  200-line limits (`diff-utils.js:11-12`). Matches the spec's Assumptions.
- **Alternatives rejected**: async/deferred diff (would miss the tool result — the whole
  point), caching (nothing to cache; each inverse is unique).

## R5 — FR-011 measurement method (RBD-2)

- **Decision**: At implementation time, after 019 is merged: take the dieted `description`
  strings in `server/mcp/tools/undo.js` / `redo.js`, append one short RETURNS line (e.g.
  "diff: what the revert changed — same shape as modify's diff"), and add it only if
  `Buffer.byteLength(description, 'utf8') <= 2048` for that file; otherwise omit entirely.
  Record the outcome (added/omitted, byte counts) in the implementation notes.
- **Rationale**: The 2KB MCP-client truncation boundary is the binding constraint; wording
  must be decided against 019's dieted baseline, never today's text (spec FR-011, sequencing
  pin).

## R6 — Client render gate

- **Decision**: In `ToolCard` (`client/src/components/AiChatMessages.jsx`), add
  `const isUndoRedo = toolName === 'undo' || toolName === 'redo';` and widen line 476 to
  `const diff = ((isModify || isUndoRedo) && isComplete && part.output?.diff) || null;`.
  Nothing else changes: `isFormatOnly` (line 477) stays keyed on `isModify`, the
  `UndoEditButton` block (lines 517-525) stays modify-only, and the existing
  `ai-diff-wrap` / `DiffView` render (lines 512-516) is reused as-is.
- **Rationale**: RBD-4/FR-008 — presence-of-diff is the whole gate; undo/redo results have
  no `changed` flag and must not grow one. Undo/redo are already in `DOC_TOOLS` (derived
  from `TOOL_LABELS` minus `NON_DOC_TOOLS`, line 41-44), so card labeling ("Undoing in …")
  is untouched. `part.reverted` is never set on undo/redo parts, so the `--undone` dimming
  class cannot mis-trigger.

## Verified current-state facts (working tree, 2026-07-18)

- `computeChatDiff(mdBefore, mdAfter)` → `{ lines, hunkStarts, formatAnnotations?, truncatedByServer? }`;
  limits `MAX_DIFF_CHARS = 50000`, `MAX_DIFF_LINES = 200` (`server/mcp/diff-utils.js`).
- 016 result contract on all paths: `{ success, undone|redone, message, clock }`
  (`server/undo/undo-service.js`); honest-empty family: nothing recorded, pending recording,
  fully superseded, concurrent loser.
- `computeInverse(rows, range, identity, liveDoc)` → `{ inverseUpdate } | null`; scratch doc
  `gc: false`; live merge precedes the pop (`server/undo/inverse.js:113-127`).
- Shared handler: `server/mcp/tools/undo-redo-handler.js` → `undoService.performUndo|performRedo`;
  chat endpoints `POST /api/docs/:docId/undo|redo` call `toolRegistry.executeTool` and
  `res.json(result)` pass-through (`server/index.js:1317-1350`) — the HTTP response carries
  `diff` with zero endpoint changes.
- Client gate today: `AiChatMessages.jsx:476` (`isModify && … output?.diff`), DiffView render
  at 512-516, `isFormatOnly` at 477/526-528.
- Chat tool-part outputs persist verbatim via `server/chat-store.js` `saveChat`/`loadChat`
  (modify's diff survives reload today) — FR-007 needs only the field to exist.
- 016 test suites to extend: `server/undo/__tests__/inverse.test.js`,
  `server/undo/__tests__/undo-service.test.js` (DB-backed, serial),
  `server/mcp/__tests__/integration/undo-redo-workflow.test.js` (also exercises the HTTP
  endpoints via supertest), `server/__tests__/chat-store.test.js`,
  `client/src/components/__tests__/AiChatMessages.test.jsx`.
