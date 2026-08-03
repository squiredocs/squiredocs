# Contract — `restoreVersion` unified path (`server/version-history.js`)

Signature unchanged:
`restoreVersion(persistence, docGuid, versionId, userId, { getSharedDoc, redisPubSub, agentName })`
(`getSharedDoc` dep remains the NON-CREATING peek, as wired since 041/046).

## The one path (FR-004, RBD-048-2)

1. **Reads & refusal (unchanged)**: target version content and current state
   via `persistence.getYDoc(docGuid, { withGap: true })`; if either read is
   still gapped after the retry budget → `DocumentSyncingError`, no row, no
   record (F3 fail-closed posture, byte-identical).
2. **Seed selection**: peek the live doc; if `isTrustedLiveDoc(liveDoc)`
   (bind complete AND ≥1 live connection — predicate unchanged,
   `server/live-doc-trust.js`) the seed is `Y.encodeStateAsUpdate(liveDoc)`;
   otherwise the seed is the persisted `currentYdoc`'s state, with the
   existing `untrustedReason` warn log retained.
3. **Compute (one shape for both cases)**: fresh ephemeral `Y.Doc` → apply
   seed → `svBefore = encodeStateVector` → `transact(applyRestoreTo)` →
   `restoreUpdate = encodeStateAsUpdate(eph, svBefore)` → destroy. This is
   today's durable-log path generalized; the no-change restore still encodes
   the empty transition (identical stored-row/`newClock` semantics).
4. **Store FIRST**: `storeUpdate(docGuid, restoreUpdate, userId, agentName,
   null, null, { meaningful: true })` → `newClock`. Then the unchanged
   agent-only `editRecords.recordEdit` (non-fatal on failure, unchanged).
5. **Broadcast (one call, both cases)**:
   `applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid, restoreUpdate,
   ORIGIN_RESTORE, 'Restore')`. Loaded here → applies to the live doc (which
   did NOT run the transaction) + fan-out via attached handler or explicit
   publish (H1 guard inside `applyLiveUpdate`); not loaded → Redis publish;
   neither → the never-silent warn (D-5). Non-fatal throughout: the row is
   already durable.

## Deleted (the live-path capture machinery)

- The `liveDoc.transact(applyRestoreTo, ORIGIN_RESTORE)` live-path branch.
- `captureHandler`, live-doc `stateVectorBeforeRestore`, `liveCapture`.
- The `publishIfUnhandled` branch (and its now-unused import in this file).

## Preserved semantics (assertable)

- One attributed row; **stored bytes === broadcast bytes** (041 invariant —
  they are literally the same `restoreUpdate` reference).
- The row's insert set carries the EPHEMERAL doc's fresh clientID — never the
  shared doc's (guard suite covers `restoreVersion` explicitly, FR-007a).
- Non-destructive restore semantics (`replaceFragmentContents`, DEC-9) —
  unchanged, only WHERE it runs moved.
- MCP (agent) restores remain undoable; human web-UI restores remain
  non-undo-targets (recordEdit gating unchanged).
- Cross-pod restore serialization posture unchanged (RBD-041-2 residual 1 —
  kept verbatim in the corrected comment).

## Accepted consequences (RBD-048-2 — pinned in tests, not "fixed")

- Crash window flips to **commit-without-broadcast**: a crash after
  `storeUpdate` and before `applyLiveUpdate` leaves the durable row to replay
  on next load — nothing lost (the safer half).
- An edit landing during the store await **merges with** the restore instead
  of being replaced — the durable path's and cross-pod restores' existing
  semantics, now uniform.

## Comment corrections in the same file (FR-011)

The "WHERE THE STORED DELTA COMES FROM" header block and "DOCUMENTED
RESIDUALS" item 2 (broadcast-then-store ordering) are rewritten to the
unified store-then-apply account; residual 1 (RBD-041-2) is kept.
