# Data Model — 020 Undo/Redo Results Carry Diffs

No database entities, schema changes, or migrations. All shapes below are in-memory /
persisted-JSON structures that already exist; this feature adds one optional member.

## Diff payload (existing — reused verbatim, no new fields)

Produced by `computeChatDiff` (`server/mcp/diff-utils.js`):

| Field | Type | Notes |
|---|---|---|
| `lines` | `string[]` | Prefixed diff lines (`-` / `+` / space), `~~~` hunk separators |
| `hunkStarts` | `{ index, oldStart, newStart }[]` | Hunk start indices into `lines` |
| `formatAnnotations?` | `object` | Format-only pair annotations (post-processing) |
| `truncatedByServer?` | `boolean` | `true` when the shared 50,000-char / 200-line bound truncated |

## Undo/redo result (016 contract + one additive member)

Returned by `performUndo` / `performRedo` on every surface (MCP tool result, chat HTTP
response body):

| Field | Type | Presence | Change |
|---|---|---|---|
| `success` | `boolean` | always | unchanged (016) |
| `undone` / `redone` | `boolean` | always (per operation) | unchanged (016) |
| `message` | `string` | always | unchanged (016) |
| `clock` | `number` | always | unchanged (016) |
| `diff` | Diff payload | **only** when `undone|redone: true` AND computation succeeded AND `lines.length > 0` | **NEW (additive)** |

Invariants:
- Honest-empty results (`undone|redone: false` — nothing recorded, pending recording, fully
  superseded, concurrent loser) never have a `diff` key (FR-003).
- `diff` reflects the pre/post states bracketing the applied inverse — never the mirror of
  the original edit's diff (FR-002).
- Absence of `diff` on a success result is legal (best-effort failure, FR-006).

## Internal: `computeInverse` return value (`server/undo/inverse.js`)

`{ inverseUpdate: Uint8Array, preMarkdown: string|null, postMarkdown: string|null } | null`

- `null` overall: nothing to invert (unchanged 016 semantics).
- `preMarkdown` / `postMarkdown`: markdown bracketing the pop (after live merge); `null`
  when serialization failed (best-effort) — the inverse is still returned and applied.

## Chat tool part (persisted chat message part — existing persistence path)

For `type: "tool-undo"` / `"tool-redo"` parts, `part.output` is the undo/redo result above;
the optional `diff` member persists verbatim through `chat-store.js` save/load like every
other output field (FR-007). No other part fields change (`reverted` remains a
modify-part concern set by the button path).

## State transitions

None — no entity lifecycle changes. The `agent_edits` state machine from 016 is untouched.
