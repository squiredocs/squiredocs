# Contract: Restore Surfaces Convergence (023)

One shared core, two thin surfaces. Requirements: FR-020..024. Decisions: R7,
D-4, D-5. Existing endpoints only — no new public API (spec Out of Scope).

## Shared core

```js
// server/version-history.js
async restoreVersion(persistence, docGuid, versionId, userId, {
  getSharedDoc,        // docGuid -> Y.Doc | null (server in-memory doc)
  redisPubSub,         // server/redis-pubsub (fan-out when doc not loaded)
  agentName = null,    // acting agent, null for human UI restore
} = {}) -> { success: true, newClock: number, message: string }
```

Pipeline (all-or-observable, in order):
1. Resolve version → replay content under the gap-tolerant read path
   (`getVersionContent` → `getYDocAtClock`); unknown/foreign id or out-of-range
   clock throws typed `VersionNotFoundError` (hotfix behavior preserved).
2. Build the replace update against current state (existing logic, unchanged).
3. **Single persist**: one `storeUpdate(..., { meaningful: true })` call → one
   `yjs_updates` row (FR-024 — regression-guarded, not re-implemented).
4. **Edit record** (FR-020): `editRecords.recordEdit` with identity
   `{ userId, agentName: agentName ?? '' }` (empty string = human, D-4/data-model
   §3), range/clocks = `[newClock, newClock]` / `[newClock]`. Record failure logs
   and does not fail the restore (modify parity); the response still succeeds.
5. **Broadcast** (FR-023, D-5): `applyLiveUpdate` (server/live-apply.js) with
   `ORIGIN_RESTORE`:
   - doc loaded on this instance → `Y.applyUpdate(sharedDoc, u, ORIGIN_RESTORE)`
     (attached redis handler fans out; persistence listener skips the sentinel);
   - not loaded + Redis enabled → `redisPubSub.publishUpdate(docGuid, u)`;
   - neither → structured warn (`[Restore] no delivery path for <docGuid> …`) —
     observable, never silent. (Redis-less + unloaded ⇒ no one is connected
     anywhere; next load replays the durable row.)

## Surface bindings

| Aspect | REST `POST /api/docs/:docId/restore` | MCP `restore_document_version` |
|---|---|---|
| Auth/ACL | requireAuth + editor check (existing) | `getOrCreateSession(…, { requiredRole: 'editor' })` (existing; session kept for ACL + presence only) |
| Identity passed | `userId` = session user, `agentName: null` → recorded as `''` | `userId` = token user, `agentName` = `agentToken.agentName` |
| getSharedDoc | `documentService.getSharedDoc` | `documentService.getSharedDoc` (**no longer** the presence-session provider doc) |
| Broadcast | identical (shared core) | identical (shared core) |
| Success body | `{ success, newClock, message }` | same object as tool result |
| Not-found | 404 via `instanceof VersionNotFoundError` | same error message surfaced to the model |
| Rate limit | `versionHistory` per-user limiter (existing) | MCP tool auth (existing) |

Equivalent inputs ⇒ identical rows written, identical broadcast, identical
response semantics (FR-022). The only permitted difference is the acting
identity.

## Undo interaction (FR-021)

No new machinery. The restore's `agent_edits` row makes it a normal 016 undo
target for its identity: surgical inverse as a forward update, later edits
preserved, superseded content skipped, fully superseded ⇒ honest "nothing left
to undo", redo = invert the inverse. Verified by tests (fresh / partial /
full-supersession / redo matrix), not by new code.
