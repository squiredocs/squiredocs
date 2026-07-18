# Contract: MCP tool surface changes (016)

The MCP tool surface stays at **sixteen tools** (FR-022); no tool is added or removed.
Names, input schemas, and required scopes are unchanged. Descriptions must be
rewritten to match the new behavior truthfully (FR-023 — drift is a bug).

## `modify` — additive result fields only

Unchanged: `changed`, `diff`, `clock` (STILL the pre-edit baseline — RBD-1),
`operationCount`, `summary`, conflict shape, all sanitizer report fields.

New (only when `changed: true`):
- `editRange: { clockStart: number, clockEnd: number }` — the durable edit identifier:
  first and last `yjs_updates` clock of exactly this call's rows (identity-qualified
  within the range; recorded only after all rows are durably persisted — FR-001/002/004).
- `editRangePending: true` — replaces `editRange` when durability confirmation timed
  out within the bounded wait (RBD-8); the server finishes recording in the background.

Description addition: the range is the handle undo uses; no doc-facing behavior change.

## `undo` — same schema, log-derived behavior

Input (unchanged): `{ docGuid: string (uuid, required) }`. Scope: `documents:write`
(unchanged, enforced in `server/mcp/tools/index.js`). Editor role on the document
required — now verified via direct role lookup, **never** by creating a presence
session (FR-008/FR-025).

Behavior: steps back through the **calling identity's own** edits (token user + agent
name) in reverse chronological order, skipping already-undone edits — full multi-step
LIFO parity with the documented stack behavior (FR-017, RBD-4). Only rows attributed
to the calling identity are ever candidates (FR-024). Works from any instance, any
time, across restarts (FR-007).

Result:
- Applied: `{ success: true, undone: true, message, clock }` — `clock` is the
  post-operation document clock (the inverse's row), replacing the retired `cursor`
  (RBD-5) so observed-clock tracking stays coherent without a re-read.
- Honest empty (nothing recorded, fully superseded, or a concurrent request won):
  `{ success: true, undone: false, message, clock }` — never an error, never a silent
  wrong answer (FR-011, FR-028).
- Errors (bad scope, no editor role, missing doc): thrown as today.

The `cursor` field is **dropped** (not `null`) and cursor restoration removed from the
description; the description documents per-identity scoping, cross-session/restart
durability, surgical later-edits-preserved semantics, and honest empty results.

## `redo` — symmetric

Input/scope/role identical to `undo`. Reapplies the calling identity's undone edits
most-recently-undone first (LIFO, RBD-4) by inverting each undo's recorded inverse
range (FR-015). Result: `{ success: true, redone: true|false, message, clock }` with
the same honesty rules; redo of a pre-016 undo is honestly `redone: false` (RBD-2).

## Parity requirement (SC-008)

Identical operation sequences through the chat endpoints and through these tools must
produce identical document states — both surfaces call the same
`server/undo/undo-service.js` core through the shared
`server/mcp/tools/undo-redo-handler.js`. The chat surface differs only in exposure
(latest-edit-only button) and in the best-effort `reverted`-flag side effect.
