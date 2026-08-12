# Implementation Plan: Live-Document Consistency

**Branch**: `main` (solo trunk workflow; spec directory `057-live-doc-consistency`) | **Date**: 2026-08-12 | **Spec**: specs/057-live-doc-consistency/spec.md

**Input**: Feature specification from `/specs/057-live-doc-consistency/spec.md`, design ground truth `design/collaboration-core.md` "Amendment (2026-08-11) — memoized readers do not self-heal", clarifications ledger RBD-057-1..6.

## Summary

Four defects let a pod's memoized in-memory doc silently disagree with the
Postgres update log: torn read labels, permanent divergence after missed
Redis fan-out, untrusted bind loads memoized as trusted, and premature
readiness. The fix wires existing 021/023/041 machinery into four places and
adds one new module:

1. **Honest labels** (US1): `read_document` labels with the highest clock
   whose rows are provably covered by the served content's Yjs state vector
   (per-doc `_verifiedClock` memo + incremental SV-coverage verification);
   additive staleness fields when durable state is newer; a stale serve
   fire-and-forgets a repair. No fence on the hot path (RBD-057-1, research R1).
2. **Reconciliation** (US2): new `server/collab-reconcile.js` —
   `reconcileDoc` fetches rows above the verified clock and applies them
   under `ORIGIN_DB_LOAD` (apply-only, non-persisting, non-broadcasting;
   research R3/R4); triggered by a 30s env-tunable periodic tick (one
   batched `MAX(clock)` query per pod per period), per-doc post-subscribe,
   subscriber (re)connect, and stale serves. Dissolves the modify livelock
   with no conflict-gate change (FR-011 regression test proves it).
3. **Bind completeness** (US3): bindState captures the tail clock before the
   fetch, opts `getYDoc` into gap+tail detection, refuses incomplete loads
   through `refuseBind` with a typed `incomplete-load` reason (paging per
   RBD-057-3: count always, page only on persistence), and only sets
   `_bindComplete` over a verified-complete load (research R5).
4. **Readiness + telemetry** (US4): the agent-presence gate arms on the
   durable clock and resolves on state-vector domination, keeping today's
   timeout semantics (research R6); three OTel counters make stale serves,
   incomplete-load refusals, and reconcile repairs dashboard-visible
   (research R8).

## Technical Context

**Language/Version**: Node.js 22 (CommonJS), Express + y-websocket backend; no client changes (explicitly out of scope)

**Primary Dependencies**: yjs (state vectors, idempotent update application), y-websocket `bin/utils` doc registry, node-redis pub/sub (`server/redis-pubsub.js`), pg (`server/postgres-persistence.js`), OpenTelemetry counters (`server/telemetry/metrics.js`)

**Storage**: PostgreSQL `yjs_updates` append-only log (unchanged — **no migrations**, research R11); new state is per-process in-memory bookkeeping (`ydoc._verifiedClock`) and counters

**Testing**: Jest backend suites (`server/__tests__/`, `__tests__/integration/`) under 052 per-worker DB/Redis isolation; multi-instance simulation reuses existing harnesses (research R9) — MockRedis shared bus, fake-claim-redis queue/flush, `receiveOn` second-pod apply, `jest.isolateModules` two-pod loading

**Target Platform**: Linux server pods, production topology 2 replicas behind non-sticky ingress (`k8s/base/app-deployment.yaml:7`)

**Project Type**: web service (backend-only feature)

**Performance Goals**: zero added latency on reads/edits/fan-out application (FR-006); no-divergence periodic tick = one batched query per pod per 30s, no per-doc row fetches (SC-005); read-path verification costs one bounded suffix fetch only when durable state moved past the verified clock

**Constraints**: no blocking fence on reads (RBD-057-1); apply-only repairs — never rebuild/delete-recreate (FR-007, Constitution IV, 021 invariants); fail-open without Redis (FR-013); refusal posture per RBD-057-3/4; readiness monotone with unchanged timeout semantics (RBD-057-5); additive-only response fields (RBD-057-6); no edits to `server/markdown-sync.js` (056 boundary) or `server/origin.js` (deliberate, research R3)

**Scale/Scope**: ~9 touched files + 1 new module + test suites; bound docs per pod is small (10s), documents to low-MB history sizes; periodic check cost independent of doc count and size in steady state

## Constitution Check

*GATE: evaluated pre-Phase 0 and re-checked post-Phase 1 design — PASS (no Complexity Tracking entries needed).*

- **I. Documentation Reflects Reality** — PASS with obligation: `read_document`
  response gains fields and a new env knob (`COLLAB_RECONCILE_INTERVAL_MS`)
  exists; tasks include a docs sweep (README/docs only where these are
  described today; agent-facing tool docs under `server/mcp/tools/tool-documentation/` if they state the response shape).
- **II. Test-Backed Changes** — PASS: every FR maps to tests (Phase task
  table); suites run under per-worker isolation; no round-trip/format surface
  touched.
- **III. Trunk-Based Solo Workflow** — PASS: pipeline-managed on main.
- **IV. Collaboration-Safe Document Operations** — PASS by construction:
  reconciliation only ever `Y.applyUpdate`s missing rows (FR-007); no
  delete-and-recreate anywhere; no positional targeting; format registry
  untouched; attribution untouched (`ORIGIN_DB_LOAD` rows are never
  persisted, so no attribution rows are created).
- **V. Secure by Default** — PASS: no new ingestion surface, endpoint, or
  auth change; counters carry no user content and bounded-cardinality labels.
- **VI. Design Docs Are Ground Truth** — PASS: the 2026-08-11 amendment's
  five contract bullets map to FR-001..010; gaps recorded in
  clarifications-needed.md (note: the amendment **does** carry the telemetry
  bullet, so ledger "design gap 2" is stale — carried as an analyze finding,
  not silently fixed).
- **VII. Horizontally Scalable App Pods** — PASS and strengthened:
  `_verifiedClock` is cache-only bookkeeping whose loss degrades honestly
  (re-verify/re-fetch from Postgres); reconciliation removes the standing
  VII violation where a pod's memory silently diverged from durable truth;
  correctness never depends on replica count or on fan-out delivery (FR-013).

## Project Structure

### Documentation (this feature)

```text
specs/057-live-doc-consistency/
├── spec.md
├── clarifications-needed.md
├── checklists/requirements.md
├── plan.md              # This file
├── research.md          # Phase 0 (R1–R11)
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── read-staleness.md
│   ├── bind-completeness.md
│   ├── reconciliation.md
│   └── readiness-and-telemetry.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
server/
├── collab-reconcile.js            # NEW — reconcileDoc + periodic tick + triggers (R4)
├── collab-bind-state.js           # bind: capture tail, opt into gap/tail detection, typed refusal, _verifiedClock (R5)
├── bind-failure.js                # refuseBind reason parameter + reason-aware paging (R5)
├── postgres-persistence.js        # getYDoc expectedTailClock passthrough; getNewestClocks batch helper (R4/R5)
├── redis-pubsub.js                # onSubscriberReady hook for (re)connect reconcile trigger (R4)
├── index.js                       # wire reconciler start/stop + post-subscribe trigger (R4)
├── telemetry/metrics.js           # stale-serve + reconcile-repair counters; refusal reason label (R8)
└── mcp/
    ├── tools/read-document.js     # verified-clock label, staleness fields, repair trigger (R1/R7)
    └── agent-presence.js          # readiness gate: arm clock + SV domination (R6)

specs/039-diff-cache-integrity/contracts/read-completeness.md   # FR-012 supersession annotation

server/__tests__/                  # unit/DB suites incl. FR-011 livelock regression
__tests__/integration/             # multi-instance fan-out/reconcile scenarios
```

**Structure Decision**: existing backend layout; one new module
(`server/collab-reconcile.js`) so reconciliation has a single owner with an
extracted, timer-free tick for tests; everything else is surgical edits at
the verified defect sites. `server/origin.js` and `server/markdown-sync.js`
are deliberately untouched (R3, 056 boundary).

## Complexity Tracking

No constitution violations to justify.
