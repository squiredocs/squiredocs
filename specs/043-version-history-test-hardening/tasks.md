---

description: "Task list for 043-version-history-test-hardening"
---

# Tasks: Version History Test Hardening

**Input**: Design documents from `/specs/043-version-history-test-hardening/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: This feature *is* tests. Every user-story task produces or repairs a test; the only
production tasks are the four move-only extractions (X1-X4) required to make production code
importable (FR-006/FR-007, ledger D9).

**Merge position**: LAST — after 041, 042 and 044. Phase 1 is a blocking re-verification gate.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1-US8 map to spec.md's user stories
- Exact file paths are given in every task

## Path Conventions

Web app: backend at `server/`, real-WS end-to-end suites at `__tests__/integration/`, client at
`client/src/`. Absolute repo root is `/local-dev`.

---

## Phase 1: Setup — re-verify against merged main (BLOCKING GATE)

**Purpose**: this feature was specced against `main` at `f0273b68`. 041, 042 and 044 merge first.
Nothing may be written until the targets are re-confirmed. Divergences resolve in 041/042's favor
(D5) and are appended to the ledger.

- [x] T001 Confirm merge position: verify 041, 042 and 044 are merged into `main` (`git log --oneline --merges -20`) and record the merge SHAs at the top of `specs/043-version-history-test-hardening/clarifications-needed.md`. If any is missing, STOP and report — this feature must not land first.
- [x] T002 Create the per-agent test database and export `DATABASE_URL` (`createdb collab_test_db_043`), run `npm ci && (cd client && npm ci)`, copy `.env` from the main tree, then confirm a clean baseline: `npm run test:server` and `npm run test:client` both green BEFORE any change.
- [x] T003 Re-verify the four extraction targets still exist inline in `server/index.js` (bindState update listener, `ws.agentName` derivation, the `origin === ORIGIN_REDIS` Redis skip-list predicate, the `/api/docs/:docId/undo-status` route). Record the post-merge line numbers in `specs/043-version-history-test-hardening/research.md` under R2.
- [x] T004 Re-verify the extraction CEILING (D9): `grep -c "installGate(" server/index.js` returns 1 and `server/index.js` still contains the literal `request.tokenMayWrite = !Array.isArray(user.scopes) || user.scopes.includes('documents:write')`, and that `server/__tests__/ws-edit-gate.test.js` still asserts both. If 042 moved either, STOP and re-plan the budget.
- [x] T005 [P] Re-verify 042's overlap: grep for `retryWithBackoff`, `isMeaningful`, `isSentinelOrigin`, `getClockRange` in `server/` — determine whether 042 already extracted anything X1 would move, and whether 042's consolidations live inside the bindState listener block. Reuse, never re-extract (FR-007, D5).
- [x] T006 [P] Re-verify 041's merged restore semantics in `server/version-history.js` (live-doc transaction path, FR-011) and the honest is-loaded probe in `server/live-apply.js` (FR-013). Record the actual post-041 behavior US4 must assert.
- [x] T007 [P] Re-verify 041's merged error-state rendering: how `client/src/hooks/useVersionHistory.js` exposes load/diff errors and how `VersionHistoryPanel.jsx` / `VersionPreview.jsx` render them. Record the exact rendered text/roles US7 will assert.
- [x] T008 [P] Re-verify 042's frontend prop collapse (FR-012): does `client/src/components/VersionHistoryPanel.jsx` now take a `VersionHistoryContext` provider or merged chrome? Record the exact render harness US7 must use. **This is the largest single risk item.**
- [x] T009 [P] Re-verify the US8 targets: `grep -c "toBeLessThan(300)" server/__tests__/postgres-gap-read.test.js` (spec says nine; the working tree had **eight** — record the true post-merge count and the line numbers), and re-confirm the orphaning suites listed in research.md R9.
- [x] T010 [P] Re-verify US6's pipeline entry points are unchanged by 042: `computeChatDiff(mdBefore, mdAfter)` in `server/mcp/diff-utils.js` and `DiffService.prototype.computeMarkdownDiff(prevDoc, currDoc, report)` in `server/diff-service.js` (042 FR-011 merges the twin traversals inside `apply-word-marks.js`; FR-014 changes the cache namespace — neither should change these signatures).
- [x] T011 [P] Re-verify 044's merged awareness-guard tests so this feature duplicates none of them; record the file paths in research.md R10 as the "do not touch" list.
- [x] T012 Append every divergence found in T003-T011 to `specs/043-version-history-test-hardening/clarifications-needed.md` as a dated re-verification note, resolving each in 041/042/044's favor (D5).

**Checkpoint**: targets confirmed, baseline green, divergences recorded. Implementation may begin.

---

## Phase 2: Foundational — the four move-only extractions (BLOCKING)

**Purpose**: make production code importable so tests can drive it. Every task here is a **pure
move**: same logic, updated call site, no behavior change. After each, the full pre-existing suite
must be green with **no test file modified** — that green run is the proof the move was faithful
(contract AC-X). If a pre-existing test must change to accommodate an extraction, that extraction
is out of budget: STOP and report.

**⚠️ CRITICAL**: no user-story work begins until Phase 2 is complete.

- [x] T013 [P] Extract **X2**: add `identityFromPrincipal(user)` to `server/agent-identity.js` per `contracts/extraction-contracts.md` §X2, and update the derivation at `server/index.js` (`ws.userId` / `ws.agentName`) to use it. Do NOT touch `installGate` or the upgrade handler.
- [x] T014 [P] Extract **X3**: add `shouldPublishToRedis(origin)` to `server/origin.js` per `contracts/extraction-contracts.md` §X3, and change the `redisUpdateHandler` predicate in `server/index.js` to `if (!shouldPublishToRedis(origin)) return;`.
- [x] T015 [P] Extract **X4**: create `server/api/undo-status.js` exporting `createUndoStatusRouter({ documents, undoService, requireAuth })` per `contracts/extraction-contracts.md` §X4 (byte-identical behavior including the `console.error('Error checking undo status:', error)` line), and mount it in `server/index.js` alongside the existing `createExportRouter`/`createImportRouter` mounts.
- [x] T016 Extract **X1**: create `server/collab-bind-state.js` exporting `createBindState(deps)`, `createUpdateListener(deps, docGuid, ydoc)` and `extractDocGuid`, moving `server/index.js`'s `setPersistence({ bindState })` body. Preserve all eight invariants in `contracts/extraction-contracts.md` §X1 verbatim — especially listener-attached-before-await, baseline-refresh-before-sentinel-return, `viaSyncFromOrigin` read after the sentinel return, `pendingWrites` ordering, the FR-018 comment block, and the terminal CRITICAL/`notifyException` catch.
- [x] T017 Update `server/index.js` to `setPersistence({ bindState: createBindState({ persistenceProvider, pendingWrites, notifyException, searchIndexer, collabGuardrail, logPerf }), writeState: async () => {}, provider: persistenceProvider })` and delete the now-dead inline block.
- [x] T018 Run the full backend suite (`npm run test:server`) and client suite with **zero test files modified**. Any failure means a move was not faithful — fix the move, never the test.
- [x] T019 Create `server/__tests__/collab-extraction-guard.test.js` implementing structural drift guards G1-G7 from `contracts/extraction-contracts.md` §X-GUARD (positive greps that `server/index.js` uses X1-X4; negative greps that no re-inlined copy exists; and G7 re-asserting the `installGate`-exactly-once / `tokenMayWrite` ceiling).

**Checkpoint**: production code is importable, behavior is provably unchanged, and re-inlining now fails a test.

---

## Phase 3: User Story 5 — Mirror-tests replaced by real-code tests (Priority: P3, sequenced early)

**Goal**: the three in-file re-implementations are deleted and their suites drive production code.

**Independent Test**: deliberately break each production unit locally — the corresponding test must
fail. Breaking only the old mirror location no longer has any test asserting it.

**Why early despite P3**: the extraction from Phase 2 is only proven useful once something real
consumes it, and `update-classifier.test.js` driving X1 is the cheapest smoke test for the largest
extraction.

- [x] T020 [P] [US5] In `server/__tests__/update-classifier.test.js`, delete the in-test `runListener` re-implementation and rewrite the "oversized doc" test to drive `createUpdateListener` from `server/collab-bind-state.js` with a spied `extractXml` and a stub persistence, asserting `meaningful === null` is what reaches `storeUpdate` and that `extractXml` is never called once the size guard trips (FR-006a).
- [x] T021 [P] [US5] In `server/__tests__/origin.test.js`, delete the local `shouldPublishToRedis` copy (and its header comment) and import the real one from `server/origin.js`; leave all nine existing call-site expectations unchanged — their passing is the proof the move was faithful (FR-006b).
- [x] T022 [P] [US5] In `server/__tests__/undo-status-api.test.js`, delete the mirrored route handler and mount `createUndoStatusRouter` from `server/api/undo-status.js` behind the existing fake-auth middleware; keep every existing assertion (role gating, error ⇒ `{false,false}`, derivation call) and add one asserting the production `console.error` path is reached on failure (FR-006c).
- [x] T023 [US5] Verify FR-006/SC-003 by deliberate local breakage: break each of X1's classify guard, X3's predicate and X4's viewer gate in turn, confirm at least one test fails each time, and revert. Record the result in `specs/043-version-history-test-hardening/quickstart.md` Step 2 if any row needs correcting.

**Checkpoint**: zero mirror re-implementations remain; each of the three units is genuinely guarded.

---

## Phase 4: User Story 1 — End-to-end attribution regression coverage (Priority: P1) 🎯 MVP

**Goal**: the historical misattribution bug (agent connects first, human's edits credited to the
agent) gains real regression coverage through the production upgrade and document-binding path.

**Independent Test**: run the suite alone; it fails if any persisted update row carries the wrong
or missing identity, and it fails if the connection path stops attributing from the token.

- [x] T024 [US1] Create `__tests__/integration/helpers/collab-harness.js` implementing the full surface and wiring requirements H1-H10 in `contracts/harness-contract.md`: `startCollabServer`, `Client` with `sendUpdate`/`sendStep2`/`sendStep1`, `waitFor`, `cleanupDoc`. Frame constants MUST come from `server/ws-edit-gate.js`, never be redeclared. Model the transport on `__tests__/integration/step2-viewer-block.test.js` but replace its hand-written `bindState` with `createBindState` (X1).
- [x] T025 [US1] Add `createHumanIdentity(pool, email)` and `createAgentIdentity(pool, email, agentName, scopes)` to the harness: real `users` rows, a real browser-shape session token (no `scopes` array) for the human, a real `sk_sqd_` `api_tokens` row with `['documents:read','documents:write']` for the agent, plus the `document_shares` grant `permissions.can.view` requires. Include token/share teardown.
- [x] T026 [US1] Wire the harness's upgrade handler to the production decision chain: `permissions.extractUser({ queryToken })` → `permissions.can.view(userId, docId)` → `request.tokenMayWrite` (same predicate as production) → `identityFromPrincipal(req.user)` (X2) → real `installGate` → `setupWSConnection`. No `?role=`/`?userId=` shortcuts (H2/H4).
- [x] T027 [US1] Create `__tests__/integration/attribution-e2e.test.js`: agent-token client connects FIRST, human-token client second, both edit the same document; assert **every** persisted row's `user_id` and `agent_name` (human rows: human id + `agent_name IS NULL`; agent rows: agent's user id + the token's name). No row is merely counted (SC-002). Acceptance scenario 1.
- [x] T028 [US1] Add the reversed-order case to `attribution-e2e.test.js`: human connects first, agent second, identical assertions — proving connection order never influences identity. Acceptance scenario 2.
- [x] T029 [US1] Add an awareness-regression assertion to `attribution-e2e.test.js`: after both clients have announced presence, assert attribution is still token-derived (a broadcast about another client cannot change a connection's recorded identity). Do NOT assert anything about presence correctness itself — that is 044's coverage.
- [x] T030 [US1] Rewrite `server/__tests__/attribution-bug.test.js`: delete both `expect(true).toBe(true)` blocks and the surrounding proposal prose, keep or fold the token-decode tests, and add a pointer comment to `__tests__/integration/attribution-e2e.test.js` as the real coverage (FR-002). Confirm `grep -rn "expect(true).toBe(true)" server/__tests__ __tests__` returns nothing (SC-001).
- [x] T031 [US1] Add `afterAll` cleanup by `doc_guid` for every document the suite creates (FR-010), and confirm the suite passes twice consecutively in the same serial run.

**Checkpoint**: the flagship attribution scenario is covered by a test that fails when identity recording breaks. **This is the MVP.**

---

## Phase 5: User Story 2 — Reconnect catch-up honesty (Priority: P2)

**Goal**: a real sync-protocol catch-up frame produces `via_sync=true` rows that keep the relayer's
identity, do not credit the relayer as an author, and are refused by undo derivation.

**Independent Test**: run alone; fails if a real catch-up frame produces rows without the sync
marker, if the timeline credits the relayer, or if undo derivation crosses the sync boundary.

- [x] T032 [US2] Create `__tests__/integration/sync-catchup-e2e.test.js` using the harness: build a local `Y.Doc` with content the server never saw, connect an **editor**-role client, and send a real `SYNC_STEP2` catch-up frame; assert the resulting rows are persisted with `via_sync = true` under that client's identity (acceptance scenario 1).
- [x] T033 [US2] In the same suite, run the **real** timeline computation (`server/version-history.js` grouping) over the resulting log and assert the relayed content does not add the relaying client as an author of a version they did not originally write (acceptance scenario 2).
- [x] T034 [US2] In the same suite, drive the **real** undo availability/derivation over the end-to-end rows and assert the post-041 shape: the pending-recording guard does NOT block on a newest `via_sync` row (041 FR-014), while inverse derivation still refuses to invert across one (041 FR-016). Assert against the real row shape, never a hand-built one (acceptance scenario 3).
- [x] T035 [US2] Add a negative control: the same forged catch-up frame from a **viewer**-role client is blocked by the real gate (`WS_STEP2_BLOCKED`, no rows) — proving the suite's editor path is passing through the real gate rather than around it.
- [x] T036 [US2] Add `afterAll` cleanup by `doc_guid` (FR-010) and a header comment naming feature 016 / ws-edit-gate as the source of the undo-refusal behavior this suite re-evidences (not redefines).

**Checkpoint**: the highest-volume relay path is guarded end-to-end.

---

## Phase 6: User Story 3 — Pin the fate of a persistence-failed live edit (Priority: P2)

**Goal**: the purest "never lose edits" scenario is characterized, not fixed (D1).

**Independent Test**: run alone; it deterministically induces persistence failure and asserts the
pinned outcome.

- [x] T037 [US3] Add failure injection support to `__tests__/integration/helpers/collab-harness.js`: `startCollabServer({ persistence })` accepts a wrapper. Implement a `rejectUpdateMatching(persistence, predicate)` helper that fails one specific update (matched by payload bytes) on **every** retry attempt and restores the original in `finally` — scoped to that update, never global.
- [x] T038 [US3] Create `__tests__/integration/persistence-failure-e2e.test.js`: connect an editor client, rig the specific update to fail through all retries, send it, and assert the **observed** outcome exactly — row absent/present, whether the edit survives in the live document and in other connected clients, and whether an error surfaced. Assert what actually happens; do not encode the prediction (acceptance scenario 1).
- [x] T039 [US3] Assert the observability side of the outcome: the terminal `.catch` path produces the CRITICAL log and one `notifyException({ source: 'persistence' })` — spy on the injected `notifyException` dependency of `createBindState` rather than on console.
- [x] T040 [US3] Write the FR-014 characterization header on `persistence-failure-e2e.test.js`: name the observed outcome, state that it is a **known limitation** tied to the 038-deferred publish-before-commit window (038 FR-018, documented at the moved comment block in `server/collab-bind-state.js`), cite ledger D1, and state that a later feature closing the window MUST make this test fail loudly so the note is retired deliberately (acceptance scenarios 2 and 3).
- [x] T041 [US3] Verify the injection tears down cleanly: run this suite followed immediately by `attribution-e2e.test.js` in one serial run and confirm no rigged state leaks. Add `afterAll` cleanup by `doc_guid` (FR-010).

**Checkpoint**: the direct edit-loss path is visible and can never silently widen.

---

## Phase 7: User Story 4 — Restore under concurrency (Priority: P2)

**Goal**: restore's "get my content back" promise is guarded under exactly the conditions users
reach for it, against 041's merged semantics.

**Independent Test**: run alone; fails if concurrent activity during restore loses content,
corrupts attribution of the restore row, or leaves the document in a state neither restore produced.

**Depends on**: T006 (041's merged restore behavior recorded).

- [x] T042 [US4] Create `__tests__/integration/restore-concurrency.test.js` with a fixture builder: a document with several versions in its log, plus a live editor connection kept open so 041's live-doc transaction path (FR-011) is the path under test, not the durable-log fallback.
- [x] T043 [US4] Implement the restore-vs-live-edit case: provoke overlap (a barrier inside the harness persistence wrapper is permitted, per D2) between a restore and a concurrent live edit. Assert **invariants only**: the concurrent edit survives in the document AND in the durable log with its own attribution; the restore row exists and is attributed to the restorer per 041's semantics. No assertion may name a race winner (acceptance scenarios 1 and 3).
- [x] T044 [US4] Implement the two-concurrent-restores case: issue restores to two different target versions concurrently. Assert the final document equals the output of one of the two restores (serializable — never an interleaved hybrid), both restore rows exist and are individually attributed, and version history reads end-to-end without error over the resulting log (acceptance scenarios 2 and 3).
- [x] T045 [US4] Assert the D8 label semantics: a human web-UI restore creates **no** `agent_edits` row and is not an undo target (`design/collaboration-core.md` 2026-08-02 amendment). Assert the absence explicitly so a revival of the pre-040-cut behavior fails here.
- [x] T046 [US4] Add `afterAll` cleanup by `doc_guid` (FR-010) and run the suite five consecutive times in one serial run to confirm the invariant assertions are interleaving-independent (D2). If any run fails, the assertion is interleaving-pinned — fix the assertion, not the timing.

**Checkpoint**: restore is guarded under concurrency without introducing a flake factory.

---

## Phase 8: User Story 6 — Diff parity from one real fixture, divergence pinned (Priority: P3)

**Goal**: both complete production diff pipelines are exercised from one shared document fixture,
with the accepted divergence pinned so it cannot drift silently.

**Independent Test**: run alone; fails if the two full pipelines disagree on plain prose, or if the
divergent markdown-syntax outputs change from their pinned shapes.

**No extraction needed** — both pipelines are already importable (research R7).

- [x] T047 [P] [US6] In `server/__tests__/diff-two-surface-parity.test.js`, add a shared `Y.Doc` before/after fixture builder covering plain-prose changes, and keep the existing `rangesFromSegments` / `rangesFromBlock` range-extraction helpers as the comparison currency (FR-008 permits reuse).
- [x] T048 [US6] Add the end-to-end parity test: drive `new DiffService(stubPersistence).computeMarkdownDiff(before, after, report)` for the version-history surface and `computeChatDiff(toMarkdown(beforeFragment), toMarkdown(afterFragment))` for the chat surface from the same fixture, and assert changed-word range parity on the plain-prose corpus (acceptance scenario 1). Keep the existing hand-built-row tests — they cover the post-processing halves and are not replaced.
- [x] T049 [US6] Add ≥3 characterization tests pinning the current divergent outputs for markdown-syntax regions — bold syntax (`**word**`), backslash escapes, and hard breaks — asserting each surface's exact current output from the shared fixture (SC-005, acceptance scenario 2).
- [x] T050 [US6] Write the FR-014 header for the divergence pins: state that the divergence is accepted per **039 A1** (chat emphasises markdown syntax, history emphasises post-parse text), that parity is contractual only on plain prose, and that any change to a pinned shape requires ratify-or-fix rather than updating the pin.
- [x] T051 [US6] Confirm this suite requires no database and no Redis (both pipelines are pure given the fixture), so it runs fast and cannot orphan rows.

**Checkpoint**: a regression in either pipeline's upstream half now fails a test.

---

## Phase 9: User Story 7 — Component coverage for the version-history UI (Priority: P3)

**Goal**: the two untested user-facing components gain tests, including the failure-path rendering
041 introduces.

**Independent Test**: run the frontend component suites alone; each of the four coverage areas has
at least one failing-mode assertion.

**Depends on**: T007 (041's error-state shape) and T008 (042's prop/context shape).

- [x] T052 [P] [US7] Create `client/src/components/__tests__/VersionPreview.test.jsx` following the `VersionConfirmDialog.test.jsx` harness pattern (Vitest + `@testing-library/react`, local `setup(props)` factory). Cover diff-document rendering: given a version with diff content, the diff document including changed-word emphasis appears in the rendered output (acceptance scenario 1). Note `client/src/test/setup.js` stubs `console.error`/`console.warn`, so do not assert on console.
- [x] T053 [US7] In `VersionPreview.test.jsx`, add the error-state case per 041 FR-006: a failed diff load renders an error state, **never** the neutral "Select a version to preview" placeholder (acceptance scenario 4). Assert against the exact post-041 rendered text/role recorded in T007.
- [x] T054 [P] [US7] Create `client/src/components/__tests__/VersionHistoryPanel.test.jsx` using whatever render harness T008 determined post-042 (direct props or a `VersionHistoryContext` provider). Cover the selection → preview → restore wiring: selecting a version and confirming restore fires the restore action with that version's identity (wiring, not styling) (acceptance scenario 2).
- [x] T055 [US7] In `VersionHistoryPanel.test.jsx`, add the error-state case per 041 FR-005: a failed history load renders an error state with a retry affordance and **never** the "No version history yet" / "Edit the document to start tracking" empty state (acceptance scenario 4, deep-dive B4).
- [x] T056 [US7] Add restore-attribution label assertions across both files: versions authored by a human, by an agent, and by a restore action render labels matching post-040/041 semantics — restores labelled as restores with the restorer, and **web-UI restores never presented as undo targets** (D8, acceptance scenario 3).
- [x] T057 [US7] Verify SC-006: both component test files exist, all four coverage areas (diff rendering, selection→preview→restore wiring, attribution labels, error-state rendering) have at least one assertion each, and at least one is a failure-path rendering assertion.

**Checkpoint**: the display layer where the attribution promise becomes visible is guarded, and 041's fixes are protected from regressing.

---

## Phase 10: User Story 8 — Flake hygiene (Priority: P3)

**Goal**: a suite whose failures are believed. Applied last so it also covers everything this
feature just created.

**Independent Test**: the affected suites pass repeated consecutive serial runs; no wall-clock
`< 300ms` assertion remains in `postgres-gap-read.test.js`.

- [x] T058 [US8] Add `cleanupDocRows(pool, docGuid)` to `server/__tests__/helpers/db.js` plus the recorded convention doc block: every suite that causes `yjs_updates` rows to exist deletes them by `doc_guid` in `finally`/`afterAll`, including rows created indirectly, so the global `reindexStale` scan never finds this suite's orphans. State why a per-suite `search_index` heal was rejected (D3) and note that `cleanupTestUser` does not cover these tables.
- [x] T059 [P] [US8] Apply `cleanupDocRows` to `server/__tests__/undo-status-api.test.js` (FR-010).
- [x] T060 [P] [US8] Apply `cleanupDocRows` to `server/undo/__tests__/undo-service.test.js` (FR-010).
- [x] T061 [P] [US8] Apply `cleanupDocRows` to `server/undo/__tests__/edit-records.test.js` (FR-010).
- [x] T062 [P] [US8] Apply `cleanupDocRows` to `server/undo/__tests__/legacy.test.js` (FR-010).
- [x] T063 [P] [US8] Convert `server/__tests__/version-history.test.js`'s existing inline `DELETE FROM yjs_updates WHERE doc_guid` to the shared helper so there is one definition of the convention (FR-010).
- [x] T064 [US8] Confirm every suite created in Phases 4-7 uses `cleanupDocRows` in `afterAll` (T031, T036, T041, T046), and record the out-of-area suites deliberately left alone (D11) in `specs/043-version-history-test-hardening/promotion-notes.md`.
- [x] T065 [US8] Replace the wall-clock assertions in `server/__tests__/postgres-gap-read.test.js` per D4's preference order: where the call returns `{ rows, gapped, retries }`, assert `retries === 0` directly; where it does not, use the existing query-count spies or a zeroed `COLLAB_READ_GAP_RETRY_DELAYS_MS`; only where neither is possible, keep a CI-tolerant bound **with a comment stating what it guards**. No bare `toBeLessThan(300)` may remain (FR-011). No production change is needed — `retries` is already returned.
- [x] T066 [US8] In `__tests__/integration/collaboration.test.js`, replace `tick(50)` sleeps with the harness's `waitFor` condition polling wherever the awaited condition is observable (row present, document text contains X). Where the wait is for an *absence*, leave the sleep and add a comment saying so — you cannot condition-wait on nothing happening (US8 acceptance scenario 3, "documented at minimum"; note this scenario has **no backing FR** — see analyze finding C2).
- [x] T067 [US8] Verify SC-007: run `npm run test:server` three consecutive times with zero failures attributable to the addressed shapes, and confirm `grep "toBeLessThan(300)" server/__tests__/postgres-gap-read.test.js` returns nothing.

**Checkpoint**: the suite's failures are trustworthy.

---

## Phase 11: Stretch (P4 — droppable per D6)

**Purpose**: honorable mentions. Implemented only if P1-P3 land with budget remaining; omitting
them does not fail the feature. Drop cleanly — do not leave partial work.

- [ ] T068 **[DROPPED — P4 stretch, ledger D6]** [P] [US8] **S1**: add a test pinning behavior when two versions receive the same name (duplicate version-name collision) in `server/__tests__/version-history.test.js`.
- [ ] T069 **[DROPPED — P4 stretch, ledger D6]** [P] [US8] **S2**: add a real assertion for `mergeNamedVersions` with a null `clock_start` (currently unasserted) in `server/__tests__/version-history.test.js`.
- [ ] T070 **[DROPPED — P4 stretch, ledger D6]** [US8] **S3**: add a crash-window characterization for undo claims — claim finalized durably, process dies before the live apply — pinning what the next undo-status/derivation sees, in `server/undo/__tests__/undo-service.test.js`. Carries an FR-014-style header.

---

## Phase 12: Polish & Cross-Cutting

- [x] T071 Run the full quickstart Step 2 deliberate-breakage matrix (`specs/043-version-history-test-hardening/quickstart.md`) and confirm every row fails the expected test; revert every break. Any row that does not fail means a test is still a mirror.
- [x] T072 Run the quickstart Step 3 honesty greps and confirm every one prints `OK`: no `expect(true).toBe(true)` anywhere in the attribution area (SC-001), no bare `toBeLessThan(300)` (SC-007), no `runListener` / local `shouldPublishToRedis` / "Mirror of the server/index.js endpoint handler" (SC-003).
- [x] T073 Verify SC-008 by reviewing `git diff --stat` restricted to production paths (`server/` excluding `server/__tests__`, `client/src` excluding `__tests__`): the only production changes are X1-X4 and their call sites. Anything else is out of budget.
- [x] T074 Verify the FR-014 headers exist and name their decisions: `persistence-failure-e2e.test.js` cites 038 FR-018 + D1; `diff-two-surface-parity.test.js` cites 039 A1.
- [x] T075 Final gate: `npm run test:server` (serial), `npm run test:client`, `npm run build` all green; confirm no new suite uses `test.concurrent` or requires a parallel runner (FR-012); confirm no Playwright or browser driver was introduced (FR-013).
- [x] T076 Record in `specs/043-version-history-test-hardening/promotion-notes.md`: browser E2E deferred with owner **Sam** (FR-013/D7); the six out-of-area orphaning suites left alone (D11); any stretch item dropped (D6); and any 041/042 divergence absorbed at T012.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup / re-verify)**: blocking gate. Nothing starts before T001-T012.
- **Phase 2 (Extractions)**: depends on Phase 1. **Blocks Phases 3-7.** Phases 8-10 do not need it.
- **Phase 3 (US5)**: depends on Phase 2.
- **Phase 4 (US1)**: depends on Phase 2. Delivers the MVP.
- **Phase 5 (US2)**: depends on Phase 4 (reuses the harness built in T024-T026).
- **Phase 6 (US3)**: depends on Phase 4 (harness) and adds injection support in T037.
- **Phase 7 (US4)**: depends on Phase 4 (harness) and T006 (041's merged restore behavior).
- **Phase 8 (US6)**: depends only on Phase 1 — fully parallel with Phases 2-7.
- **Phase 9 (US7)**: depends only on Phase 1 (specifically T007/T008) — fully parallel with Phases 2-8.
- **Phase 10 (US8)**: T058 and T065-T067 depend only on Phase 1; T064 depends on Phases 4-7.
- **Phase 11 (Stretch)**: after Phases 3-10.
- **Phase 12 (Polish)**: after all desired stories.

### User Story Dependencies

- **US1 (P1)**: needs Phase 2. Independently testable and the MVP.
- **US2, US3, US4 (P2)**: each needs the US1 harness; each is independently runnable once built.
- **US5 (P3)**: needs Phase 2 only. Independent of US1-US4.
- **US6 (P3)**: fully independent — no extraction, no harness, no DB.
- **US7 (P3)**: fully independent (client-side). Most exposed to 042's merged shape.
- **US8 (P3)**: partly independent (T058, T065-T067); T064 waits on the new suites existing.

### Parallel Opportunities

- **Phase 1**: T005-T011 are all `[P]` — different files, pure reads.
- **Phase 2**: T013, T014, T015 are `[P]` (three different modules). T016/T017 are the serial core.
- **Phase 3**: T020, T021, T022 are `[P]` — three different test files.
- **Phases 8 and 9** can run alongside Phases 2-7 entirely (backend-pure and client-only respectively).
- **Phase 10**: T059-T063 are `[P]` — five different suites.
- **Phase 11**: T068, T069 are `[P]`.

**Hard serialization constraint**: backend Jest is `--runInBand` against one database (Constitution II,
FR-012). Parallelism above is about *authoring* order, never concurrent test runs. Never launch two
backend runs against the same DB.

---

## Parallel Example: Phase 2

```bash
# Three independent module extractions can be authored together:
Task: "Extract identityFromPrincipal into server/agent-identity.js (T013)"
Task: "Extract shouldPublishToRedis into server/origin.js (T014)"
Task: "Extract createUndoStatusRouter into server/api/undo-status.js (T015)"

# Then the serial core:
Task: "Extract createBindState/createUpdateListener into server/collab-bind-state.js (T016-T017)"
```

## Parallel Example: Phase 10

```bash
Task: "Apply cleanupDocRows to server/__tests__/undo-status-api.test.js (T059)"
Task: "Apply cleanupDocRows to server/undo/__tests__/undo-service.test.js (T060)"
Task: "Apply cleanupDocRows to server/undo/__tests__/edit-records.test.js (T061)"
Task: "Apply cleanupDocRows to server/undo/__tests__/legacy.test.js (T062)"
Task: "Convert version-history.test.js to the shared helper (T063)"
```

---

## Implementation Strategy

### MVP First (US1)

1. Phase 1 — re-verify against merged main. **Do not skip; this feature merges last for a reason.**
2. Phase 2 — the four extractions, each proven by a green unmodified suite.
3. Phase 3 — US5, the cheapest proof the extractions are real.
4. Phase 4 — US1, the flagship attribution E2E.
5. **STOP and VALIDATE**: break `identityFromPrincipal` locally; `attribution-e2e.test.js` must fail.

### Incremental Delivery

Phases 5, 6, 7 each add one guarded loss path on top of the shared harness. Phases 8 and 9 can be
delivered any time after Phase 1 and are the natural fill for periods when the harness work is
blocked. Phase 10 lands last so it sweeps the new suites too.

### Stop-and-report conditions

- 041, 042 or 044 not yet merged (T001).
- An extraction requires modifying a pre-existing test (Phase 2, contract AC-X).
- The 038 C1 guard no longer holds after an extraction (T004/T018) — the budget ceiling was breached.
- A US4 assertion cannot be made interleaving-independent (T046) — do not ship an interleaving-pinned test.
- A scenario cannot be expressed without faking a production decision (harness anti-requirements).

---

## Notes

- `[P]` = different files, no dependency on an incomplete task. It never means "run backend tests concurrently".
- Every characterization test carries an FR-014 header naming the accepted behavior and the decision it traces to (038 FR-018 / 039 A1) — a future change must fail loudly and point somewhere useful.
- Commit granularly with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer; never push or merge.
- Never edit `CLAUDE.md`, `README.md` or `docs/dev.md` from the implementer worktree.
