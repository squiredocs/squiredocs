# Feature Specification: Version History Simplification

**Feature Branch**: `042-version-history-simplification`

**Created**: 2026-08-02

**Status**: Merged (2026-08-02)

**Input**: User description: "042-version-history-simplification: behavior-preserving dead-code removal and structural refactors in version-history/undo/diff"

## Context

The 2026-08-02 version-history deep dive (`tmp/version-history-deep-dive-2026-08-02.md`,
section C) found the core machinery sound but carrying dead weight: an entire unused
persistence module, a hot-path diagnostic block left over from a closed investigation,
a frontend content-loading path superseded by the diff pipeline, ~250 lines of dead CSS,
unused exports, and several structural duplications (twin undo/redo implementations,
twin hand-synchronized diff traversals, 15-of-20 pass-through props) that make every
future change in this area cost more than it should.

This feature is the deep dive's Bundle "C": **behavior-preserving** dead-code removal
and structural refactors. It changes what the code looks like, not what it does. The
only permitted observable change is the disappearance of removed diagnostic logging.

**Sequencing**: this feature merges AFTER `041-version-history-truth`. Both touch the
same files (`useVersionHistory.js`, `VersionHistoryPanel.css`, `version-history.js`,
`HierarchicalVersionList.jsx`, `server/undo/edit-records.js`); 041's behavioral fixes
land first and this feature rebases over them. This spec is written against current
`main`; overlap points are flagged inline and must be re-verified at rebase time.

Every deletion claim below was re-verified against the code on 2026-08-02 (import/
reference greps); verification notes appear in the scope inventory.

## User Scenarios & Testing *(mandatory)*

The "user" of this feature is the maintainer and the agents who work on this codebase:
value is delivered as a smaller, single-sourced, honest code surface with identical
runtime behavior. End users of Squire Docs must notice nothing.

### User Story 1 - Dead code is gone (Priority: P1)

As the maintainer, when I read or search the version-history/undo/diff area, everything
I find is live code: no unused modules, no leftover investigation logging, no superseded
frontend data paths, no dead CSS, no exports nothing imports.

**Why this priority**: pure deletions are the highest-value/lowest-risk slice — every
line removed is a line agents no longer read, test, or accidentally resurrect. They are
independently shippable with zero behavior risk.

**Independent Test**: delete the listed items, run the full backend (Jest, serial) and
frontend (Vitest) suites — all green; grep confirms zero remaining references; exercise
the version-history panel, undo/redo, and diff preview manually — identical behavior.

**Acceptance Scenarios**:

1. **Given** the server codebase, **When** searching for `redis-persistence`, **Then**
   neither the module nor its test exists and no import site remains.
2. **Given** a cross-instance document update arriving via Redis pub/sub, **When** it is
   applied, **Then** the document state is identical to today's behavior and no
   `ROOT_CAUSE` diagnostic logging is emitted; apply errors are still caught and logged.
3. **Given** the version-history panel in the browser, **When** selecting versions,
   drilling down, previewing diffs, and restoring, **Then** every interaction behaves
   exactly as before the deletions (the removed frontend path was already unused).
4. **Given** the stylesheets, **When** auditing selectors against rendered markup,
   **Then** no dead selector blocks remain — except `.version-history-error`, which is
   retained because feature 041 wires it up.
5. **Given** the undo subsystem, **When** inspecting module exports, **Then** only
   symbols with external importers are exported, and the production-dead `baselineClock`
   branch in `legacy.js` is gone along with its tests.

---

### User Story 2 - Backend structure is single-sourced (Priority: P2)

As the maintainer, the backend's duplicated mechanisms are collapsed: one undo/redo
core, one clock-range check, one diff-document traversal, and generic Yjs surgery lives
in the Yjs utility module — with every existing test still green.

**Why this priority**: these duplications (undo/redo ~80% identical, twin diff
traversals acknowledged as a drift hazard) are where future bugs will come from; the
existing test suites make the refactor safe to do now.

**Independent Test**: each refactor lands with the full affected suite passing
unchanged (no test deleted or weakened to make it pass); the diff traversal merge is
additionally gated on the existing traversal-agreement pin tests passing byte-for-byte.

**Acceptance Scenarios**:

1. **Given** undo and redo requests of every current flavor (normal, legacy-range,
   honest-empty, contention), **When** served by the merged single core, **Then**
   responses, persisted rows, and error shapes are identical to today's, as proven by
   the existing undo suites passing unmodified.
2. **Given** a version preview or restore for an in-range clock, **When** the clock
   range is validated, **Then** the result is identical to today's but the validation
   no longer reads the entire update log where only min/max are needed; out-of-range
   clocks still produce the same not-found errors with the same messages.
3. **Given** a restore of any version, **When** the replacement content is built,
   **Then** the outcome is identical, with the element-cloning and delta-building steps
   now living in the shared Yjs utility module where the viewer-deletion bug class is
   guarded.
4. **Given** the version-history diff pipeline, **When** plain text and word marks are
   produced, **Then** a single traversal emits both, and the existing
   traversal-agreement tests pass without modification.

---

### User Story 3 - Frontend structure is single-sourced (Priority: P3)

As the maintainer, the version-history panel no longer forwards three-quarters of its
props unchanged, and the two hand-rolled restore-confirmation flows are one shared flow.

**Why this priority**: valuable but riskier to sequence — these are the same files 041
touches most, so this story lands after rebase with fresh verification.

**Independent Test**: frontend suites green; manual walk of both restore entry points
(header and row menu) shows identical dialogs, messages, error handling, and
post-restore navigation.

**Acceptance Scenarios**:

1. **Given** the version-history UI, **When** props are audited, **Then** no component
   forwards a prop it neither reads nor transforms; duplicated empty-state markup and
   the unreachable loading branch are gone; rendered output is unchanged.
2. **Given** a restore initiated from the header or from a row menu, **When** the user
   confirms, cancels, or hits an error, **Then** both entry points exhibit identical
   behavior driven by one shared flow, matching today's user-visible behavior.

---

### User Story 4 - Stale diff-cache entries can no longer be served by a forgotten bump (Priority: P3)

As the maintainer, changing the diff pipeline can no longer silently serve
stale-shaped cache entries: the cache key namespace incorporates a fingerprint derived
from the pipeline source, so any pipeline change automatically invalidates old entries.

**Why this priority**: three manual version bumps in three weeks (v7→v10) show the
manual step is a recurring hazard; automation removes a failure mode rather than
patching an instance of it.

**Independent Test**: modify any diff-pipeline source file in a scratch branch and
observe the derived cache namespace change; unchanged source yields a stable namespace
across restarts.

**Acceptance Scenarios**:

1. **Given** an unchanged diff pipeline, **When** the server restarts, **Then** the
   cache namespace is identical and warm entries remain valid.
2. **Given** any change to a diff-pipeline source file, **When** the server starts,
   **Then** the namespace differs and pre-change entries are never served.
3. **Given** the automation, **Then** the one-time invalidation on rollout is accepted
   (it is a cache with a 1-hour TTL) and no manual bump step remains in the workflow.

---

### User Story 5 - Small consolidations and honest comments (Priority: P4)

As the maintainer, the long tail of small duplications is consolidated (retry helper,
meaningfulness predicate, sentinel-origin check, date formatters, clock-range label,
undo-state hook, update-fetch data option, env-config reads, redundant conversion
skip), and the handful of comments/JSDoc that describe code that no longer exists are
corrected.

**Why this priority**: each item is small; together they remove the paper cuts. All are
behavior-preserving; none blocks the stories above.

**Independent Test**: suites green after each consolidation; grep shows one definition
per concept; the corrected comments match what the code actually does.

**Acceptance Scenarios**:

1. **Given** the two hand-rolled retry implementations, **Then** one shared
   retry-with-backoff helper serves both with today's delays and bounds.
2. **Given** the three code paths that test update meaningfulness, **Then** they share
   one `isMeaningful` helper — with the 041 coordination rule: 041 fixes the drill-down
   filter bug itself; this feature only consolidates the helper if 041 has not already
   introduced it (verify at rebase).
3. **Given** the drifting sentinel-origin lists, **Then** a single `isSentinelOrigin`
   predicate is the one source of truth and all call sites keep their current outcomes.
4. **Given** the two different `formatDateTime` implementations (a shared util plus
   local re-implementations, including a name collision), **Then** date formatting is
   consolidated without changing any rendered string.
5. **Given** the drill-down update fetch, **Then** it no longer transfers update blobs
   it immediately discards (data inclusion becomes opt-in), with identical response
   payloads to the client.
6. **Given** the stale comments (`VersionPreview.jsx` "toggled purely via CSS",
   `diff-service.js` result-shape JSDoc, `useVersionHistory.js` stale shape comments,
   `shared/diff/word-diff.js` "client bundler can consume it" header), **Then** each is
   corrected to describe the code as it is.

---

### Edge Cases

- **041 rebase conflicts**: 041 edits the same hook, CSS, and server files. Every
  deletion in US1 and consolidation in US5 must be re-verified against post-041 `main`
  at rebase time — 041 may have wired up something listed here as dead (the error CSS
  is the known case; the `isMeaningful` helper is the known possible case).
- **Migration dependency**: `migrations/1766103664104_add-title-to-documents.js`
  requires `server/postgres-persistence.js` and calls `getDocumentMeta` — these
  functions are NOT script-only and must not be moved out of the module (see
  Non-Goals/decisions).
- **Tests that import deleted symbols**: the hook test exercises `clearSelection`;
  component test mocks include it; `legacy.test.js` covers the `baselineClock` branch.
  Deleting the code deletes/updates those tests in the same change — removing a test
  that tests only deleted code is not "weakening the suite".
- **Cache-namespace fingerprint stability**: the fingerprint must be deterministic
  across pods of the same build (derived from source content, not timestamps or
  install paths), or pods would maintain disjoint caches.
- **Honest-empty and error shapes in the undo merge**: the five hand-built empty-result
  copies differ only incidentally today; the merged builder must reproduce the exact
  current response shapes, not an idealized one.
- **Log-scan replacement**: in the named-version path the full-log read exists only for
  range checking and can be replaced outright; in the numeric-clock path the same read
  also feeds meaningful-filtered metadata grouping — that use must be preserved (only
  the redundant scan is eliminated, not the data the path genuinely needs).

## Requirements *(mandatory)*

### Functional Requirements

**Hard constraint (applies to every FR)**

- **FR-001**: Zero behavior change. Every existing backend and frontend test suite
  MUST pass without modification, except tests whose sole subject is deleted code
  (which are deleted or updated in the same change). No user-visible string, response
  shape, error message, or interaction may change. The only permitted observable
  difference is the absence of removed diagnostic/console logging.

**Pure deletions (US1)**

- **FR-002**: Remove `server/redis-persistence.js` and
  `server/__tests__/redis-persistence.test.js`. (Verified: the test is the module's
  only importer.)
- **FR-003**: Reduce the "ROOT CAUSE INVESTIGATION" block in the Redis pub/sub
  `onUpdate` handler (`server/index.js:2159-2181`) to a plain update-apply with the
  existing error handling retained. The O(doc-size) encode/diff/decode work and all
  `ROOT_CAUSE` log lines are removed from this hot fan-out path.
- **FR-004**: Remove the frontend legacy content path from `useVersionHistory.js` and
  its consumers: `loadVersionContent`, `loadContentAtClock`,
  `loadPreviousContentAtClock`, the `versionContent`/`previousVersionContent` state,
  the `refresh` alias, the `versionContent` prop `EditorView.jsx` passes to a component
  that does not declare it, and the unused `clearSelection` (including its test block
  and mock entries). (Verified: `EditorView` destructures but never uses these beyond
  the undeclared prop pass-through.)
- **FR-005**: Remove dead CSS: the pre-hierarchical flat-list blocks in
  `VersionHistoryPanel.css` (~250 lines) and the dead blocks in
  `HierarchicalVersionList.css` (`.hierarchy-combined*`, `.hierarchy-breadcrumb*`, and
  any other selector matching no rendered markup). `.version-history-error` MUST be
  kept — feature 041 wires it up. Dead-selector determination MUST be re-verified
  against post-041 markup at rebase.
- **FR-006**: Stop exporting undo symbols with no external importers — `claimUndo`,
  `claimRedo`, `insertLegacyUndone` (module-internal in `edit-records.js`),
  `EDIT_ORIGIN`/`HISTORY_ORIGIN` (module-internal in `inverse.js`), `LEGACY_GAP_MS`
  (module-internal in `legacy.js`) — keeping the functions themselves where they are
  used internally. Remove the production-dead `baselineClock` branch in
  `legacy.js:118-132` and its tests. (Verified: no external import sites; the
  `baselineClock` occurrences in `markdown-sync.rejection.test.js` and
  `live-fanout.test.js` are a different subsystem's field and are untouched.)
- **FR-007**: Remove `getDiff` from `server/postgres-persistence.js` (verified: zero
  callers). Mark `getAllDocuments`, `getAllDocumentsWithMeta`, and `getDocumentMeta`
  with a comment stating their consumers (backfill script, title migration,
  integration-test harness) — do NOT move them (see decision DEC-2).

**Structural refactors (US2)**

- **FR-008**: Merge `performUndo`/`performRedo` in `server/undo/undo-service.js` into a
  single `performInverse(mode)` core, and replace the five hand-built empty-result
  copies with one honest-empty result builder that reproduces the exact current shapes.
- **FR-009**: Add a `getClockRange(docGuid)` persistence query (MIN/MAX) and a shared
  range-check helper; use it to eliminate the full user-joined log reads that exist
  only for range validation in `getVersionContent` and `getContentAtClock`. Where the
  numeric-clock path in `getVersionContent` also uses the log for metadata grouping,
  that read is preserved (per the edge case above). Error messages and not-found
  semantics MUST be byte-identical.
- **FR-010**: Extract the element-cloning and replace-delta construction inside
  `restoreVersion` (`version-history.js`, `cloneXmlElement` at ~line 625 and the
  surrounding delta build) into `server/yjs-utils.js` as generic, tested Yjs surgery.
  Restore outcomes MUST be identical.
- **FR-011**: Merge the twin hand-synchronized traversals in
  `server/diff/apply-word-marks.js` (`plainTextOf` + `stampSide`) into a single walk
  emitting both text and node references. The existing traversal-agreement pin tests
  are the safety net and MUST pass unmodified.

**Frontend structure (US3)**

- **FR-012**: Collapse the version-history prop drill: `VersionHistoryPanel` currently
  declares ~21 props and forwards most unchanged to `HierarchicalVersionList`.
  Eliminate pass-through-only forwarding (default mechanism: a
  `VersionHistoryContext`; the plan may choose merging chrome into the list if simpler
  — see DEC-3), removing the duplicated empty-state JSX and the unreachable loading
  branch. Rendered output unchanged.
- **FR-013**: Extract a single `useRestoreFlow` used by both the header and row-menu
  restore entry points, unifying dialog, messages, error handling, and post-restore
  navigation with today's user-visible behavior preserved exactly.

**Cache-version automation (US4)**

- **FR-014**: Replace the manual diff cache-version bump with a source-fingerprint
  appended to the cache key namespace: a deterministic digest of the diff-pipeline
  source files (at minimum `server/diff-service.js`, `server/diff/apply-word-marks.js`,
  `shared/diff/word-diff.js`) combined with the existing human-readable
  `CACHE_VERSION`. Any pipeline source change automatically invalidates prior entries;
  identical source yields identical namespaces across pods and restarts. (Chosen over
  the CI-guard alternative — see DEC-1.)

**Small consolidations (US5)**

- **FR-015**: Consolidate the long-tail duplications, each with zero behavior change:
  - a shared `retryWithBackoff` helper covering the inline implementation in
    `server/index.js:367` and the `_runStoreSlot` retry constants in
    `postgres-persistence.js`;
  - a single `isMeaningful(update)` helper for the three meaningfulness checks —
    ONLY if 041 has not already introduced it (041 owns the drill-down filter bug fix
    itself; verify at rebase);
  - a single `isSentinelOrigin()` predicate replacing the drifting sentinel lists;
  - an `includeData` option on `getUpdatesInRange` so drill-down stops fetching update
    blobs it maps away (client-visible payload unchanged);
  - env-config consolidation in `postgres-persistence.js` (one place that reads and
    parses its environment knobs);
  - skip the redundant document re-conversion in the diff identical-markdown branch;
  - date-formatter consolidation on the shared util, resolving the `formatDateTime`
    name collision (`client/src/utils/datetime.js` vs the local re-implementations in
    `HierarchicalVersionList.jsx` and `AdminPage.jsx`) without changing any rendered
    string;
  - a `clockRangeLabel` helper for the repeated range-label formatting;
  - extract `useYUndoState(editor)` from its current inline home so desktop undo
    buttons have a ready hook if ever added (no UI change now).
- **FR-016**: Correct the stale comments/JSDoc from deep-dive D5:
  `client/src/components/VersionPreview.jsx:11` ("toggled purely via CSS" is false),
  `server/diff-service.js` `computeDiff` JSDoc result shape, the stale shape comments
  in `useVersionHistory.js` (lines ~57 and ~145-151 describe different shapes; align
  both with the actual response), and the `shared/diff/word-diff.js:8-11` header claim
  that the client bundler consumes it (no client import exists — verified).

**Sequencing**

- **FR-017**: This feature MUST merge after `041-version-history-truth`. Before merge,
  every deletion and consolidation touching 041's files MUST be re-verified against
  post-041 `main` (fresh reference greps), and the clarifications ledger updated if any
  claim changed.

### Key Entities

- **Diff cache namespace**: the composite cache-key prefix (human-readable version +
  derived source fingerprint) that scopes all cached diff computations; changes
  whenever the diff pipeline's source changes.
- **Clock range**: the (min, max) clock pair for a document's update log, now
  obtainable without materializing the log.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All pre-existing backend and frontend test suites pass with zero
  modifications, except suites whose sole subject was deleted code.
- **SC-002**: Net lines-of-code reduction of at least 600 lines across the
  version-history/undo/diff area (deep-dive estimate: ~140 module + ~250 CSS + legacy
  paths + dedup savings), with zero new user-facing functionality.
- **SC-003**: A reference search for every deleted symbol/module returns zero hits in
  production code after merge.
- **SC-004**: Cross-instance update fan-out no longer performs per-update
  encode/diff/decode diagnostics; the handler does strictly less work per update than
  before.
- **SC-005**: A manual walk of the version-history panel (timeline, drill-down,
  preview with diff highlights on/off, restore from both entry points, undo/redo after
  restore) is indistinguishable from pre-change behavior.
- **SC-006**: A deliberate scratch change to any diff-pipeline source file changes the
  cache namespace with no human action; reverting it restores the prior namespace.
- **SC-007**: Exactly one implementation exists for each consolidated concept (retry,
  meaningfulness, sentinel origins, date formatting, range labels), verified by search.

## Non-Goals

- **Deleting `server/undo/legacy.js`**: explicitly out of scope. It is the only undo
  path for pre-016 edits and for permanent recording failures; removing it is a product
  decision about the legacy-decay horizon, not cleanup. Only its production-dead
  `baselineClock` branch and dead exports are removed (FR-006).
- **Unifying the two diff surface pipelines** (chat tool-output vs version-history):
  explicit 039 non-goal, restated here. FR-011 merges the twin traversals *within* the
  version-history surface only.
- **Behavioral fixes from the deep dive** (all A- and B-series findings, e.g. error
  rendering, selection reconciliation, named-version author scoping): those are
  041-version-history-truth's scope and land before this feature.
- **Test-gap work** (deep-dive section E, including replacing the
  `attribution-bug.test.js` placeholders — item C7): a separate testing bundle; not
  part of this feature.
- **Moving `getAllDocuments*`/`getDocumentMeta` out of the persistence module**: kept
  in place and marked (DEC-2), because a shipped migration depends on them.
- **Wiring up the `baselineClock` branch "deliberately"**: the report offered
  delete-or-wire; wiring is a behavior change and violates FR-001 (DEC-4).

## Assumptions

- The deep dive's line references are against `main` at f0273b68; exact line numbers
  will drift after 041 merges, but the identified code blocks are stable enough to
  locate by content.
- The existing test suites are an adequate behavioral safety net for these refactors
  (the deep dive confirms strong coverage in the undo/diff core; the known-weak spots
  — attribution E2E — are not areas this feature's refactors change semantically).
- Backend tests run serially against the shared DB per the constitution; nothing here
  changes test infrastructure.
- One-time diff-cache invalidation when FR-014 first deploys is acceptable (1-hour TTL
  cache; recomputation is the designed cold path).
- 041's final shape is not yet merged; the rebase-time re-verification (FR-017) is the
  mechanism that absorbs any drift between this spec and post-041 reality.

## Verification notes (claims checked 2026-08-02)

- `redis-persistence`: only importer is its own test — **confirmed deletable**.
- ROOT CAUSE block: present at `server/index.js:2159-2181` exactly as described.
- Frontend legacy path: all listed symbols present; `EditorView` passes `versionContent`
  at line 405; `clearSelection` destructured (line 173) but unused; hook test and
  component-test mocks reference `clearSelection` and must be updated with the deletion.
- Dead exports: no external import sites for any of the six symbols; `baselineClock`
  hits in two other test files belong to the markdown-sync baseline (different concept).
- `getDiff`: zero callers — confirmed.
- **Falsified nuance**: `getAllDocuments*`/`getDocumentMeta` are *not* script-only —
  `migrations/1766103664104_add-title-to-documents.js` requires the persistence module
  and calls `getDocumentMeta`. Spec response: mark, don't move (DEC-2).
- **Falsified nuance**: `getVersionContent`'s full-log read is dual-purpose in the
  numeric-clock path (range check + meaningful-filtered metadata grouping); only
  `getContentAtClock` and the named-version path read the log purely for min/max.
  FR-009 scoped accordingly.
- `formatDateTime` collision confirmed (shared util + two local re-implementations).
- `word-diff.js` lives at `shared/diff/word-diff.js` (report cited the bare filename);
  its "client bundler can consume it" header claim is false today — no client import.
- Minor: `redis-persistence.js` is 142 lines, not 143.
