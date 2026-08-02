# Tasks: Version History Truth — Attribution Correctness and Failure-Path Honesty

**Input**: Design documents from `/specs/041-version-history-truth/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R16), data-model.md, contracts/, quickstart.md

**Tests**: INCLUDED — the spec mandates them (Assumptions: "every FR here is a behavioral change and ships with tests"; Constitution Principle II). Tests-first within each story where the test pins a lie (write it, watch it fail, fix it).

**Organization**: By user story, in spec priority order. **US1 is the top-priority cluster** (Sam-relayed bidirectional A1 reproduction, ledger N-041-1).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Files can be EDITED in parallel (different files, no dependency). ⚠️ **Backend test RUNS are always serial** (`--runInBand`, one shared DB per worktree) — [P] never means "run jest concurrently".
- Paths are absolute-repo-relative from `/local-dev/`.

## Overrides in force (pipeline)

Stay on `main`; never branch, never commit (the implement/merge stages own commits). Never edit `CLAUDE.md`, `README.md`, `docs/dev.md` (README drift is a merge-queue obligation — plan.md "Merge-queue notes"). **No migrations** — if any task seems to need one, STOP and escalate (slots are globally serialized; RBD-041-9 exists precisely to avoid this).

---

## Phase 1: Setup

**Purpose**: Confirm a green baseline so every later failure is attributable to this feature.

- [x] T001 Run the affected suites serially and record the baseline: `npx jest server/__tests__/version-history.test.js server/__tests__/origin.test.js server/__tests__/undo-status-api.test.js server/undo/__tests__ --runInBand` and `cd client && npx vitest run src/hooks/__tests__/useVersionHistory.test.js src/components/__tests__/HierarchicalVersionList.test.jsx`. All green before any edit; note any pre-existing red in specs/041-version-history-truth/clarifications-needed.md.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: None required — the seven stories share no new blocking infrastructure (the two small shared helpers land inside their owning stories: `computeRangeMeta`/`isMeaningful` in US1, `peekSharedDoc` in US4). Stories are independently implementable after Phase 1.

**Checkpoint**: Phase 1 green ⇒ all user stories may begin.

---

## Phase 3: User Story 1 — Named versions and drill-downs credit exactly the right people (Priority: P1) 🎯 MVP — TOP-PRIORITY CLUSTER (N-041-1)

**Goal**: Named versions, split fragments, and drill-downs derive authors/on-behalf-of/counts from their OWN clock range under the timeline's meaningful rule (FR-001..004; contracts/range-scoped-version-meta.md; research R1/R2/R16).

**Independent Test**: spec US1 — name a version over A's sub-range of a shared burst: only A credited on it, only B on B's fragment (both directions); drill-down counts match the timeline.

### Tests for User Story 1 (write FIRST, watch them fail)

- [x] T002 [US1] **PINNED (N-041-1): bidirectional split regression test** in server/__tests__/version-history.test.js — one burst: user A rows clocks 1–5, user B rows clocks 6–10; (a) named version over 1–5 ⇒ its authors = [A] only, the 6–10 fragment's authors = [B] only; (b) mirrored: named version over 6–10 ⇒ [B] only, and the 1–5 fragment [A] only; (c) onBehalfOf provenance likewise scoped per range (a sync-push row in one sub-range never appears on the other). Drive `mergeNamedVersions`/`getVersionTimeline` directly with a mock persistence.
- [x] T003 [US1] A7/noise-edge tests in server/__tests__/version-history.test.js (same file as T002 — sequential): named version whose `clock_end` row is noise-classified still resolves authors+timestamp from its own range; noise-only named range falls back to the UNFILTERED in-range rows (R16 — real authors, never phantom outside-range ones); genuinely row-less range ⇒ empty authors; all-unattributed range ⇒ single Unknown-author entry (040 FR-008 preserved).
- [x] T004 [US1] Drill-down parity tests in server/__tests__/version-history.test.js (same file — sequential): range containing noise rows ⇒ `getUpdatesForVersion` emits no noise-only sub-group (unknown-classified groups ARE emitted); each `updateCount` = surviving rows only (never `clockEnd - clockStart + 1`); Σ drill-down counts == timeline accounting for the same range (SC-002).

### Implementation for User Story 1

- [x] T005 [US1] In server/version-history.js: add `isMeaningful(u)` (`u.meaningful !== false`) and pure `computeRangeMeta(updates, clockStart, clockEnd)` → `{authors, onBehalfOf, onBehalfOfMore, timestamp}` per research R1/R16 (author keying/UNKNOWN_AUTHOR/dedupeOnBehalfOf identical to `groupUpdatesIntoVersions`; timestamp = last in-range row; noise-only fallback to unfiltered in-range rows; empty only for row-less range).
- [x] T006 [US1] In server/version-history.js: `mergeNamedVersions(autoVersions, namedVersions, updates)` — use `computeRangeMeta` at ALL THREE inheritance sites: named-version objects (:294-303, replacing `matchingAutoVersion?.authors || []`; `matchingAutoVersion` survives only as a timestamp fallback layer), the post-named fragment spread (:335-341), and the pre-named fragment spread (:349-357). Update the caller `getVersionTimeline` (:435) to pass its meaningful-filtered `updates`; update existing direct `mergeNamedVersions` unit tests for the new signature.
- [x] T007 [US1] In server/version-history.js `getUpdatesForVersion` (:754-792): filter with `isMeaningful` BEFORE grouping; compute each sub-version's `updateCount` as the number of surviving rows grouped into it; replace the three inline `meaningful !== false` predicates (:419, :540, new site) with `isMeaningful`.
- [x] T008 [US1] Serial run: `npx jest server/__tests__/version-history.test.js --runInBand` — T002–T004 green, zero regressions in the rest of the suite (SC-001/SC-002).

**Checkpoint**: US1 independently shippable — the attribution lie is dead in both directions.

---

## Phase 4: User Story 2 — Failures look like failures, never like an empty or new document (Priority: P1)

**Goal**: History/diff failures render error states with retry (FR-005/006); a document-load failure refuses the bind instead of serving a blank doc (FR-010; contracts/bind-failure.md; research R3/R7; RBD-041-1).

**Independent Test**: spec US2 — failing history + diff endpoints render error states (no empty-state text); storage failure on a doc with content refuses the bind; genuinely new doc still opens.

### Client — error states (FR-005, FR-006)

- [x] T009 [US2] In client/src/hooks/useVersionHistory.js: split preview failures into new `diffError` state (set in `selectVersion`/`selectUpdate` catch blocks, cleared on new selection/success; timeline+CRUD keep `error`); expose both plus `fetchHistory` as the retry affordance (research R3).
- [x] T010 [US2] Wire list error UI: client/src/components/EditorView.jsx destructures `error` + passes `error`/`onRetry` into VersionHistoryPanel; client/src/components/VersionHistoryPanel.jsx renders the error state + Retry button using the existing `.version-history-error` CSS (VersionHistoryPanel.css:160-171 — do NOT let 042's dead-CSS pass delete it) and gates the empty state on `!error && !isLoading && versions.length === 0` (empty text only for a successful zero-version response).
- [x] T011 [US2] Wire preview error UI: client/src/components/VersionPreview.jsx takes `diffError`; renders an error state when set; the "Select a version to preview" placeholder renders ONLY when nothing is selected (`!selection`); EditorView.jsx passes `diffError` through.
- [x] T012 [P] [US2] Client tests: extend client/src/hooks/__tests__/useVersionHistory.test.js (error vs diffError independence; retry re-fetches); NEW client/src/components/__tests__/VersionHistoryPanel.test.jsx (error state + working retry rendered on failure; "No version history yet" only on successful empty; SC-003); NEW client/src/components/__tests__/VersionPreview.test.jsx (diffError ⇒ error state; placeholder only with no selection).

### Server — bind refusal (FR-010)

- [x] T013 [US2] In server/index.js bindState catch (:469-474), implement contracts/bind-failure.md: `notifyException(error, { source: 'bindState', extra: { docGuid } })`; error-level log (NEVER the `NEW DOC` info line / `BIND_STATE_NEW_DOC` perf event on this path); set `ydoc._bindFailed = true`; evict via `docs.delete(docName)` (y-websocket `docs` map — import from `y-websocket/bin/utils` alongside `getYDoc` at :43); close every conn on the doc with code 1013; make the update listener drop persist attempts while `_bindFailed`. If the inline closure resists testing, extract the load-and-bind step into a named function exported for tests — behavior identical.
- [x] T014 [US2] Tests for FR-010: NEW __tests__/integration/bind-failure.test.js (or server/__tests__/bindstate-failure.test.js against the extracted function) — throwing `getYDoc` ⇒ notifier paged, doc evicted from `docs`, conns closed 1013, no NEW-DOC logging, no persisted rows; PIN the legitimate path: zero-rows document binds normally as empty (persistence `getYDoc` does not throw for no rows) — SC-004. Run serially with the integration suite.

**Checkpoint**: US1+US2 independently functional — the two P1 lies (wrong credit, fake emptiness) are gone.

---

## Phase 5: User Story 3 — The open history panel stays truthful over time (Priority: P2)

**Goal**: Selection reconciled after every refresh (FR-007, RBD-041-8), live refresh by poll (FR-008, R5), expanded drill-downs re-fetch (FR-009) — research R4/R5/R6.

**Independent Test**: spec US3 — rename/mid-range-name with the panel open updates header/contributors/restore gating; expanded rows never show false "No individual updates".

### Implementation for User Story 3

- [ ] T015 [US3] In client/src/hooks/useVersionHistory.js: post-refresh selection reconciliation (R4) — after every `fetchHistory` resolution, re-resolve a live selection to the fresh version containing the old selection's `clockEnd`, else the default-selection rule; adopt the FRESH object (id/name/range/isCurrent); re-run the diff load ONLY when the (clockEnd, previousClock) pair changed; sub-version selections reconcile against their containing version.
- [ ] T016 [US3] In client/src/hooks/useVersionHistory.js: live refresh poll (R5) — 10 s `setInterval` while the hook has a `docGuid`, skipping ticks when `document.hidden`, cleaned up on unmount/doc change; a failed tick keeps the last-good list AND sets `error` (no implicit clear, no selection loss).
- [ ] T017 [US3] In client/src/components/HierarchicalVersionList.jsx: expanded-row re-fetch effect (R6) — any expanded id present in the fresh list with no `versionUpdates[id]` and not loading triggers `onLoadUpdates` with the FRESH range; expanded ids absent from the fresh list are dropped from `expandedVersions`; "No individual updates" renders only after a successful zero-subversion response (loading state wins).
- [ ] T018 [P] [US3] Tests: extend client/src/hooks/__tests__/useVersionHistory.test.js (fake timers: poll cadence, hidden-tab skip, failed-tick behavior; reconcile on rename/resplit/delete — deleted selection re-resolves, never retained; diff reload only on range change — SC-005/SC-006) and client/src/components/__tests__/HierarchicalVersionList.test.jsx (re-fetch after cache wipe, expansion drop for vanished ids, no false empty text).
- [ ] T019 [US3] Verify the header restore path end-to-end in a component test (client/src/components/__tests__/EditorView.banners.test.jsx style, or a focused new EditorView.versionhistory.test.jsx): after a simulated mid-range naming refresh, the header "Restore this version" posts a version id that EXISTS in the post-split list (spec US3 scenario 2).

**Checkpoint**: The open panel tracks reality; all client-side truth fixes complete.

---

## Phase 6: User Story 4 — Restore does exactly what its label claims (Priority: P2)

**Goal**: Live-doc restore delta in a transaction (FR-011), tail-complete target read (FR-012), honest is-loaded probe with no doc leak (FR-013) — contracts/restore-live-delta.md; research R8/R9/R10; RBD-041-2.

**Independent Test**: spec US4 — restore under concurrent typing stores the actual transition; short-tail log refuses; unopened-doc restore leaves server memory unchanged.

### Implementation for User Story 4

- [ ] T020 [US4] In server/document-service.js: add `peekSharedDoc(docGuid)` returning `docsMap.get('s/' + docGuid) || null` — NEVER creates; extend `init` to accept the y-websocket `docs` map and pass it from server/index.js:1917 (map already exported by `y-websocket/bin/utils`; re-export from index.js's exports block at :2333 for tests).
- [ ] T021 [US4] Switch is-loaded consumers to the peek (R10): `undo-service.resolveDeps` default `getSharedDoc` (server/undo/undo-service.js:54-60), the REST restore route deps (server/index.js:1531), and the MCP tool deps (server/mcp/tools/restore-document-version.js:94). EXPLICITLY unchanged: `getSharedDoc` for `updateDocument` (modify/import) and the WS-setup `getYDoc` (index.js:2142).
- [ ] T022 [US4] In server/postgres-persistence.js `getYDocAtClock` (:783-798): add `expectedTailClock` option forwarded to `_fetchRowsWithGapRetry` (same semantics/caution comment as `getUpdateRowsUpTo` :806-821 — never derived from `clock`); in server/version-history.js `getVersionContent`, pass `expectedTailClock: clockEnd` ONLY on the `withGap: true` path (safe: clockEnd is min/max-validated first — R9).
- [ ] T023 [US4] In server/version-history.js `restoreVersion`: live path per contracts/restore-live-delta.md — peek for a local live doc; when present, run the delete-and-reclone replace inside `liveDoc.transact(fn, ORIGIN_RESTORE)` with an origin-scoped update-capture listener; `storeUpdate` the captured bytes (`meaningful: true`); `publishIfUnhandled` when no Redis handler was attached; skip `applyLiveUpdate` on this path. Not-loaded path byte-identical to today. Document BOTH residuals in the function header: cross-pod serialization out of scope (RBD-041-2) and live-path broadcast-then-store ordering (B1/038 accepted posture).
- [ ] T024 [P] [US4] Tests (serial runs): extend server/__tests__/version-history.test.js — restore refuses on short-tail target read (nothing stored; `DocumentSyncingError`); live-path test: concurrent transaction on the live doc during restore ⇒ stored row equals the transition applied to the live doc, exactly one stored row, fan-out fired once; not-loaded path regression (existing tests stay green). Extend a persistence test (server/__tests__/postgres-gap-read.test.js or sibling) for `getYDocAtClock` + `expectedTailClock` short-tail ⇒ `gapped: true`.
- [ ] T025 [US4] No-leak test (SC-009): in server/undo/__tests__/undo-service.test.js and/or the version-history suite — restore, undo, and redo of a document loaded nowhere leave the y-websocket `docs` map size unchanged; `applyLiveUpdate`'s not-loaded warn path is reachable.

**Checkpoint**: Restore's stored record, fail-closed guarantee, and memory behavior are honest.

---

## Phase 7: User Story 5 — Undo is available when it should be, and "Reverted" never lies (Priority: P2)

**Goal**: Sync rows never fake "still being recorded" (FR-014); the Reverted stamp is verified against the record actually undone (FR-015) — contracts/undo-result-and-stamp.md; research R11/R12; RBD-041-3. **Nothing cut by 040 D19 is revived.**

**Independent Test**: spec US5 — undo immediately after reconnect catch-up proceeds; a card whose edit is not the undone record is never stamped.

### Implementation for User Story 5

- [ ] T026 [US5] In server/undo/edit-records.js `hasPendingRecording` (:189-211): add `AND via_sync IS NOT TRUE` to the newest-row probe; test in server/undo/__tests__/edit-records.test.js — fresh `via_sync=true` newest row does NOT report pending (undo-status and undo proceed, SC-007); a genuine unrecorded fresh edit still does.
- [ ] T027 [US5] In server/undo/undo-service.js: additive result fields per contracts/undo-result-and-stamp.md — `undoneRecordRange` (performUndo success) and `redoneRecordRange` (performRedo success), both from the claimed row's `editClockStart`/`editClockEnd`; honest-empty results unchanged; tests in server/undo/__tests__/undo-service.test.js (fields present on success, absent on every honest-empty).
- [ ] T028 [US5] In server/index.js `makeUndoRedoHandler`/`setChatPartReverted` (:1582-1615): verified stamp per the contract — locate the part, read `part.output?.editRange`, stamp ONLY on exact bound equality with `undoneRecordRange`/`redoneRecordRange`; skip + one structured warn on mismatch OR missing/malformed card range (pre-016 and editRangePending cards = mismatch by rule); refactor `setChatPartReverted` minimally so find-and-compare happens without loading the chat twice; HTTP response identical whether stamped or skipped.
- [ ] T029 [US5] Route tests in server/__tests__/undo-status-api.test.js (or a sibling undo-stamp.test.js): matching card ⇒ stamped; range-mismatch card (cross-chat shape: undone record ≠ card range) ⇒ NOT stamped + log line; card with no stored `editRange` ⇒ not stamped + logged; arbitrary `toolCallId` via direct POST ⇒ unrelated card untouched (SC-008); redo symmetric (unstamp verified the same way); undo/redo result body unchanged in all cases.

**Checkpoint**: The undo surface is available when it should be and never labels the wrong card.

---

## Phase 8: User Story 6 — Silent degradations become loud (Priority: P3)

**Goal**: Null/primitive origins degrade loudly (FR-017, RBD-041-9); the inverse spanning fallback enforces the sync exclusion (FR-016, RBD-041-5) — research R13/R14.

### Implementation for User Story 6

- [ ] T030 [P] [US6] In server/origin.js (:186): final fallback returns `malformedOrigin: 'null-or-primitive'` with a guarded `console.error` (include `typeof origin` + stringified slice); in server/index.js (:328) extend the notification branch to page `'null-or-primitive'` exactly like `'non-uuid-string'`; `'unrecognized-object'` unchanged. Tests: server/__tests__/origin.test.js (`parseOrigin(null)`, `(42)`, `(true)`, `(undefined)` ⇒ marker + unattributed identity) and the listener-notification test asserting the page + that the row still persists unattributed (SC-010). NO schema change (RBD-041-9).
- [ ] T031 [P] [US6] In server/undo/inverse.js (:105-113): in the spanning-range (no-`clockSet`) branch, never track rows with `viaSync === true` (guard preferred per RBD-041-5); test in server/undo/__tests__/inverse.test.js — a same-identity `viaSync: true` row inside a legacy spanning range is NOT inverted; legacy non-sync behavior byte-identical (if the guard provably changes a legitimate legacy scenario, fall back to the load-bearing invariant comment and record the choice in clarifications-needed.md).

**Checkpoint**: No degradation path in scope is silent.

---

## Phase 9: User Story 7 — The code's own story matches the shipped behavior (Priority: P3)

**Goal**: Post-040-D19 truth on the three named surfaces (FR-018, FR-019) — research R15.

### Implementation for User Story 7

- [ ] T032 [P] [US7] Rewrite server/agent-identity.js docstring (:18-30): CHAT_AGENT_NAME no longer claims web-UI restores are recorded under it; describe actual uses (assistant's own chat modify edits; chat undo/redo endpoints resolving the same identity). Sweep server/undo/edit-records.js sentinel comment (:24-46) for any remaining pre-cut phrasing ("is what a human web-UI restore now records under"-era claims) — the comment must read: chat-assistant identity = the assistant's own modify edits only.
- [ ] T033 [P] [US7] Update server/mcp/tools/restore-document-version.js description (:28-49): an agent's restore is itself a recorded edit that the agent's own `undo` tool can invert, in addition to counter-restore (matches the design amendment and surviving 023 FR-020 behavior).
- [ ] T034 [US7] SC-011 sweep: `git grep -n "web-UI restore\|web UI restore" server/` and read the three surfaces — zero pre-cut claims remain; extend server/__tests__/agents-md-claims.test.js-style assertion ONLY if a cheap grep-pin fits naturally, else record the sweep result in the implement report.

**Checkpoint**: All 19 FRs implemented.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T035 Full serial verification per quickstart.md: backend `npx jest server/__tests__ server/undo/__tests__ __tests__/integration --runInBand` (or the project's standard serial invocation) and client `npx vitest run`; every FR row in the quickstart matrix has a passing test; zero regressions.
- [ ] T036 Guard-rail audit: confirm NO migration files added under migrations/; confirm nothing revived from the 040 D19 cut (no `agent_edits` write for `agentName === null` restores — the `if (agentName)` gate in server/version-history.js untouched; no offer-guard machinery); confirm `design/collaboration-core.md` 2026-08-02 amendment still holds against the diff.
- [ ] T037 Record implement-stage deviations/decisions (if any) in specs/041-version-history-truth/clarifications-needed.md; assemble the merge-queue handoff notes from plan.md (README drift check; `.version-history-error` CSS now LIVE — flag to 042; manual-check list from quickstart.md for Sam).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1**: none — start immediately.
- **Phase 2**: empty (documented) — no blocker.
- **Phases 3–9 (US1–US7)**: each depends only on Phase 1. All seven stories are mutually independent EXCEPT: T021/T023 (US4) and T027/T028 (US5) both touch server/undo/undo-service.js and server/index.js — implement US4's T020–T021 before US5's T027–T028 or coordinate edits (same-file conflicts, not semantic dependencies). US1 first regardless (top-priority cluster, N-041-1).
- **Phase 10**: after all implemented stories.

### Story order (single implementer, recommended)

US1 → US2 → US3 → US4 → US5 → US6 → US7 → Polish. (US3 depends on nothing in US2 but shares useVersionHistory.js/EditorView.jsx with it — keep them adjacent to minimize re-reading.)

### Parallel Opportunities

- Within US2: T012 (client tests) in parallel with T013/T014 (server bind work) — disjoint files.
- US6 (T030, T031) and US7 (T032, T033) are fully parallel with each other and with US3 (disjoint files).
- ⚠️ Backend test EXECUTION is serial always (`--runInBand`, shared per-worktree DB) — parallelism applies to editing, never to jest runs.

---

## Implementation Strategy

**MVP = Phase 1 + Phase 3 (US1)**: the bidirectional attribution fix alone is shippable and validatable (T002 is the pinned proof). Then US2 (the second P1) completes the honesty pair. Each later story is an independent increment with its own checkpoint; stopping after any checkpoint leaves main consistent and green.

Task count: 37. FR coverage: FR-001..004 (T002–T008), FR-005/006 (T009–T012), FR-010 (T013–T014), FR-007..009 (T015–T019), FR-011..013 (T020–T025), FR-014/015 (T026–T029), FR-016/017 (T030–T031), FR-018/019 (T032–T034).
