# Clarifications Ledger — 020-undo-redo-diffs

Decisions the design amendment (`design/in-app-ai-assistant.md` — **Amendment (Sam,
2026-07-18) — undo/redo results carry diffs (feature 020)**, commit e3874c6) did not answer
were taken with the best default and recorded here as
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)**.

Decisions the amendment already made are Sam-ratified 2026-07-18 and are cited in the spec,
not re-decided: same diff payload shape as modify; computed from the pre/post states of the
INVERSE application (honest post-supersession reality — never the mirror of the original
edit's diff); persisted on the tool part; rendered with the same DiffView on undo/redo tool
cards; both surfaces (MCP tools and the chat Undo/Redo button path) flow through the one
shared handler from 016.

---

## RBD-1: Chat Undo/Redo button path is response-carries, tool-cards-render for v1

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment says the button path (same shared handler) "returns the same
  diff payload", but the button sits on the ORIGINAL modify card (`UndoEditButton` in
  `client/src/components/AiChatMessages.jsx`) — should the button path also *render* the
  inverse diff somewhere (e.g. a new row under the reverted card), or is rendering
  tool-cards-only in v1?
- **Decision**: Tool-cards-only rendering for v1. The HTTP response
  (`POST /api/docs/:docId/undo|redo`) carries the additive `diff` field by construction
  (shared handler — spec FR-009), but the client button keeps its exact current behavior:
  toggle, `reverted` dimming of the original modify diff, status re-poll. Nothing is
  persisted for the button path — a button click has no tool part to persist on (only the
  existing `reverted` flag persists, unchanged).
- **Why this default**: The motivating incident was the bare MCP *tool card*; the button
  lives on a modify card whose original diff is already visible, and the reverted dimming
  already communicates the state. Rendering a second (inverse) diff there would mostly
  duplicate the one above it, and would require a new client rendering location — in
  tension with the amendment-adjacent pin that no new client diff code path is added beyond
  the render gate. Because the payload is already in the response, a later feature can
  surface it with zero server change.

## RBD-2: Tool-description mention is conditional and deferred to 019's dieted baseline

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: Should the `undo`/`redo` tool descriptions document the new `diff` return
  field, given MCP clients truncate descriptions at 2KB and feature 019 is concurrently
  dieting exactly these files' prose?
- **Decision**: At most one short RETURNS line (e.g. "diff: what the revert changed — same
  shape as modify's diff"), added only if the post-019 description fits the 2KB budget with
  it; otherwise omitted entirely. Exact wording is decided at implementation time against
  019's merged, dieted text — never against today's pre-019 descriptions (spec FR-011).
  The result is self-describing regardless (the field is present with an obvious shape), so
  omission costs little.
- **Why this default**: Avoids a prose collision with 019 (sequencing pin: 020 implements
  after 019 merges) and respects the byte budget as the binding constraint, mirroring how
  019 treats description bytes as a first-class contract.

## RBD-3: Diff computation is best-effort and rides the inverse computation's own states

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: The amendment pins *what* the diff is computed from (pre/post states of the
  inverse application) but not the failure posture, nor which concrete server-side states
  qualify.
- **Decision**: (a) Best-effort, exactly like modify: a diff computation failure is logged
  and the result is returned without `diff`; the revert itself never fails, blocks, or rolls
  back for diff reasons (spec FR-006). (b) The qualifying states are the document's markdown
  immediately before and immediately after the inverse application the service actually
  performed — in practice the gc-off scratch rebuild inside the inverse computation
  (`server/undo/inverse.js`) already holds both states, making it the natural (and
  race-free) source: the pair brackets exactly the popped inverse, not any concurrent
  in-flight edits on the live doc. Any implementation choice must preserve that bracketing
  property.
- **Why this default**: Modify set the precedent (`try/catch` around `computeChatDiff`,
  `diff: null` on failure — `server/mcp/tools/modify.js`); the revert is the durable,
  user-visible action and the diff is presentation. Bracketing the actual inverse keeps the
  amendment's honesty pin airtight under concurrency.

## RBD-4: The undo/redo card's render gate is presence-of-diff only — no format-only branch

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)
- **Question**: Modify cards have a second gate, `isFormatOnly` ("Formatting changes only"),
  keyed off modify's `changed` flag. Undo/redo results have no `changed` flag — should the
  cards replicate that branch?
- **Decision**: No. The undo/redo cards gate purely on `part.output?.diff` being present
  (spec FR-008). A formatting-only revert still produces a diff (the shared post-processing
  emits annotated -/+ pairs), so it renders informatively through the same gate; the empty
  cases carry no diff at all and stay label-only (spec FR-003).
- **Why this default**: Replicating `isFormatOnly` would require adding a `changed`-like
  field to the undo result (contract growth) or inferring it client-side (a new client code
  path) — both contrary to the additive-only and no-new-client-diff-machinery pins — and
  buys nothing: every case is already covered honestly by presence/absence of `diff`.
