# Feature Specification: Undo/Redo Results Carry Diffs

**Feature Branch**: `020-undo-redo-diffs`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Undo/redo results (MCP tools + the chat Undo/Redo button, one shared handler since 016) carry the same diff payload modify emits, computed server-side from the pre/post states of the inverse application, persisted on the tool part, and rendered with the existing DiffView on undo/redo tool cards."

**Design ground truth**: `design/in-app-ai-assistant.md` → **Amendment (Sam, 2026-07-18) — undo/redo results carry diffs (feature 020)** (commit e3874c6, RATIFIED). The amendment pins: same diff payload shape as modify; computed from the pre/post states of the INVERSE application (honest post-supersession reality, deliberately NOT the mirror of the original edit's diff); persisted on the tool part; rendered with the same DiffView on undo/redo tool cards that modify cards use. Motivating incident: during 016 live testing the "Undoing in README ✓" card was a bare label beside modify's rich diff.

## Overview

Since feature 016, undo and redo converge on one shared handler (`server/mcp/tools/undo-redo-handler.js` → `server/undo/undo-service.js`): the target edit's clock range is inverted against the durable update log and the surgical inverse is applied to the live document. The result today is `{ success, undone|redone, message, clock }` — honest, but blind: neither the chat transcript nor an external MCP agent can see *what* the undo actually changed, even though modify's results have carried a rich, rendered diff since the chat's first release.

This feature closes that asymmetry with one mechanism: after a successful inverse application, the server computes the same structured line diff modify emits (`server/mcp/diff-utils.js` `computeChatDiff` → `{ lines, hunkStarts, formatAnnotations?, truncatedByServer? }`) from the document's actual pre-inverse and post-inverse states, attaches it as an additive `diff` field on the result, and the chat client renders it on undo/redo tool cards with the existing `DiffView` component — the same gate-plus-render pattern modify cards use today (`client/src/components/AiChatMessages.jsx`).

The honesty pin matters: 016's supersession rules mean an undo may revert *less* than the original edit inserted (later edits win). The diff therefore must come from what the inverse actually did, never from replaying or mirroring the original modify's stored diff. Empty results stay empty: when there is honestly nothing (left) to undo, the result carries no diff at all — no empty-diff card.

No schema or migration work; no new client diff machinery beyond the render gate; modify's own path is untouched.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Chat user sees what an assistant undo reverted (Priority: P1)

Sam asks the assistant to undo its last edit to a document. The assistant calls the `undo` tool; the tool card in the transcript ("Undoing in *Doc* ✓") now shows, directly beneath the label, the same color-coded line diff a modify card shows — removed lines that the undo took back out, restored lines it brought back — instead of a bare label.

**Why this priority**: This is the motivating incident from the amendment, verbatim. The transcript is the primary surface where the blindness was felt.

**Independent Test**: In the chat, have the assistant make an edit, then undo it via the tool. The undo card renders a DiffView whose content is the inverse of the edit; the modify card above is unchanged.

**Acceptance Scenarios**:

1. **Given** the assistant just made an edit via modify, **When** it calls the `undo` tool and the undo succeeds (`undone: true`), **Then** the undo tool card renders the inverse diff with the same DiffView presentation (colors, hunk separators, format annotations) as modify cards.
2. **Given** an undo has been rendered, **When** the assistant calls `redo` and it succeeds (`redone: true`), **Then** the redo tool card renders the re-application diff the same way.
3. **Given** there is nothing to undo, **When** the assistant calls `undo` (`undone: false`), **Then** the card shows only the label and honest message — no diff area, no empty diff table.

---

### User Story 2 - The diff shows post-supersession reality (Priority: P2)

An agent's edit was partially superseded by a later edit (someone rewrote one of the paragraphs the agent had inserted). Undoing the agent's edit reverts only what survived. The diff on the undo result shows exactly that partial revert — not the full mirror of the original edit.

**Why this priority**: The amendment's central design pin. A mirrored diff would be actively misleading precisely in the cases where undo semantics are subtle.

**Independent Test**: Make edit A (insert two paragraphs), make edit B replacing one of them, undo A: the diff shows only the surviving paragraph being removed.

**Acceptance Scenarios**:

1. **Given** an edit partially superseded by later edits, **When** it is undone, **Then** the diff contains only the changes the inverse actually applied (superseded portions absent).
2. **Given** an edit fully superseded by later edits, **When** undo is attempted, **Then** the result is the existing honest empty (`undone: false`, "Nothing left to undo…") and carries no diff.

---

### User Story 3 - Diffs persist and reach external agents (Priority: P3)

Reloading a chat re-renders undo/redo diffs from the stored transcript, exactly as modify diffs already do. An external MCP agent (e.g. Claude Code) calling `undo`/`redo` receives the `diff` field in the tool result and can verify what the operation actually did without a re-read — the same "verify your edit with it" affordance modify's result documents.

**Why this priority**: Persistence and the MCP surface come along for free from the mechanism (the diff rides the tool result, which is already persisted on the chat tool part); they must be verified but need no separate machinery.

**Independent Test**: After scenario US1, reload the page: the undo card still shows its diff. Separately, call the `undo` MCP tool from an external client and inspect the returned JSON for the `diff` field alongside the untouched 016 fields.

**Acceptance Scenarios**:

1. **Given** a chat containing a rendered undo diff, **When** the page is reloaded and the chat re-fetched, **Then** the undo card renders the identical diff from the persisted tool part.
2. **Given** an external MCP client, **When** it calls `undo` and an edit is reverted, **Then** the result contains `success`, `undone`, `message`, `clock` with their 016 meanings unchanged, plus `diff` in modify's exact payload shape.

### Edge Cases

- **Honest-empty family** — nothing recorded, fully superseded, concurrent loser ("already undone by a concurrent request"), and the pending-recording refusal ("still being recorded — retry shortly") all return `undone|redone: false` today: none of them may carry a `diff` field, and their cards stay label-only.
- **Very large revert**: the diff is truncated by the same shared limits modify uses (50,000 chars / 200 lines → `truncatedByServer: true`); the undo itself is never blocked by diff size.
- **Diff computation failure**: best-effort parity with modify — if diff computation throws, the undo/redo result is returned without `diff` and the operation stands (RBD-3). A revert must never fail or roll back because its diff could not be rendered.
- **Formatting-only revert**: flows through the same shared post-processing (span stripping, format annotations), so the card shows the annotated pair exactly as a modify card would. No separate "Formatting changes only" branch is added for undo/redo cards — the render gate is presence of `diff`, nothing else (RBD-4).
- **Legacy (pre-016) fallback undo**: the legacy-derived range flows through the same inverse application, so its result carries a diff by the same mechanism — no special case.
- **Chat Undo/Redo button**: the shared handler means the HTTP response (`POST /api/docs/:docId/undo|redo`) carries the `diff` field additively, but v1 renders diffs on tool cards only — the button path keeps its current behavior (toggle + reverted dimming of the original modify diff) and ignores the field (RBD-1). No tool part exists for a button action, so there is nothing to persist on that path.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every successful undo (`undone: true`) and redo (`redone: true`) result produced by the shared handler MUST include a `diff` field whose payload shape is exactly the one modify emits: `{ lines, hunkStarts, formatAnnotations?, truncatedByServer? }`, produced by the same shared diff computation and post-processing (`computeChatDiff` semantics: hunk separators, span stripping, format-only annotation detection).
- **FR-002**: The diff MUST be computed server-side from the document's actual pre-inverse and post-inverse markdown states — the states surrounding the inverse application the service performed. It MUST NOT be derived from, or be the mirror of, the original edit's stored diff. After supersession, the diff shows only what the inverse actually changed.
- **FR-003**: Unsuccessful/empty results (`undone: false` / `redone: false` in all their existing variants — nothing recorded, fully superseded, concurrent loser, pending recording) MUST NOT carry a `diff` field. The client MUST NOT render an empty diff area for them.
- **FR-004**: The `diff` field is strictly additive to the 016 result contract: `success`, `undone`/`redone`, `message`, and `clock` keep their exact existing meanings and presence on every path (tool results and the chat HTTP endpoints alike). No field is renamed, removed, or re-typed.
- **FR-005**: Diff size is bounded by the same shared limits as modify (50,000 characters / 200 lines, `truncatedByServer: true` on overflow). No new limit values are introduced.
- **FR-006**: Diff computation MUST be best-effort: a computation failure logs and yields a result without `diff`; it never fails or rolls back the undo/redo itself (RBD-3).
- **FR-007**: For undo/redo executed as chat tool calls, the diff persists with the tool part's output in the stored chat (the existing message-persistence path — no separate storage), so a reloaded chat re-renders it identically.
- **FR-008**: The chat client MUST render `diff` on undo/redo tool cards using the existing `DiffView` component, gated on output presence — the same pattern as modify cards. No new client-side diff rendering, processing, or styling code path is introduced beyond extending the render gate to the undo/redo tools (RBD-4).
- **FR-009**: The chat Undo/Redo button path receives the `diff` field in its HTTP response by construction (shared handler) but does not render it in v1; the button's existing behavior (undo/redo toggle, reverted dimming of the original modify card's diff, status re-poll) is unchanged (RBD-1).
- **FR-010**: Modify's own diff path is untouched: zero behavior change to how modify computes, attaches, persists, or renders its diff.
- **FR-011**: The `undo`/`redo` tool descriptions MAY gain one short RETURNS mention of the new `diff` field only if the descriptions' byte budget (the 2KB MCP-client truncation boundary) allows after feature 019's description diet lands; wording is decided against 019's dieted baseline at implementation time (RBD-2).

### Key Entities

- **Diff payload**: the existing structured chat diff — prefixed lines (`-`/`+`/space, `~~~` hunk separators), hunk start indices, optional format-only annotations, optional server-truncation flag. Reused as-is; this feature adds no fields to it.
- **Tool part output**: the persisted per-tool-call result in a stored chat message. Undo/redo outputs gain the optional `diff` member; everything else on the part is unchanged.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a real revert, the undo (and redo) tool card in the chat transcript renders a DiffView visually identical in presentation to modify's — verified side by side in one transcript containing a modify card and its undo card.
- **SC-002**: Supersession honesty: undo an edit partially superseded by a later edit — the rendered diff contains only the changes that actually reverted, and the superseded content does not appear.
- **SC-003**: A no-op undo/redo (nothing to undo, fully superseded, concurrent loser, pending recording) produces a card with no diff area — indistinguishable from today's label-only card.
- **SC-004**: After a full page reload, a previously rendered undo/redo diff re-renders identically from the persisted chat.
- **SC-005**: An external MCP client receives `diff` in successful undo/redo results with the exact modify payload shape, while `success`, `undone`/`redone`, `message`, and `clock` remain contract-compatible with 016 (existing 016 result-shape tests keep passing, save any that assert the absence of extra fields).
- **SC-006**: A revert larger than the shared truncation limits returns `truncatedByServer: true` with at most 200 diff lines, and the revert itself completes.
- **SC-007**: Zero change to modify's own path: modify's diff behavior, result shape, and rendering are identical before and after this feature.

## Dependencies & Sequencing

- **After 019 merges**: feature 019's description diet touches `server/mcp/tools/undo.js` / `redo.js` prose. To avoid collision, 020 implementation starts only after 019 is merged, and FR-011's wording decision is made against 019's dieted descriptions.
- **On post-018 main**: implementation bases on current main after feature 018's merge.
- **No migrations**: no database schema changes; the diff rides existing result and persistence paths.
- **Feature 016** (log-derived undo) is the substrate: the shared handler, the inverse application, and the honest-empty result family are reused unchanged.

## Assumptions

- The inverse application already has (or can cheaply reconstruct from the same log it already loads) the document's pre- and post-inverse states server-side; no new data source is needed. The gc-off scratch rebuild the inverse computation performs is the natural place these states exist.
- The legacy pre-016 fallback undo flows through the same inverse application and therefore carries a diff with no special-casing.
- Chat tool-part persistence already stores tool outputs verbatim (modify's `diff` survives reload today), so FR-007 requires no new persistence mechanism — only that the field be present on the output.
- Diff computation cost is comparable to modify's (same shared algorithm, same bounded output) and acceptable inline on the undo/redo request path.
