# Research: 057-live-doc-consistency

All Technical Context unknowns resolved. Each decision below is grounded in a
read of the current code (paths/lines verified 2026-08-12) and the ratified
design amendment (`design/collaboration-core.md`, "Amendment (2026-08-11) —
memoized readers do not self-heal").

## R1 — One-source clock label: verify by state-vector coverage, not by fence and not by bookkeeping alone

**Decision**: `read_document` labels the served content with the highest clock
N such that the served doc's Yjs state vector covers every durable row ≤ N
(contiguously). Mechanism: keep a per-doc memo `_verifiedClock` (starts at the
bind-verified tail); on each read, take the newest durable clock from the
row query the read already performs; when newest > verified, fetch only rows
in `(verifiedClock, newest]` **with bytes** (`getUpdatesInRange(..., {
includeData: true })`) and check each row's write set
(`Y.encodeStateVectorFromUpdate`) against the served doc's state vector
(`Y.encodeStateVector`), advancing the memo as far as coverage stays
contiguous. Label = the advanced verified clock. No blocking fence, no wait.

**Rationale**:
- RBD-057-1 ratifies label-not-fence. But bookkeeping alone (advance only on
  bind/reconcile/local-persist) cannot satisfy FR-001's "MUST be the highest"
  nor the "no spurious staleness marker" edge case: Redis fan-out messages
  carry raw update bytes with **no clock** (`server/index.js:2148-2153`,
  `server/redis-pubsub.js`), so a pod that is perfectly current via fan-out
  would still look behind to a pure ledger and emit a false staleness marker
  on every cross-pod live read. SV-coverage verification proves integration
  without trusting delivery.
- Cost profile: zero extra queries when verified == newest (idle steady
  state); when behind, one bounded fetch of only the unverified suffix plus a
  per-row SV decode (small, CPU-only). The newest-clock signal rides the
  `getRecentUpdatesWithUsers` query the read path already issues
  (`server/mcp/tools/read-document.js:139`).
- The served content is the **agent-presence session doc**
  (`session.provider.doc`, read-document.js:111), one ws hop from the registry
  doc — so verification MUST run against the session doc's own state vector,
  and `_verifiedClock` memoizes per served doc, not per registry doc.

**Alternatives considered**:
- *Blocking fence against DB max clock*: rejected by RBD-057-1 (couples hot
  read latency to repair latency).
- *Capture-then-build per read* (the docs-export precedent,
  `server/api/docs-export.js:243-252`, `getYDocAtClock`): correct but rebuilds
  the doc from the full log on every read — fine for a cold export path,
  wrong for the hot serve-from-memory path. We adopt its **atomicity
  contract** (label exactly what was built/served), not its build strategy.
- *Ledger-only bookkeeping*: rejected — false staleness + under-labels for
  fan-out-current pods (above).

## R2 — Fan-out stays clock-less; reconciliation verifies instead

**Decision**: Do not add clocks to the published Redis payload. The receiving
pod never advances `_verifiedClock` on a fan-out apply; verification happens
on reads (R1) and reconcile passes (R4).

**Rationale**: the publisher runs on the Y.Doc `update` event **before**
persistence assigns the clock (`server/index.js:2193-2209`; storeUpdate
assigns clock async under the 023 advisory lock). Publishing post-commit is
durable-before-broadcast territory — explicitly out of scope (045). A
correlation side-channel ("clock notice") was considered and rejected as new
protocol machinery the design did not ask for; Yjs idempotence makes
verify-and-over-apply free instead.

**Consequence (accepted, recorded)**: for a doc receiving live remote edits,
the periodic check sees `newest > verified` and performs one incremental
fetch of the unverified suffix even though content may already be current;
the rows arrive, coverage is confirmed (usually zero actually-missing), the
memo advances. This is bounded by rows-since-last-verify, not doc size, and
is exactly the same fetch that repairs a genuinely missed message — the two
cases are indistinguishable without clocks on messages, by design. SC-005's
"no-divergence case performs no per-document row fetches" is judged on the
clock comparison (newest == verified ⇒ no fetch), which holds for every idle
doc — the overwhelming steady state.

## R3 — Non-persisting origin: reuse ORIGIN_DB_LOAD, do not touch origin.js

**Decision**: reconciliation applies rows with the existing `ORIGIN_DB_LOAD`
sentinel (`server/origin.js:16`).

**Rationale**: its semantics are exactly what FR-007 requires — `parseOrigin`
returns null so the update listener never persists
(`server/collab-bind-state.js` listener skip; origin.js:135), and
`shouldPublishToRedis` returns false so nothing re-broadcasts
(origin.js:252). It also refreshes the classification baseline the same way
the bind load does. A distinct `ORIGIN_RECONCILE` would require editing
`server/origin.js`, which carries `ORIGIN_SYNC_PUSH` — machinery adjacent to
the sibling feature 056 (`markdown-sync.js`); avoiding that file removes a
parallel-implementation collision surface. Observability comes from the
reconciler's own return values and the `collab.reconcile.repairs` counter,
not origin identity.

**Alternative**: new `ORIGIN_RECONCILE` in origin.js — rejected for the
overlap risk and because it buys nothing the counter doesn't.

## R4 — Reconciler shape: new module `server/collab-reconcile.js`

**Decision**: one new module owning:
- `reconcileDoc(docGuid, ydoc)`: fetch `getUpdatesInRange(verified+1,
  2147483647, { includeData: true })`, apply rows in one transact under
  `ORIGIN_DB_LOAD`, run the R1 coverage check, advance `ydoc._verifiedClock`.
  Counts a **repair** (metric) only when the pre-apply state vector lacked at
  least one fetched row (over-apply/bookkeeping catch-up is not a repair).
  Guards: identity check against the registry (`docs.get('s/'+guid) ===
  ydoc`) and try/catch so a pass racing eviction/destroy is a silent no-op —
  never resurrects a doc, never leaks listeners (spec edge case).
- `startPeriodicCheck({ docs, persistence })`: `setInterval` at
  `COLLAB_RECONCILE_INTERVAL_MS` (default 30000, env-tunable; parser
  validates like `readGapRetryEnv`, postgres-persistence.js:48). Each tick:
  collect bound registry docs (skip `_bindFailed`, require `_bindComplete`),
  issue **one** batched query `getNewestClocks(guids)` (new persistence
  helper: `SELECT doc_guid, MAX(clock) ... WHERE doc_guid = ANY($1) GROUP BY
  doc_guid`), and `reconcileDoc` sequentially for each doc found behind.
  Tick body extracted as a callable `runReconcileTick()` so tests drive it
  without timers (precedent: `evaluateAccessRecheck`, index.js:2042-2049).
  Registered with the shutdown drain like the auth-events purge timer
  (index.js:2299 `stopBackgroundJobs`).
- Runs whether or not Redis is enabled (FR-013 fail-open).

**Triggers wired in**:
1. Periodic tick (above).
2. Per-doc post-subscribe: after `subscribeToDocument` resolves in index.js
   (the call at :2125 is deliberately not awaited — attach `.then(() =>
   reconcileDoc(...))`), closing the bind-to-subscribe blind window.
3. Subscriber (re)connect: `server/redis-pubsub.js` exposes an
   `onSubscriberReady(cb)` hook fired when the subscriber connection is
   (re)established; the reconciler registers reconcile-all-bound-docs.
   (Exact client reconnect event verified at implement time; the module owns
   the subscriber client and its channel set, so the resubscribe point is
   observable there.)
4. Staleness-marked serve (R1): read path fire-and-forgets
   `reconcileDoc` — never awaited on the read path (FR-006 hot-path rule).

## R5 — Bind completeness: capture tail, opt in, refuse with a typed reason

**Decision**: `createBindState` captures `expectedTailClock` **before** the
row fetch via `getClockRange(docGuid)` (postgres-persistence.js:858 — one
extra round trip on the cold bind path), then calls `getYDoc(docGuid, {
withGap: true, expectedTailClock })`. `getYDoc` (:523) gains the
`expectedTailClock` passthrough — same shape `getYDocAtClock` already has
(:1017); `_fetchRowsWithGapRetry` already implements both interior-gap and
short-tail detection (:455-504). A load still incomplete after the existing
retry budget refuses via `refuseBind` with a new `reason:
'incomplete-load'`; success sets `ydoc._verifiedClock = maxClock ?? -1`
before `_bindComplete = true` (trust flag still set last, over a
verified-complete load only). Zero rows ⇒ `maxClock` null ⇒ no tail check ⇒
empty bind completes (US3 scenario 4).

**Refusal paging (RBD-057-3)**: `refuseBind` (bind-failure.js:75) gains a
`reason` (`'load-error'` default — byte-identical 041 behavior — or
`'incomplete-load'`). Incomplete-load refusals do **not** page on the first
occurrence for a doc; a repeat within the existing `PAGE_THROTTLE_MS` window
pages through the existing per-doc throttle map, so persistent gaps
(RBD-057-4 log damage) still reach a human. `recordBindRefusal` gains a
`reason` attribute (2-value cardinality; labelled-counter precedent:
`collab.awareness.blocked`, telemetry/metrics.js:54).

## R6 — Readiness gate: arm on the durable clock, resolve on state-vector domination

**Decision**: `_waitForDocumentContent` (agent-presence.js:352) is replaced
by a monotone two-stage condition. At arm time capture `C` = newest durable
clock (from `getClockRange`; `getUpdateCount`'s role — "is the doc empty" —
is subsumed: no rows ⇒ resolve immediately). The gate resolves when:
(1) the registry doc for the guid (non-creating peek, document-service
precedent :142) has `_verifiedClock >= C` — bind or reconcile has verified
integration of everything counted; then (2) the session doc's state vector
dominates a target captured from the registry doc at that moment. Checks run
on session-doc `update` events plus one immediate check. The existing 10s
timeout and 2s DB-error fallback keep their exact semantics — only the
meaning of "ready" changes (RBD-057-5; SC-007).

**Rationale**: all-in-memory (no per-check queries), monotone in both stages
(later edits only over-satisfy), honest on timeout, and it reuses the
verified-clock machinery instead of counting update *events* (the defect:
`ydoc.once('update', ...)` at :372 resolves on the first event regardless of
the count fetched at :374).

**Alternative**: verify session-doc coverage of rows ≤ C directly by
fetching all row bytes — rejected: O(doc history) per session creation for
what the registry doc already proves in-process.

## R7 — Staleness surface (RBD-057-6)

**Decision**: additive fields on the existing `read_document` result
(read-document.js:162-171): `clock` keeps its position and becomes the
verified integrated clock; when newest durable > verified, add
`newestClock`, `stale: true`, and a one-line `stalenessNote` for rendered
output. A current copy carries none of the new fields. The version-read path
(`readDocumentAtVersion`) is untouched — it builds from the log at a fixed
clock (capture-then-build already).

## R8 — Telemetry counters

**Decision** (mechanism: `server/telemetry/metrics.js` lazy instruments,
OTel counters; test harness `server/__tests__/helpers/telemetry-capture.js`):
- `collab.read.gapped_serves` — incremented centrally in the 021 choke
  point's incomplete branch (`_fetchRowsWithGapRetry`, postgres-persistence.js
  :486-501, today console.warn-only) with a `gap.reason` label, so every
  log-rebuild reader's gapped/short serves are visible — not just
  read_document's (amendment bullet 5).
- `collab.read.stale_serves` — incremented by the read_document path when a
  serve carries the staleness indicator.
- `collab.bind.refusals` — existing counter gains `refusal.reason`
  attribute (`load-error` | `incomplete-load`).
- `collab.reconcile.repairs` — incremented per reconcile pass that applied
  at least one genuinely-missing row.
All swallow-on-error like `recordBindRefusal` (:161-167).

## R9 — Test strategy: reuse the existing multi-instance harnesses

**Decision**: no new harness. Reuse, per suite:
- **Cross-pod fan-out with drop/suppress**: the `MockRedis` + shared
  in-process bus pattern (`__tests__/integration/redis-sync.test.js:18-78` —
  `quit()`/`unsubscribe()` make an instance deaf; self-message filtering
  mirrors real Redis) and the fake-bus queue/flush/reorder controls
  (`server/mcp/__tests__/helpers/fake-claim-redis.js:237-245`).
- **Second-pod apply without a second server**: the `receiveOn(receiver,
  published)` pattern from `server/__tests__/live-fanout.test.js:251-269`
  (apply published buffers with `ORIGIN_REDIS`), plus
  `jest.isolateModules` two-pod loading where module state matters
  (`server/mcp/__tests__/presence-multi-instance.test.js:32-69`).
- **FR-011 livelock regression**: real-DB suite (052 per-worker isolation):
  bind a doc, persist divergent rows directly through a second persistence
  handle (simulating pod A) while suppressing fan-out (redis double,
  `import-presence-doubles.js:30`), assert `modify` refuses with
  content-divergence, run `reconcileDoc`, assert the same `modify` succeeds
  — no conflict-gate change (modify.js:340-357 untouched).
- **SC-005 query-behavior assertion**: spy on persistence methods /
  pool queries during a no-divergence tick — assert exactly one batched
  newest-clocks query and zero `getUpdatesInRange` calls.
- **Counters**: `installCapture()` + `findMetric` per
  `server/__tests__/telemetry-metrics.test.js:105-140`.

## R10 — Feature-boundary check (sibling 056)

056 declares ownership of `server/markdown-sync.js` only (its spec's sole
`server/` reference as of this writing; its plan.md is still template-stage).
057 touches: `read-document.js`, `collab-bind-state.js`, `bind-failure.js`,
`redis-pubsub.js`, `index.js`, `agent-presence.js`, `postgres-persistence.js`,
`telemetry/metrics.js`, new `collab-reconcile.js`, tests, and the FR-012
annotation in `specs/039-diff-cache-integrity/contracts/read-completeness.md`.
No overlap with `markdown-sync.js`. Residual risk: 056 could plausibly touch
`postgres-persistence.js` or `telemetry/metrics.js` (shared infrastructure
files) — flagged in the implement brief so the merge queue watches those two;
057 deliberately avoids `server/origin.js` (R3) to shrink this surface.

## R11 — No schema change

All new state is in-memory (`_verifiedClock`, reconciler timer/state) and
OTel counters. No migrations; the rolled-back-008 migration-number hazard is
moot. (Had one been needed, plan policy was stop-and-report.)
