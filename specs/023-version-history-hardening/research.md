# Research: Version History Hardening (023)

All unknowns are resolved against the current tree (2026-07-19, post-hotfix-bundle
bf849ed..4022c93) and the two ratified design amendments in
`design/collaboration-core.md` (commit db85ee7). No external/library research was
required; every decision below is a mechanism choice the amendments explicitly left
to the plan phase, or a composition detail discovered by reading the code.

---

## R1: Write-serialization mechanism (FR-001..006, D-1, D-8, D-9)

**Decision**: Two composed layers, both inside `PostgresPersistence.storeUpdate`
(server/postgres-persistence.js):

1. **Per-document in-process FIFO queue** — a `Map<docGuid, tailPromise>` promise
   chain in the persistence layer. Every pool-client `storeUpdate` call enqueues its
   entire critical section (transient-retry loop + clock acquisition + insert) as one
   queue slot. The map entry is deleted when the tail settles and the chain continues
   after a rejected slot (error isolation), so a poisoned update never wedges the
   queue (D-9).
2. **Postgres advisory transaction lock** as the cross-instance clock-acquisition
   backstop — the insert runs in a short transaction that first takes
   `SELECT pg_advisory_xact_lock($NS, hashtext(doc_guid))` (fixed int namespace
   constant + hashed guid; hash collisions merely over-serialize, never corrupt).
   The lock releases at COMMIT/ROLLBACK automatically — no leak path.

The existing `ON CONFLICT (doc_guid, clock) DO NOTHING` + MAX+1 retry loop is
**retained** as belt-and-suspenders: during the rolling-deploy window old pods write
without the lock (D-8), and the retry loop is what makes the new mechanism tolerate an
unserialized peer with today's exact failure semantics.

**Transient-failure retry moves inside the queue slot.** Today `bindState`
(server/index.js ~260-279) wraps `storeUpdate` in `retryWithBackoff`; a transiently
failing update would re-enter the new queue *behind* later-produced updates and invert
clocks — the exact bug this feature kills. So the backoff retry (3 attempts,
exponential + jitter — same constants) becomes part of the queued task inside
`storeUpdate`, and `bindState` calls `storeUpdate` directly. The promise `bindState`
registers in `pendingWrites` settles only after the queue slot completes, so the
graceful-shutdown flush covers queued-but-not-started writes with zero changes
(FR-006). Terminal failure still rejects out to bindState's `.catch` → CRITICAL log +
`notifyException` (FR-004); the queue proceeds to the next slot (D-9).

**The 016 claim-transaction composition (FR-003)**: `finalizeClaim`
(server/undo/edit-records.js:205) invokes `storeUpdate` with an `externalClient`
inside its own open `BEGIN..COMMIT`. That path **bypasses the in-process queue** and
relies on the advisory xact lock alone, taken on the caller's client inside the
caller's transaction:

- *No deadlock*: lock acquisition order is strictly unidirectional — finalizeClaim
  takes the `agent_edits` row lock (claim UPDATE) first, then the advisory lock;
  ordinary writers take only the advisory lock and never touch `agent_edits`. Two
  concurrent claims serialize on the row UPDATE before either reaches the advisory
  lock. No cycle exists.
- *No starvation*: the claim holds the advisory lock only from the `storeUpdate` call
  to COMMIT (one INSERT + one small UPDATE) — milliseconds. Ordinary updates queue
  briefly behind it, in order.
- *Ordering*: the inverse is computed from the durable log (undo reads committed
  rows), so any fresh MAX+1 clock acquired under the lock is causally after
  everything it inverts. The inverse row participates in the same guarantee.
- *Why not run it through the process queue too*: the queue slot would be held across
  a caller-owned transaction whose duration storeUpdate does not control; bypassing it
  removes that coupling, and the advisory lock alone already gives the claim path
  atomic clock acquisition against every writer on every instance.

**The honest cross-instance story (D-1)**, to be stated in code comments and README:

- The **actual observed hazard** is same-instance: one client's rapid updates through
  one socket produce many fire-and-forget persists racing MAX+1. The process queue
  serializes exactly that causal chain in production order.
- **Cross-instance causal chains** (client produces U1 on instance A, reconnects,
  produces U2 on instance B while A's persist is in flight) are covered by Yjs
  sync semantics, not by any lock: B can only accept U2 after the reconnect sync
  integrates the client's state — which *contains* U1 — and B persists that missing
  state through its own ordered queue **before** U2. Content-causality is therefore
  preserved on B's stream. If A's original in-flight row later lands at a higher
  clock, it is a content-duplicate (Yjs apply is idempotent) — every replayed state
  remains a state that actually existed (SC-001).
- The **advisory lock** removes the remaining cross-instance clock-acquisition race
  (two instances reading the same MAX simultaneously), so causally concurrent
  cross-instance writes take distinct clocks in a single attempt; either order is
  correct for true CRDT concurrency (D-1).

**Alternatives considered**:
- *Advisory lock only* — rejected: the lock serializes clock acquisition but grants in
  arrival order at Postgres, not production order; two in-flight persists from one
  socket can still acquire it inverted. It fixes the race's symptom (conflict
  retries), not the ordering hazard.
- *In-process queue only* — rejected: leaves the cross-instance MAX+1 acquisition race
  (conflict-retry churn, and D-1's ratified stance is that the lock is the queue's
  cross-instance backstop).
- *Redis-based distributed lock* — rejected: new failure domain, fail-open semantics
  under Redis loss, and Postgres already provides exactly this primitive on the
  connection doing the write.
- *SERIALIZABLE transactions / sequence per doc* — rejected: per-doc sequences are DDL
  per document; serializable retries reintroduce the reordering under contention.

## R2: Gap-tolerance shape — funnel, not per-reader copies (FR-007..010, D-2)

**Decision**: One private gap-tolerant row fetcher in `PostgresPersistence`:

```
async _fetchRowsWithGapRetry(client, sql, params, label) -> { rows, gapped, retries }
```

It owns the 021 loop verbatim (contiguity via the existing `_findFirstGap`, budget
from the **shared** `COLLAB_READ_GAP_RETRIES` / `COLLAB_READ_GAP_RETRY_DELAYS_MS`
knobs — no new per-path configuration, FR-008), and emits the 021-format structured
warn line tagged with `label` when a read is served gapped (FR-010). Every
`yjs_updates` reader funnels through it:

| Reader | Today | After |
|---|---|---|
| `getYDoc` (full rebuild) | own 021 loop | refactored onto the fetcher (behavior identical) |
| `getYDocAtClock` (point-in-time) | raw fetch | fetcher (`clock <= $2` slice) |
| `_queryUpdatesWithUsers` → `getUpdatesWithUsers`, `getUpdatesInRange`, `getRecentUpdatesWithUsers` | raw fetch | fetcher (timeline metadata, drill-down, undo log load) |
| Diff service row fetch (diff-service.js:56-59) | own inline SQL on its own pool | replaced by new `persistence.getUpdateRowsUpTo(docGuid, clock)` built on the fetcher; returns the `gapped` flag |
| Undo inverse log load (`undo-service.js` `loadLog`) | `getUpdatesInRange` | inherits the fetcher via `getUpdatesInRange`, which now surfaces `gapped` |
| Classification backfill (new) | — | uses the fetcher; skips-and-resumes a doc still gapped |

After this, the "single choke point" comment on `getYDoc` is rewritten to name the
fetcher as the choke point — making the claim true (FR-007's closing requirement).

**Still-gapped behavior split by consequence (D-2, FR-009)**:
- *Serving-only* (`getYDoc` live load, version preview/`getYDocAtClock`, timeline
  metadata): serve as-is with the warn line — 021 semantics, unchanged.
- *Diff service*: computes and **serves** the diff but **skips the Redis cache
  write** when `gapped` is true (the next request recomputes from a healed log).
  Gap-free requests cache exactly as today.
- *Undo inverse*: a still-gapped log load **aborts the undo observably** (error
  result, no claim attempted) — an edit-record transition and inverse row are stored
  artifacts and must never derive from a torn read.
- *Backfill*: never writes classifications from a gapped fetch — logs, skips the doc,
  and the next (idempotent) run picks it up.
- *Named-version creation*: after R6 it stores no content at all, so nothing to
  freeze (the strongest possible fix).

**Retry-storm check (US2 AS4)**: reader budget is bounded (default 2 retries,
100/300ms waits); the writer holds the advisory lock for single-digit milliseconds;
worst interaction is one extra bounded wait. No amplification path exists.

**Alternatives considered**: per-reader copies of the loop — rejected: five diverging
copies of retry/logging logic is how the current "only getYDoc is covered" state
happened. Funneling makes coverage structural.

## R3: Classification storage + write-time computation (FR-015, FR-018, D-3)

**Decision**: nullable `meaningful BOOLEAN` column on `yjs_updates` (migration R9-1).
`NULL` = unknown ⇒ **treated as meaningful at every read** (fail-visible, D-3). No
side table: the timeline reads these exact rows already; a join buys nothing.

**Classifier parity**: the classification is the same predicate
`filterMeaningfulUpdates` applies today — "did `extractXml(doc)` change?" (note:
XML string, not plain text — formatting-only edits count as meaningful today and must
keep doing so, FR-015). Extracted into a new shared module
`server/update-classifier.js`:

- `classifyByXml(prevXml, nextXml) -> boolean`
- used by the write path (below) and the backfill (R5), so write-time and replay-time
  classification cannot drift.

**Write-time computation site**: the `bindState` update listener (server/index.js
~251) — the one place with the live before/after context the amendment names. It
keeps the doc's last-known XML on the ydoc instance (`ydoc._lastClassifiedXml`,
initialized lazily on first update from the pre-update state? No — the listener fires
*after* the update applies, so it initializes at bind time right after the DB load
completes, and on the very first listener firing before initialization it degrades to
`null`/unknown). Per update: `extractXml(ydoc)` → compare with the stored value →
pass `meaningful` into `storeUpdate` → store the new XML. Listener invocations are
synchronous in production order, and the queue (R1) preserves that order to the rows.
Any classifier throw degrades to `null` + a log line and never touches the
persistence result (FR-018).

Cost note: one `extractXml` per persisted update — the exact per-update cost the
timeline currently pays *per request over the whole log*; paying it once at write
time is the amendment's stated trade.

**`storeUpdate` signature**: appends an options object —
`storeUpdate(docGuid, update, userId, agentName, onBehalfOf, externalClient, { meaningful = null } = {})`.
Direct callers that are meaningful by construction pass `true` (restore's replace
update, the undo/redo inverse via `finalizeClaim`); all other callers (import,
sync-push, tests) default to `null` ⇒ meaningful at read — never hides a real edit.

**Alternatives considered**: computing in `storeUpdate` by replaying the log before
each insert — rejected: O(log) work per write defeats the purpose; the listener has
the state for free. Side table — rejected: extra join, same rows, no isolation win.

## R4: O(rows) timeline (FR-016, FR-019)

**Decision**: `_queryUpdatesWithUsers` adds `u.meaningful` to its SELECT.
`getVersionTimeline` (version-history.js:504) replaces the
`filterMeaningfulUpdates` replay call with an in-memory filter
`rows.filter(r => r.meaningful !== false)` (NULL ⇒ kept, D-3), then groups exactly as
today. `filterMeaningfulUpdates` is deleted (its only caller is the timeline).
`totalEdits` = filtered count (parity). Versions whose range is all-noise never form
(grouping runs on the filtered set — FR-019 automatic). `getVersionContent`'s
auto-version metadata grouping applies the same filter for parity. MCP
`list_document_versions` inherits all of this (it calls `getVersionTimeline`);
its pagination cost becomes independent of document content size (US4 AS4).

No index changes: the timeline query is already `WHERE doc_guid ORDER BY clock` on
the same rows.

## R5: Classification backfill (FR-017, D-3)

**Decision**: `server/scripts/backfill-meaningful-classification.js`, following the
established `server/scripts/backfill-search-index.js` pattern (standalone script,
PostgresPersistence, statement-timeout opt-out). Algorithm:

1. `SELECT DISTINCT doc_guid FROM yjs_updates WHERE meaningful IS NULL`.
2. Per doc: gap-tolerant full-log fetch (R2 fetcher). If still gapped → log, skip doc
   (next run heals it).
3. Replay once with `update-classifier` (same predicate as the write path), batch
   `UPDATE yjs_updates SET meaningful = v.m FROM (VALUES ...) WHERE ... AND meaningful IS NULL`.
4. Idempotent + resumable by construction: the classifier is deterministic, selection
   is NULL-only, and a doc interrupted mid-update just reruns. Rows written by old
   pods during the deploy window are NULL and get swept by a later run (D-8) —
   harmless either way because NULL reads as meaningful.

## R6: snapshot_data drop — replay is the sole source (FR-011..013, D-6)

**Decision**:
- `createNamedVersion` (postgres-persistence.js:676) stops replaying
  (`getYDocAtClock`) and stops encoding a snapshot — it becomes a plain INSERT of
  (doc_id, name, clock_start, clock_end, created_by). Its one content-bearing write
  path disappears, so named-version creation can no longer freeze anything (FR-011).
- `getVersionContent` (version-history.js:590-597) drops the `snapshot_data` branch —
  every named version resolves through the range-checked `getYDocAtClock` replay,
  which is gap-tolerant after R2 (FR-012). Pre-023 rows need no backfill; a diverged
  frozen blob heals silently to the replayed truth (D-6, ratified).
- Migration R9-2 drops the column; every label field survives untouched (FR-013).
- `canReconstruct` (import path) and the append-only log are untouched (FR-014).

## R7: Restore as a first-class undoable edit (FR-020..024, D-4, D-5)

**Decision** — `restoreVersion` (version-history.js:662) stays the single shared core
behind both surfaces and gains three things:

1. **Edit record (FR-020, D-4)**: after the single `storeUpdate` (passing
   `meaningful: true`), call `editRecords.recordEdit` with
   `{ docGuid, userId, agentName: agentName ?? '', clockStart: newClock, clockEnd: newClock, clocks: [newClock] }`.
   - `agent_edits.agent_name` is `text NOT NULL` (migration 1796000000000), so the
     **human-restore identity uses the empty string `''` as the no-agent value** —
     documented in data-model.md. This keeps every existing identity query
     (`agent_name = $3`) and the identity-unique constraint working with zero schema
     change and zero NULL-distinctness surprises. Undo targeting is unchanged 016
     scoping: a chat/MCP restore records under the acting agent's name and that
     surface's Undo inverts it; a human UI restore is recorded under `''` and becomes
     invertible the moment any surface targets that identity (D-4's explicit stance).
   - recordEdit failure logs and does not fail the restore (matches modify's
     posture); the restore stands, undo finds nothing and reports honestly.
2. **Broadcast without silent skip (FR-023, D-5)**: extract the H1-reviewed
   `applyToLiveDoc` from `server/undo/undo-service.js` into a shared
   `server/live-apply.js` — `applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid, update, origin, label)`:
   apply to the in-memory shared doc when loaded (its attached redis handler fans
   out); otherwise publish via `redisPubSub.publishUpdate` so instances holding the
   doc apply it; when neither is possible (Redis-less, doc loaded nowhere — nobody is
   connected anywhere) emit an observable warn, never silence. `restoreVersion` calls
   it with `ORIGIN_RESTORE`; `undo-service` switches to the shared module (behavior
   identical).
3. **Surface convergence (FR-022)**: the REST route (index.js:1364) and the MCP tool
   (mcp/tools/restore-document-version.js) both pass the same deps
   (`documentService.getSharedDoc`, `redisPubSub`) and differ only in identity
   (`agentName: null` vs `agentToken.agentName`). The MCP tool **stops** using its
   presence-session provider doc as the broadcast vehicle (session stays for
   ACL/presence via `getOrCreateSession(requiredRole: 'editor')`); both surfaces
   return the same `{ success, newClock, message }` contract and the same typed
   `VersionNotFoundError` mapping.

**Single-persist (FR-024)**: not re-implemented — a regression test asserts exactly
one `yjs_updates` row (and one edit record) per restore, on both surfaces, with the
ORIGIN_RESTORE sentinel still skipping the bindState persistence listener.

**Undo semantics (FR-021)**: no new machinery — the restore row is a normal forward
update; `computeInverse` inverts its insertions/deletions under existing 016
supersession rules. Needs tests (fresh restore, partial supersession, full
supersession, redo-after-undo), not code.

## R8: Dead-code deletion + yjs_state_vectors drop (FR-025..026)

Re-verified 2026-07-19 against the tree — no live callers outside definitions/tests:

- `enrichVersionsWithMetadata` + `extractMetadata` (version-history.js:345-444; not
  even exported).
- `getYDocWithHistory`, `getStateVectorsAtClocks` (postgres-persistence.js:564-620).
- `DiffService.invalidateCache` (diff-service.js:236-251).
- `client/src/extensions/YChangeExtension.js` — zero imports anywhere in client/src
  (grep confirms; editorExtensions.js does not reference it). Deletion only —
  coordinated with the 024 client-only agent, which does not touch this file.
- `yjs_state_vectors` writers: `storeUpdate` first-update branch
  (postgres-persistence.js:139-149), `clearDocument` (:314), `clearAll` (:339),
  onboarding welcome-doc reset (onboarding.js:154). All removed; document birth is
  just the first `yjs_updates` row (the table was write-once-never-read, so no read
  path changes). Migration R9-3 drops the table.

## R9: Migrations (FR-027, D-7)

Current max is `1798000000000_chunk-structure-columns.js`. Feature 023 is the sole
in-flight migration-adding feature. Three migrations, all > 1798000000000 and
ordered by dependency:

| # | File | Up | Down |
|---|---|---|---|
| R9-1 | `1799000000000_add-meaningful-to-yjs-updates.js` | `ALTER TABLE yjs_updates ADD COLUMN meaningful boolean` (nullable, no default, no backfill in-migration) | drop column |
| R9-2 | `1799100000000_drop-version-snapshot-data.js` | `ALTER TABLE document_versions DROP COLUMN snapshot_data` | re-add nullable `bytea` (content unrecoverable by design — replay is truth) |
| R9-3 | `1799200000000_drop-yjs-state-vectors.js` | `DROP TABLE yjs_state_vectors` | recreate table shape (empty) |

Kept separate (D-7 allows combining, but separate files keep each `down` honest and
let R9-1 ship ahead of the code that reads it if ever needed). All clear the
1795000000000 phantom-row floor and the 1796* undo migrations by construction.
