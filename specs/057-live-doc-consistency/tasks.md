# Tasks: Live-Document Consistency

**Input**: Design documents from `/specs/057-live-doc-consistency/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R11), data-model.md, contracts/

**Tests**: included — the spec mandates them (Constitution II; FR-011 is itself a test requirement; SC-001..007 are test-verified). Test tasks precede implementation within each story; write them first and watch them fail.

**Organization**: grouped by user story (US1 honest labels, US2 reconciliation, US3 bind completeness, US4 readiness+telemetry), after a Foundational phase holding the shared machinery (persistence helpers, verified-clock helpers, counters, reconcileDoc core).

**Conventions for every task**: backend Jest suites run under 052 per-worker isolation; never edit `server/markdown-sync.js` or `server/origin.js` (056 boundary / research R3); reconciliation applies updates only — never rebuild or delete-recreate (FR-007); reuse `ORIGIN_DB_LOAD` for repair applies; `grep -a` when searching `markdown-sync.js` / `resupply-resolution.js` (NUL bytes). No migrations — if one seems needed, stop and escalate.

## Phase 1: Setup

- [X] T001 Baseline: run the existing collab/read/modify suites (`npx jest server/__tests__ __tests__/integration`) and record the green baseline so SC-007 deltas are attributable; skim the verified defect anchors (`server/mcp/tools/read-document.js:111,139-148`, `server/collab-bind-state.js:275,310`, `server/index.js:2125,2148-2153,2205`, `server/mcp/agent-presence.js:372-385`, `server/mcp/tools/modify.js:340-357`) against spec assumptions and flag drift before coding

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: shared machinery every story consumes. No story work before this completes.

- [X] T002 [P] Add `expectedTailClock` passthrough to `getYDoc` in `/local-dev/server/postgres-persistence.js` (mirror `getYDocAtClock`'s option at :1017; `_fetchRowsWithGapRetry` already implements the check) and extend `/local-dev/server/__tests__/postgres-gap-read.test.js` with getYDoc tail-short/gap/heal cases (existing callers stay byte-identical when the option is omitted)
- [X] T003 Add `getNewestClocks(docGuids)` batched helper (same file as T002 — serialize after it) (`SELECT doc_guid, MAX(clock) ... WHERE doc_guid = ANY($1) GROUP BY doc_guid`) to `/local-dev/server/postgres-persistence.js` with unit tests (empty input ⇒ no query; docs with no rows absent from result) in `/local-dev/server/__tests__/postgres-gap-read.test.js` or a sibling suite
- [X] T004 [P] Create `/local-dev/server/verified-clock.js`: state-vector helpers — `rowsCovered(ydoc, rows)` (per-row `Y.encodeStateVectorFromUpdate` vs `Y.encodeStateVector(ydoc)`), `advanceVerifiedClock(ydoc, rows)` (contiguous advance of `_verifiedClock` per data-model invariant), `dominates(svA, svB)` — with unit tests in `/local-dev/server/__tests__/verified-clock.test.js` (covered/uncovered/interior-gap/empty-row shapes, monotonicity, undefined `_verifiedClock` treated as unverified)
- [X] T005 [P] Extend `/local-dev/server/telemetry/metrics.js`: new counters `collab.read.gapped_serves` (label `gap.reason`: gap|short-tail|gap+short-tail — recorded from `_fetchRowsWithGapRetry`'s incomplete branch in `/local-dev/server/postgres-persistence.js` :486-501 alongside the existing console.warn, so every log-rebuild reader is covered), `collab.read.stale_serves`, and `collab.reconcile.repairs`; add `refusal.reason` attribute to `recordBindRefusal` (default `load-error` so existing call sites are unchanged); swallow-on-error like the precedent (:161-167); extend `/local-dev/server/__tests__/telemetry-metrics.test.js` with increment + label assertions via the capture harness (choke-point wiring lands after T002/T003 to avoid same-file churn)
- [X] T006 Create `/local-dev/server/collab-reconcile.js` with `reconcileDoc(docGuid, ydoc, deps)` per contracts/reconciliation.md: fetch `getUpdatesInRange(verified+1, 2147483647, {includeData: true})`, apply in one transact under `ORIGIN_DB_LOAD`, advance via T004 helpers, count a repair (T005 counter) only when a fetched row was previously uncovered; guards: registry identity check + try/catch eviction-race no-op; unit tests in `/local-dev/server/__tests__/collab-reconcile.test.js` (apply-only, no re-persist/re-broadcast via method spies, idempotent over-apply leaves content and rows unchanged, repair accounting, eviction race, undefined verified clock fetches full log) (depends on T003, T004, T005)

**Checkpoint**: shared machinery tested — user stories can begin (US1/US2/US3/US4 are then mutually independent).

---

## Phase 3: User Story 1 - A read is never labeled with a clock it did not integrate (Priority: P1) 🎯 MVP

**Goal**: `read_document` labels only the verified integrated contiguous clock; explicit additive staleness fields when durable state is newer; stale serve fires a repair. Contract: contracts/read-staleness.md.

**Independent Test**: fault-inject a lagging in-memory copy (integrated N, log N+k) and a torn copy ({1, 5–9}); labels are N and 1 respectively, staleness indicator present, never N+k / 9; a subsequent read after repair converges.

### Tests for User Story 1

- [X] T007 [P] [US1] Write `/local-dev/server/__tests__/read-document-staleness.test.js` (fail first): US1 acceptance 1–3 (current ⇒ label 9 no fields; lagging {1..5} vs 9 ⇒ label 5 + `newestClock:9`/`stale:true`/note + reconcile triggered + next read label 9; torn {1,5–9} ⇒ label 1); edge cases: fresh bind no spurious marker, fan-out-current pod no spurious marker (SV verification proves currency); `collab.read.stale_serves` increments; version-read path (`versionId`) unchanged

### Implementation for User Story 1

- [X] T008 [US1] Rework the current-content label block in `/local-dev/server/mcp/tools/read-document.js` (:139-171): derive newest durable clock from the existing `getRecentUpdatesWithUsers` window; when newest > session doc's `_verifiedClock`, fetch only the unverified suffix with bytes (`getUpdatesInRange(..., {includeData: true})`) and advance via `verified-clock.js` against the SERVED session doc; set `clock` = verified clock; add `newestClock`/`stale`/`stalenessNote` only when behind after verification (RBD-057-6 additive shape per data-model.md); record `collab.read.stale_serves`; fire-and-forget `reconcileDoc` on stale (never awaited); `lastModifiedAt`/`lastModifiedBy`/`recentAuthors` semantics untouched (depends on T004, T005, T006)
- [X] T009 [US1] SC-007 sweep for the read surface: run the MCP read/chat suites; any existing assertion that encoded the torn-label behavior is updated as a deliberate contract change with a comment naming FR-001/FR-002 — everything else must pass unchanged

**Checkpoint**: US1 independently shippable — honest labels + visible staleness, repair best-effort via reconcileDoc core.

---

## Phase 4: User Story 2 - A pod that misses fan-out converges without waiting for eviction (Priority: P1)

**Goal**: reconciliation triggers — periodic batched tick (30s, env-tunable), per-doc post-subscribe, subscriber (re)connect, Redis-down fail-open — bound divergence and dissolve the modify livelock. Contract: contracts/reconciliation.md.

**Independent Test**: suppress fan-out for one committed update, verify divergence, run one tick, verify convergence and that a previously-refused `modify` succeeds.

### Tests for User Story 2

- [ ] T010 [P] [US2] Write `/local-dev/__tests__/integration/reconcile-fanout-loss.test.js` (fail first) reusing the MockRedis shared-bus harness (`__tests__/integration/redis-sync.test.js:18-78`) and/or `receiveOn` second-pod pattern (`server/__tests__/live-fanout.test.js:251`): missed fan-out ⇒ tick repairs to log-rebuilt equality within one `runReconcileTick()`; subscriber reconnect ⇒ reconcile-all covers the blind window; over-apply idempotence (US2 scenario 4); Redis fully disabled ⇒ tick still heals (scenario 5, FR-013); both-pods-behind heals independently; `collab.reconcile.repairs` increments only for genuine repairs
- [ ] T011 [P] [US2] Write `/local-dev/server/__tests__/modify-livelock-regression.test.js` (fail first, FR-011/SC-003): bind a doc, commit foreign rows through a second persistence handle with fan-out suppressed (redis double, `server/__tests__/helpers/import-presence-doubles.js:30`), assert `modify` refuses with content-divergence on retry, run `reconcileDoc` alone (assert `server/mcp/tools/modify.js` untouched by this feature — gate semantics unchanged), assert the same `modify` succeeds

### Implementation for User Story 2

- [ ] T012 [P] [US2] Add `onSubscriberReady(cb)` to `/local-dev/server/redis-pubsub.js`: fire on subscriber connection establishment AND re-establishment (verify the client library's reconnect/ready event against the actual client used there; resubscribe already restores channels); unit-test the hook firing in `/local-dev/server/__tests__/redis-pubsub.test.js`
- [ ] T013 [US2] Add the periodic check to `/local-dev/server/collab-reconcile.js`: `runReconcileTick({docs, persistence})` — collect bound registry docs (`_bindComplete` true, `_bindFailed` absent), ONE `getNewestClocks` batch, sequential `reconcileDoc` for docs behind; `startPeriodicCheck`/`stopPeriodicCheck` with `COLLAB_RECONCILE_INTERVAL_MS` (default 30000, validated parse per `readGapRetryEnv` style); tick unit tests incl. the SC-005 query-behavior spy test (no-divergence tick = exactly one batch query, zero `getUpdatesInRange` calls) in `/local-dev/server/__tests__/collab-reconcile.test.js` (depends on T006)
- [ ] T014 [US2] Wire `/local-dev/server/index.js`: start the periodic check at boot (Redis-independent, FR-013), register `stopPeriodicCheck` with the shutdown drain (`stopBackgroundJobs` precedent :2299), chain a per-doc `reconcileDoc` onto the un-awaited `subscribeToDocument(...)` at :2125 (`.then`, error-swallowed), and register reconcile-all-bound-docs on `onSubscriberReady`; assert wiring via the extraction-guard/integration suites (depends on T012, T013)

**Checkpoint**: US1+US2 = the two P1 stories; divergence is now bounded and self-healing, livelock dissolved.

---

## Phase 5: User Story 3 - Incomplete loads are refused, never memoized as trusted (Priority: P2)

**Goal**: bind captures the tail clock before the fetch, opts into gap+tail detection, refuses incomplete loads with a typed reason and RBD-057-3 paging posture; `_bindComplete` only over verified-complete loads. Contract: contracts/bind-completeness.md.

**Independent Test**: fault-inject a gapped bind fetch surviving the retry budget ⇒ refusal via the existing path with a gap-typed reason and no trust flag; heal ⇒ retried bind completes.

### Tests for User Story 3

- [ ] T015 [P] [US3] Write `/local-dev/server/__tests__/collab-bind-completeness.test.js` (fail first): US3 acceptance 1–4 (interior gap past budget ⇒ refused, no memoization, evicted, 1013, `refusal.reason=incomplete-load` counter; short-of-captured-tail ⇒ refused identically; heals-within-budget ⇒ clean bind, `_verifiedClock`=tail then `_bindComplete`, no refusal; zero rows ⇒ empty bind OK, `_verifiedClock` -1); paging posture: first incomplete-load refusal pages nobody, repeat within `PAGE_THROTTLE_MS` pages once, load-error paging byte-identical to 041

### Implementation for User Story 3

- [ ] T016 [US3] Extend `refuseBind` in `/local-dev/server/bind-failure.js` with `reason: 'load-error'|'incomplete-load'` (default preserves 041 behavior exactly): incomplete-load skips the page on a doc's first refusal and pages through the existing per-doc throttle on repeat (RBD-057-3(b)); export the reason values; keep the return shape additive
- [ ] T017 [US3] Rework `createBindState` in `/local-dev/server/collab-bind-state.js`: capture `expectedTailClock` via `getClockRange(docGuid)` BEFORE the load; call `getYDoc(docGuid, {withGap: true, expectedTailClock: maxClock})` (null max ⇒ no tail check); on `gapped` ⇒ `refuseBind({reason: 'incomplete-load', ...})` + `recordBindRefusal('incomplete-load')` + perf log, no memoization; on success set `ydoc._verifiedClock = maxClock ?? -1` then `_bindComplete = true` (order per contract); catch path keeps 041 behavior with `reason: 'load-error'` (depends on T002, T016)
- [ ] T018 [US3] 041/046 regression sweep: existing `bind-failure`, `live-doc-trust`, and pending-write suites pass unchanged (`isTrustedLiveDoc` consumers untouched); the sole deliberate delta is the new refusal class

**Checkpoint**: torn loads can no longer be frozen into the registry.

---

## Phase 6: User Story 4 - Readiness means the counted updates are integrated; defects are measurable (Priority: P3)

**Goal**: readiness resolves on verified integration (arm clock + SV domination), timeout semantics unchanged; every defect class emits its counter. Contract: contracts/readiness-and-telemetry.md.

**Independent Test**: delay integration of all-but-one counted update ⇒ gate unresolved until domination; timeout still bounds the wait; each counter increments under fault injection.

### Tests for User Story 4

- [ ] T019 [P] [US4] Write `/local-dev/server/__tests__/agent-presence-readiness.test.js` (fail first): US4 acceptance 1–2 (N counted, first event only ⇒ unresolved; full integration ⇒ resolved; never-arriving ⇒ existing 10s timeout resolves honestly, 2s DB-error fallback intact), edge cases counted=0 ⇒ immediate, counted=1 resolves on that update, later concurrent edits over-satisfy (monotone, no starvation)

### Implementation for User Story 4

- [ ] T020 [US4] Replace `_waitForDocumentContent` in `/local-dev/server/mcp/agent-presence.js` (:352-395) with the two-stage gate: arm-time `C` = newest durable clock (`getClockRange`; no rows ⇒ resolve immediately); stage 1 registry-doc `_verifiedClock >= C` via non-creating peek (document-service precedent :142); stage 2 session-doc SV dominates the registry SV captured at stage-1 satisfaction (`verified-clock.js` `dominates`); re-check on session-doc `update` events + one immediate check; keep the 10s timeout and 2s fallback verbatim (depends on T004)
- [ ] T021 [US4] SC-006 consolidation in `/local-dev/server/__tests__/telemetry-metrics.test.js`: one fault-injection assertion per counter (`collab.read.gapped_serves`, `collab.read.stale_serves`, `collab.bind.refusals{incomplete-load}`, `collab.reconcile.repairs`) via the capture harness, plus the metrics-fault-never-propagates case for the new recorders (depends on T005; scenario plumbing from T007/T010/T015 may be referenced, not duplicated)

**Checkpoint**: all four stories independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T022 [P] FR-012: annotate `specs/039-diff-cache-integrity/contracts/read-completeness.md` § Non-consumers (:90-96) with a short supersession note pointing at the 2026-08-11 amendment and feature 057 (annotation only; the rest of the 039 contract stands)
- [ ] T023 [P] Docs sweep (Constitution I): document `COLLAB_RECONCILE_INTERVAL_MS` and the additive `read_document` staleness fields wherever the response shape or collab consistency is described — `README.md`, `docs/dev.md` (env knobs section), and `server/mcp/tools/tool-documentation/` if read_document's response is specified there; touch nothing that doesn't describe changed behavior
- [ ] T024 Full verification: entire backend + integration suites green (SC-007 — diffs only where the contract deliberately changed: torn labels, unconditional trust flag, first-event readiness); run the quickstart.md validation set end-to-end; confirm zero edits to `server/markdown-sync.js`, `server/origin.js`, `server/mcp/tools/modify.js` (`git diff --stat`)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (P1)** → **Foundational (P2)** → user stories. Foundational blocks all stories.
- **US1 (Phase 3)** needs T004, T005, T006. **US2 (Phase 4)** needs T003, T005, T006. **US3 (Phase 5)** needs T002, T005, T016-order. **US4 (Phase 6)** needs T004 (+T005 for T021).
- Stories are mutually independent after Foundational: US1 does not need US2's triggers (it calls `reconcileDoc` directly); US2 handles undefined `_verifiedClock` (full-log verify) so it does not need US3; US4's stage 1 degrades to the timeout path when `_verifiedClock` is absent, so it does not need US3 either — though US3 landing first makes its fast path live.
- **Polish (Phase 7)** after all desired stories.

### Parallel Opportunities

- Foundational: T002→T003 (shared file), with T004 and T005 in parallel alongside; T006 after T003/T004/T005.
- Test-first tasks parallel per story: T007; T010+T011; T015; T019.
- Cross-story: after Phase 2, US1 (T007-T009), US2 (T010-T014), US3 (T015-T018), US4 (T019-T020) can proceed in parallel — they touch disjoint files except `collab-reconcile.js` (T006 foundational, T013 US2) and `telemetry-metrics.test.js` (T005, T021 — serialize those two).
- T022 and T023 in parallel.

### Parallel Example: Foundational

```bash
Task: "getYDoc expectedTailClock passthrough in server/postgres-persistence.js"      # T002
Task: "getNewestClocks batch helper in server/postgres-persistence.js"               # T003 (same file as T002 — serialize with it; parallel to the rest)
Task: "verified-clock helpers in server/verified-clock.js"                           # T004
Task: "counters in server/telemetry/metrics.js"                                      # T005
```

(Note: T002/T003 share `postgres-persistence.js` — run them as one unit or serialize.)

## Implement-Brief Notes (analyze MEDIUMs folded forward)

1. **Ledger staleness (C1, report to Sam — do not hand-edit)**: clarifications-needed.md "design gap 2" says the amendment has four bullets; the committed amendment (design/collaboration-core.md:171-181) carries a fifth ratified telemetry bullet. FR-010 is design-ratified, stronger than the ledger claims. Surface in the promotion notes.
2. **First-read verification cost (C3)**: a fresh session doc has no `_verifiedClock`, so T008's suffix fetch would be the full log with bytes once per session. Seed it in-process when possible: if the registry doc's `_verifiedClock` is set and the session SV dominates the registry SV, adopt the registry value with no query. Otherwise accept the one-time fetch (bounded by 60s+ session reuse). Never block the read on this.
3. **056 boundary (C4, verified clean at plan time)**: 056's finished plan/tasks write only `server/markdown-sync.js`, `server/__tests__/markdown-sync.apply-correctness.test.js` + `markdown-sync.replay.test.js`, `__tests__/integration/sync-push.route.test.js`, and `server/mcp/tools/tool-documentation/export-api.js` — no overlap with 057's surface (it does not touch `postgres-persistence.js` or `telemetry/metrics.js`). Two standing cautions: (a) T023's docs sweep must NOT edit `tool-documentation/export-api.js` (056 owns it this cycle — read_document's own doc file only); (b) `server/origin.js` and `server/markdown-sync.js` stay untouched regardless. Any newly discovered overlap during implement is a merge-queue escalation, not a silent rebase.
4. **Deterministic repair tests (C5)**: `reconcileDoc` returns its promise and the read path keeps a test-observable handle to the last fire-and-forget repair (e.g., module-level `_lastRepair` seam), so T007/T010 await completion instead of sleeping. The production path never awaits it.

## Implementation Strategy

- **MVP**: Phases 1-3 (US1) — honest labels with best-effort repair is already a user-visible fix for the field-reported defect.
- **Recommended increment**: land Phases 1-4 together (both P1 stories) — US2 is what makes the staleness honesty *converge* and dissolves the livelock (SC-002/SC-003).
- Then US3, then US4, then Polish. Stop at any checkpoint; each story leaves the suite green and the system strictly more honest than before.
