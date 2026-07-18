# Data Model: Log-Derived Agent-Edit Undo/Redo (016)

**Spec**: [spec.md](spec.md) | **Strategy**: [research.md](research.md)

## 1. New table: `agent_edits`

One row per recorded content-changing agent edit; doubles as the undo/redo chain state
machine and the at-most-once claim guard (research R5/R6; RBD-3, RBD-7, FR-014,
FR-017, FR-028).

**Migration**: `migrations/1796000000000_create-agent-edits.js` (node-pg-migrate;
timestamp deliberately > 1795000000000 — the retired-008 phantom-row floor; 016 is the
only in-flight feature adding migrations). Provide `exports.down` dropping the table.

| Column | Type | Constraints | Meaning |
|---|---|---|---|
| `id` | `bigserial` | PK | — |
| `doc_guid` | `uuid` | not null | Document (matches `yjs_updates.doc_guid` type) |
| `user_id` | same type as `yjs_updates.user_id` | not null | Acting identity: user |
| `agent_name` | `text` | not null | Acting identity: agent (log attribution value, e.g. `Squire Docs Assistant` for chat, the token's agent name for MCP) |
| `edit_clock_start` | `integer` | not null | Original edit's first log row (clock) |
| `edit_clock_end` | `integer` | not null | Original edit's last log row (clock) |
| `state` | `text` | not null, `CHECK (state IN ('active','undone'))` | Chain polarity |
| `undo_target_start` | `integer` | not null | Range the **next undo** inverts — init = edit range; after each redo, the redo's own range |
| `undo_target_end` | `integer` | not null | (pair of the above) |
| `undo_target_clocks` | `integer[]` | null | Post-merge review M1 (migration `1796500000000`): the EXACT clock set the next undo inverts — init = the edit's covering clock set from the durability wait; after each redo, `[c']` (the redo's inverse row). Null (legacy first-undo inserts, pre-migration rows) = spanning-range fallback |
| `redo_target_start` | `integer` | null | Range the **next redo** inverts — the latest undo's inverse rows; null until first undo |
| `redo_target_end` | `integer` | null | (pair of the above) |
| `last_undone_at` | `timestamptz` | null | LIFO ordering for redo (RBD-4) |
| `created_at` | `timestamptz` | not null default now() | — |
| `updated_at` | `timestamptz` | not null default now() | — |

**Constraints & indexes**:
- `UNIQUE (doc_guid, user_id, agent_name, edit_clock_start)` — identity of an edit;
  arbitrates concurrent legacy first-undo inserts (R6/R7).
- Index `(doc_guid, user_id, agent_name, edit_clock_start DESC)` — latest edit /
  LIFO undo stepping (FR-003, FR-017), undo-status `canUndo` (FR-019).
- Index `(doc_guid, user_id, agent_name, state, last_undone_at DESC)` — redo pick
  (most-recently-undone first) and undo-status `canRedo`.

**State transitions** (all transitions are single conditional row writes — the
at-most-once guard, executed in the same DB transaction as the inverse row's
`yjs_updates` insert; research R6):

```
(modify, changed:true, range durable)   → INSERT state='active',
                                          undo_target = edit range
active --undo--> undone                 : WHERE state='active';
                                          redo_target := inverse's [c,c];
                                          last_undone_at := now()
undone --redo--> active                 : WHERE state='undone';
                                          undo_target := redo's [c',c']
(legacy edit, first undo)               → INSERT ... ON CONFLICT DO NOTHING
                                          with derived edit range, state='undone',
                                          redo_target set (R7)
rowCount = 0 on any transition          → loser: honest already-undone/redone result,
                                          nothing applied (FR-028, RBD-7)
```

Rows are never deleted by this feature; document deletion cleanup may cascade later
(out of scope — the log itself is removed on doc deletion today; a doc-deletion
`DELETE` of matching `agent_edits` rows is included in the migration's design note and
the doc-deletion path task).

## 2. Modified entities (no schema change)

### Modify tool result (`server/mcp/tools/modify.js`)
- Existing `clock` (pre-edit baseline) — **unchanged meaning** (RBD-1; staleness
  machinery depends on it).
- NEW `editRange: { clockStart, clockEnd }` — the durable edit identifier (FR-001/002),
  present only when `changed: true` and durability was confirmed within the bounded
  wait.
- NEW `editRangePending: true` — returned instead of `editRange` on durability-wait
  timeout (RBD-8); recording completes in the background (`agent_edits` still gets its
  row).

### Chat modify tool part (chat message store; no schema — JSON parts)
- Gains `editRange` implicitly via the persisted tool output (FR-002; same store the
  `reverted` flag uses, `server/index.js:1331-1346`). The operative server-side record
  remains `agent_edits`; the part copy is the per-message UI/state home (RBD-3).
- `reverted` flag: unchanged semantics (set on successful undo, cleared on successful
  redo, best-effort — FR-018, FR-020).

### Update log entry (`yjs_updates`) — existing, read-only input
- Never mutated (FR-006, SC-009). The inverse (and each redo) is appended as one new
  attributed row via `storeUpdate(docGuid, inverseUpdate, userId, agentName)`; its
  clock range is `[c, c]`.

### Origin sentinels (`server/origin.js`)
- NEW `ORIGIN_INVERSE_APPLY`: `parseOrigin` returns null (bindState listener does not
  double-store); **not** on the Redis publish skip-list (fans out to other instances) —
  the `ORIGIN_SYNC_PUSH` treatment exactly (research R3).

### PostgresPersistence (`server/postgres-persistence.js`)
- `storeUpdate` gains an optional external-client parameter so the inverse insert can
  join the claim transaction (research R6). Behavior with no client passed is
  byte-identical to today.

## 3. Key derived values (not stored)

- **Acting identity** = `(user_id, agent_name)` exactly as attributed on `yjs_updates`
  rows (FR-024). Chat surface: requesting user + `CHAT_AGENT_NAME`; MCP: token's
  user + agent name. Row selection inside any clock range is always
  identity-qualified (FR-001, FR-029).
- **Inverse update** = the single Yjs update captured from the scratch doc's `update`
  event during the replica-UndoManager pop (research R1). Empty ⇒ honest
  nothing-left result; nothing stored, no state transition (FR-011).
- **Legacy edit range** = derived per research R7 (contiguous identity run anchored at
  the persisted baseline, or trailing run; segmented at >10 s gaps — RBD-10); refusal
  on ambiguity (FR-021, SC-011).
