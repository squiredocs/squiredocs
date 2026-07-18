# Research: Log-Derived Agent-Edit Undo/Redo (016)

**Date**: 2026-07-18 | **Spec**: [spec.md](spec.md) | **yjs**: 13.6.30 (verified in `node_modules/yjs`)

This document records the CRDT strategy and every plan-stage decision, with the code
facts they rest on. All yjs internals cited were read from
`node_modules/yjs/src/utils/UndoManager.js` and `node_modules/yjs/src/structs/Item.js`
at the pinned version.

---

## R1. The chosen inverse-computation strategy

**Decision**: **Replica-UndoManager on a log-rebuilt, gc-off scratch doc; inverse
extracted as a single normal update; applied to the live doc via store-then-apply.**

Per undo (or redo — same code path, different input range):

1. **Load** all `yjs_updates` rows for the doc in clock order (`update_data` +
   attribution), plus the target range `[s, e]` and the acting identity
   `(user_id, agent_name)`.
2. **Rebuild** a scratch `Y.Doc({ gc: false })`:
   - apply rows with `clock < s` with an untracked origin (`'history'`);
   - create `new Y.UndoManager(scratch.get('default', Y.XmlFragment), {
     trackedOrigins: new Set([EDIT_ORIGIN]), captureTimeout: Number.MAX_SAFE_INTEGER })`;
   - apply rows in `[s, e]` **in clock order**: rows attributed to the acting identity
     with origin `EDIT_ORIGIN` (tracked), interleaved foreign rows with `'history'`
     (untracked — FR-001/FR-029);
   - apply rows with `clock > e` with `'history'`;
   - merge this instance's live shared doc state (if loaded):
     `Y.applyUpdate(scratch, Y.encodeStateAsUpdate(liveDoc, Y.encodeStateVector(scratch)), 'history')`
     — brings in-flight, not-yet-persisted edits into the supersession evaluation
     (FR-013; see R9 for the residual race posture).
3. **Invert**: subscribe once to the scratch doc's `'update'` event, call
   `undoManager.undo()`.
   - `undo()` returning `null` (or no `'update'` event firing) ⇒ the edit is fully
     superseded ⇒ honest "nothing left to undo" (FR-011). No write of any kind.
   - Otherwise the captured `'update'` payload **is the surgical inverse**: exactly the
     one transaction popStackItem performed (its new structs + its delete set), minimal
     bytes — not a full-DeleteSet `encodeStateAsUpdate` diff.
4. **Apply** via the feature-004 store-then-apply pattern (`server/markdown-sync.js`
   `applySyncPush`, research R8 there): claim the at-most-once guard and
   `storeUpdate(docGuid, inverseUpdate, userId, agentName)` in **one DB transaction**
   (see R6), yielding the inverse's clock `c`; then
   `Y.applyUpdate(sharedDoc, inverseUpdate, ORIGIN_INVERSE_APPLY)` on the live doc.
   The sentinel origin parses to `null` in `parseOrigin` (no double-store by the
   bindState listener, `server/index.js:246-299`) and is **not** on the Redis publish
   skip-list (`server/index.js:1936-1943` skips only `ORIGIN_REDIS`/`ORIGIN_DB_LOAD`),
   so the inverse broadcasts to this instance's clients **and** fans out to other
   instances — identical to a sync push.

**Why the UndoManager is usable off-session**: its `afterTransactionHandler`
(`UndoManager.js:211-267`) captures **any** transaction whose origin is in
`trackedOrigins` — including transactions produced by `Y.applyUpdate` of a remote/
stored update. The StackItem's `insertions` DeleteSet is built from the transaction's
`beforeState`/`afterState` per-client diff (so it covers structs regardless of which
clientID authored them — exactly the edit's logged structs), and `deletions` is the
transaction's merged deleteSet. With `captureTimeout: MAX_SAFE_INTEGER` every tracked
transaction merges into **one** StackItem (`UndoManager.js:239-243`), so a multi-row
edit (script transaction + sanitization passes, spec Edge "Multi-update edits") is one
undo unit by construction; untracked interleaved foreign transactions neither join the
item nor break the merge.

**Why the semantics are exactly popStackItem** (`UndoManager.js:54-128`): we run the
real `popStackItem`, not a re-implementation —
- *Insertions half*: iterates the edit's struct id ranges, **skips structs already
  deleted** (`!struct.deleted`, line 84) — supersession skip for insertions (FR-010);
  follows `redone` pointers (line 77-83) so redo chains resolve; deletes survivors by
  struct identity (line 104-109) — later edits' structs are different ids and are
  untouched (FR-009).
- *Deletions half*: iterates the edit's deleteSet, **skips structs the edit itself
  created** (`!isDeleted(stackItem.insertions, ...)`, line 94 — internal churn is not
  resurrected), and restores the rest via `redoItem` (`Item.js:143-241`), which
  **re-creates the content** (`item.content.copy()`) as a *new* item anchored by
  surviving left/right neighbors traced through `redone` chains. `redoItem` returns
  `null` when the parent is gone or a conflicting change wins — supersession skip for
  deletions (FR-010). Content restoration requires the deleted items' content, which
  is why the scratch doc is built **gc:false from the full log** (the live doc gc's
  tombstones; the log never loses content — same reason `diff-service.js` builds
  gc-off).
- *Honest emptiness*: with exactly one StackItem on the stack, `performedChange ===
  false` ⇒ `undo()` returns `null` (line 111, 121-127) — FR-011. (popStackItem's
  pop-until-change loop can't walk further back: our stack has one item.)

**Why applying the inverse to the live doc is CRDT-correct**: the inverse is an
ordinary Yjs update from a fresh clientID (the scratch doc's):
- its delete set targets **only the edit's own struct ids** — deleting by id is
  commutative and idempotent, so concurrent content (even text typed *inside* the
  edit's insertion — separate items, separate ids) is untouched and a concurrent
  deletion of the same ids merges harmlessly;
- its new items (restored content) carry left/right origins pointing at structs that
  exist in the live doc (they exist in the log the scratch was built from), so YATA
  integration places them deterministically among any concurrent inserts;
- it never rewrites history: it is appended with a fresh clock like any edit (FR-006),
  attributed to the acting identity via `storeUpdate(..., userId, agentName)` (FR-026),
  and grouped by version history's normal inactivity rules (FR-027).

**Alternatives considered**:
- *Hand-rolled inverse from `decodeUpdate` struct/ds extraction + manual
  `redoItem`-equivalent*: re-implements the trickiest internals in yjs (redone
  chains, parent restoration, map-conflict checks); every divergence is a
  content-destroying bug class. Rejected — we get the ratified
  "popStackItem-equivalent" semantics *by running popStackItem*.
- *Keep a live `Y.UndoManager` per session*: the retired mechanism; fails FR-005/007/008.
- *Position-based diff-and-patch (rebuild pre/post states, compute a text diff, apply
  positionally)*: violates Constitution IV (positional targeting), destroys later
  edits' bytes under concurrency. Rejected.
- *Apply the inverse through a presence session provider*: recreates the orphan-session
  pathology (FR-008). Rejected — store-then-apply through the shared doc, like restore
  and sync-push.

**Public-API audit** (all verified exported from `require('yjs')` at 13.6.30):
`Y.Doc`, `Y.applyUpdate`, `Y.encodeStateVector`, `Y.encodeStateAsUpdate`,
`Y.UndoManager`, `decodeUpdate`, `parseUpdateMeta`, `mergeUpdates`, `getState`. No
imports from `yjs/src/...` internals are needed.

## R2. The edit identifier: capture and durability (FR-001..004, RBD-1)

**Current facts**: `modify` executes on the agent session's *client-side* Y.Doc
(`session.provider.doc`, a y-websocket client — `server/mcp/tools/modify.js:277-285`);
its local updates flow over WS to the server's shared doc, whose bindState listener
persists each one asynchronously with `(userId, agentName)` attribution
(`server/index.js:246-299`). The modify result's `clock` is the **pre-edit** max clock
captured before the script runs (`modify.js:291-300, 535`) — kept unchanged per RBD-1.
Clocks are assigned at write time (max+1, `postgres-persistence.js:121-179`), so
foreign rows can interleave with the edit's rows.

**Decision** — capture-and-verify, record post-durability:
1. During the modify call (script + all sanitization passes), subscribe to the session
   doc's `'update'` event and collect the emitted payloads `U1..Uk` — these are
   precisely the update messages the provider ships and the server persists as rows.
2. After the edit, poll the log (bounded: ~100–250 ms interval, ≤5 s total; in
   practice one round-trip — the session connects to its own instance): fetch
   identity-attributed rows with `clock > baseline` (`getUpdatesInRange` /
   `getRecentUpdatesWithUsers`), and declare the edit durable when the union of the
   stored rows' `parseUpdateMeta` struct ranges and `decodeUpdate(...).ds` delete-sets
   **covers** every captured payload's struct ranges and delete-sets. This is exact:
   it also handles deletion-only edits (no struct-clock advance) and excludes unrelated
   same-identity rows (a different session has a different clientID; earlier calls'
   late rows have struct clocks below the captured coverage).
3. The recorded range is `[min clock, max clock]` of the identity rows that intersect
   the captured coverage. Row selection at undo time re-applies the identity filter
   inside the range (FR-001, FR-029).
4. Record the range in three places: the modify **result** (`editRange: { clockStart,
   clockEnd }`), hence automatically the persisted chat tool part (FR-002; the chat
   layer stores tool outputs on the message parts today — the `reverted` flag rides
   the same store, `server/index.js:1331-1346`), and an **`agent_edits` row** (R5) —
   the durable server-side record MCP undo/status need (edits by external MCP agents
   have no chat message).
5. On timeout (durability not confirmed in the bounded window): return the result
   *without* `editRange` plus `editRangePending: true`, and finish the recording in
   the background (insert the `agent_edits` row when coverage completes). An undo
   arriving in that window finds no identifier and reports nothing-to-undo honestly —
   exactly the spec's "Undo immediately after modify" edge and RBD-7(b). Recorded as
   **RBD-8** in the ledger.

**Alternatives**: inferring the range at undo time from response-time clocks
(speculative — violates FR-004); making storeUpdate return clocks to the modify caller
(the writes happen on the server shared-doc path, not in modify's call stack; plumbing
a per-edit callback through y-websocket internals is far more invasive than observing
the log); byte-matching stored rows against captured payloads (fragile — the server
persists the *applied diff*, which need not be byte-identical).

## R3. Where the inverse applies (FR-006/007/008)

**Decision**: through the **live shared Y.Doc** via `documentService.getSharedDoc`
(which loads/binds the doc if absent — undo works with no client connected, FR-007),
using the store-then-apply pattern with a new sentinel `ORIGIN_INVERSE_APPLY` in
`server/origin.js` (parseOrigin ⇒ null; deliberately not on the Redis skip-list —
byte-for-byte the `ORIGIN_SYNC_PUSH` treatment, `origin.js:17-31`,
`markdown-sync.js:1138-1152`). No presence session is created, extended, or consulted
(FR-008) — which also removes the 015-era wart where an undo on a session-less pod
minted an orphan session and took over the presence claim. Feature 015's claim
machinery is untouched.

If the freshly-created shared doc is still async-loading in bindState when the inverse
is applied, both orders converge: the row is already stored, applies are idempotent,
and bindState's DB load includes or merges it — the same window restore already
tolerates (`version-history.js:744-763`).

## R4. Redo = invert the inverse (FR-014..017)

**Decision**: `performRedo` runs the identical R1 algorithm with the input range set to
the last inverse's recorded range `[c, c]` (the inverse is a single stored row). The
scratch UndoManager captures the inverse's row as the tracked "edit"; popping it
deletes the inverse's restored items (if not since superseded) and re-creates the
original edit's content via `redoItem` (content available — gc:false full-log rebuild),
with `followRedone` resolving chains of any length. Each application records its own
range (R5), so undo→redo→undo→… derives each step from the previous one and survives
restarts/instance switches at every link (FR-016). "Nothing left to redo" falls out of
the same `undo() === null` honesty.

## R5. The durable record: `agent_edits` (RBD-3, FR-014, FR-017)

**Decision**: one table, one row per recorded agent edit, doubling as the undo/redo
chain state machine:

- Identity/keys: `doc_guid`, `user_id`, `agent_name`, `edit_clock_start`,
  `edit_clock_end`; `UNIQUE (doc_guid, user_id, agent_name, edit_clock_start)`.
- Chain state: `state` (`'active'` | `'undone'`), `undo_target_start/end` (the range
  the *next undo* inverts — initialized to the edit's range, updated to each redo's
  range), `redo_target_start/end` (nullable — the range the *next redo* inverts, set
  to each undo's inverse range), `last_undone_at` (LIFO ordering for redo, RBD-4).
- Written by: modify (insert, `state='active'`), undo (claim + set redo targets),
  redo (claim + set undo targets), legacy undo (insert-on-first-undo, R7).

Queries: chat/MCP undo target = most recent `'active'` row for (doc, identity) by
`edit_clock_start DESC` (stepping back skips undone rows — FR-017); redo target = most
recent `'undone'` row by `last_undone_at DESC`; undo-status = the same two lookups
(R8). Migration via node-pg-migrate, timestamp **1796000000000** (> 1795000000000 per
the phantom-008 constraint; 016 is the only in-flight feature adding migrations).

**Alternatives**: chat-message store only (fails bare MCP `redo(docGuid)` — RBD-3
already rejected); Redis (fails restart durability — rejected in RBD-3); separate
edits + inversions tables (an event log is more ceremony than the chain needs; the
single-row state machine is the minimal thing that answers every query above and makes
the at-most-once claim a one-row conditional write).

## R6. At-most-once and crash-consistency (FR-028, RBD-7)

**Decision**: the guard is a **conditional row transition executed in the same DB
transaction as the inverse row's insert**:

- undo: `UPDATE agent_edits SET state='undone', redo_target_*=..., last_undone_at=now()
  WHERE <identity+edit> AND state='active'` (legacy first undo: `INSERT ... ON CONFLICT
  DO NOTHING`); redo: the symmetric `WHERE state='undone'`.
- `rowCount = 0` ⇒ a concurrent request won: return the honest already-undone /
  already-redone result, apply nothing (FR-028).
- The winner, still in the same transaction, inserts the inverse's `yjs_updates` row
  (via `storeUpdate` extended to accept an external client — its max+1/ON CONFLICT
  retry loop is transaction-safe since `DO NOTHING` doesn't abort) and writes the
  resulting clock into the chain row. Commit ⇒ the claim, the inverse row, and the
  redo record are atomic — no crash window in which the chain says "undone" without a
  durable inverse (FR-014). Only after commit is the update applied to the live doc
  (R3); a crash in that gap leaves a persisted row that every subsequent load replays —
  the same posture restore has.

The inverse is computed (read-only) *before* claiming, so the fully-superseded case
claims nothing and writes nothing (FR-011).

## R7. Legacy derivation (FR-021, RBD-2)

Pre-016 chat parts persist only the pre-edit `clock` (`part.output.clock` /
`part.output.value.clock` — the same field `chat-staleness.js:45` reads); external MCP
agents' pre-016 edits have no record at all; pre-016 undos have a `reverted` flag but
no inverse range.

**Decision** (elaborating RBD-2's ratified policy; segmentation default recorded as
**RBD-10**):
- With a part baseline `b`: the edit = the contiguous run of identity-attributed rows
  starting at the **first row after `b`**; refuse (honest unavailability) if that first
  row is foreign (the start can't be pinned) or no identity rows follow.
- Without any baseline (bare MCP undo, undo-status fallback): the edit = the
  **trailing** contiguous identity run in the log.
- In both cases the run is additionally **segmented at >10-second `created_at` gaps**,
  taking the segment nearest the anchor: consecutive same-identity rows within a call
  land sub-second apart (script + sanitization), while separate modify calls are
  seconds-to-minutes apart. An unsegmentable ambiguity refuses honestly — a guessed
  inverse is the one forbidden outcome (SC-011).
- A successful legacy undo inserts the `agent_edits` row (derived range,
  `state='undone'`, redo targets), so its redo chain is fully 016-native. Redo of a
  **pre-016** undo (no inverse range exists anywhere) is honestly unavailable.
- Known, accepted quirk: a pre-016 *session-mechanism* undo is itself an ordinary
  identity-attributed row in the log, so the "latest edit" a legacy derivation finds
  may be that undo — undoing it re-applies the edit. That is the honest reading of the
  log ("undo your latest edit"), never a guessed or partial inverse.

## R8. undo-status: cheap availability (FR-019, RBD-6)

**Decision**: `GET /api/docs/:docId/undo-status` becomes two indexed `agent_edits`
lookups for (doc, user, `CHAT_AGENT_NAME` identity): `canUndo` = latest edit row
exists with `state='active'`; `canRedo` = an `'undone'` row exists. Legacy fallback
(no rows at all): one `getRecentUpdatesWithUsers(100)` pass through R7's derivation.
No presence-session dependency of any kind; viewer role and errors keep returning
`{canUndo:false, canRedo:false}`. Full supersession is discovered at action time
(RBD-6); the client already re-fetches status after every action
(`AiChatMessages.jsx:617`). Cost fits the existing 30-second per-client poll (SC-007).

## R9. Supersession evaluation basis and the residual race (FR-013) — RBD-9

**Decision**: supersession is evaluated against **the full log at computation time
merged with this instance's live shared-doc state** (R1 step 2). The remaining window
— an edit landing on another instance between computation and apply — resolves by
CRDT merge: the inverse's deletes are idempotent against a racing delete, and a racing
edit is preserved (FR-009 holds unconditionally). The one observable asymmetry: a
racing deletion of content the inverse is *restoring* doesn't retro-delete the restored
copy. This is the same window the retired in-session popStackItem had (it evaluated
against its instance's doc state at pop time), is loss-free in both directions, and
self-heals with one more user action. Recorded as **RBD-9**.

## R10. Surfaces, results, and retirements (FR-018/022/023, RBD-5)

- Both REST endpoints keep routing through `toolRegistry.executeTool('undo'|'redo')`
  (`server/index.js:1296-1349`) — one shared core, literally (SC-008). The
  best-effort `reverted`-flag persistence on the chat part is unchanged.
- Tool results: `{ success, undone|redone, message, clock }` where `clock` is the
  post-operation document clock (the inverse's clock on success; the current max on
  the honest-empty path) — RBD-5. The `cursor` field and cursor-restoration promises
  are removed from behavior and both descriptions; descriptions are rewritten to the
  log-derived truth (FR-023). Input schemas, names, scopes (`documents:write`,
  enforced in `server/mcp/tools/index.js:105-192`), and the 16-tool surface are
  unchanged (FR-022).
- Editor-role enforcement without a session: the handler checks
  `documents.getRole(docGuid, agentToken.userId)` directly (FR-025); the REST
  endpoints already do their own role check before dispatch.
- Retired: `session.undoManager` creation/destruction in
  `server/mcp/agent-presence.js` (~line 448, 580) and
  `getUndoRedoAvailability` (~line 999); the cursor-resolution block in
  `undo-redo-handler.js`. The chat client's `UndoEditButton` keeps its poll/act flow
  (it works unchanged against the new status semantics) but its lifetime comments and
  the honest nothing-left result surface are updated.

## R11. Testing approach

Backend Jest, **serial** (shared DB — Constitution II): unit semantics matrix on pure
Y.Doc fixtures + fabricated rows (no DB) for the inverse core; DB-backed tests for
`agent_edits` claims and modify range-recording; integration tests simulate restarts
(fresh persistence/doc instances, no sessions) and cross-instance service (two
independently-loaded doc instances against one DB — the established pattern in
`server/__tests__/integration/` and `presence-multi-instance.test.js`). Client Vitest
for `UndoEditButton`. No new dependencies anywhere.
