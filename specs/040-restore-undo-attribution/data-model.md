# Phase 1 Data Model — 040-restore-undo-attribution

**No schema change. Zero migrations (FR-014, SC-007).** This document describes the *values*
that flow through two existing tables and the two in-process shapes this feature adds.

---

## Persisted entities (unchanged schema)

### `yjs_updates` — the update log

Relevant columns: `doc_guid`, `clock`, `user_id` (FK → `users`, **ON DELETE SET NULL**),
`agent_name` (**nullable**), `via_sync` (nullable, feature 038), `created_at`, `update_data`.

A restore produces exactly **one** row.

| Restore surface | `user_id` | `agent_name` before 040 | `agent_name` after 040 |
|---|---|---|---|
| Web UI (`POST /api/docs/:docId/restore`) | requesting user | `NULL` | **`'Squire Docs Assistant'`** |
| MCP (`restore_document_version`) | token's user | agent token's name | agent token's name (**unchanged**) |

`agent_name` stays nullable — a direct human keystroke through the websocket still writes
`NULL`, and that is correct. Only the *restore* row changes.

### `agent_edits` — the undoable unit / undo-redo state machine

Relevant columns: `doc_guid`, `user_id` (FK → `users`, **ON DELETE CASCADE**), `agent_name`
(**`NOT NULL`**, `migrations/1796000000000_create-agent-edits.js:36`), `edit_clock_start`,
`edit_clock_end`, `state` (`active` | `undone`), `undo_target_*`, `undo_target_clocks`,
`redo_target_*`, `last_undone_at`. Unique on
`(doc_guid, user_id, agent_name, edit_clock_start)`.

A restore produces exactly **one** row with `edit_clock_start = edit_clock_end = newClock` and
`undo_target_clocks = [newClock]` (the exact-clock set that makes the inversion surgical).

| Restore surface | `agent_name` before 040 | `agent_name` after 040 | Reachable by |
|---|---|---|---|
| Web UI | `''` (dead sentinel) | **`'Squire Docs Assistant'`** | before: **nobody**; after: the chat undo surface |
| MCP | agent token's name | agent token's name (**unchanged**) | that agent's MCP undo |

**Sentinel rule (FR-007), to be documented in `server/undo/edit-records.js`:**

- `agent_name` is `NOT NULL` and MUST be a **real, non-empty agent display name** — an MCP agent
  token's name, or the shared chat-assistant identity.
- `''` is **retired**. No new record may be written with it; `recordEdit` rejects it (FR-006).
- Legacy `''` rows (every web-UI restore between feature 023 and this feature) remain in the
  database, permanently unreachable and harmless. **No migration, no backfill** (D1).
- Legacy `yjs_updates` restore rows with `agent_name = NULL` likewise remain as-is.

**FK-policy divergence (FR-012), to be documented at the same module:** `yjs_updates.user_id`
is `ON DELETE SET NULL` while `agent_edits.user_id` is `ON DELETE CASCADE`. This is
**intentional and must not be "unified"**: history rows must survive a user's deletion
(anonymized — which is exactly what the unknown-author entry below renders), while a deleted
user's undo chain dies with the account because a deleted user can never undo anything. The
policies themselves do not change in this feature.

---

## In-process shapes

### `AgentIdentity` (existing shape, now with one comparison)

```
{ userId: string, agentName: string | null | undefined }
```

Sources disagree on the absent case: a DB row yields `agentName: null`; an in-process identity
object built by a caller that omitted the field yields `undefined`. **`isSameIdentity` is the
single definition that reconciles them** (FR-015):

```
isSameIdentity(a, b) === (a.userId === b.userId)
                     && ((a.agentName ?? null) === (b.agentName ?? null))
```

Contract details in [`contracts/agent-identity.md`](./contracts/agent-identity.md).

### `Author` (version-history response shape, unchanged fields)

```
{ id: string|null, name: string, email: string|null,
  picture: string|null, color: string, isAgent: boolean }
```

Three variants after this feature:

| Variant | `id` | `name` | `color` | `isAgent` |
|---|---|---|---|---|
| Human | user id | user's name (or `'Unknown'`) | `generateColorFromId(userId)` | `false` |
| Agent (incl. a web-UI restore) | user id | `` `${agentName} (${userName})` `` — e.g. `Squire Docs Assistant (Sam Goldstein)` | `generateColorFromId(`${userId}-agent-${agentName}`)` | `true` |
| **Unknown author (NEW, FR-008)** | `null` | `'Unknown author'` | `'#888888'` | `false` |

**Unknown-author rules:**

- Synthesized only when a version contains at least one update row with **no** `userId` (deleted
  account — `ON DELETE SET NULL` — or a legacy unattributed row). It is never synthesized for a
  version with zero rows, because a version is *built from* rows.
- **Collapsed**: at most one entry per version, regardless of how many unattributed rows it
  contains (fixed author key `unknown`), so long-dead accounts cannot spam the contributor list.
- Coexists with real authors: a mixed version shows the real authors **and** one unknown entry.
- Applies to the version list and the sub-version drill-down (one code site — both go through
  `groupUpdatesIntoVersions`), plus the single-author version metadata at
  `version-history.js:794`.
- `'#888888'` is the same neutral the server already returns from `generateColorFromId(null)`
  (`version-history.js:59`) and the same neutral the client falls back to
  (`HierarchicalVersionList.jsx:61`, shipped by 039) — one gray means "no identity" everywhere.
- The client must tolerate `id: null` (FR-009): `HierarchicalVersionList` keys on
  `` `${author.id}-${i}` `` and `VersionPreview` on `author.id || i`; both already fall back on
  `author.name` and `author.color`. Requirement is pinned by a test, not by new code.

---

### `UndoStatus` (HTTP response shape, additively extended — FR-016, D13/D14)

```
{ canUndo: boolean, canRedo: boolean,
  nextUndo?: { editClockStart: number },     // present only when an agent_edits row backs it
  nextRedo?: { editClockStart: number } }
```

`editClockStart` is `agent_edits.edit_clock_start` — part of the row's unique key and therefore
**immutable**, unlike `undo_target_*`/`redo_target_*`, which `finalizeClaim` rewrites on every
transition. It is the same number `modify` already returns to the client as
`editRange.clockStart`, which is what makes the client-side offer guard a direct comparison.
Fields are **omitted, never null-guessed**, when the corresponding `can*` is false or when the
legacy-derivation fallback answered (no record exists). Full contract in
[`contracts/agent-identity.md`](./contracts/agent-identity.md).

## State transitions (unchanged mechanism, newly reachable for web-UI restores)

```
restore (web UI)  --recordEdit(CHAT_AGENT_NAME)-->  agent_edits row: state='active'
                                                     undo_target_clocks=[newClock]

active  --chat Undo (userId, CHAT_AGENT_NAME)-->  undone   (inverse stored as a
                                                            NORMAL FORWARD update;
                                                            redo_target := [inverseClock])
undone  --chat Redo (userId, CHAT_AGENT_NAME)-->  active    (undo_target := [redoClock])
```

History is never rewritten: every inversion is a new forward row. Identity scoping (016 FR-024)
is unchanged — an MCP agent's restore is invisible to the chat identity's undo and vice versa.
A fully superseded restore still yields the honest "nothing left to undo".
