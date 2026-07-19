# Contract: Persistence Write Serialization & Gap-Tolerant Reads (023)

Internal module contract for `server/postgres-persistence.js` consumers.
Requirements: FR-001..010, FR-015..018. Decisions: research R1/R2/R3.

## storeUpdate

```js
async storeUpdate(
  docGuid, update, userId = null, agentName = null, onBehalfOf = null,
  externalClient = null,
  { meaningful = null } = {}          // NEW: true | false | null(unknown)
) -> number  // the assigned clock
```

### Ordering guarantees
1. **Pool-client calls (externalClient == null)** enter the per-document FIFO
   queue. For any two calls A then B on the same process and doc where B is
   issued after A (production order), B's clock > A's clock — including when A
   retries transient failures (the backoff retry runs *inside* A's queue slot).
2. **Clock acquisition is cross-instance atomic**: MAX+1 + INSERT run in a short
   transaction holding `pg_advisory_xact_lock(NS, hashtext(docGuid))`. The
   `ON CONFLICT DO NOTHING` retry loop is retained solely for unserialized peers
   (rolling-deploy window, D-8).
3. **externalClient calls (016 claim path)** bypass the process queue; the
   advisory lock is taken on the caller's client inside the caller's open
   transaction and held to COMMIT. Composition guarantees: no deadlock (lock
   order agent_edits-row → advisory is unidirectional; ordinary writers never
   touch agent_edits), no starvation (lock hold ≤ one INSERT + one UPDATE), and
   the inverse row receives a clock causally after everything it inverts.

### Failure semantics (unchanged externally)
- Terminal failure rejects to the caller (bindState: CRITICAL log +
  notifyException). The queue continues with the next slot — one poisoned update
  never wedges the document (FR-004, D-9).
- The promise returned to bindState settles only after the queue slot completes,
  so the existing `pendingWrites` graceful-shutdown flush covers
  queued-but-not-started writes with no changes (FR-006).

### Classification
- `meaningful` is persisted verbatim (`null` allowed). It never affects success:
  classification errors upstream degrade to `null` before reaching storeUpdate
  (FR-018). Callers passing `true` by construction: restoreVersion,
  finalizeClaim (inverse). bindState passes the computed value from
  `server/update-classifier.js`.

## Gap-tolerant read funnel

```js
// private choke point — every yjs_updates reader goes through it
async _fetchRowsWithGapRetry(client, sql, params, label)
  -> { rows, gapped: boolean, retries: number }
```

- Contiguity check: existing `_findFirstGap` (within fetched rows only).
- Budget: shared 021 knobs `COLLAB_READ_GAP_RETRIES` (default 2) and
  `COLLAB_READ_GAP_RETRY_DELAYS_MS` (default `100,300`). **No new knobs** (FR-008).
- Gap-free reads: identical behavior/latency to today + one integer pass (FR-008).
- Observability (FR-010): on gapped serve, one structured warn in the 021 format:
  `[Postgres] <label> <docGuid>: served with clock gap (retries=…, rows=…, firstGapAfterClock=…)`.

### Covered readers and still-gapped behavior (FR-007, FR-009, D-2)

| Reader | Method | Still-gapped after budget |
|---|---|---|
| Full rebuild | `getYDoc` | serve as-is + warn (021, unchanged) |
| Point-in-time | `getYDocAtClock` | serve as-is + warn (preview is serving-only) |
| Metadata/log reads | `_queryUpdatesWithUsers` (`getUpdatesWithUsers`, `getUpdatesInRange`, `getRecentUpdatesWithUsers`) | return rows + expose `gapped` to callers that produce artifacts |
| Diff rows | **NEW** `getUpdateRowsUpTo(docGuid, clock)` → `{ rows, gapped }` | DiffService serves the diff but **skips the cache write** |
| Undo inverse log | `loadLog` via `getUpdatesInRange` | undo-service **aborts before any claim** with an observable error — no edit-record transition, no inverse row |
| Backfill replay | script uses the funnel | skip the doc + log; next idempotent run heals |

After this feature the `getYDoc` "single choke point" comment is rewritten to name
`_fetchRowsWithGapRetry` as the choke point — the claim must be literally true
(FR-007).

### Removed from this module (FR-025/026)
`getYDocWithHistory`, `getStateVectorsAtClocks`, and every `yjs_state_vectors`
statement (first-update INSERT, clearDocument/clearAll DELETEs).
`createNamedVersion` no longer replays or stores content (pure label INSERT).
