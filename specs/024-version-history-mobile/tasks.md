# Tasks: Version History Mobile/Touch Usability

**Input**: Design documents from `/specs/024-version-history-mobile/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ui-contract.md, quickstart.md

**Tests**: INCLUDED — Constitution Principle II mandates test-backed changes and SC-006
requires the extended component suite to pass. Frontend Vitest is the reviewer.

**Organization**: Grouped by user story (P1→P3). Client-only; all paths under `client/src/`.
No server/API/schema files are touched (FR-015 / D7).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: different file, no dependency on an incomplete task → parallelizable
- Same-file tasks are sequential (notably `HierarchicalVersionList.jsx`, touched by US1/US2/US4)

## Path Conventions

Web-app client: components in `client/src/components/`, tests in
`client/src/components/__tests__/`, root wiring in `client/src/App.jsx`.

---

## Phase 1: Setup

**Purpose**: Confirm the working baseline before touching code.

- [X] T001 Run the frontend Vitest suite from `client/` (`npx vitest run`) and confirm it is green on current `main` (post-2026-07-19 hotfix bundle), establishing the regression baseline for SC-006. No new npm dependency is required; `createPortal` comes from the existing `react-dom`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Cross-story groundwork.

**No blocking cross-story prerequisites exist** — the four stories are independently
implementable and testable (US1 = CSS+JSX in the list; US2 = new dialogs; US3 = CSS;
US4 = navigation wiring). The only shared file is `HierarchicalVersionList.jsx` (touched by
US1, US2, US4); those edits are sequenced within their stories, not foundational.

**Checkpoint**: Proceed directly to user stories.

---

## Phase 3: User Story 1 - Access version actions by touch (Priority: P1) 🎯 MVP

**Goal**: The per-row options menu is visible and tappable on every row (top-level AND
drill-down) on touch, revealed on hover for both row types on desktop, and its dropdown is
never clipped by the panel's scroll area and closes on outside tap.

**Independent Test**: At 360-430px touch emulation, open version history; the three-dot menu
is visible on a top-level row and a drill-down row without hovering, opens on one tap fully
visible near the bottom edge, and closes on an outside tap.

### Tests for User Story 1

- [X] T002 [US1] Extend `client/src/components/__tests__/HierarchicalVersionList.test.jsx`: assert the menu button renders on a drill-down (sub-version) row; clicking it opens the dropdown; opening the menu does NOT trigger row selection (`onSelectVersion`/`onSelectUpdate` not called); an outside `pointerdown` closes the open menu.

### Implementation for User Story 1

- [X] T003 [US1] In `client/src/components/HierarchicalVersionList.css`: add an `@media (hover: none)` block setting `.hierarchy-menu-btn` to `opacity: 1` for both `.hierarchy-version` and `.hierarchy-update` rows; add a `.hierarchy-update:hover .hierarchy-menu-btn` reveal rule (the missing sub-row desktop reveal, Breakage #1); keep the existing `.hierarchy-version:hover` and `:focus` reveals (FR-001, FR-002).
- [X] T004 [US1] In `client/src/components/HierarchicalVersionList.jsx`: portal the open dropdown (`.hierarchy-menu-dropdown`) to `document.body` via `createPortal` with `position: fixed` coordinates computed from the trigger button's `getBoundingClientRect()` on open, flipping above the button when space below is insufficient and right-aligning clamped into the viewport; close the menu on `scroll` (capture) and `resize` (FR-003, research R2).
- [X] T005 [US1] In `client/src/components/HierarchicalVersionList.jsx`: change the outside-dismiss listener from `mousedown` to `pointerdown` and make the "inside" test also count the portaled dropdown (ref on the portaled node, or `stopPropagation` from the dropdown) so a single tap/click outside closes on both touch and pointer; preserve `stopPropagation` on the menu button so opening never selects the row (FR-003).
- [X] T006 [US1] In `client/src/components/HierarchicalVersionList.css`: add the fixed-position dropdown variant class used by the portaled menu (viewport-anchored positioning, retaining existing surface/shadow/z-index tokens), keeping the non-portaled styling intact for tests/fallback.

**Checkpoint**: US1 delivers a reachable, unclipped, dismissible menu on all rows; actions
still run via the existing prompts (US2 replaces those).

---

## Phase 4: User Story 2 - Name, rename, restore, remove-name through in-app dialogs (Priority: P2)

**Goal**: All four actions run through styled in-app dialogs (reviving the dead
`.version-dialog*` CSS); no `window.prompt`/`window.confirm` remains anywhere in version
history.

**Independent Test**: Trigger each of the four actions (from a row menu and, for restore, the
header button); each opens an in-app dialog with confirm/cancel, disabled-when-empty for
name/rename, consequence text for restore/remove-name, and no native browser popup appears.

### Tests for User Story 2

- [X] T007 [P] [US2] Create `client/src/components/__tests__/VersionNameDialog.test.jsx`: pre-fill on rename mode; confirm disabled for empty/whitespace input; submit passes the trimmed value; Enter submits; Escape / backdrop / Cancel dismiss with no `onConfirm`; `error` prop keeps the dialog open and visible (FR-005, FR-006).
- [X] T008 [P] [US2] Create `client/src/components/__tests__/VersionConfirmDialog.test.jsx`: renders `title`/consequence `message`; only explicit confirm calls `onConfirm`; Escape / backdrop / Cancel dismiss; `busy` disables controls; `error` surfaces and keeps it open (FR-006).
- [X] T009 [US2] Extend `client/src/components/__tests__/HierarchicalVersionList.test.jsx`: with spies on `window.prompt`/`window.confirm`, assert neither is called for any action; each action still invokes the correct callback with the same args — `onCreateNamedVersion(trimmedName, item.clockEnd)`, `onRenameVersion(item.id, trimmedName)`, `onRestoreVersion(item.id)`, `onDeleteVersion(item.id)` (FR-004, FR-005, C5).

### Implementation for User Story 2

- [X] T010 [US2] In `client/src/components/VersionHistoryPanel.css`: revive the dead `.version-dialog*` block (lines ~366-450) as the real dialog styling and augment it — a `@media (max-width: 480px)` bottom-sheet treatment mirroring `ShareDialog.css:336-355`, ≥44px min-height on the input and action buttons (SC-003), and an error-message line style (FR-006). Nothing may remain dead (FR-007).
- [X] T011 [P] [US2] Create `client/src/components/VersionNameDialog.jsx`: styled overlay (revived `.version-dialog*`) per C3 — overlay `onClick=onCancel`, inner card `stopPropagation`, auto-focused (text-selected for rename) input, Escape handler, confirm disabled while `value.trim()` empty, `busy`/`error` states (FR-004, FR-005).
- [X] T012 [P] [US2] Create `client/src/components/VersionConfirmDialog.jsx`: styled confirmation overlay per C4 — `title`, consequence `message`, `confirmLabel`, explicit-confirm-only, Escape/backdrop/Cancel dismiss, `busy`/`error` states (FR-004, FR-006).
- [X] T013 [US2] In `client/src/components/HierarchicalVersionList.jsx`: replace `handleNameItem` (`prompt`), `handleDeleteVersion` (`window.confirm`), and `handleRestoreItem` (`window.confirm`) with dialog state (`{ kind, item, busy, error }`) that renders `VersionNameDialog` / `VersionConfirmDialog`; preserve exact semantics and role gating (name→`clockEnd`, rename→`id`, sub-rows no remove-name), capture the target `item` so a mid-flight history refresh can't act on a stale row, and surface failures in the dialog (FR-005, FR-014, Edge Cases). (Same file as US1 — sequence after T004/T005.)
- [X] T014 [US2] In `client/src/components/EditorView.jsx`: replace the header "Restore this version" `window.confirm` (~line 360) with a `VersionConfirmDialog` holding `{ busy, error }` over the current `selection`; confirm calls `restoreVersion(selection.id)` and surfaces failure without leaving version history (FR-004, FR-006). (Restore-success navigation is wired in US4/T021.)

**Checkpoint**: US1 + US2 — every action reachable on touch and completed via themed dialogs;
zero native prompts (SC-002).

---

## Phase 5: User Story 3 - Version history layout works at phone widths (Priority: P2)

**Goal**: The whole screen is operable at 360-430px (portrait + landscape) — 44px targets,
non-overflowing header, independent scroll, no horizontal page scroll — keeping the 60/40
split (D4).

**Independent Test**: At 360/393/430px and one landscape height, walk the screen: every
interactive element is ≥44px, nothing overflows horizontally, and both scroll regions work.

### Implementation for User Story 3

- [X] T015 [P] [US3] In `client/src/components/EditorView.css` (version-history-header area, ~346-361): make `.version-history-title` truncate (`min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`); ensure `.version-history-back-btn` and `.restore-version-btn` stay visible with no horizontal overflow at 360-430px, compacting the Restore padding/label at ≤480px while keeping it identifiable; give the back button a 44px effective target on touch, reusing the `EditorView.css:234-256` 44px precedent (FR-008, FR-009).
- [X] T016 [US3] In `client/src/components/EditorView.css` (`.version-history-inner` split + `@media (max-width: 768px)`): ensure the 60/40 preview/list regions each remain usable and independently scrollable in short (landscape) viewport heights — neither collapses to an unusable strip (FR-010, US3 AC4). Minimal rebalance only if landscape genuinely demands it (D4).
- [X] T017 [P] [US3] In `client/src/components/VersionHistoryPanel.css`: give the panel close (`.version-history-close`), the filter `<select>`, and the "Highlight changes" toggle 44px effective touch targets (wrap the 14px checkbox in a ≥44px tappable `<label>` rather than enlarging the box); let the controls row wrap at 360px so filter + toggle stay operable (FR-008, US3 AC5). Coordinate with the T010 dialog edits in the same file (sequence after T010).
- [X] T018 [P] [US3] In `client/src/components/HierarchicalVersionList.css`: give the row menu button, expand chevron button, menu items, and month header 44px effective touch targets on touch layouts, and ensure long version names / author lists wrap or truncate with no horizontal overflow at 360px (on-behalf-of already wraps) (FR-008, FR-011). Sequence after the US1 CSS (T003/T006) in the same file.

**Checkpoint**: US1 + US2 + US3 — the screen is fully operable at phone widths (SC-003, SC-004).

---

## Phase 6: User Story 4 - Restore and close without page-reload jank (Priority: P3)

**Goal**: Restore ends in in-app navigation to the live document (no `window.location.reload`);
close returns to the document even on a deep-linked/fresh-tab history screen.

**Independent Test**: Restore on mobile → document appears with restored content, no full-page
reload; open `/d/{guid}/versions` in a fresh tab → close lands on the document; navigate from
the doc → back returns to the doc.

### Tests for User Story 4

- [ ] T019 [US4] Extend the version-history tests (`client/src/components/__tests__/HierarchicalVersionList.test.jsx`, and an EditorView-level test if needed): assert a successful restore invokes the in-app navigate callback (`onNavigateToDoc`) with the doc guid and does NOT call `window.location.reload` (spied) (FR-012, C7).

### Implementation for User Story 4

- [ ] T020 [US4] In `client/src/App.jsx`: set a `versionsReachedInApp` ref/flag in `navigateToVersions` (unset on a fresh load landing directly on `/d/{guid}/versions`), and pass `navigateToDoc` into `EditorView` as `onNavigateToDoc` plus the close-behavior signal (the flag or a ready-made `onCloseVersions`) alongside the existing `onNavigateTo*` props (FR-013, research R5).
- [ ] T021 [US4] In `client/src/components/EditorView.jsx`: change the header restore success path to call `onNavigateToDoc(docGuid)` instead of `window.location.reload()` (~line 364); rewrite `handleCloseVersionHistory` to `window.history.back()` when reached in-app and `onNavigateToDoc(docGuid)` on a deep link/fresh tab (FR-012, FR-013, US4 AC2/AC3). (Same file as T014 — sequence after.)
- [ ] T022 [US4] In `client/src/components/VersionHistoryPanel.jsx`: thread the post-restore in-app navigation callback (`onNavigateToDoc`) from `EditorView` down to `HierarchicalVersionList` (FR-012).
- [ ] T023 [US4] In `client/src/components/HierarchicalVersionList.jsx`: on a successful row-menu restore, call the passed post-restore navigation callback instead of `window.location.reload()` (remove the reload at ~line 356) (FR-012). (Same file as T013 — sequence after.)

**Checkpoint**: All stories complete — restore/close are jank-free and deep-link-safe (SC-005).

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T024 [P] Guard the no-native-dialog invariant: grep the version-history files (`HierarchicalVersionList.jsx`, `VersionHistoryPanel.jsx`, and the version-history paths in `EditorView.jsx`) to confirm no remaining `window.prompt`/`window.confirm`/`window.alert` and no `window.location.reload` in the restore/close paths (SC-002, C9).
- [ ] T025 Run the full frontend Vitest suite from `client/` (`npx vitest run`) and confirm green — desktop regression-free per SC-006 (selection, drill-down, filter, diff toggle, "Showing N of M edits", on-behalf-of).
- [ ] T026 Execute the manual device/width matrix in `quickstart.md` at 360/393/430px portrait plus one landscape height, verifying SC-001, SC-003, SC-004, and SC-005 (touch actions end-to-end, 44px targets, no horizontal scroll, no-reload restore, deep-link close). Owned by Sam (browser E2E).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: none (empty) — stories start immediately after Setup.
- **User Stories (Phases 3-6)**: independently testable. Recommended order P1→P2→P2→P3.
  - US2 (T013) and US4 (T023) both edit `HierarchicalVersionList.jsx` after US1 (T004/T005);
    US4 (T021) edits `EditorView.jsx` after US2 (T014); US3 (T017) edits
    `VersionHistoryPanel.css` after US2 (T010); US3 (T018) edits
    `HierarchicalVersionList.css` after US1 (T003/T006).
- **Polish (Phase 7)**: after all desired stories.

### Within each story

- Tests before/with implementation (write, watch fail, implement).
- Same-file tasks are sequential; different-file tasks marked [P] can run in parallel.

### Parallel opportunities

- US2: T007 and T008 (two new test files) in parallel; T011 and T012 (two new dialog
  components) in parallel; both precede/accompany T013/T014.
- US3: T015 and T016 (both EditorView.css but distinct regions — coordinate) can pair with
  T017/T018 which are different files entirely.
- Polish: T024 is [P] with nothing blocking it once code lands.

---

## Parallel Example: User Story 2

```bash
# New dialog tests together:
Task: "Create client/src/components/__tests__/VersionNameDialog.test.jsx"
Task: "Create client/src/components/__tests__/VersionConfirmDialog.test.jsx"

# New dialog components together:
Task: "Create client/src/components/VersionNameDialog.jsx"
Task: "Create client/src/components/VersionConfirmDialog.jsx"
```

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Setup (T001) → 2. US1 (T002-T006) → 3. STOP & validate: menu reachable/unclipped/dismissible
on touch. The actions still function via existing prompts — shippable increment.

### Incremental delivery

US1 (MVP) → US2 (themed dialogs, kills native prompts) → US3 (44px + no-overflow layout) →
US4 (no-reload restore + deep-link-safe close). Each story adds value without breaking prior
ones; run `npx vitest run` after each.
