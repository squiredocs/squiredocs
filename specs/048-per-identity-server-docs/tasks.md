# Tasks: Per-Identity Server Docs

**Input**: Design documents from `/specs/048-per-identity-server-docs/`

**Prerequisites**: plan.md, spec.md (amended: FR-013), research.md, data-model.md, contracts/, quickstart.md, clarifications-needed.md (RBD-048-1..4)

**Tests**: MANDATORY for this feature — the guard suite is itself a deliverable (FR-007/FR-013), and Constitution Principle II binds every behavioral change. Test tasks are therefore first-class below.

**Organization**: Foundational phase = plan Phase A (the bind-readiness gate) — it MUST land before the mechanism, because seeding from an ungated doc reproduces the verified lost-write bug (plan Loud Flag 1). User stories follow in priority order.

**Ground rules for every task**: backend suites are serial-only (`--runInBand`) on a database this run owns — coordinate per plan ("a suite run was in progress at plan time"); never touch `design/`, `README.md`, `docs/dev.md`, `CLAUDE.md`; `server/resupply-resolution.js` contains non-UTF8 bytes — search it with `grep -a`, edit surgically, never re-encode.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

**Purpose**: verify the plan's anchors still hold on the working tree (parallel pipeline — main moves).

- [ ] T001 Re-locate the plan's symbol anchors in the working tree and note any drift inline in this file: `updateDocument`/`createSeededDocument` in `server/document-service.js`; `_bindComplete` set-site in `server/collab-bind-state.js` (success path of `createBindState`); `restoreVersion` live/durable branches in `server/version-history.js`; `waitForDocLoaded` in `server/api/docs-import.js`; the six call sites listed in research R1. If any call site has appeared or moved, update the affected task descriptions before starting.

---

## Phase 2: Foundational — the bind-readiness gate (plan Phase A; FR-013, RBD-048-4)

**Purpose**: close the orchestrator-verified half-loaded hazard BEFORE the ephemeral mechanism exists, and consolidate the three divergent half-loaded predicates onto one owner. Blocks all user stories.

**⚠️ CRITICAL**: no Phase 3+ task may start until this phase is green — seeding from an ungated doc inherits the reproduced title-loss bug verbatim.

- [ ] T002 Implement and export `waitForDocReady(ydoc, docGuid, timeoutMs = 5000)` in `server/document-service.js` per `contracts/document-service.md`: immediate resolve on `_bindComplete === true`; throw `BindFailedError(docGuid)` on `_bindFailed` (observed at entry or while polling); 10 ms poll; timeout error message `Timed out waiting for document <docGuid> to load` (the `waitForDocLoaded` shape, so route 500 mapping is unchanged); never creates docs, never reads persistence, never mutates the doc.
- [ ] T003 Await the gate in `updateDocument` in `server/document-service.js`, immediately after `getSharedDoc` and BEFORE any read of doc state or listener attachment. The existing body stays otherwise untouched in this task (mechanism rewrite is T008).
- [ ] T004 Replace `waitForDocLoaded` in `server/api/docs-import.js` with `documentService.waitForDocReady`: delete the local function and its `persistence.getYDoc` read; the PUT-route call (unconditional for append AND replace, before the append-baseline read and `importMarkdown`) becomes `await documentService.waitForDocReady(ydoc, docId)` — it MUST stay at the route level because the append-mode presence baseline reads doc state BEFORE `updateDocument` runs; update the header comment that references the old poll; keep the route's existing error/status mapping byte-identical.
- [ ] T005 [P] Sweep every suite that drives `document-service` through its `init` seam with plain `Y.Doc` fakes and mark the fakes `_bindComplete = true` in setup: `server/__tests__/document-service-capture.test.js`, `server/__tests__/document-titles.test.js`, `server/__tests__/live-fanout.test.js`, `server/__tests__/import-presence.test.js`, `server/__tests__/bindstate-failure.test.js`, plus any others found by `grep -rl "updateDocument\|createSeededDocument" server/__tests__ __tests__` (the integration collab-harness uses the real `createBindState` and needs nothing).
- [ ] T006 Create `server/__tests__/per-operation-doc.test.js` with the half-loaded test class H1–H5 from `contracts/invariant-guards.md`: delayed-bind fake `getYDoc` (persisted title/body applied after a delay, then `_bindComplete = true`); assert H1 title set ALWAYS survives the late load (pre-fix repro: ~50% loss to Y.Map LWW), H2 append lands after persisted content (never index 0), H3 `_bindFailed` during wait → `BindFailedError` + shared doc untouched + no row, H4 never-binding doc → timeout error + no write, H5 warm doc takes the fast path (no observable wait).

- [ ] T007 Phase-2 checkpoint: focused serial run from `/local-dev` — `npx jest server/__tests__/per-operation-doc.test.js server/__tests__/document-service-capture.test.js server/__tests__/import-presence.test.js server/__tests__/live-fanout.test.js server/__tests__/document-titles.test.js server/__tests__/bindstate-failure.test.js --runInBand` — green before any Phase 3 task starts (serial-only DB discipline).

---

## Phase 3: User Story 1 — a server-side write can never be misattributed (P1) 🎯 MVP

**Goal**: paths 1–5 author through fresh one-shot ephemeral clientIDs with byte-identical observable behavior; every guarded property pinned.

**Independent test**: perform each converged operation, decode stored rows via `Y.parseUpdateMeta`, verify fresh distinct clientIDs ≠ the shared doc's; verify a process with no shared memory resolves resupplied rows identically (never a wrong person).

- [ ] T008 [US1] Rewrite `updateDocument`'s core in `server/document-service.js` to the ephemeral per-operation mechanism per `contracts/document-service.md` steps 5–13: seed fresh `Y.Doc` from `Y.encodeStateAsUpdate(ydoc)`; attach ephemeral capture listener AFTER the seed; `eph.transact(() => updateFn(eph), origin)` with detach+`eph.destroy()` in `finally` (throwing `updateFn` discards the ephemeral doc, shared doc untouched, error propagates — FR-006); merge captured bytes with `Y.applyUpdate(ydoc, bytes, origin)`; seed→transact→merge synchronous with no awaits (FR-001); keep the shared-doc origin-scoped capture, emit-time `hadRedisHandler`, `setImmediate` hop, post-merge `_bindFailed` check, and the `{ update, hadRedisHandler }` return contract (FR-005). Call sites unchanged (research R1).
- [ ] T009 [US1] Update `server/document-service.js` header + inline commentary (FR-011 share): the module header, the `getSharedDoc` write-path warning, and the capture commentary now describe gate + ephemeral mechanism + merge-back; no comment may still claim the transaction runs on the shared doc.
- [ ] T010 [P] [US1] Add guards G1+G3 to `server/__tests__/per-operation-doc.test.js`: for a content insert, a meta title set, and a seeded create through `updateDocument`, `[...Y.parseUpdateMeta(update).to.keys()]` never contains `sharedDoc.clientID` (G1); two consecutive calls emit two DISTINCT clientIDs (G3, US1-AS2).
- [ ] T011 [P] [US1] Add guard G4 to `server/__tests__/per-operation-doc.test.js`: the doc passed to `updateFn` is `!==` the shared doc, and a mutation made inside `updateFn` is NOT visible on the shared doc until the merge (unit, FR-007b).
- [ ] T012 [P] [US1] Add guard G5 to `server/__tests__/per-operation-doc.test.js`: a throwing `updateFn` propagates its error, leaves the shared doc byte-identical (compare `Y.encodeStateAsUpdate` before/after), initiates no row, and leaks no armed listener (FR-006/SC-005, US1-AS5).
- [ ] T013 [P] [US1] Add guard G6 to `server/__tests__/per-operation-doc.test.js`: a no-change `updateFn` returns the zero value `{ update: null, hadRedisHandler: false }`, produces no shared-doc event and no row, and leaves no armed listener (listener-count technique from the 038 capture suite).
- [ ] T014 [US1] Contract-preservation pass (FR-005/FR-010): re-run and, where fakes require it, minimally adjust `server/__tests__/document-service-capture.test.js`, `import-presence.test.js`, `live-fanout.test.js`, `document-titles.test.js`, `bindstate-failure.test.js` — assertions may be relocated but never weakened; origin-scoped capture, emit-time `hadRedisHandler`, settle timing, `publishIfUnhandled` semantics, and import-presence origin-filtered observation must all pass against the new mechanism.
- [ ] T015 [US1] Add undoability regressions U1/U2 (FR-009) in `__tests__/integration/`: an agent markdown import and an agent title set performed through the new mechanism remain undoable exactly as today (log-derived undo; identity predicates on stamps, never clientIDs). Place beside the existing undo integration suites.
- [ ] T016 [US1] Add the resupply-honesty end-to-end (US1-AS3/AS4, SC-001/SC-002) extending the 045/047 scaffolding in `server/__tests__/resupply-resolution.test.js` (or the integration resupply suite if that is where the scaffolding lives): a server-side write under a plain user identity whose row is deleted post-broadcast and re-supplied as a `via_sync` row resolves as the honest "Synced content" on a resolver with NO in-memory knowledge of the writer — never a prior same-doc author; and two independent resolver processes give identical answers for the same post-cutover rows.

**Checkpoint**: US1 independently deliverable — quickstart focused commands green; this is the MVP.

---

## Phase 4: User Story 2 — restore becomes one store-then-apply path (P2)

**Goal**: restore unifies onto the ephemeral mechanism with identical visible semantics; live-path capture machinery deleted; ordering flips per RBD-048-2.

**Independent test**: restore a version on a loaded document and on an unloaded one; both produce one attributed row whose stored bytes are exactly the broadcast bytes; connected clients receive it; an MCP restore remains undoable.

- [ ] T017 [US2] Rewrite `restoreVersion` in `server/version-history.js` per `contracts/restore-unification.md`: keep reads + F3 gap refusal byte-identical; seed selection (trusted live doc via unchanged `isTrustedLiveDoc` → `Y.encodeStateAsUpdate(liveDoc)`, else persisted `currentYdoc`, keeping the `untrustedReason` warn); one ephemeral compute (seed → `svBefore` → `transact(applyRestoreTo)` → delta → destroy); `storeUpdate` FIRST, then unchanged agent-only `recordEdit`; ONE `applyLiveUpdate(..., ORIGIN_RESTORE, 'Restore')` broadcast for both cases; DELETE `captureHandler`, live `stateVectorBeforeRestore`, `liveCapture`, the live-path transact, the `publishIfUnhandled` branch and its now-unused import.
- [ ] T018 [US2] Correct the restore header comments in `server/version-history.js` (FR-011): rewrite "WHERE THE STORED DELTA COMES FROM" and DOCUMENTED RESIDUALS item 2 (broadcast-then-store) to the unified ephemeral store-then-apply account citing RBD-048-2; keep residual 1 (RBD-041-2 cross-pod) verbatim.
- [ ] T019 [P] [US2] Add guard G2 to `server/__tests__/per-operation-doc.test.js`: `restoreVersion`'s stored update's insert set never contains the shared doc's clientID, for BOTH the trusted-live seed and the durable-log seed (FR-007a).
- [ ] T020 [US2] Update the restore suites (unit in `server/__tests__/`, integration in `__tests__/integration/`) for the unified path: one attributed row; stored bytes === broadcast bytes (same reference handed to `applyLiveUpdate`); loaded AND not-loaded cases; connected clients receive the restore via `applyLiveUpdate` (live doc no longer pre-has the update); no-change restore keeps the empty-transition row semantics; delete/adjust any assertion that expected `publishIfUnhandled` or broadcast-then-store ordering.
- [ ] T021 [P] [US2] Add RBD-048-2 consequence tests (US2-AS3/AS4) in `__tests__/integration/`: a concurrent edit landing during the store await merges with the restore (neither lost); a "crash" between commit and broadcast (skip the broadcast call in a harness) leaves a durable row that replays on next load.
- [ ] T022 [US2] Re-verify undo semantics around restore (US2-AS5): MCP/agent restore remains undoable, human web-UI restore remains a non-target — run the existing suites and extend only if the unified path changed an assertion's setup.

**Checkpoint**: restore behaves identically from the user's perspective; ordering pinned.

---

## Phase 5: User Story 3 — the invariant is pinned and the backstop stays (P3)

**Goal**: conformance cannot rot silently; the resolver keeps all three sources.

**Independent test**: run the guard suite; introduce a deliberate direct transact on the shared doc in a scratch change and observe guards fail.

- [ ] T023 [P] [US3] Add pinning test P1 beside the existing undo suites in `server/__tests__/`: the undo/redo inverse update's insert-set clientID is the scratch doc's own one-shot ID (never the live doc's) and the flow is store-then-apply (`server/undo/inverse.js` unchanged — test only).
- [ ] T024 [P] [US3] Add pinning test P2 for the sync-push exception: `fork.clientID === syntheticClientId(docGuid, baselineClock, sha256(md))` pinned before any op, and an identical retry push produces a byte-identical update. Extend `__tests__/integration/sync-push.route.test.js` (or the unit suite owning `syntheticClientId`) ONLY if this exact pin is not already asserted.
- [ ] T025 [P] [US3] Add wiring assertion P3 to `server/__tests__/resupply-resolution.test.js` (FR-008, US3-AS5): the live-peek source (`init({ peekSharedDoc })` from `server/index.js`), the durable `SHARED_DOC_WRITER_AGENTS`/`CHAT_AGENT_NAME` stamp source, and the 2+ identity ambiguity source are all still active — nothing deleted at cutover.
- [ ] T026 [US3] SC-004 deliberate-regression check (review-time, NOT committed): on a scratch change, make `updateDocument` transact directly on the shared doc and confirm G1/G3 in `server/__tests__/per-operation-doc.test.js` FAIL; revert the scratch; record the result in the implementation report for the merge queue.

---

## Phase 6: Polish & the corrected record

- [ ] T027 Correct the falsified shared-doc account in `server/resupply-resolution.js` (FR-011, ledger N-048-1): rewrite the "The shared server doc" header block (~lines 80–125) to a past-tense account — before 048 those paths transacted on the shared doc; after 048 every server-side operation authors under a one-shot ephemeral clientID; live-peek is a defense-in-depth tripwire (RBD-048-3); residuals R1/R2 closed for post-cutover rows; pre-cutover rows keep the old shapes; assistant rows still refused on resupply (RBD-048-1). SURGICAL edit — file contains non-UTF8 bytes; use `grep -a`, do not re-encode.
- [ ] T028 [P] Verify no falsified claim remains: `grep -ar "transacts on the ONE live" server/` and `grep -ar "broadcast-then-store" server/` return nothing (or only corrected past-tense text); also sweep `server/bind-failure.js`'s reference to `updateDocument` (lines ~161–164) for accuracy against the new mechanism.
- [ ] T029 Full authoritative verification per `quickstart.md`: entire backend suite serially (`npm test -- --runInBand`) from `/local-dev`; confirm the quickstart FR/SC matrix is fully covered by named passing tests; no client suites expected to change (server-only feature) — spot-check nothing red.
- [ ] T030 Handoff completeness check (no file writes outside allowed scope): RBD-048-4 present in `specs/048-per-identity-server-docs/clarifications-needed.md`; spec FR-013 + amended half-loaded edge case present in `specs/048-per-identity-server-docs/spec.md`; restate in the final report the merge-queue notes from plan.md (README sweep for restore ordering + per-operation authorship; optional Squire-side design amendment for the gate; one-replica deploy constraint unchanged, FR-012).

---

## Dependencies & execution order

- **Phase 1 → Phase 2 → Phase 3 (US1) → Phase 4 (US2) → Phase 5 (US3) → Phase 6.**
- Phase 2 (gate) blocks EVERYTHING: T008's seed is only safe behind T002/T003; T006's test class must exist before the mechanism changes what it guards.
- US2 (T017) depends on US1's T008 only conceptually (same mechanism shape) — restore has its own ephemeral compute, so T017 can technically start after Phase 2; keep the priority order anyway so the guard suite (G1/G3–G6) exists before restore rides on the pattern.
- US3's pins (T023–T025) are independent of US1/US2 code and parallelizable among themselves; T026 requires the guard suite (T010).
- T027/T028 must follow T009/T018 (all FR-011 corrections in before the sweep).

## Parallel opportunities

- Phase 2: T004 ∥ T005 (different files) after T002/T003.
- Phase 3: T010 ∥ T011 ∥ T012 ∥ T013 (same NEW file but independent describe blocks — safe for one agent, sequential if multiple agents share the file) after T008; T015 ∥ T016 after T008.
- Phase 4: T019 ∥ T021 after T017.
- Phase 5: T023 ∥ T024 ∥ T025 anytime after Phase 2.

## Implementation strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1)**: the gate plus the mechanism plus its guards close the constitutional defect (every new server-side row binds one identity) even before restore unifies — restore's live path would then be the last shared-doc author, so US2 follows immediately, not optionally. Deliver in phase order; stop-and-report if any contract-preservation assertion (T014) cannot pass without weakening — that is a design-conflict signal, not a test to fix.

**Task count**: 30 (T001–T030).
