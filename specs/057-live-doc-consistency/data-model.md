# Data Model: 057-live-doc-consistency

No schema changes (research R11). All new state is in-memory, per-process,
cache-only (Constitution VII: loss degrades honestly — re-verify from
Postgres). Existing durable entities are consumed, not modified.

## Durable entities (existing, read-only for this feature)

### yjs_updates (durable update log)
- `doc_guid`, `clock` (unique per doc, contiguous in an intact log post-023;
  clock order = causal order), `update_data` (Yjs update bytes), attribution
  columns. Append-only; the single source of durable truth.
- New access pattern: `getNewestClocks(docGuids)` — one batched
  `SELECT doc_guid, MAX(clock) ... WHERE doc_guid = ANY($1) GROUP BY doc_guid`
  (periodic check, FR-006). Existing `getClockRange`, `getUpdatesInRange
  (includeData: true)`, `getYDoc` (gains `expectedTailClock` passthrough).

## In-memory state (new)

### Verified integrated clock — `ydoc._verifiedClock` (number)
- Lives on served Y.Doc instances (registry docs and agent-session docs).
- **Invariant**: the doc's state vector covers every durable row with
  `clock <= _verifiedClock`, contiguously. Never advanced on trust —
  only on proof:
  - bind success: set to the pre-fetch captured tail (`maxClock ?? -1`),
    valid because the bind refused unless the load reached that tail;
  - reconcile pass: advanced to the tail of fetched-and-applied rows after
    coverage confirms;
  - read-path verification: advanced by SV-coverage over the fetched
    unverified suffix.
- **Never advanced by**: Redis fan-out application (messages carry no clock,
  research R2), local edits awaiting persistence.
- Monotone non-decreasing for the life of the doc instance. Absent/undefined
  ⇒ treat as “nothing verified” (fresh session docs start unverified; reads
  verify from the suffix they fetch).

### Bind trust flag — `ydoc._bindComplete` (existing, semantics narrowed)
- After this feature it is only ever set over a **verified-complete** load
  (tail captured before fetch; gap/short ⇒ refused, flag never set).
  `_bindFailed` unchanged. `isTrustedLiveDoc` consumers unchanged.

### Reconciler state (module-scoped, `server/collab-reconcile.js`)
- interval handle (started at boot, stopped via shutdown drain);
- `COLLAB_RECONCILE_INTERVAL_MS` knob (default 30000, validated parse);
- per-tick working set: bound registry docs (`_bindComplete` true,
  `_bindFailed` absent). No cross-tick memory required; no per-doc timers.

### Readiness gate condition (agent-presence, per session creation)
- Arm-time capture: `C` = newest durable clock (null ⇒ resolve immediately).
- Stage 1: registry doc `_verifiedClock >= C` → capture target SV from
  registry doc. Stage 2: session doc SV dominates target SV → resolve.
- Timeout (10s) and DB-error fallback (2s) unchanged. Both stages monotone.

## Response shape (additive, RBD-057-6)

`read_document` current-content result:
- `clock` (existing field, now honest): the served content's verified
  integrated contiguous clock.
- `newestClock` (new, only when `> clock`): newest known durable clock from
  this call's own query.
- `stale: true` (new, only alongside `newestClock`).
- `stalenessNote` (new, human-readable one-liner, only when stale).
- Absent fields ⇒ current. No field changes meaning or disappears.

## Telemetry counters (new/extended, OTel via telemetry/metrics.js)

| Counter | Labels | Incremented when |
|---|---|---|
| `collab.read.gapped_serves` | `gap.reason`: `gap` \| `short-tail` \| `gap+short-tail` | the 021 choke point (`_fetchRowsWithGapRetry`) serves an incomplete row set after its retry budget — central, covers every log-rebuild reader |
| `collab.read.stale_serves` | — | a `read_document` serve carries the staleness indicator |
| `collab.bind.refusals` (existing) | `refusal.reason`: `load-error` \| `incomplete-load` | refuseBind runs; reason distinguishes 041 load failures from 057 incomplete loads |
| `collab.reconcile.repairs` | — | a reconcile pass applied ≥ 1 row the doc's state vector did not already cover |

## State transitions

```text
BIND:    capture tail → fetch(withGap, expectedTailClock)
           ├─ complete → apply(ORIGIN_DB_LOAD) → _verifiedClock=tail → _bindComplete=true
           └─ incomplete after budget → refuseBind('incomplete-load') → evict; no flags set

SERVE:   newest ≤ verified → label=verified (no staleness fields)
         newest > verified → fetch suffix bytes → SV-coverage advance
           ├─ verified reaches newest → label=newest, no staleness fields
           └─ still behind → label=verified, stale fields, counter, fire reconcileDoc

RECONCILE (tick | post-subscribe | subscriber-ready | stale serve):
         newest ≤ verified → no-op (no row fetch on the tick path)
         newest > verified → fetch suffix → apply(ORIGIN_DB_LOAD) → verify → advance
           └─ any previously-uncovered row applied → repairs counter

READY:   C=null → resolve
         registry._verifiedClock ≥ C → target=SV(registry) → sessionSV ⊇ target → resolve
         10s timeout → resolve (unchanged semantics)
```
