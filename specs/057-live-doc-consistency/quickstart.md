# Quickstart: validating 057-live-doc-consistency

Prereqs: the in-pod dev environment (docs/dev.md) or the local backend test
stack (pg+pgvector+redis with `DATABASE_URL` as BASE — 052 per-worker
isolation derives worker DBs). NUL-byte hazard: `markdown-sync.js` and
`resupply-resolution.js` need `grep -a`.

## Run the feature suites

```bash
# Backend (from repo root, in the app-dev pod)
npx jest server/__tests__/collab-reconcile.test.js \
         server/__tests__/collab-bind-completeness.test.js \
         server/__tests__/read-document-staleness.test.js \
         server/__tests__/agent-presence-readiness.test.js \
         server/__tests__/modify-livelock-regression.test.js \
         __tests__/integration/reconcile-fanout-loss.test.js

# Regression: full collab/read/modify suites must pass unchanged (SC-007)
npx jest server/__tests__ __tests__/integration
```

(Exact new-suite filenames are fixed in tasks.md; the list above is the
validation set.)

## Scenario walkthroughs (what proves what)

1. **Honest labels (US1 / SC-001)** — `read-document-staleness.test.js`
   fault-injects a lagging and a torn ({1, 5–9}) in-memory copy and asserts:
   label = highest contiguous verified clock; staleness fields present only
   when durable > verified; no spurious marker on a fresh bind or a
   fan-out-current pod; stale serve increments `collab.read.stale_serves`
   and fires a reconcile so the next read converges.
2. **Fan-out loss converges (US2 / SC-002)** —
   `reconcile-fanout-loss.test.js` binds a doc, commits rows through a
   second persistence handle while the redis double suppresses delivery,
   asserts divergence, runs `runReconcileTick()` directly (no 30s wait),
   asserts convergence to the log-rebuilt doc, idempotent over-apply (no
   content change, zero persisted/broadcast rows), and the Redis-disabled
   path still healing.
3. **Livelock regression (FR-011 / SC-003)** —
   `modify-livelock-regression.test.js`: diverged pod ⇒ `modify` refuses
   with content-divergence on retry; `reconcileDoc` alone (conflict gate
   untouched) ⇒ same `modify` succeeds.
4. **Incomplete binds refused (US3 / SC-004)** —
   `collab-bind-completeness.test.js` fault-injects gapped and short row
   fetches surviving the retry budget ⇒ refuseBind with
   `incomplete-load` reason, no `_bindComplete`, doc evicted, 1013 closes,
   counter labeled; healed fetch ⇒ clean bind; zero rows ⇒ empty bind OK;
   paging: silent first occurrence, throttled page on repeat.
5. **Readiness (US4)** — `agent-presence-readiness.test.js`: N counted
   updates with delayed integration ⇒ gate unresolved after first event,
   resolves on domination; timeout semantics unchanged; counted 0 ⇒
   immediate.
6. **Tick cost (SC-005)** — method-spy test: no-divergence tick = exactly
   one `getNewestClocks` call, zero `getUpdatesInRange` calls.
7. **Counters (SC-006)** — telemetry-capture harness asserts each of the
   three counters increments under its fault injection.

## Manual smoke (post-deploy, maintainer)

- Two-replica prod: edit a doc via one pod, read via MCP until routed to the
  other pod; response should be current or honestly stale, converging ≤ 30s.
- Dashboards: `collab.read.stale_serves`, `collab.bind.refusals` (by
  reason), `collab.reconcile.repairs` visible; baseline rates near zero.
- Env knob: `COLLAB_RECONCILE_INTERVAL_MS` respected (set 5000 in a dev pod,
  observe tick logs).
