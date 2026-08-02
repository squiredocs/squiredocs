---
description: "Task list for 042 Version History Simplification"
---

# Tasks: Version History Simplification

**Input**: Design documents from `/specs/042-version-history-simplification/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/behavior-preservation.md, quickstart.md

**Tests**: This feature's acceptance bar is that **pre-existing** suites pass *unmodified*.
Test tasks appear in only two forms: (a) deleting/updating tests whose sole subject is
deleted code (permitted by spec FR-001 and the Edge Cases), and (b) **new characterization
tests** for `VersionHistoryPanel` / `VersionPreview`, which have no tests at all today
(research R17) and would otherwise leave US3 unguarded.

**Organization**: One phase per user story. Phase order follows plan.md's Implementation
Sequencing, which is driven by 041 rebase risk rather than by priority alone — see
Dependencies for the one deliberate deviation (US4 before US2/US3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1-US5 per spec.md
- Every line anchor below is **pre-041** and must be re-derived in Phase 2

---

## Phase 1: Setup

**Purpose**: Isolated worktree, isolated database, and a captured green baseline. Without
the baseline there is no way to prove FR-001.

- [ ] T001 Create the implementation worktree branched off **post-041** `main` and install dependencies with `npm ci && (cd client && npm ci)` (worktrees do not inherit `node_modules`)
- [ ] T002 Create the per-worktree database and export it: `createdb collab_test_db_042` then `export DATABASE_URL=postgresql://$USER@localhost:5432/collab_test_db_042` — never point at the shared `collab_test_db`, and note `server/__tests__/globalSetup.js` only auto-creates the DB named by its `TEST_DB_NAME` constant
- [ ] T003 Capture the green baseline: `npm run test:server`, `npm run test:client`, `npm run build`, and record the merge-base SHA for the SC-002 measurement in contracts/behavior-preservation.md C11

**Checkpoint**: Both suites green before any edit.

---

## Phase 2: Foundational (Blocking Prerequisites) — FR-017 rebase re-verification

**Purpose**: 041 has modified the same files. Every deletion and consolidation target
claimed in research.md must be re-verified against post-041 `main` **before it is touched**.

**⚠️ CRITICAL**: No user story work may begin until this phase completes. Exclude
`.claude/worktrees/` from every grep — it holds ~45 stale full-repo copies.

- [ ] T004 Re-verify every US1 deletion target against post-041 `main` with fresh reference greps (`redis-persistence`, `getDiff(`, `baselineClock` in `server/undo/`, `claimUndo`/`claimRedo`/`insertLegacyUndone`/`EDIT_ORIGIN`/`HISTORY_ORIGIN`/`LEGACY_GAP_MS`, and the `useVersionHistory` legacy symbols); confirm counts match research.md R1-R6 and record any drift
- [ ] T005 Re-verify the backend refactor anchors in `server/version-history.js`, `server/postgres-persistence.js`, `server/undo/undo-service.js`, and `server/diff/apply-word-marks.js` — 041 rewrote `restoreVersion`'s delta source (FR-010's extraction target) and the drill-down `getUpdatesForVersion` (FR-015's `includeData` target), so re-derive both from post-041 code
- [ ] T006 [P] Re-verify the frontend anchors in `client/src/hooks/useVersionHistory.js`, `client/src/components/EditorView.jsx`, and `client/src/components/HierarchicalVersionList.jsx` — 041 may have added consumers of state FR-004 plans to delete, and its selection-reconciliation work rewrites FR-013's restore targeting
- [ ] T007 [P] Re-verify the dead-CSS determination against post-041 rendered markup in `client/src/components/VersionHistoryPanel.css` and `client/src/components/HierarchicalVersionList.css`; confirm `.version-history-error` is now referenced by 041's error rendering and MUST be kept
- [ ] T008 [P] Resolve DEC-5: grep for an `isMeaningful` helper introduced by 041. If 041 introduced one, FR-015's meaningfulness clause is **dropped** from this feature; if not, it proceeds as a pure refactor of the surviving predicates
- [ ] T009 Check the DEC-7 gate: confirm whether the Squire design amendment removing the `server/redis-persistence.js` reference (`design/authentication-and-sharing.md:19`) and the 24-hour Redis doc cache claim (`design/collaboration-core.md:23`) has landed via `node design/sync.mjs`. **If it has not, T011 is blocked and FR-002 is descoped** — record the outcome and its SC-002 consequence
- [ ] T010 Update `specs/042-version-history-simplification/clarifications-needed.md` with every claim that changed in T004-T009, per FR-017

**Checkpoint**: Every downstream task now references verified post-041 reality.

---

## Phase 3: User Story 1 - Dead code is gone (Priority: P1) 🎯 MVP

**Goal**: Every remaining line in the version-history/undo/diff area is live code.

**Independent Test**: Both suites green with no test modifications beyond deleted-code
tests; every SC-003 reference grep returns zero hits; the panel, undo/redo, and diff
preview behave identically by manual walk.

- [ ] T011 [US1] **GATED ON T009** — delete `server/redis-persistence.js` and `server/__tests__/redis-persistence.test.js` (FR-002); if T009 found the design amendment absent, skip this task and record the descope
- [ ] T012 [US1] Reduce the "ROOT CAUSE INVESTIGATION" block in the Redis pub/sub `onUpdate` handler in `server/index.js` to a plain apply, keeping `Y.applyUpdate(doc, updateData, ORIGIN_REDIS)` and the `try`/`catch` with its `[RedisPubSub] Error applying doc update for …` log; match the shape of the sibling `onAwareness` handler directly above (FR-003, SC-004)
- [ ] T013 [US1] Remove the legacy content path from `client/src/hooks/useVersionHistory.js`: `loadVersionContent`, `loadContentAtClock`, `loadPreviousContentAtClock` (never returned), the `versionContent` / `previousVersionContent` state (the latter is never set non-null), the `refresh` alias, and `clearSelection` (FR-004)
- [ ] T014 [US1] Remove the now-dangling destructures and the undeclared prop in `client/src/components/EditorView.jsx`: the `versionContent` / `previousVersionContent` / `clearSelection` destructure entries and the `versionContent={versionContent}` prop passed to `VersionPreview`, which does not declare it (FR-004)
- [ ] T015 [US1] Delete the test blocks whose sole subject is the removed hook symbols in `client/src/hooks/__tests__/useVersionHistory.test.js` (the `clearSelection` describe, the `refresh` test, and the `versionContent` assertions) (FR-004)
- [ ] T016 [US1] [P] Remove the `versionContent` and `clearSelection` mock entries from `client/src/components/__tests__/EditorView.banners.test.jsx` and `client/src/components/__tests__/EditorView.toolsmenu.test.jsx` (FR-004)
- [ ] T017 [US1] [P] Delete the dead pre-hierarchical flat-list blocks from `client/src/components/VersionHistoryPanel.css` (the `.version-history-view-toggle`/`.view-toggle-btn` family and the `.version-history-list` / `.version-group*` / `.version-item*` / `.version-author*` / `.version-menu-*` / `.version-expand-btn` families, ~234 lines), preserving every live block listed in research.md R4 and **keeping `.version-history-error`** (FR-005)
- [ ] T018 [US1] [P] Delete the dead blocks from `client/src/components/HierarchicalVersionList.css`: `.hierarchy-combined*`, `.hierarchy-breadcrumb*`, `.hierarchy-version-date`, `.hierarchy-version-edits` (~43 lines); keep `.hierarchy-loading`, which is live (FR-005)
- [ ] T019 [US1] [P] Stop exporting `claimUndo`, `claimRedo`, `insertLegacyUndone` from `server/undo/edit-records.js` and `EDIT_ORIGIN` / `HISTORY_ORIGIN` from `server/undo/inverse.js`, keeping the functions themselves where used internally (FR-006)
- [ ] T020 [US1] Stop exporting `LEGACY_GAP_MS` and delete the production-dead `baselineClock` branch (JSDoc `@param`, destructure, and branch body) from `server/undo/legacy.js`; do **not** touch `LEGACY_FRESHNESS_MS` or `_isIdentityRow`, which have live test importers (FR-006)
- [ ] T021 [US1] Delete the `baselineClock` test cases from `server/undo/__tests__/legacy.test.js`, leaving every other case untouched; do **not** touch the unrelated feature-004 `baselineClock` sync field in `server/api/docs-import.js`, `server/mcp/`, `markdown-sync.rejection.test.js`, `live-fanout.test.js`, or `__tests__/integration/sync-push.route.test.js` (FR-006)
- [ ] T022 [US1] [P] Delete `getDiff` from `server/postgres-persistence.js` and correct the doc comment that names it (FR-007)
- [ ] T023 [US1] [P] Add a consumer-naming comment above `getAllDocuments`, `getAllDocumentsWithMeta`, and `getDocumentMeta` in `server/postgres-persistence.js` citing the backfill script, the title migration, and the integration-test harness — do **not** move them (FR-007, DEC-2, contract C8)
- [ ] T024 [US1] Verify US1: run `npm run test:server` and `npm run test:client`, confirm no test file changed beyond T015/T016/T021 and the T011 deletion, and run every SC-003 reference grep from quickstart.md Step 2

**Checkpoint**: US1 independently shippable.

---

## Phase 4: User Story 4 - Cache-version automation (Priority: P3, sequenced 2nd)

**Goal**: A diff-pipeline source change invalidates stale cache entries with no human step.

**Independent Test**: An unchanged pipeline yields a stable namespace across restarts; a
scratch edit to any pipeline source changes it; reverting restores the original.

**Sequenced here (not by priority)** so that the US2 edits to `apply-word-marks.js` and
`diff-service.js` auto-invalidate the cache instead of relying on a manual bump mid-feature.

- [ ] T025 [US4] Add a deterministic source-fingerprint helper that digests the **contents** of `server/diff-service.js`, `server/diff/apply-word-marks.js`, and `shared/diff/word-diff.js` — sorted file list, normalized line endings, explicit encoding, and never paths, mtimes, or `__dirname` (FR-014, data-model E1)
- [ ] T026 [US4] Fold the fingerprint into the **exported** `CACHE_VERSION` in `server/diff-service.js` as `` `${humanVersion}.${fingerprint}` ``, leaving the key template and the 3600s TTL untouched so `server/__tests__/diff-service.test.js`'s cache-key assertion passes unmodified (FR-014, DEC-8, contract C3)
- [ ] T027 [US4] Verify US4: run the SC-006 scratch-edit demonstration from quickstart.md Step 2 in both directions, and confirm `git diff --stat server/__tests__/diff-service.test.js` is empty

**Checkpoint**: Manual cache bumps are gone; the pin test never moved.

---

## Phase 5: User Story 2 - Backend structure is single-sourced (Priority: P2)

**Goal**: One undo/redo core, one clock-range check, one diff traversal, and generic Yjs
surgery in the Yjs utility module.

**Independent Test**: Each refactor lands with the full affected suite passing unchanged;
the traversal merge is additionally gated on the pin tests passing byte-for-byte.

- [ ] T028 [US2] Add a single honest-empty result builder in `server/undo/undo-service.js` reproducing all **nine** current literals exactly (5 in `performUndo`, 4 in `performRedo` — the spec says five; research R7 corrects the count), including `success: true`, the per-mode `undone`/`redone` key, the verbatim messages, and a fresh `await currentMaxClock(...)` at each site (FR-008, contract C1)
- [ ] T029 [US2] Merge `performUndo` and `performRedo` into a single `performInverse(mode)` core in `server/undo/undo-service.js`, preserving every asymmetry in data-model E3 (undo's pending-recording guard and legacy fallback, the conditional `targetRange` on `finalizeClaim`, the differing success messages, and the `...(diff ? { diff } : {})` key-absence spread); keep `performUndo`/`performRedo` as exported wrappers so the module's export surface is unchanged (FR-008)
- [ ] T030 [US2] Add `getClockRange(docGuid)` to `server/postgres-persistence.js` as a `SELECT MIN(clock), MAX(clock)`, normalizing the single-row SQL `NULL` result for an empty log to the same values `Math.min`/`Math.max` produced (FR-009, data-model E2)
- [ ] T031 [US2] Add a shared range-check helper and use it to replace the full user-joined log read in `getContentAtClock` (`server/version-history.js`), preserving its exact error types and strings — `Document has no version history` as a `VersionNotFoundError` here, and the out-of-range message **without** the `versionId` prefix (FR-009, contract C2)
- [ ] T032 [US2] Replace the full-log read in `getVersionContent` (`server/version-history.js`) **on the named-version branch only**, preserving the clock-number branch's read because it also feeds meaningful-filtered metadata grouping; keep `Document has no version history` as a bare `Error` here and the out-of-range message **with** the `versionId` prefix (FR-009, contract C2, research R8)
- [ ] T033 [US2] Extract `cloneXmlElement` and the replace-delta construction from `restoreVersion` in `server/version-history.js` into `server/yjs-utils.js` as exported helpers, **behavior unchanged** — the delete-all+reinsert shape is preserved as-is per DEC-9, and no guard is added (FR-010, data-model E9)
- [ ] T034 [US2] Add unit tests for the newly exported Yjs surgery helpers in `server/__tests__/` covering `Y.XmlText` delta cloning, `Y.XmlElement` attribute and child cloning, and the non-Yjs-node null return (FR-010)
- [ ] T035 [US2] Merge the twin `plainTextOf` and `stampSide` traversals in `server/diff/apply-word-marks.js` into one walk emitting `{ text, nodeRefs }` that are index-consistent by construction, preserving the hard-break word-fusion behavior and the `loggedOnce` once-per-process logging (FR-011, data-model E5, contract C10)
- [ ] T036 [US2] Verify US2: run `npx jest server/undo server/__tests__/diff-service.test.js server/__tests__/diff-two-surface-parity.test.js server/__tests__/version-history.test.js --runInBand --forceExit` and confirm `git diff --stat` shows no test changes beyond T021's and T034's additions

**Checkpoint**: Backend duplications collapsed with every existing suite green.

---

## Phase 6: User Story 3 - Frontend structure is single-sourced (Priority: P3)

**Goal**: No pass-through-only prop forwarding, and one shared restore-confirmation flow.

**Independent Test**: Frontend suites green; a manual walk of both restore entry points
shows identical dialogs, messages, error handling, and post-restore navigation.

**⚠️ Weakest test net in the feature**: `VersionHistoryPanel.jsx` and `VersionPreview.jsx`
have **no** dedicated tests today (research R17). T037/T038 come first for that reason.

- [ ] T037 [US3] [P] Write characterization tests for `client/src/components/VersionHistoryPanel.jsx` in `client/src/components/__tests__/` pinning current rendered output: the empty state and its `.version-history-empty` / `.version-history-empty-hint` wrapper classes, the filter control, the highlight toggle, the footer edit count, and the close affordance (contract C6)
- [ ] T038 [US3] [P] Write characterization tests for `client/src/components/VersionPreview.jsx` in `client/src/components/__tests__/` pinning the `showDiff` on/off document selection, including the fallback to the diff-annotated document when the server sent no `currentDocument` (contract C10 — pin the quirk, do not fix it)
- [ ] T039 [US3] Create `client/src/contexts/VersionHistoryContext.jsx` carrying the 14 pure pass-through values listed in data-model E6, with a props-over-context shape so `client/src/components/__tests__/HierarchicalVersionList.test.jsx` continues to mount the component directly with props **unmodified** (FR-012, DEC-3)
- [ ] T040 [US3] Rewire `client/src/components/VersionHistoryPanel.jsx` to provide the context instead of forwarding, and `client/src/components/HierarchicalVersionList.jsx` to consume it, keeping panel-local chrome (`isOpen`, `onClose`, `totalEdits`, `showDiffHighlights`, `onToggleDiffHighlights`, `filter`) as props/state (FR-012, data-model E6)
- [ ] T041 [US3] Remove the duplicated empty-state JSX and the unreachable `isLoading` branch in `client/src/components/HierarchicalVersionList.jsx`, preserving which wrapper classes render under which condition and keeping the live `.hierarchy-loading` class used for "Loading updates..." (FR-012, contract C6, research R11)
- [ ] T042 [US3] Create `client/src/hooks/useRestoreFlow.js` exposing `open(target)` / `confirm()` / `cancel()` plus `busy` and `error`, taking the restore target as a **parameter** so the header's live `selection` and the row menu's open-time captured item both keep today's semantics (FR-013, data-model E7, contract C7)
- [ ] T043 [US3] Wire both restore entry points to `useRestoreFlow` — the header flow in `client/src/components/EditorView.jsx` and the row-menu flow in `client/src/components/HierarchicalVersionList.jsx` — preserving the dialog copy, each site's navigation guard, the row menu's dropdown close, and `fetchHistory()` staying inside `useVersionHistory.restoreVersion` (FR-013, contract C6/C7)
- [ ] T044 [US3] Verify US3: run `npm run test:client`, confirm `git diff --stat client/src/components/__tests__/HierarchicalVersionList.test.jsx` is empty, and manually walk both restore entry points

**Checkpoint**: Prop drill and twin restore flows gone; rendered output unchanged.

---

## Phase 7: User Story 5 - Small consolidations and honest comments (Priority: P4)

**Goal**: One definition per concept, and comments that describe the code as it is.

**Independent Test**: Suites green after each consolidation; grep shows one definition per
concept; corrected comments match actual behavior.

- [ ] T045 [US5] Add a shared `retryWithBackoff` helper and use it for the closure inside the `bindState` update listener in `server/index.js` (currently re-allocated on every Yjs update) and `_runStoreSlot` in `server/postgres-persistence.js`, preserving the identical `baseDelay * 2^(attempt-1) + Math.random()*50` formula and 3-attempt bound; leave `_fetchRowsWithGapRetry` and `MAX_CONFLICT_RETRIES` alone (FR-015, research R14)
- [ ] T046 [US5] **Conditional on T008** — if 041 did not introduce one, add a single `isMeaningful(update)` helper and use it for the surviving `u.meaningful !== false` predicates in `server/version-history.js`; this is a pure refactor of whatever predicate exists post-041, never a change to filtering behavior (FR-015, DEC-5)
- [ ] T047 [US5] Export a single `isSentinelOrigin()` from `server/origin.js` for the authoritative five-member check and correct the stale prose comments (`origin.js` lists only 2 of 5); **do not** unify the deliberate subsets at the publish and awareness skip-lists in `server/index.js`, which must stay different (FR-015, contract C9)
- [ ] T048 [US5] Add an `includeData` option to `getUpdatesInRange` in `server/postgres-persistence.js` with a default preserving today's behavior, and opt out at the two `server/version-history.js` call sites proven not to read the blob (`getUpdatesForVersion` and `getContentAtClock`); leave the three sites that do read it untouched (FR-015, data-model E8)
- [ ] T049 [US5] Co-locate the environment-knob parsing in `server/postgres-persistence.js` while **preserving read timing** — the pool knobs are read once at construction, the gap-retry knobs on every call (FR-015, contract C10)
- [ ] T050 [US5] [P] Skip the redundant document re-conversion in the identical-markdown early-return branch of `server/diff-service.js` (FR-015)
- [ ] T051 [US5] [P] Resolve the `formatDateTime` name collision by moving the `HierarchicalVersionList.jsx` and `AdminPage.jsx` variants into `client/src/utils/datetime.js` under distinct names and re-pointing their call sites, changing **zero** rendered strings and carrying the `'Never'` null-guard with its function; leave `formatVersionTimestamp` untouched (FR-015, DEC-10, contract C4)
- [ ] T052 [US5] [P] Extract a `clockRangeLabel` helper for the two repeated range-label sites in `client/src/components/HierarchicalVersionList.jsx`, emitting the **U+2013 EN DASH** exactly as today (FR-015, contract C5)
- [ ] T053 [US5] Extract `useYUndoState(editor)` into `client/src/hooks/useYUndoState.js` from the combined effect in `client/src/components/MobileActionBar.jsx`, splitting it out without changing the `selectionUpdate`/`transaction` subscriptions or their cleanup; no UI change, and do not touch the unrelated server-fetched `canUndo`/`canRedo` in `AiChatMessages.jsx` (FR-015, research R14)
- [ ] T054 [US5] [P] Correct the stale comments and JSDoc: the "toggled purely via CSS" claim in `client/src/components/VersionPreview.jsx`, the `computeDiff` result-shape JSDoc in `server/diff-service.js`, the two divergent shape comments in `client/src/hooks/useVersionHistory.js` plus the echo in `client/src/components/EditorView.jsx`, and the "client bundler can consume it" header in `shared/diff/word-diff.js` (FR-016, research R15)
- [ ] T055 [US5] Verify US5: run both suites and the SC-007 single-definition greps from quickstart.md Step 2

**Checkpoint**: All five stories complete.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T056 Run the full authoritative verification serially: `npm run migrate` (proves the title migration still resolves `getDocumentMeta`), `npm test`, `npm run build`
- [ ] T057 Measure SC-002 with `git diff --shortstat <merge-base> HEAD -- . ':(exclude)specs'` and confirm a net reduction of at least 600 lines; if T011 was skipped under the DEC-7 gate, record that the target is unreachable and needs renegotiating rather than padding other deletions (contract C11)
- [ ] T058 Complete the manual walk in quickstart.md Step 3 — timeline, drill-down, preview with diff highlights on and off, restore from both entry points, undo/redo after restore, filter toggling, in dark mode and at mobile width (SC-005)
- [ ] T059 Verify SC-004 on a two-instance setup: state converges, no `[RedisPubSub:ROOT_CAUSE]` output remains, and an induced apply error still logs `[RedisPubSub] Error applying doc update for …`
- [ ] T060 Confirm no new migrations were added and no test file changed beyond the permitted set, then record the final DEC-7 outcome in `specs/042-version-history-simplification/clarifications-needed.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies
- **Foundational (Phase 2)**: depends on Setup — **BLOCKS every user story** (FR-017)
- **US1 (Phase 3)**: after Foundational. T011 additionally gated on T009 (DEC-7)
- **US4 (Phase 4)**: after Foundational; independent of US1, sequenced 2nd deliberately
- **US2 (Phase 5)**: after Foundational; benefits from US4 landing first
- **US3 (Phase 6)**: after Foundational; T039-T043 depend on T037/T038 characterization tests
- **US5 (Phase 7)**: after Foundational; T046 depends on T008's DEC-5 outcome
- **Polish (Phase 8)**: after all stories

### Deliberate priority deviation

US4 is **P3** by spec priority but is sequenced **second**, before the P2 US2 work. Reason:
US2 edits `server/diff/apply-word-marks.js` and `server/diff-service.js`, which are
fingerprint inputs. Landing FR-014 first means those edits auto-invalidate the diff cache
instead of depending on a manual bump partway through the feature — which is the exact
failure mode US4 exists to remove. No requirement is weakened by the reordering.

### Within each story

- Deletions before the refactors that would otherwise have to preserve them
- Characterization tests before any US3 refactor
- Verification task last in every phase

### Parallel Opportunities

- **Phase 2**: T006, T007, T008 in parallel after T004/T005
- **US1**: T016, T017, T018, T019, T022, T023 all touch different files
- **US3**: T037 and T038 in parallel
- **US5**: T050, T051, T052, T054 all touch different files

Backend test runs are **never** parallel — serial-only against one database.

---

## Implementation Strategy

### MVP (US1 only)

Phases 1-3 deliver the entire deletion bundle: ~865 lines of dead code gone with zero
behavior risk, independently shippable. If DEC-7 blocks T011, the MVP still delivers
roughly 395 lines and the rest of US1 intact.

### Incremental delivery

1. Setup + Foundational → verified post-041 ground truth
2. + US1 → dead code gone (MVP)
3. + US4 → a whole failure mode removed
4. + US2 → backend single-sourced
5. + US3 → frontend single-sourced
6. + US5 → paper cuts gone

Each increment leaves both suites green and the product observably unchanged.

---

## Notes

- **The bar is "nothing happens."** Any observable difference other than removed diagnostic logging is a defect, not a judgement call.
- `contracts/behavior-preservation.md` is the authority on what must stay byte-identical — consult it before "tidying" any nearby string, shape, or quirk.
- Every line anchor in this file is pre-041 and must be re-derived in Phase 2.
- Permitted test modifications, exhaustively: `useVersionHistory.test.js` (deleted-symbol blocks), the two `EditorView.*.test.jsx` mock entries, `legacy.test.js` (`baselineClock` cases), the deleted `redis-persistence.test.js`, plus **new** files from T034/T037/T038.
