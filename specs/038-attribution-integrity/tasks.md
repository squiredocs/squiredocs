# Tasks: Attribution Integrity

**Input**: Design documents from `/specs/038-attribution-integrity/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R11), data-model.md, contracts/, quickstart.md

**Tests**: INCLUDED — the spec explicitly mandates them (FR-007 updated contract test,
FR-008 protocol-level e2e, SC-009 full-suite pass). Write each story's tests so they FAIL
against the old behavior before the story's implementation lands.

**Organization**: Grouped by user story (US1–US5, priorities P1–P5), each independently
testable.

## ⚠ Non-negotiable guardrails (parallel-pipeline)

- Stay on the current branch. NEVER create/switch branches, NEVER commit — the merge
  queue handles integration.
- NEVER edit `CLAUDE.md`, `README.md`, `docs/dev.md` (reconciled in the merge queue) or
  anything under `design/` (Squire-synced, never hand-edited).
- **039 boundary** (see plan.md "Shared-file boundary"): in
  `server/postgres-persistence.js` touch ONLY `storeUpdate` / `_runStoreSlot` /
  `_storeUpdateCritical` (write path) and `_queryUpdatesWithUsers` / `_mapUpdateRow`
  (metadata surfacing). DO NOT touch `getUpdateRowsUpTo`, `_fetchRowsWithGapRetry`,
  `_findFirstGap`, anything under `server/diff/`, `server/diff-service.js`, or
  `specs/039-*`.
- **Migration slot**: this feature owns the single in-flight migration
  (`1799700000000_add-via-sync-to-yjs-updates.js`); add no other migration.

## Worktree environment (do this before anything else)

- `npm ci && (cd client && npm ci)` — worktrees do not inherit node_modules.
- Copy `.env` from the main tree if present; Redis is shared and fine.
- Backend tests: NEVER point at the shared test DB from a worktree. Create a per-agent
  database (`createdb collab_test_db_038`) and run every test command with
  `DATABASE_URL=postgres://...collab_test_db_038` (the helpers in
  `server/__tests__/helpers/db.js` respect it). Backend tests are serial-only within one
  DB (`--runInBand` is already wired; do not defeat it).
- Client tests (vitest) and `npm run build` are worktree-safe as-is.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

**Purpose**: Worktree environment + verified baseline

- [ ] T001 Set up the worktree environment exactly per the "Worktree environment" block
      above (npm ci both trees, `.env`, `createdb collab_test_db_038`), then apply
      migrations to the per-agent DB: `DATABASE_URL=... npm run migrate` (head should be
      `1799600000000_add-yjs-updates-user-activity-index.js` pre-feature)
- [ ] T002 Baseline run (all must be GREEN before any change, with `DATABASE_URL` set to
      the per-agent DB): `npx jest server/__tests__/permissions.test.js
      server/__tests__/origin.test.js server/undo/__tests__/legacy.test.js
      server/__tests__/collab-guardrail.test.js server/__tests__/live-fanout.test.js
      server/__tests__/import-presence.test.js
      server/__tests__/awareness-removal-propagation.test.js
      __tests__/integration/collaboration.test.js`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The migration (owned slot), write-path threading, and the extracted gate
module that US1 and US2 both build on

**⚠️ CRITICAL**: complete before any user-story phase

- [ ] T003 [P] Create migration `/local-dev/migrations/1799700000000_add-via-sync-to-yjs-updates.js`
      per data-model.md: up = `pgm.addColumns('yjs_updates', { via_sync: { type: 'boolean',
      notNull: false } })`, down = `pgm.dropColumns('yjs_updates', ['via_sync'])`; header
      comment documenting D1 (no default, no backfill, null = unknown) modeled on
      `migrations/1799000000000_add-meaningful-to-yjs-updates.js`; then run
      `DATABASE_URL=... npm run migrate` against the per-agent DB
- [ ] T004 [P] Create `/local-dev/server/ws-edit-gate.js` (research R1, contract
      `contracts/sync-protocol-gate.md`): export protocol constants (`MESSAGE_SYNC`,
      `MESSAGE_AWARENESS`, `SYNC_STEP1`, `SYNC_STEP2`, `SYNC_UPDATE`) and
      `classifyFrame(buffer) → { isEdit, kind: 'update'|'step2'|null }` — pure,
      throw-free on null/empty/short/non-sync input; `SYNC_UPDATE` AND `SYNC_STEP2` are
      edits (FR-001); frames < 2 bytes never edit-classified; include the design-rule
      comment ("any frame that can reach the document-apply path is an edit; new sync
      message types must be classified before they ship")
- [ ] T005 Thread `viaSync` through the WRITE path in
      `/local-dev/server/postgres-persistence.js` (FR-012, contract
      `contracts/internal-api-changes.md`): `storeUpdate(..., { meaningful = null,
      viaSync = null })` → `_runStoreSlot` → `_storeUpdateCritical` → add `via_sync` to
      the INSERT column list/params; NO other change to queue/lock/retry/commit
      semantics; add the FR-015 `via_sync` contract comment ("proves transport, not
      authorship; null = unknown ≡ not-sync")
- [ ] T006 Surface the column to readers in `/local-dev/server/postgres-persistence.js`
      (same file as T005 — run after it): add `u.via_sync` to the `_queryUpdatesWithUsers`
      SELECT and `viaSync: row.via_sync ?? null` to `_mapUpdateRow`; DO NOT touch the
      039-owned read functions

**Checkpoint**: migration applied; `storeUpdate` accepts `viaSync`; gate module exists —
user stories can begin (T002 suites still green)

---

## Phase 3: User Story 1 — Viewers cannot write through any sync channel (Priority: P1) 🎯 MVP

**Goal**: A viewer-role connection cannot alter the document through ANY sync frame
(step2 included); blocked step2 frames emit `WS_STEP2_BLOCKED`; viewer read experience
and editor offline-sync are untouched. This is the security fix.

**Independent Test**: quickstart.md "US1" — hand-crafted step2 from a viewer produces no
doc change, no `yjs_updates` row, one `WS_STEP2_BLOCKED` event, connection stays open and
still syncs downstream; same frame from an editor applies and persists.

### Tests for User Story 1

- [ ] T007 [P] [US1] Create `/local-dev/server/__tests__/ws-edit-gate.test.js`: pin the
      NEW contract via the REAL module (`require('../ws-edit-gate')`) — update frame ⇒
      `{isEdit: true, kind: 'update'}`; step2 ⇒ `{isEdit: true, kind: 'step2'}`; step1,
      awareness, null, empty, 1-byte ⇒ not edits; never throws on garbage input
- [ ] T008 [P] [US1] Update `/local-dev/server/__tests__/permissions.test.js` lines
      257–293 (FR-007): DELETE the hand-mirrored local `isEditMessage` copy (it is how
      the bug stayed pinned), import from `server/ws-edit-gate.js`, and flip the step2
      assertion to the new contract (step2 IS edit-classified). Keep: update-is-edit,
      step1/awareness-not-edit, short-frame cases. NOTE: changing this test is the work
      itself, not collateral damage — do not "preserve" the old assertion.
- [ ] T009 [P] [US1] Create `/local-dev/__tests__/integration/step2-viewer-block.test.js`
      (FR-008, research R11): mini-server pattern from
      `__tests__/integration/collaboration.test.js` + frame-crafting helpers pattern from
      `server/__tests__/attribution-bug.test.js`, wiring the REAL
      `server/ws-edit-gate.js` interceptor and a production-shaped bindState listener
      (parseOrigin → storeUpdate) with a `logPerf` capture hook. Viewer case: craft a
      step2 carrying content the server lacks (private Y.Doc → `Y.encodeStateAsUpdate` →
      `[MESSAGE_SYNC, SYNC_STEP2, varUint8Array]`), send as the connection's FIRST frame
      ⇒ assert doc XML unchanged, zero new `yjs_updates` rows, one `WS_STEP2_BLOCKED`
      `{connId, userId, docId, role}`, socket still open and still receives a subsequent
      editor edit. Editor case: same frame ⇒ content applied, exactly one new row,
      attribution = editor. (The `via_sync = true` row assertion is added in T017 once
      US2's flag lands.)

### Implementation for User Story 1

- [ ] T010 [US1] Wire the gate into `/local-dev/server/index.js` (FR-002/003/006, D4):
      delete the inline protocol constants + `isEditMessage` (~lines 1955–1997), import
      from `server/ws-edit-gate.js`; in the `ws.emit` interceptor replace the
      `isEditMessage` check with `classifyFrame`: `!currentCanEdit && kind === 'update'`
      ⇒ `logPerf('WS_EDIT_BLOCKED', …)` + drop (unchanged); `!currentCanEdit && kind ===
      'step2'` ⇒ `logPerf('WS_STEP2_BLOCKED', { connId, userId, docId, role: userRole })`
      + console line + drop (`return false`), connection stays open; step1/awareness
      untouched for all roles; editor frames untouched
- [ ] T011 [US1] Run US1 suites: `DATABASE_URL=... npx jest
      server/__tests__/ws-edit-gate.test.js server/__tests__/permissions.test.js
      __tests__/integration/step2-viewer-block.test.js
      __tests__/integration/collaboration.test.js` — all green (collaboration.test.js
      proves normal sync unbroken, FR-004/005)

**Checkpoint**: the write-permission bypass is closed and independently verified — MVP

---

## Phase 4: User Story 2 — Reconnect re-supply recorded as sync, not authorship (Priority: P2)

**Goal**: Every row originating from a step2 catch-up frame carries `via_sync = true`
(attribution unchanged); undo treats flagged rows as foreign; guardrail annotates
sync-sourced triggers.

**Independent Test**: quickstart.md "US2" — editor step2 row flagged, adjacent live-edit
rows not; undo refuses across flagged rows; guardrail pages carry `syncSourced`.

### Tests for User Story 2

- [ ] T012 [P] [US2] Extend `/local-dev/server/undo/__tests__/legacy.test.js` (FR-013,
      D2): (a) trailing run whose newest row has `viaSync: true` ⇒ run breaks at it
      (foreign semantics), derived range excludes it or refuses per anchor rules; (b)
      anchored case where the first row after baseline is flagged ⇒ `null` (start
      unpinnable); (c) window where ALL identity rows are flagged ⇒ `null` (honest
      "nothing to undo" — never stitches across); (d) `viaSync: null`/absent ⇒ byte-for-
      byte today's behavior
- [ ] T013 [P] [US2] Extend `/local-dev/server/__tests__/collab-guardrail.test.js`
      (FR-014, D3): a matching evaluation with `viaSync: true` ⇒ warn line contains
      `syncSourced=true` and `notifyException` extra contains `syncSourced: true`; a
      matching evaluation with `viaSync: null` ⇒ no annotation; paging/suppression
      decisions identical in both cases

### Implementation for User Story 2

- [ ] T014 [US2] Step2 flag scoping in `/local-dev/server/index.js` (FR-011, research
      R2): in the `ws.emit` interceptor, when `kind === 'step2'` and the connection may
      edit, set `ws._applyingSyncStep2 = true`, call `originalEmit(...)` in `try`, clear
      in `finally` (a throw must not leave it stuck); comment at the flag site
      documenting the synchronicity assumption (dispatch → `readSyncMessage` →
      `readSyncStep2` → `Y.applyUpdate(doc, payload, conn)` → update listeners, one
      synchronous chain; y-websocket passes the ws object as origin; revisit if the
      library ever defers application)
- [ ] T015 [US2] Thread the flag through the bindState listener in
      `/local-dev/server/index.js` (FR-010/012): AFTER the `parseOrigin` sentinel
      early-return, compute `const viaSync = (origin && typeof origin === 'object' &&
      origin._applyingSyncStep2 === true) || null`; pass `{ meaningful, viaSync }` to
      `persistenceProvider.storeUpdate(...)` and `viaSync` into the
      `collabGuardrail.evaluateUpdate({...})` call; attribution args unchanged
- [ ] T016 [US2] Undo exclusion in `/local-dev/server/undo/legacy.js` (FR-013, D2):
      `isIdentityRow` returns `false` when `row.viaSync === true`; header comment gains
      the via_sync rule ("a flagged row proves transport, not authorship — foreign to
      identity runs; refusal, never transparent skipping")
- [ ] T017 [US2] Guardrail annotation in `/local-dev/server/collab-guardrail.js`
      (FR-014, D3): `evaluateUpdate({ docGuid, update, userId, agentName, viaSync = null })`;
      when truthy, append `syncSourced=true` to the N1 `console.warn` match line and add
      `syncSourced: true` to the `notifyException` extra; matching, suppression, and
      whether a page fires unchanged
- [ ] T018 [US2] Extend `/local-dev/__tests__/integration/step2-viewer-block.test.js`
      with the flag-window e2e (SC-003, spec edge cases): editor step2 ⇒ its row has
      `via_sync = true` with the editor's unchanged attribution; a live update frame
      sent immediately after on the SAME connection ⇒ its row has `via_sync` NULL (flag
      never leaks); a second step2 on the same connection gets its own flagged window;
      empty-diff step2 ⇒ no row, no error
- [ ] T019 [US2] Run US2 suites: `DATABASE_URL=... npx jest
      server/undo/__tests__/legacy.test.js server/__tests__/collab-guardrail.test.js
      server/__tests__/undo-status-api.test.js
      __tests__/integration/step2-viewer-block.test.js` — all green

**Checkpoint**: US1 + US2 independently verified; history channel marker live end-to-end

---

## Phase 5: User Story 3 — Malformed attribution never causes silent data loss (Priority: P3)

**Goal**: A malformed transaction origin degrades attribution loudly but can never block
persistence; the publish-before-commit window is documented.

**Independent Test**: quickstart.md "US3" — non-UUID string origin ⇒ unattributed row +
loud signal, CRITICAL drop path unreachable; unrecognized object ⇒ persisted + warning.

### Tests for User Story 3

- [ ] T020 [P] [US3] Extend `/local-dev/server/__tests__/origin.test.js` (FR-017):
      (a) valid-UUID string ⇒ `{ userId: <uuid>, agentName: null }` (unchanged);
      (b) non-UUID string (incl. almost-UUIDs: wrong length, bad chars — strict, not
      fuzzy) ⇒ `{ userId: null, agentName: null, malformedOrigin: 'non-uuid-string' }`,
      never throws; (c) object with neither `userId` nor `agentName` property ⇒
      `malformedOrigin: 'unrecognized-object'`; (d) explicit `{ userId: null }` /
      ws-shaped objects ⇒ NOT flagged (unchanged); (e) all five sentinels (db-load,
      redis, sync-push string + branded object, inverse-apply, restore) ⇒ still `null`

### Implementation for User Story 3

- [ ] T021 [US3] Harden `parseOrigin` in `/local-dev/server/origin.js` (FR-017, research
      R7, contract `contracts/internal-api-changes.md`): sentinel skip-list first,
      unchanged; string branch validates
      `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` — invalid ⇒
      null attribution + `malformedOrigin: 'non-uuid-string'` + `console.error` including
      the rejected value; object branch: `'userId' in origin || 'agentName' in origin`
      both false ⇒ `malformedOrigin: 'unrecognized-object'` + `console.warn`; never
      throws; JSDoc updated
- [ ] T022 [US3] Alert wiring + FR-018 comment in `/local-dev/server/index.js`: in the
      bindState listener, when `parsed.malformedOrigin === 'non-uuid-string'`, call
      `notifyException(new Error('Malformed string transaction origin (persisting
      unattributed)'), { source: 'origin-parsing', extra: { docGuid, rejectedOrigin } })`
      and continue persisting unattributed (the drop path must be unreachable from
      origin parsing, SC-006). Separately, add the FR-018 comment at the `storeUpdate`
      call site documenting the publish-before-commit window (broadcast/Redis publish
      initiated synchronously at update time; durable commit async; an instance dying in
      between leaves content live elsewhere but absent from durable history; reorder
      deliberately deferred as hot-path risk — documentation only, no behavior change)
- [ ] T023 [US3] Run US3 suites: `DATABASE_URL=... npx jest
      server/__tests__/origin.test.js server/__tests__/version-history.test.js
      server/__tests__/live-fanout.test.js` — green (version-history/live-fanout guard
      against accidental sentinel/ws-path regressions)

**Checkpoint**: origin parsing can degrade attribution but never reach the CRITICAL drop

---

## Phase 6: User Story 4 — Server-driven changes never adopt an unrelated user's update (Priority: P4)

**Goal**: `updateDocument` capture is origin-scoped and synchronously detached; the 50 ms
armed-listener window is gone; 037 contracts preserved.

**Independent Test**: quickstart.md "US4" — no-change op overlapping a concurrent foreign
edit captures nothing; change path still returns its own bytes with emit-time sampling.

### Tests for User Story 4

- [ ] T024 [P] [US4] Create `/local-dev/server/__tests__/document-service-capture.test.js`
      (FR-019/020/021): (a) change-producing `updateDocument` returns exactly its
      transaction's update bytes with `hadRedisHandler` sampled at emit time; (b)
      no-change `updateDocument`, then a concurrent update with a DIFFERENT origin
      applied to the same ydoc immediately after the call returns but well inside the
      FORMER 50 ms window (the F4 repro: old code captures it, new code must not) ⇒
      `{ update: null, hadRedisHandler: false }` and the foreign update is not captured.
      NOTE: do not try to inject a foreign-origin update *during* the call — attach →
      transact → detach is one synchronous block, and `Y.applyUpdate` inside an open
      transaction inherits the outer origin (Yjs nested-transaction semantics); (c) `updateFn` throws ⇒ error propagates
      AND no `update` listener remains on the ydoc (`ydoc._observers` / emit a probe
      update and assert nothing captured); (d) no 50 ms wait on the no-change path
      (resolves without timers — use fake timers or elapsed-time bound)

### Implementation for User Story 4

- [ ] T025 [US4] Rework capture in `/local-dev/server/document-service.js` per research
      R6 (verbatim shape in research.md): origin-identity match (`updOrigin === origin`)
      via `ydoc.on` + `finally`-detached `ydoc.off`; delete the
      `updatePromise`/`timeoutPromise` race and the 50 ms `setTimeout`; change path
      defers one `setImmediate` turn before resolving ("persistence initiated", FR-021);
      no-change path returns the zero value immediately; PRESERVE the load-bearing
      emit-time `hadRedisHandler` comment (037) and the returned shape
      `{ update, hadRedisHandler }`
- [ ] T026 [US4] Run US4 suites (037 regression guards): `DATABASE_URL=... npx jest
      server/__tests__/document-service-capture.test.js
      server/__tests__/live-fanout.test.js server/__tests__/import-presence.test.js
      server/__tests__/onboarding.test.js` — all green

**Checkpoint**: capture race closed; import fan-out and presence dial semantics intact

---

## Phase 7: User Story 5 — Presence cleanup never evicts the wrong participant (Priority: P5)

**Goal**: Delete the homegrown client-id capture; presence removal on close relies solely
on y-websocket's per-connection controlled-id tracking; Redis cleanup preserved.

**Independent Test**: quickstart.md "US5" — no references remain; 015 awareness-removal
fan-out suite green; manual two-participant disconnect walk post-deploy (Sam).

### Implementation for User Story 5

- [ ] T027 [US5] Delete the client-id machinery from `/local-dev/server/index.js`
      (FR-022/023/024, research R9): remove `parseAwarenessClientIds` (~lines
      1963–1984), the first-awareness-frame capture block + `connectionClientId`
      declaration in the interceptor (~lines 2042–2066), and the
      `if (connectionClientId) … removeAwarenessStates` block in the doc-scoped close
      handler (~lines 2241–2245). PRESERVE VERBATIM the Redis pub/sub cleanup
      `setImmediate` block in that same close handler (~lines 2247–2272), the ping/pong
      interval, role re-check, and `WS_CLOSE` logging. Remove the lib0 `decoding` import
      ONLY if `grep -n "decoding\." server/index.js` shows no remaining users
- [ ] T028 [US5] Verify removal + regression: `grep -rn
      "parseAwarenessClientIds\|connectionClientId" /local-dev/server/` returns only
      comment/history mentions (e.g. `attribution-bug.test.js` narrative comments — leave
      those); then `DATABASE_URL=... npx jest
      server/__tests__/awareness-removal-propagation.test.js
      __tests__/integration/collaboration.test.js __tests__/integration/redis-sync.test.js`
      — all green (015 relay fix + close-path Redis cleanup intact)

**Checkpoint**: all five stories independently functional

---

## Phase 8: Polish & Cross-Cutting Verification

- [ ] T029 Full-gate run per quickstart.md (SC-009): `DATABASE_URL=... npm test`
      (backend, serial), then `cd client && npx vitest run`, then `npm run build` — all
      green with zero skipped suites
- [ ] T030 Boundary + scope audit of the working diff: `git status`/`git diff --stat`
      shows NO changes to `server/postgres-persistence.js` read-path functions
      (`getUpdateRowsUpTo`, `_fetchRowsWithGapRetry`, `_findFirstGap`), NO files under
      `server/diff/`, `server/diff-service.js`, `specs/039-*`, `design/`, `CLAUDE.md`,
      `README.md`, `docs/dev.md`; exactly ONE new migration
      (`migrations/1799700000000_add-via-sync-to-yjs-updates.js`); migration `down`
      tested once against the per-agent DB (`npm run migrate down` then re-up)
- [ ] T031 Requirements sweep: walk FR-001..FR-024 and SC-001..SC-009 against the diff
      and test output; confirm the three FR-015/FR-011/FR-018 contract comments exist at
      their mandated sites (flag site + persistence module + persistence listener); fix
      any gap found
- [ ] T032 Write `/local-dev/specs/038-attribution-integrity/merge-notes.md` for the
      merge queue: migration-to-run note (`1799700000000`, reversible), new
      observability event `WS_STEP2_BLOCKED` (for the telemetry/alert catalog), any
      README/docs deltas the queue should reconcile (expected: none — mechanics below
      doc granularity), and the deferred items (publish-after-commit reorder; escalation
      policy for repeat step2 offenders, cf. 034 detector follow-on)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)** → nothing
- **Phase 2 (Foundational)** → Phase 1. T003/T004 parallel; T005 → T006 (same file)
- **US phases** → Phase 2. Priority order is P1 → P5, but the stories are largely
  file-disjoint (see below) — a solo implementer should still go in priority order
- **Phase 8 (Polish)** → all story phases

### User Story Dependencies

- **US1 (P1)**: only Phase 2 (T004). Independent.
- **US2 (P2)**: Phase 2 (T003/T005/T006) + US1's T010 (the interceptor rewrite it hooks
  into) and T009 (the e2e file T018 extends). Undo/guardrail halves (T012/T013/T016/T017)
  are independent of US1.
- **US3 (P3)**: independent of other stories (T022 touches `server/index.js` — coordinate
  ordering with T010/T014/T015, sequential edits to the same file).
- **US4 (P4)**: fully independent (`server/document-service.js`).
- **US5 (P5)**: independent, but touches `server/index.js` — schedule its edits after
  US1/US2/US3's index.js edits to avoid churn.

### Within Each Story

Tests first (fail against old behavior where applicable) → implementation → story suite
run green.

### Parallel Opportunities

- Phase 2: T003 ∥ T004
- US1: T007 ∥ T008 ∥ T009 (three different test files)
- US2: T012 ∥ T013 (different test files)
- US3: T020 ∥ (US4's T024) ∥ (US2's T012/T013) — cross-story test authoring is
  file-disjoint
- `server/index.js` is the one contention point: T010 → T014 → T015 → T022 → T027 must be
  sequential

## Parallel Example: User Story 1

```bash
# Author the three US1 test files together (different files, no dependencies):
Task: "ws-edit-gate contract test in server/__tests__/ws-edit-gate.test.js"
Task: "un-pin the bug in server/__tests__/permissions.test.js (import the real gate)"
Task: "protocol e2e in __tests__/integration/step2-viewer-block.test.js"
# Then implement T010 (index.js wiring) and run T011.
```

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 → Phase 2 → Phase 3 (US1).
2. **STOP and VALIDATE**: T011 green = the security hole is closed and provable — this
   alone is shippable.

### Incremental Delivery

Each subsequent phase (US2 → US3 → US4 → US5) is an independently green, independently
valuable increment; run the story's suite task at each checkpoint before moving on. The
final gate is T029–T032.

---

## Notes

- 32 tasks total: 26 implementation/test + 6 setup/polish; each story independently completable.
- NO commits from this worktree (merge queue owns integration); stop at any checkpoint.
- If any ratified default (D1–D5) proves wrong during implementation, do not block:
  apply the best default and append the deviation to
  `specs/038-attribution-integrity/clarifications-needed.md` as RATIFIED-BY-DEFAULT.
