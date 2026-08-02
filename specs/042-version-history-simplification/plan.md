# Implementation Plan: Version History Simplification

**Branch**: `042-version-history-simplification` (parallel-pipeline feature; planning happens on `main`, implementation in a worktree branched off post-041 `main`) | **Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/042-version-history-simplification/spec.md`

## Summary

Behavior-preserving cleanup of the version-history / undo / diff area: delete one
production-dead persistence module and its test, strip a hot-path diagnostic block,
remove a superseded frontend content path and ~277 lines of dead CSS, unexport six
symbols and delete a production-dead branch, then collapse six structural duplications
(undo/redo cores, clock-range validation, restore's Yjs surgery, twin diff traversals,
the frontend prop drill, the twin restore flows), automate the diff cache-version bump
with a source fingerprint, and consolidate a long tail of small duplications and stale
comments.

The hard constraint (FR-001) is zero behavior change. The technical approach is
therefore **invariant-pinning first, refactor second**: every change is gated on the
pre-existing suites passing *unmodified*, and the invariants those suites pin only
implicitly (error strings, the diff cache-key shape, rendered date strings, the
honest-empty response shapes) are enumerated in
[`contracts/behavior-preservation.md`](./contracts/behavior-preservation.md) and
checked by construction rather than by hope.

Two facts discovered during planning shape the whole plan:

1. **FR-002 is not design-neutral.** `design/authentication-and-sharing.md:19` names
   `server/redis-persistence.js` by path, and `design/collaboration-core.md:23` lists a
   "24-hour Redis doc cache" among "the only materialized states". That cache exists
   *only* in the module FR-002 deletes, and nothing wires it up today — so the design
   docs are already stale, and deleting the file makes one of them reference a
   nonexistent path. Under Constitution Principle VI this MUST be resolved by amending
   the source Squire documents and re-syncing, which this feature cannot do itself.
   See **DEC-7** and the Constitution Check below. **This gates FR-002.**
2. **FR-014 can be made test-transparent.** `server/__tests__/diff-service.test.js:712`
   pins the cache key as `` `diff${CACHE_VERSION}:test-doc:-1:0` `` using the module's
   *exported* `CACHE_VERSION`. If the fingerprint is folded **into** that exported
   constant rather than appended at the key-build site, the pin test passes unmodified
   and FR-001/SC-001 hold. See **DEC-8**.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS on the server), React 18 + JSX (ESM in `client/`)

**Primary Dependencies**: Express, y-websocket, Yjs, `@tiptap/y-tiptap`, PostgreSQL (`pg`, node-pg-migrate), Redis (`ioredis`), Vite

**Storage**: PostgreSQL (`yjs_updates`, `documents`, `document_versions`, `agent_edits`); Redis as an optional 1-hour diff cache. **No new migrations** — this feature adds no schema change (spec acceptance bar).

**Testing**: Backend Jest via `npm run test:server` (`--runInBand --forceExit`, LLM reporter); frontend Vitest via `npm run test:client`. Backend suites are serial-only against one database; implementers MUST use a per-worktree DB (`createdb collab_test_db_042` + `DATABASE_URL=…collab_test_db_042`), because `server/__tests__/helpers/db.js:getTestDatabaseUrl()` short-circuits on `DATABASE_URL` and `globalSetup.js` migrates whatever URL it resolves.

**Target Platform**: Linux server (k3s), evergreen browsers

**Project Type**: Web application — Express/y-websocket backend + React SPA, with `shared/` code consumed by both

**Performance Goals**: Strictly non-regressive, with two intended improvements: the cross-instance fan-out handler drops per-update `encodeStateVector`/`diffUpdate`/`decodeStateVector` + two `toArray()` walks + 8 `console.log`s (SC-004); `getVersionContent`/`getContentAtClock` stop materializing the full user-joined update log for a min/max check (FR-009).

**Constraints**:
- **FR-001 zero behavior change.** Pre-existing suites pass *unmodified* except those whose sole subject is deleted code. Only permitted observable delta: removed diagnostic logging.
- **No new migrations**, and `migrations/1766103664104_add-title-to-documents.js:1,80` imports `PostgresPersistence` and calls `getDocumentMeta` — so the persistence module's export shape is a migration ABI. Breaking it breaks `globalSetup.js`, which runs `npm run migrate` before *every* backend test run (DEC-2).
- **Merges after 041.** FR-017's rebase-time re-verification is task T001 and blocks everything.

**Scale/Scope**: ~11 backend files, ~8 client files, 2 CSS files, 1 shared file. Deletion budget available: ~865 lines of pure deletion (see Complexity Tracking on SC-002) against a ≥600-line net target.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design.*

| Principle | Gate | Verdict |
|---|---|---|
| **I. Documentation Reflects Reality** | Does this change behavior/APIs/workflow described in `README.md` or `docs/dev.md`? | **PASS.** No user-visible behavior, API, or workflow change (FR-001). Parallel-pipeline overrides forbid editing those files from this agent; the merge queue reconciles docs. FR-016's corrections are in-code comments, not the governed docs. |
| **II. Test-Backed Changes** | Behavioral changes covered by tests; affected suites pass; backend serial. | **PASS with a caveat.** There is no behavioral change to cover, and the acceptance bar is *stronger* than the principle: pre-existing suites must pass unmodified. Caveat: `VersionHistoryPanel.jsx` and `VersionPreview.jsx` have **zero** dedicated test files, so US3 refactors an untested surface. Plan response: characterization tests are added **before** the US3 refactor — new tests over existing behavior, not modifications of existing ones. |
| **III. Trunk-Based Solo Workflow** | No ceremony for its own sake. | **PASS.** No new process. Implementation is a worktree branch per the pipeline's collision rules, merged serially. |
| **IV. Collaboration-Safe Document Operations** | No delete-and-recreate of live document content; structural targeting; single format registry. | **PASS, with an explicit recorded tension.** FR-010 *moves* `restoreVersion`'s existing delete-all+reinsert delta build (`version-history.js:661-677`) into `server/yjs-utils.js` unchanged. That shape is in tension with Principle IV, but *changing* it is a behavior change forbidden by FR-001. The move is byte-preserving; the tension is recorded, not resolved. See **DEC-9**. |
| **V. Secure by Default** | New ingestion surfaces, sandbox, ACLs. | **PASS.** No new surface, endpoint, or input path. FR-014's fingerprint digests first-party source files at startup only. |
| **VI. Design Docs Are Ground Truth** | Code/spec disagreement with `design/` must be flagged in the ledger, never resolved ad hoc; exports must not be hand-edited; falsified mechanisms must be amended in the same effort. | **⚠️ FAIL — unresolved at plan time.** FR-002 deletes a module two design exports describe as live (`design/authentication-and-sharing.md:19`, `design/collaboration-core.md:23`). Constitution VI requires the source Squire docs be amended and re-synced via `node design/sync.mjs`; `design/` exports MUST NOT be hand-edited, and this planning agent cannot author Squire docs. Flagged as **DEC-7** in the ledger (as Principle VI requires) and surfaced as the analyze gate's blocking finding. **FR-002 must not be implemented until the amendment lands.** |

**Post-Phase-1 re-evaluation**: unchanged. Phase 1 introduced no new violations; DEC-9 was
surfaced *by* the Phase 1 design work and is recorded rather than silently absorbed. The
Principle VI failure is a spec-scope gap, not a design defect, and is resolvable by an
orchestrator action outside this feature.

## Project Structure

### Documentation (this feature)

```text
specs/042-version-history-simplification/
├── plan.md                              # This file
├── spec.md                              # Input
├── clarifications-needed.md             # DEC-1..DEC-6 (given) + DEC-7..DEC-10 (added here)
├── research.md                          # Phase 0 output
├── data-model.md                        # Phase 1 output
├── quickstart.md                        # Phase 1 output
├── contracts/
│   └── behavior-preservation.md         # Phase 1 output — the invariant contract
├── checklists/requirements.md           # From spec phase
└── tasks.md                             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
server/
├── redis-persistence.js                 # FR-002 DELETE (gated on DEC-7)
├── index.js                             # FR-003 (ROOT CAUSE block 2168-2204), FR-015 (retry 363-379)
├── version-history.js                   # FR-009, FR-010, FR-015 (includeData, isMeaningful)
├── postgres-persistence.js              # FR-007, FR-009 (getClockRange), FR-015 (retry, includeData, env)
├── yjs-utils.js                         # FR-010 destination (currently 79 lines, 2 exports)
├── diff-service.js                      # FR-014 (CACHE_VERSION), FR-015 (skip re-conversion), FR-016 (JSDoc)
├── origin.js                            # FR-015 (isSentinelOrigin)
├── diff/apply-word-marks.js             # FR-011 (plainTextOf + stampSide merge)
├── undo/
│   ├── undo-service.js                  # FR-008 (performInverse + honest-empty builder)
│   ├── edit-records.js                  # FR-006 (unexport claimUndo/claimRedo/insertLegacyUndone)
│   ├── inverse.js                       # FR-006 (unexport EDIT_ORIGIN/HISTORY_ORIGIN)
│   └── legacy.js                        # FR-006 (unexport LEGACY_GAP_MS; delete baselineClock branch)
├── __tests__/redis-persistence.test.js  # FR-002 DELETE
└── undo/__tests__/legacy.test.js        # FR-006 (delete baselineClock test blocks)

shared/diff/word-diff.js                 # FR-016 (false "client bundler" header claim)

client/src/
├── hooks/useVersionHistory.js           # FR-004, FR-016
├── hooks/useRestoreFlow.js              # FR-013 NEW
├── hooks/useYUndoState.js               # FR-015 NEW (extracted from MobileActionBar)
├── contexts/VersionHistoryContext.jsx   # FR-012 NEW (DEC-3 default)
├── components/
│   ├── EditorView.jsx                   # FR-004 (destructure 162/163/173, prop at 405), FR-013
│   ├── VersionHistoryPanel.jsx          # FR-012
│   ├── VersionHistoryPanel.css          # FR-005 (~234 dead lines; KEEP .version-history-error)
│   ├── HierarchicalVersionList.jsx      # FR-012, FR-013, FR-015 (formatDateTime, clockRangeLabel)
│   ├── HierarchicalVersionList.css      # FR-005 (~43 dead lines)
│   ├── VersionPreview.jsx               # FR-016 (false "toggled purely via CSS" comment)
│   ├── MobileActionBar.jsx              # FR-015 (useYUndoState extraction source, 12-57)
│   └── AdminPage.jsx                    # FR-015 (local formatDateTime, 188-193)
└── utils/datetime.js                    # FR-015 (name-collision resolution — see DEC-10)

design/                                  # READ-ONLY to this feature (Constitution VI); DEC-7 gate
migrations/                              # UNTOUCHED — no new migrations
```

**Structure Decision**: The existing web-app layout is kept exactly as-is. This feature
adds four files and deletes two (`server/redis-persistence.js` and its test). No module
is relocated across a package boundary — notably `getAllDocuments*`/`getDocumentMeta`
stay in `server/postgres-persistence.js` because a shipped migration imports them
(DEC-2), and `server/undo/legacy.js` stays entirely (spec Non-Goals).

## Implementation Sequencing

Story order is driven by rebase risk against 041, not by value alone.

| Order | Story | Rationale |
|---|---|---|
| 0 | **Rebase re-verification (FR-017)** | Blocks everything. 041 modifies `version-history.js`, `postgres-persistence.js`, `undo/edit-records.js`, `useVersionHistory.js`, `EditorView.jsx`. Every deletion/consolidation target is re-greped against post-041 `main` before it is touched. |
| 1 | **US1 pure deletions** (FR-002 gated on DEC-7) | Zero-risk, largest LOC win, shrinks the surface later refactors must reason about. |
| 2 | **US4 cache fingerprint** (FR-014) | Independent of everything else; landing it early means a pipeline-source edit in US2 auto-invalidates the cache instead of relying on a manual bump mid-feature. |
| 3 | **US2 backend structure** (FR-008..FR-011) | Guarded by the strongest existing suites (`undo-service.test.js` 607 lines, `inverse.test.js` 591, `diff-service.test.js` 1276, the two-surface parity pin test). |
| 4 | **US3 frontend structure** (FR-012, FR-013) | Highest 041 overlap and the weakest test net — needs characterization tests first. |
| 5 | **US5 long tail** (FR-015, FR-016) | Small and independent, and FR-015's `isMeaningful` clause is conditional on what 041 landed (DEC-5), so it benefits from being last. |

## Complexity Tracking

> Filled because the Constitution Check has one FAIL and two recorded tensions.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **Principle VI** — FR-002 deletes a module two design exports describe as live | The module is production-dead (its only importer is its own test); leaving it is exactly the "code agents read, test, and accidentally resurrect" that US1 exists to remove. The design docs are *already* false (nothing wires the 24-hour cache), so the drift exists with or without this feature. | *Leave the module in place*: rejected as primary path because it preserves a false design claim plus 470 lines of dead code — but it **is** the recorded fallback if the amendment cannot be obtained (DEC-7). *Hand-edit `design/`*: forbidden outright by Principle VI. *Delete and say nothing*: forbidden ("never resolved ad hoc"). |
| **Principle IV** — FR-010 relocates a delete-all+reinsert Yjs delta build into the shared Yjs utility module | Moving it is the point of FR-010 (extract generic surgery from a 160-line five-job function); the shape is pre-existing and untouched by the move. | *Fix the shape during the move* (targeted in-place transformation): rejected because it is a behavior change forbidden by FR-001, and the y-tiptap viewer-deletion bug class deserves its own feature with its own tests. Recorded as DEC-9 so the move does not launder the tension into "already reviewed". |
| **SC-002 counting basis undefined** — the ≥600-line target is met only if deleted *test* lines count | `server/__tests__/redis-persistence.test.js` alone is 328 of the ~865 available deletion lines; if FR-002 is descoped by DEC-7, 470 of them vanish and SC-002 becomes unreachable. | Not a violation to justify so much as an ambiguity to pin: `contracts/behavior-preservation.md` defines the basis explicitly (net across all tracked files including tests, measured by `git diff --shortstat` at merge) and records the DEC-7 dependency. Surfaced as a MEDIUM analyze finding rather than silently assumed. |
