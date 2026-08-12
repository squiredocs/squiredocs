# Contract: cross-replica reconciliation (FR-005..008, FR-011, FR-013, RBD-057-2)

Surface: new module `server/collab-reconcile.js` (reconcileDoc,
runReconcileTick, startPeriodicCheck/stop), hooks in `server/index.js` and
`server/redis-pubsub.js`, batch helper `getNewestClocks` in
`server/postgres-persistence.js`, `collab.reconcile.repairs` counter.

## Guarantees

1. **Apply-only** (Constitution IV, 021 invariants): a reconcile pass only
   `Y.applyUpdate`s durable rows onto the live doc. It never rebuilds,
   deletes-and-recreates, or mutates the doc toward a reconstruction. The
   y-tiptap editor-binding patches are untouched.
2. **Non-persisting, non-broadcasting**: rows apply under `ORIGIN_DB_LOAD`
   — `parseOrigin` null ⇒ never re-persisted; `shouldPublishToRedis` false
   ⇒ never re-broadcast. No attribution rows are created by repair.
3. **Idempotent / over-apply-safe** (FR-008): applying rows already
   integrated leaves content unchanged and produces no spurious updates;
   safe concurrent with live edits (Yjs commutativity).
4. **Triggers** (FR-005, FR-006):
   - per-doc, after `subscribeToDocument` resolves (closes the not-awaited
     subscribe window);
   - all bound docs, on subscriber connection (re)establishment
     (`onSubscriberReady` hook in redis-pubsub) — covers the whole blind
     window;
   - periodic tick every `COLLAB_RECONCILE_INTERVAL_MS` (default 30000,
     env-tunable, validated parse);
   - fire-and-forget from a stale-marked serve.
5. **Tick cost bound** (RBD-057-2, SC-005): one batched newest-clock query
   per pod per period covering all bound docs; docs with newest ≤ verified
   perform **no row fetch**; docs behind fetch only `(verified, newest]`.
   Steady-state cost is independent of doc count and doc size. The tick
   never runs on, or adds latency to, the read/edit/fan-out paths
   (sequential background work, extracted `runReconcileTick` for tests).
6. **Fail-open without Redis** (FR-013): the periodic tick runs and bounds
   divergence with Redis disabled or down; fan-out delivery is never a
   correctness precondition.
7. **Eviction race**: a pass racing eviction/destroy is a silent no-op
   (registry identity check + guarded apply); it never re-inserts a doc into
   the registry and never leaks listeners or timers. Shutdown drain stops
   the interval.
8. **Repair accounting**: `collab.reconcile.repairs` increments only when a
   pass applied ≥ 1 row the doc's state vector did not already cover
   (bookkeeping catch-up after healthy fan-out is not a repair).
9. **Livelock dissolution** (FR-011): no change to `modify`'s conflict gate;
   the regression test proves a diverged pod's refusing `modify` succeeds
   after `reconcileDoc` alone.

## Convergence bound

A pod that misses fan-out converges within one period (default ≤ 30s;
SC-002 budget ≤ 60s allows one missed cycle) or immediately on subscriber
reconnect / stale serve, whichever fires first. Both-pods-behind heals on
each side independently (each compares against Postgres, never the peer).

## Test obligations

- US2 acceptance 1–5 (missed fan-out repair within one tick; reconnect
  reconcile-all; FR-011 livelock regression; over-apply idempotence — no
  content change, no persisted/broadcast rows; Redis-down tick still heals).
- SC-005 query-behavior test: no-divergence tick issues exactly one batched
  query and zero row fetches (method spies).
- Eviction race no-op; interval stop on shutdown drain.
