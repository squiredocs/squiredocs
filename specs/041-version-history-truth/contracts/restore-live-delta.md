# Contract: Restore Read/Write Honesty (FR-011, FR-012, FR-013)

## Target read (FR-012)

- `getYDocAtClock(docGuid, clock, { withGap, expectedTailClock })` — NEW option
  `expectedTailClock`, forwarded to `_fetchRowsWithGapRetry` (same semantics as
  `getUpdateRowsUpTo`): `gapped === true` now means interior gap OR the read did
  not reach `expectedTailClock` (short tail).
- `getVersionContent(..., { withGap: true })` (the restore path) passes
  `expectedTailClock: clockEnd`. Guaranteed safe against the CD-5/G5 sentinel
  hazard: `clockEnd` is validated against the document's real min/max BEFORE
  the read, so it is always a committed clock. Serving-only callers never pass
  it (unchanged).
- Restore's existing refusal (`DocumentSyncingError` → REST 503 / MCP teaching
  error; nothing stored) now fires on a short tail too.

## Delta construction (FR-011)

| Doc state (THIS instance) | Path |
|---|---|
| Loaded (honest peek hits) | Transaction ON the live doc under `ORIGIN_RESTORE`: delete-and-reclone replace (existing shape), transaction bytes captured origin-scoped; captured bytes = the stored row (`storeUpdate`, `meaningful: true`). Fan-out via the doc's own handlers (y-websocket broadcast; Redis handler if attached — `ORIGIN_RESTORE` is not on the publish skip-list); `publishIfUnhandled` covers a handler-less doc. No `applyLiveUpdate` call (would double-apply). Persistence listener skips `ORIGIN_RESTORE` (sentinel) — exactly one row. |
| Not loaded here | Existing path unchanged: Postgres current-state read → tempDoc delta → `storeUpdate` → `applyLiveUpdate` (cross-instance publish / honest no-delivery warn). |

Guarantee: when the doc is live on the serving instance, the stored restore row
is byte-for-byte the transition applied to the live doc — concurrent live edits
serialize against the transaction instead of interleaving invisibly between a
stale read and the store.

**Documented residuals** (in `restoreVersion`'s header comment):
1. Cross-pod: a doc loaded ONLY on another instance takes the not-loaded path;
   restore-vs-writes serialization across pods is out of scope (RBD-041-2).
2. Live-path ordering is broadcast-then-store — the same publish-before-commit
   window every normal edit has (038 FR-018, accepted; B1 stays closed).

## Honest is-loaded probe (FR-013)

- NEW `documentService.peekSharedDoc(docGuid)`: returns the y-websocket
  `docs.get('s/' + docGuid)` entry or `null`. NEVER creates, never triggers
  bindState.
- Switched to the peek: `restoreVersion` deps (REST route index.js:1531 + MCP
  tool), `undo-service.resolveDeps` default `getSharedDoc` (liveDoc merge +
  applyLiveUpdate deps).
- Explicitly NOT switched: `updateDocument`/`getSharedDoc` for agent modify &
  imports (creating is that path's contract) and the WS connection setup
  (`setupWSConnection` already created the doc).
- Post-condition (SC-009): a restore/undo/redo of a document loaded nowhere
  leaves the `docs` map size unchanged — no doc created, nothing to evict, no
  leak. `applyLiveUpdate`'s not-loaded branches become genuinely reachable.

## Attribution & undo (unchanged — design amendment 2026-08-02)
- Human web-UI restore: `yjs_updates` row under the human, NO `agent_edits`
  row, not an undo target.
- Agent/MCP restore: recorded under the acting agent (`recordEdit`), undoable by
  that agent's own undo tool. This feature does not touch that gate.
