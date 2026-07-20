# Tasks: Version History Hardening

**Input**: Design documents from `/specs/023-version-history-hardening/`

**Prerequisites**: plan.md, spec.md, research.md (R1..R9), data-model.md,
contracts/persistence-write-read.md, contracts/restore-surfaces.md, quickstart.md

**Tests**: INCLUDED — constitution II (test-backed changes) makes tests mandatory for
every behavioral change; spec SC-001..007 name the required scenarios. Backend tests
run **serially** against the shared test DB — never in parallel with each other.
`[P]` on backend test tasks means the *files* are independent to write, not that the
suites may run concurrently.

**Organization**: Grouped by user story. Phase order follows spec sequencing: US1 →
US2 → US4 → US3 → US5 → US6 (US4 must land before US3's migration; US2/US3/US4 share
priority P2 and are ordered by the spec's own dependency note).

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

**Purpose**: Green baseline + the numbers SC-007/FR-005 are compared against.

- [X] T001 Verify green baseline: run (serially) `npx jest server/__tests__/postgres-persistence.test.js server/__tests__/postgres-gap-read.test.js server/__tests__/version-history.test.js server/__tests__/diff-service.test.js server/__tests__/pending-writes-flush.test.js server/undo/__tests__` and record pre-023 single-writer `DB_PERSIST` latency plus timeline latency on a large fixture in `specs/023-version-history-hardening/baseline-notes.md` (feeds SC-003/SC-007 comparisons; do not commit failures forward)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The single gap-tolerant fetch choke point every later story builds on
(research R2). Behavior-identical refactor — 021 tests must stay green unchanged.

- [X] T002 Extract `_fetchRowsWithGapRetry(client, sql, params, label)` in `/local-dev/server/postgres-persistence.js` (021 loop + `_findFirstGap` + shared `COLLAB_READ_GAP_RETRIES`/`COLLAB_READ_GAP_RETRY_DELAYS_MS` knobs + 021-format warn line with `label`; returns `{ rows, gapped, retries }`) and refactor `getYDoc` onto it, per contracts/persistence-write-read.md
- [X] T003 Add fetcher unit tests (return shape, label in warn line, budget sharing, gap-free zero-overhead path) to `/local-dev/server/__tests__/postgres-gap-read.test.js` and confirm all existing 021 gap tests pass unchanged

**Checkpoint**: getYDoc behavior identical; fetcher available to all stories.

---

## Phase 3: User Story 1 — The version coordinate always tells the truth (Priority: P1) — MVP

**Goal**: Per-document write serialization so clock order = causal order by
construction (queue + advisory-lock backstop, R1), composing with the 016 claim
transaction and preserving fire-and-forget failure semantics.

**Independent Test**: SC-001 — repeated concurrent-write stress (many unawaited
`storeUpdate` calls issued in production order) yields zero clock inversions;
claim-transaction and poisoned-update scenarios behave per FR-003/FR-004.

### Tests for User Story 1 (write first, must fail against current code)

- [X] T004 [US1] Ordering stress test in `/local-dev/server/__tests__/postgres-persistence.test.js`: issue 50+ `storeUpdate` calls for one doc in production order without awaiting each, plus a variant where one mid-stream call fails transiently once (mock) — assert persisted clocks strictly follow production order, zero inversions across repeated runs (spec US1 AS1/AS2, SC-001)
- [X] T005 [P] [US1] Claim-transaction composition test in `/local-dev/server/undo/__tests__/edit-records.test.js`: run `finalizeClaim` (external-client storeUpdate inside BEGIN..COMMIT) concurrently with a burst of ordinary `storeUpdate` calls on the same doc — assert no deadlock, all writes complete, inverse clock exceeds every clock it inverts, ordinary updates keep production order (FR-003, US1 AS3)
- [X] T006 [P] [US1] Poisoned-update test in `/local-dev/server/__tests__/postgres-persistence.test.js` + `/local-dev/server/__tests__/pending-writes-flush.test.js`: a terminally failing queue slot rejects (caller sees the error → CRITICAL/notifier path per bindState), subsequent queued updates persist in order (D-9, FR-004); pendingWrites flush still covers queued-but-unstarted writes (FR-006)

### Implementation for User Story 1

- [X] T007 [US1] Rewrite `storeUpdate` in `/local-dev/server/postgres-persistence.js` per contracts/persistence-write-read.md: per-doc FIFO queue (`Map<docGuid, tail>`, error-isolated chain, entry cleanup on settle) wrapping the critical section for pool-client calls; in-slot transient retry/backoff (3 attempts, exponential + jitter — the constants bindState uses today); short transaction with `pg_advisory_xact_lock(NS, hashtext(doc_guid))` around MAX+1 + INSERT; keep the ON CONFLICT retry loop as the mixed-window backstop (D-8); externalClient path bypasses the queue and takes the advisory lock on the caller's client (FR-001..005)
- [X] T008 [US1] Update bindState in `/local-dev/server/index.js`: drop the outer `retryWithBackoff` around `storeUpdate` (retry now lives in the queue slot — keeps queue position on retry), call `persistenceProvider.storeUpdate` directly; `pendingWrites` registration, `DB_PERSIST` logPerf, guardrail hook, title sync, and the CRITICAL `.catch` + `notifyException` stay byte-for-byte in behavior (FR-004/FR-006)

**Checkpoint**: SC-001 green under repeated runs; T001 latency comparison shows no
meaningful single-writer regression (FR-005).

---

## Phase 4: User Story 2 — No history reader ever builds on a torn read (Priority: P2)

**Goal**: Every log-rebuild reader funnels through the T002 choke point; still-gapped
results are never frozen (diff cache skip, undo abort) per D-2/FR-009.

**Independent Test**: SC-002 — inject a clock gap while exercising each covered
reader; each detects, retries within the shared budget, and never caches/persists a
gapped result; gap-free behavior byte-identical.

### Tests for User Story 2

- [X] T009 [US2] Gap-injection tests for `getYDocAtClock` and `_queryUpdatesWithUsers` family (`getUpdatesWithUsers`/`getUpdatesInRange`/`getRecentUpdatesWithUsers`) in `/local-dev/server/__tests__/postgres-gap-read.test.js`: gap detected → retry within shared budget → healed read served; still-gapped → served + 021-format warn with per-reader label (FR-007/008/010)
- [X] T010 [P] [US2] Diff-cache gap test in `/local-dev/server/__tests__/diff-service.test.js`: still-gapped row fetch → diff computed and served but NO Redis cache write (assert key absent); gap-free → cached exactly as today (FR-009, US2 AS2, SC-002)
- [X] T011 [P] [US2] Undo gapped-log test in `/local-dev/server/undo/__tests__/undo-service.test.js`: still-gapped `loadLog` → undo aborts observably BEFORE any claim (no agent_edits transition, no inverse row) (FR-009/D-2)

### Implementation for User Story 2

- [X] T012 [US2] Funnel remaining readers in `/local-dev/server/postgres-persistence.js`: route `getYDocAtClock` and `_queryUpdatesWithUsers` through `_fetchRowsWithGapRetry`; surface a `gapped` indicator to callers that need it (attach to the returned array or secondary return per contract); add `getUpdateRowsUpTo(docGuid, clock) -> { rows, gapped }` for the diff service; rewrite the `getYDoc` "single choke point" comment to name the fetcher (FR-007)
- [X] T013 [P] [US2] Update `/local-dev/server/diff-service.js`: replace the inline SQL row fetch (lines ~53-63) with `persistence.getUpdateRowsUpTo` (constructor gains persistence access; keep pool for nothing else), and skip the `setex` cache write when `gapped` (FR-009); serve the computed result either way
- [X] T014 [P] [US2] Update `/local-dev/server/undo/undo-service.js`: `loadLog` checks the gapped indicator; still-gapped after budget → return the observable error result and never reach claim/inverse computation (D-2)

**Checkpoint**: SC-002 matrix green; retry-storm non-interaction argued in R2 holds
(budget bounded; no new knobs).

---

## Phase 5: User Story 4 — The timeline stays fast as documents grow (Priority: P2)

**Goal**: Meaningful-vs-noise classification persisted at write time; timeline and
version lists become O(rows); idempotent backfill; unknown ⇒ meaningful (D-3).
(Sequenced before US3: classification erases the replay-cost rationale for snapshots.)

**Independent Test**: SC-003 — timeline on a large-log fixture performs zero
per-update replays/serializations (spies) and scales with row count; write-time
classification matches the replay-based filter; NULL rows read as meaningful.

### Tests for User Story 4

- [X] T015 [P] [US4] Classifier unit tests in new `/local-dev/server/__tests__/update-classifier.test.js`: text change ⇒ meaningful; CRDT-only/no-op update ⇒ noise; formatting-only change ⇒ meaningful (XML compare parity with `filterMeaningfulUpdates`, FR-015); classifier throw handled upstream as unknown
- [X] T016 [US4] Timeline O(rows) tests in `/local-dev/server/__tests__/version-history.test.js`: `getVersionTimeline` uses stored flags (spy: zero `getYDocAtClock`/`getUpdatesInRange`-with-data replay calls, zero `extractXml` over historical states); `meaningful=NULL` rows appear (fail-visible); all-noise range produces no phantom version; `totalEdits` counts filtered rows (FR-016/017/019, US4 AS2/AS3, edge case "empty ranges")
- [X] T017 [P] [US4] Write-path classification tests in `/local-dev/server/__tests__/postgres-persistence.test.js` + a bindState-level test (extend `/local-dev/server/__tests__/attribution-bug.test.js` or add to postgres-persistence suite): `storeUpdate` persists `meaningful` true/false/null verbatim; classification failure degrades to NULL and never fails persistence (FR-015/018, US4 AS1)
- [X] T018 [P] [US4] Backfill tests in new `/local-dev/server/__tests__/backfill-meaningful.test.js`: classifies exactly like the write path on a replayed fixture; NULL-only writes (never overwrites); rerun is a no-op (idempotent); interrupted run resumes; gapped doc skipped with log (FR-017, D-3, quickstart §4)
- [X] T019 [P] [US4] MCP pagination cost test in `/local-dev/server/mcp/__tests__/` (extend the existing list-document-versions test file): a page request on a large-log doc triggers no full-log content replay (spy), output shape unchanged (US4 AS4)

### Implementation for User Story 4

- [X] T020 [US4] Create migration `/local-dev/migrations/1799000000000_add-meaningful-to-yjs-updates.js`: `ALTER TABLE yjs_updates ADD COLUMN meaningful boolean` (nullable, no default); down drops it (R9-1, FR-027)
- [X] T021 [P] [US4] Create `/local-dev/server/update-classifier.js`: `classifyByXml(prevXml, nextXml)` (+ any thin helper over `extractXml`), the single predicate shared by write path and backfill (R3)
- [X] T022 [US4] Extend `/local-dev/server/postgres-persistence.js`: `storeUpdate(..., { meaningful = null } = {})` persists the flag in the INSERT; `_queryUpdatesWithUsers` SELECTs `u.meaningful` and maps it (R3/R4; depends on T007's rewritten storeUpdate)
- [X] T023 [US4] bindState classification in `/local-dev/server/index.js`: initialize `ydoc._lastClassifiedXml` after the DB load applies; per update compute `extractXml(ydoc)`, classify vs previous, pass `{ meaningful }` to storeUpdate, update the stored XML; any throw ⇒ `meaningful: null` + one log line, persistence result untouched (FR-015/018)
- [X] T024 [US4] Rewrite timeline in `/local-dev/server/version-history.js`: `getVersionTimeline` filters `meaningful !== false` on `getUpdatesWithUsers` rows instead of calling `filterMeaningfulUpdates`; DELETE `filterMeaningfulUpdates`; apply the same filter to `getVersionContent`'s auto-version metadata grouping (parity); `totalEdits` = filtered count (FR-016/019)
- [X] T025 [P] [US4] Create backfill script `/local-dev/server/scripts/backfill-meaningful-classification.js` per R5 (pattern: `server/scripts/backfill-search-index.js` incl. statement-timeout opt-out): NULL-only doc selection, gap-tolerant fetch, one replay per doc with `update-classifier`, batched `UPDATE ... FROM (VALUES ...) ... AND meaningful IS NULL`, per-doc progress logs, skip-and-continue on gapped/failed docs

**Checkpoint**: SC-003 spies green; quickstart §4 backfill double-run converges;
large-fixture wall-clock vs T001 baseline shows ≥10x (recorded in baseline-notes.md).

---

## Phase 6: User Story 3 — A named version can never disagree with the log (Priority: P2)

**Goal**: Named versions become pure clock-range labels; all version content comes
from gap-tolerant log replay; `snapshot_data` dropped with labels preserved (D-6).

**Independent Test**: SC-005 — stored named versions carry no content; preview/
diff/restore of any named version (incl. pre-migration rows) equals replay at
`clock_end`.

### Tests for User Story 3

- [X] T026 [US3] Replay-only named-version tests in `/local-dev/server/__tests__/version-history.test.js` + `/local-dev/server/__tests__/postgres-persistence.test.js`: `createNamedVersion` stores labels only (no content, no replay call — spy on `getYDocAtClock`); `getVersionContent` for a named version replays to `clock_end` under the gap-tolerant path; a fixture emulating a pre-023 diverged snapshot serves the REPLAYED content (D-6); out-of-range clock / foreign id still throws `VersionNotFoundError` (FR-011/012, US3 AS1/AS2/AS4)

### Implementation for User Story 3

- [X] T027 [US3] `/local-dev/server/postgres-persistence.js`: `createNamedVersion` becomes a pure INSERT of `(doc_id, name, clock_start, clock_end, created_by)` — remove the `getYDocAtClock` replay and `snapshot_data` from the statement (FR-011)
- [X] T028 [P] [US3] `/local-dev/server/version-history.js`: delete the `namedVersion.snapshot_data` fast-path branch in `getVersionContent` (lines ~589-597) so every read replays (FR-012)
- [X] T029 [US3] Create migration `/local-dev/migrations/1799100000000_drop-version-snapshot-data.js`: drop `document_versions.snapshot_data` preserving all label columns; down re-adds nullable `bytea` (content unrecoverable by ratified design) (R9-2, FR-013, US3 AS3) — lands only after T027/T028 merge
- [X] T030 [US3] Update snapshot-era fixtures/mocks in `/local-dev/server/__tests__/version-history.test.js` (rows at lines ~1488-1524 reference `snapshot_data`) to the label-only shape, keeping the cross-doc-leak (F7) assertions intact

**Checkpoint**: SC-005 green before and after migration; `canReconstruct` import
guard untouched (FR-014).

---

## Phase 7: User Story 5 — A restore is a first-class, undoable edit on every surface (Priority: P3)

**Goal**: Every restore records an `agent_edits` row at the shared core (human = `''`
identity), chat/MCP undo inverts it under 016 semantics, both surfaces converge on
one core with live broadcast on every instance (no silent skip).

**Independent Test**: SC-004 + SC-006 — restore via each surface produces one update
row + one edit record with correct identity/range; undo matrix behaves; collaborators
on other instances see the restore without reload.

### Tests for User Story 5

- [X] T031 [US5] Restore edit-record + single-persist tests in `/local-dev/server/__tests__/version-history.test.js`: restore records exactly ONE `yjs_updates` row (FR-024 regression, ORIGIN_RESTORE still skipped by bindState) and ONE `agent_edits` row with `[newClock, newClock]`/`clocks=[newClock]`; human restore → `agent_name=''`, agent restore → acting agent name; recordEdit failure logs but restore still succeeds (FR-020, contracts/restore-surfaces.md)
- [X] T032 [P] [US5] Undo-of-restore matrix in `/local-dev/server/undo/__tests__/undo-service.test.js` (or `/local-dev/__tests__/integration/collaboration.test.js` if a live doc is needed): fresh restore inverted surgically; later edits preserved (partial supersession); fully superseded restore → honest "nothing left to undo"; redo after undo inverts the inverse (FR-021, US5 AS2, SC-004)
- [X] T033 [P] [US5] Broadcast tests in `/local-dev/server/__tests__/version-history.test.js` (mocked deps) + `/local-dev/__tests__/integration/redis-sync.test.js`: doc loaded → applied with ORIGIN_RESTORE (fans out, no re-persist); NOT loaded + Redis → `publishUpdate` called with the restore update; neither → observable warn, never silent (FR-023, D-5, US5 AS3, SC-006)
- [X] T034 [P] [US5] Surface-parity tests: REST route (`/local-dev/server/__tests__/version-history.test.js` route-level or `server.test.js` style) and MCP tool (`/local-dev/server/mcp/__tests__/`, extend the restore tool's test file or add one): equivalent inputs produce identical rows/records/response shape; typed 404 via `VersionNotFoundError` on both (FR-022, US5 AS4)

### Implementation for User Story 5

- [X] T035 [US5] Create `/local-dev/server/live-apply.js` by extracting `applyToLiveDoc` from `/local-dev/server/undo/undo-service.js` as `applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid, update, origin, label)` (keep the H1 double-send guard: publish only when no attached `_redisUpdateHandler` did); switch undo-service to the shared module, behavior identical (R7)
- [X] T036 [US5] Rework `restoreVersion` in `/local-dev/server/version-history.js` per contracts/restore-surfaces.md: deps-object signature `{ getSharedDoc, redisPubSub, agentName }`; `storeUpdate(..., { meaningful: true })`; `editRecords.recordEdit` with `agentName ?? ''` (non-fatal on failure); broadcast via `applyLiveUpdate` with ORIGIN_RESTORE replacing the getSharedDocFn silent-skip block; unchanged `{ success, newClock, message }` response (FR-020/022/023)
- [X] T037 [P] [US5] Update REST route `POST /api/docs/:docId/restore` in `/local-dev/server/index.js` (~line 1364): pass `{ getSharedDoc: documentService.getSharedDoc, redisPubSub, agentName: null }`; error mapping unchanged
- [X] T038 [P] [US5] Update `/local-dev/server/mcp/tools/restore-document-version.js`: keep `getOrCreateSession(..., { requiredRole: 'editor' })` for ACL/presence, drop the session-provider `getSharedDocFn`, pass `{ getSharedDoc: documentService.getSharedDoc, redisPubSub, agentName: agentToken.agentName }` (FR-022)

**Checkpoint**: SC-004 fully automated; SC-006 automated at unit/integration level,
staging multi-instance walk-through deferred to quickstart §5 (maintainer-owed).

---

## Phase 8: User Story 6 — The version-history machinery carries no dead weight (Priority: P4)

**Goal**: Ratified dead code and the write-once-never-read `yjs_state_vectors` table
are gone; document birth works without the state-vector write.

**Independent Test**: SC-007 — repo-wide grep finds zero references; full backend +
frontend suites pass; first-update/document-birth paths behave identically.

### Tests for User Story 6

- [X] T039 [US6] Document-birth-without-state-vectors tests in `/local-dev/server/__tests__/postgres-persistence.test.js` + `/local-dev/server/__tests__/onboarding.test.js`: first update of a new doc persists (no `yjs_state_vectors` write), `clearDocument`/`clearAll` and the onboarding welcome-doc reset work with the table absent (FR-026, edge case "first update of a new document")

### Implementation for User Story 6

- [X] T040 [US6] Remove `yjs_state_vectors` writers: first-update branch in `storeUpdate` and the DELETEs in `clearDocument`/`clearAll` in `/local-dev/server/postgres-persistence.js`; the reset DELETE in `/local-dev/server/onboarding.js` (~line 154) (FR-026)
- [X] T041 [US6] Delete dead server code with their tests' references: `enrichVersionsWithMetadata` + `extractMetadata` in `/local-dev/server/version-history.js` (~lines 340-444), `getYDocWithHistory` + `getStateVectorsAtClocks` in `/local-dev/server/postgres-persistence.js`, `DiffService.invalidateCache` in `/local-dev/server/diff-service.js` (FR-025)
- [X] T042 [P] [US6] Delete `/local-dev/client/src/extensions/YChangeExtension.js` (zero imports — verified 2026-07-19; feature 024's agent does not touch this file) and run `cd client && npx vitest run` (FR-025)
- [X] T043 [US6] Create migration `/local-dev/migrations/1799200000000_drop-yjs-state-vectors.js`: `DROP TABLE yjs_state_vectors`; down recreates the (empty) table shape (R9-3, FR-026/027) — lands after T040
- [X] T044 [US6] Zero-reference sweep: `grep -rn "getYDocWithHistory\|getStateVectorsAtClocks\|invalidateCache\|enrichVersionsWithMetadata\|extractMetadata\|YChangeExtension\|yjs_state_vectors\|filterMeaningfulUpdates\|snapshot_data" /local-dev/server /local-dev/client/src /local-dev/shared` — only migrations and specs/ may match; fix any stragglers (SC-007)

**Checkpoint**: full backend suite (serial) + client suite green with everything
deleted.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T045 [P] Update README.md version-history section (serialized writes, replay-only named versions, persisted classification + backfill, restore-undo, dropped table) — **executed by the serial merge/implement stage, not by a parallel agent** (constitution I; parallel-agent override forbids README edits here)
- [X] T046 Run full quickstart validation (`specs/023-version-history-hardening/quickstart.md`): migrations up/down/up, full serial backend suite, client suite, backfill double-run, grep sweep
- [X] T047 Performance comparison against T001 baseline in `specs/023-version-history-hardening/baseline-notes.md`: single-writer DB_PERSIST within noise (FR-005/SC-007); 10k-update timeline fixture ≥10x faster with zero full-log replays (SC-003)
- [ ] T048 Staging multi-instance validation per quickstart §5 (restore visible <2s cross-instance, both surfaces; rolling-deploy mixed-window sanity) — maintainer-owed (Sam), record outcome in the feature ledger

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)** → none.
- **Phase 2 (Foundational)** → after Phase 1. BLOCKS all stories (fetcher is the
  choke point US2/US4/US5 build on; US1's gap-injection stress reuses its tests).
- **US1 (Phase 3)** → after Phase 2. Foundation for ordering guarantees; touches
  `storeUpdate`, which T022 (US4) then extends — do US1 before US4.
- **US2 (Phase 4)** → after Phase 2; independent of US1 logic but shares
  `postgres-persistence.js` — sequence T012 after T007 to avoid same-file conflicts.
- **US4 (Phase 5)** → after US1 (T022 extends the rewritten storeUpdate) and after
  Phase 2 (backfill uses the fetcher). MUST complete before US3's migration (spec
  sequencing).
- **US3 (Phase 6)** → after US4. T029 (migration) strictly after T027/T028.
- **US5 (Phase 7)** → after US1 (ordered writes), US2 (gap-safe reads), and US4
  (`meaningful: true` option exists). T036 after T035.
- **US6 (Phase 8)** → T040/T041 after all stories that touch the same files land
  (US1..US5); T042 anytime; T043 after T040.
- **Phase 9** → last; T045 belongs to the serial merge stage.

### Story Independence Notes

Each story remains independently *testable* at its checkpoint (its tests exercise
only its own guarantees), but US4→US3 and US1/US2/US4→US5 are real build-order
dependencies ratified by the spec's Sequencing section — this feature hardens one
subsystem, not six parallel features.

### Parallel Opportunities

- Within US2: T013 and T014 (different files) after T012.
- Within US4: T021 ∥ T020; T025 ∥ T023/T024 once T021/T022 exist.
- Within US5: T037 ∥ T038 after T036.
- US6 T042 (client deletion) is parallel to everything.
- Test-writing tasks marked [P] may be authored in parallel; backend suites still
  RUN serially (constitution II).

---

## Implementation Strategy

**MVP = Phase 1 + 2 + US1** (SC-001): the coordinate-truth guarantee is the
foundation everything else consumes; it is independently shippable and immediately
de-risks the worst corruption class. Then increments in phase order — each checkpoint
is a deployable state: US2 (no torn reads frozen), US4 (fast timeline + backfill),
US3 (replay-only named versions — includes a migration; deploy code before running
migration R9-2), US5 (undoable restores), US6 (cleanup + final migration).

Migration deploy notes (rolling, no freeze — D-8): R9-1 before/with US4 code (old
pods write NULL = legal); R9-2 only after US3 code is fully deployed (old pods still
INSERT snapshot_data until then); R9-3 only after US6 code is fully deployed (old
pods still write state vectors until then).

**Total**: 48 tasks (T001-T048). Per story: US1 = 5 (T004-T008), US2 = 6 (T009-T014),
US4 = 11 (T015-T025), US3 = 5 (T026-T030), US5 = 8 (T031-T038), US6 = 6 (T039-T044);
Setup/Foundational = 3 (T001-T003); Polish = 4 (T045-T048).
