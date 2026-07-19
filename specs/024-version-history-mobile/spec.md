# Feature Specification: Version History Mobile/Touch Usability

**Feature Branch**: `024-version-history-mobile`

**Created**: 2026-07-19

**Status**: Draft

**Input**: User description: "Make the version-history view genuinely usable on mobile/touch (Sam, ratified 2026-07-19 — the mobile slice of a broader deferred UX overhaul; scope is USABILITY, not redesign). Client-only; no migrations, no server API changes."

## Verified Current Breakages *(code-audited 2026-07-19)*

These were each confirmed against current `main` (post-2026-07-19 hotfix bundle):

1. **Row actions unreachable on touch.** The per-row three-dot options menu only becomes visible on pointer hover (`.hierarchy-version:hover .hierarchy-menu-btn`, `client/src/components/HierarchicalVersionList.css:187-188`). Touch devices have no hover, so the button stays at `opacity: 0`. Worse, drill-down edit rows (`.hierarchy-update`) have **no** reveal rule at all — their menu button is invisible even on desktop hover (only keyboard `:focus` reveals it). Naming, renaming, restoring, and removing a name from any row are therefore impossible on a phone and partially broken on desktop.
2. **Native browser prompts for core actions.** Name/rename uses `window.prompt` and restore/remove-name use `window.confirm` (`client/src/components/HierarchicalVersionList.jsx:332-360`); the header Restore button also uses `window.confirm` (`client/src/components/EditorView.jsx:360`). These are visually jarring, unstyled, unthemed, truncate on small screens, and are suppressed entirely in some embedded/PWA contexts. ~90 lines of fully styled but dead dialog CSS (`.version-dialog*`, `client/src/components/VersionHistoryPanel.css:366-450`) remain from a dropped styled-dialog implementation; no component references them.
3. **Small-screen layout is unaudited and has concrete faults.** Version mode renders a preview area plus a 320px right panel; at ≤768px this flips to preview-top (60%) / panel-bottom (40%) (`client/src/components/EditorView.css:324-361`). At 360-430px widths: header title can crowd the "Restore this version" button; interactive elements are far below the 44px touch minimum (menu button ≈24px, expand chevron ≈24px, close ≈36px, highlight-changes checkbox 14px); the row menu dropdown can be clipped by the panel's scroll container near the bottom edge — acute in a 40%-height bottom panel; landscape phones leave the list a few rows tall.
4. **Full page reload after restore; brittle close.** Restore success triggers `window.location.reload()` (`HierarchicalVersionList.jsx:356`, `EditorView.jsx:364`) even though the version-history screen has no live editor mounted and the restore call already refreshes history state. Close/back is `window.history.back()` (`EditorView.jsx:194-196`), which exits the app when the history URL (`/d/{guid}/versions`) was opened directly (deep link, new tab).

**Existing app conventions to match (not reinvent)**: breakpoints at 768px and 480px; 44px minimum touch targets already used for header buttons (`EditorView.css:234-256`); `@media (hover: none)` for touch-specific reveal (`MenuCommon.css:177`); styled overlay dialogs per the Share dialog pattern (`ShareDialog.css` — token-based overlay, centered card, 480px small-screen adjustments); the AI panel's right/bottom dock precedent for panel placement.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Access version actions by touch (Priority: P1)

A collaborator opens a document's version history on a phone or tablet and wants to act on a version — name it, rename it, restore it, or remove its name. Today the three-dot menu that holds every one of these actions is invisible and untappable on touch devices, and invisible on drill-down edit rows even with a mouse. They must be able to see and tap the menu on every row (top-level versions and drill-down edit rows alike) and pick an action.

**Why this priority**: Every version action funnels through this one menu; on touch it is unreachable, which makes the entire feature read-only on mobile. This is the single highest-impact fix.

**Independent Test**: On a touch device (or touch emulation) at 360-430px width, open version history, tap the options menu on a top-level version row and on a drill-down edit row, and confirm the action list opens fully visible. Delivers value even if nothing else in this feature ships (the actions themselves still work via the existing prompts).

**Acceptance Scenarios**:

1. **Given** version history is open on a device with no hover capability, **When** the user looks at any version row or drill-down edit row, **Then** the options menu control is visible without any prior interaction and opens on a single tap.
2. **Given** version history is open on a desktop with a pointer, **When** the user hovers a drill-down edit row, **Then** its options menu control is revealed (fixing the currently missing desktop reveal), and hover-reveal behavior for top-level rows is preserved.
3. **Given** a row's menu is open near the bottom of the list area, **When** the menu would extend past the visible edge of the panel, **Then** the full menu remains visible and tappable (it is not clipped by the panel's scroll area).
4. **Given** an open row menu, **When** the user taps anywhere outside it, **Then** the menu closes (works with touch, not only mouse events).

---

### User Story 2 - Name, rename, restore, and remove-name through in-app dialogs (Priority: P2)

A user on any device picks a version action and completes it in a styled, in-app dialog instead of a native browser popup: a text-input dialog for name/rename (pre-filled when renaming), and a confirmation dialog for restore and remove-name that states what will happen.

**Why this priority**: Native prompts are the second wall a mobile user hits after reaching the menu — cramped, unthemed, and suppressed in some embedded contexts. Depends on Story 1 for touch users to reach the actions at all.

**Independent Test**: On desktop or mobile, trigger each of the four actions and confirm each flows through an in-app dialog with explicit confirm/cancel controls and no native browser prompt appears anywhere in version history.

**Acceptance Scenarios**:

1. **Given** the user chooses "Name this version", **When** the dialog opens, **Then** it shows a text input with focus ready for typing, a confirm action disabled while the input is empty/whitespace, and a cancel action; confirming creates the named version exactly as before.
2. **Given** the user chooses "Rename" on a named version, **When** the dialog opens, **Then** the input is pre-filled with the current name and confirming saves the trimmed new name.
3. **Given** the user chooses "Restore this version" (from a row menu or the header button), **When** the confirmation dialog opens, **Then** it explains that a new version will be created with the restored content, and only an explicit confirm performs the restore.
4. **Given** the user chooses "Remove name", **When** the confirmation dialog opens, **Then** it names the version being affected and only an explicit confirm removes the name.
5. **Given** any of these dialogs is open on a 360px-wide screen, **When** it renders, **Then** it fits the viewport (no horizontal overflow), its controls meet the touch-target minimum, and it can be dismissed by cancel, tapping the backdrop, or pressing Escape.
6. **Given** a dialog's confirmed action fails (e.g., network error), **Then** the failure is surfaced to the user rather than silently dismissed.

---

### User Story 3 - Version history layout works at phone widths (Priority: P2)

A user on a 360-430px-wide phone (portrait or landscape) opens version history and can actually operate the whole screen: read the header, tap back and Restore, switch the filter, toggle change highlights, expand/collapse months and versions, drill into edits, see the "Showing N of M edits" indicator, scroll both the preview and the list, and read the footer count — all without horizontal scrolling or mis-taps.

**Why this priority**: Even with Stories 1-2 done, the screen is only nominally functional if targets are too small to hit and the header overflows. This story makes the existing layout genuinely operable; it does not redesign it.

**Independent Test**: At 360px, 393px, and 430px widths (portrait) plus one landscape height, walk the full screen: every interactive element is tappable at ≥44px effective target, nothing overflows horizontally, and both scroll regions work independently.

**Acceptance Scenarios**:

1. **Given** version history at 360px width, **When** a long version name or timestamp is shown in the header, **Then** the title truncates gracefully and the back control and Restore action both remain visible and tappable without horizontal scroll.
2. **Given** the bottom-docked list panel on a phone, **When** the user scrolls the version list, **Then** the list scrolls independently of the preview, and the month accordion, version rows, expand chevrons, drill-down rows, "Showing N of M edits" indicator, and footer are all reachable and readable.
3. **Given** any interactive element in version history on a touch device (back, Restore, close, filter, highlight toggle, month header, expand chevron, row, menu button, menu items, dialog controls), **When** measured, **Then** its effective touch target is at least 44px in the smaller dimension.
4. **Given** a phone in landscape (viewport height ≈ 360-430px), **When** version history opens, **Then** the list panel and preview each remain usable (neither collapses to an unusably small strip) and internal scrolling gives access to all content.
5. **Given** the filter select and "Highlight changes" toggle at 360px width, **When** rendered, **Then** both controls fit on the controls row (wrapping if needed) and remain operable.

---

### User Story 4 - Restore and close without page-reload jank (Priority: P3)

After confirming a restore, the user lands back on the live document showing the restored content via in-app navigation — no full page reload. Closing version history returns to the document even when the history screen was opened directly via its URL.

**Why this priority**: Functional today but hostile on mobile and PWA-ish contexts (flash, lost scroll, re-auth round trips, and back-exits-the-app on deep links). Smallest slice; safe to defer if it grows.

**Independent Test**: Restore a version on mobile and observe the document appears with restored content without a full page reload; open `/d/{guid}/versions` in a fresh tab and confirm close/back lands on the document instead of leaving the app.

**Acceptance Scenarios**:

1. **Given** the user confirms a restore from either the header button or a row menu, **When** the restore succeeds, **Then** the app navigates to the live document view showing the restored content without a full page reload, and the version history data reflects the new restore-created version on next open.
2. **Given** the user opened version history via a link in a fresh tab (no in-app history), **When** they use the close/back control, **Then** they land on the document view rather than leaving the app.
3. **Given** the user navigated to version history from the document, **When** they use close/back, **Then** browser history behaves as before (one step back returns to the document; browser back button equivalent works).

---

### Edge Cases

- **Menu near scroll edge**: a row menu opened for the last visible row in a 40%-height bottom panel must not be clipped or force the user to scroll blind (Story 1, scenario 3).
- **Menus/dialogs vs. row selection**: tapping the menu button must not also select the row (existing stop-propagation behavior must survive on touch).
- **Viewer role**: viewers see no Restore actions (row or header) but can still name/rename per existing rules — dialogs must respect the same role gating as the current prompts.
- **Whitespace-only or unchanged name**: name/rename dialog confirm stays disabled for empty/whitespace input; renaming to the identical name is a no-op that still closes cleanly.
- **Dialog open during data refresh**: history refreshes after actions; an open dialog must not be wiped out or act on a stale row identity.
- **Restore failure**: server rejects or network drops mid-restore — user gets an error and stays in version history; no navigation, no reload.
- **Deep-linked history URL with no referrer** (Story 4, scenario 2) — close must not exit the app.
- **Very long version names / author lists / on-behalf-of lines** at 360px — wrap or truncate without horizontal overflow (on-behalf-of already wraps via `overflow-wrap`).
- **Touch + keyboard hybrids** (convertible laptops): hover reveal and always-visible-on-touch must coexist; keyboard focus reveal must keep working.
- **Suppressed native dialogs**: after this feature, no code path in version history depends on `window.prompt`/`window.confirm`, so embedded contexts that block them lose nothing.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: On devices without hover capability, the per-row options menu control MUST be persistently visible on every version row and drill-down edit row, and MUST open on a single tap.
- **FR-002**: On hover-capable devices, the options menu control MUST be revealed on row hover for BOTH top-level version rows and drill-down edit rows (fixing the missing sub-row reveal), and on keyboard focus as today.
- **FR-003**: An open row menu MUST be fully visible within the viewport — never clipped by the list's scroll container — and MUST close when the user taps or clicks anywhere outside it, on both touch and pointer devices.
- **FR-004**: All four version actions (name, rename, restore, remove name) MUST run through styled in-app dialogs consistent with the app's existing dialog conventions; no native browser prompt/confirm dialogs may remain anywhere in the version-history experience.
- **FR-005**: The name/rename dialog MUST provide a focused text input (pre-filled for rename), disable confirmation for empty/whitespace input, trim the submitted name, and preserve the exact create/rename semantics of the current implementation (including which clock a name attaches to).
- **FR-006**: The restore and remove-name confirmation dialogs MUST state the consequence of the action and require an explicit confirm; cancel, backdrop tap, and Escape MUST dismiss without side effects.
- **FR-007**: The ~90 lines of unreferenced dialog styling from the dropped implementation MUST be either revived as the actual styling of the new dialogs or deleted — not left dead.
- **FR-008**: Every interactive element in version history (header back, Restore, panel close, filter, highlight toggle, month headers, expand chevrons, rows, menu buttons, menu items, dialog controls) MUST have an effective touch target of at least 44px in its smaller dimension on touch layouts, following the app's existing 44px header-button precedent.
- **FR-009**: At viewport widths of 360-430px, the version-history header MUST show the back control, a truncating title, and the Restore action (when permitted) without horizontal overflow; the Restore label MAY compress at narrow widths provided the action remains clearly identifiable.
- **FR-010**: At ≤768px the existing preview-over-list split MUST remain, with the list panel and preview independently scrollable and all list content (months, versions, drill-down edits, "Showing N of M edits" indicator, footer total) reachable; in landscape-height viewports both regions MUST remain usable.
- **FR-011**: Version-history screens MUST produce no horizontal page scrolling at any width from 360px up, with long names, author lists, and provenance lines wrapping or truncating instead.
- **FR-012**: After a successful restore, the app MUST return the user to the live document showing the restored content via in-app navigation, without a full page reload.
- **FR-013**: The close/back control MUST return the user to the document view even when version history was opened directly by URL with no prior in-app history; when in-app history exists, existing back semantics are preserved.
- **FR-014**: All existing behavior not called out here MUST be preserved unchanged: role gating (restore hidden for viewers; naming allowed per current rules), selection semantics, drill-down loading, the named-versions filter, diff-highlight toggle, and the "Showing N of M edits" indicator.
- **FR-015**: The feature MUST NOT modify any server code, API contracts, or database schema; it is client-only. If implementation uncovers a genuine server-side need, it MUST be recorded as a gap in the feature ledger, not implemented.
- **FR-016**: Touch/layout adaptations MUST reuse the app's existing responsive conventions (768px/480px breakpoints, hover-capability media detection, existing design tokens, the established overlay-dialog pattern) rather than introducing a new system.

### Key Entities

No new data entities. The feature operates on existing client-side representations of versions, drill-down edit ranges, and user role — none of which change shape.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a touch device at 360px width, a user can complete each of the four version actions (name, rename, restore, remove name) end to end via the row menus — 100% of applicable action paths completable on both top-level version rows and drill-down edit rows, versus 0 today.
- **SC-002**: Zero native browser prompt/confirm dialogs appear anywhere in the version-history experience.
- **SC-003**: 100% of interactive elements in version history measure ≥44px effective touch target on touch layouts (audited element-by-element at 360px and 430px).
- **SC-004**: No horizontal page scrolling occurs at any viewport width from 360px upward on the version-history screen, including with maximal content (long names, 3+ authors, provenance lines, open menus, open dialogs).
- **SC-005**: Restoring a version returns the user to the updated document without a full page reload, and closing a deep-linked version-history tab lands on the document instead of exiting the app — verified in both cases.
- **SC-006**: Desktop behavior is regression-free: hover reveal, keyboard focus reveal, selection, drill-down, filter, and diff toggle all behave as before (existing component test suite still passes, extended for the new interactions).

## Assumptions

- The feature builds on the current state of `main` including the 2026-07-19 hotfix bundle (which touched `HierarchicalVersionList.jsx` + test, `useVersionHistory.js`, and `EditorView.jsx`); no coordination with in-flight server-side feature 023 is needed because this feature touches no server files.
- "Touch device" is detected via CSS hover/pointer capability (the convention already present in the codebase, `MenuCommon.css:177`), not user-agent sniffing, except where the app already applies its existing mobile detection.
- The preview-over-list bottom-panel arrangement at ≤768px is retained as-is (usability fixes only); rebalancing or making the split adjustable is out of scope unless required to satisfy FR-010's landscape-usability bar with minimal change.
- The broader deferred UX overhaul — human-readable version labels, live refresh of the version list, splitting the route/view architecture — remains DEFERRED and is explicitly out of scope.
- The existing frontend test suite (Vitest, `client/src/**/__tests__/`) is the verification vehicle; new interactions (touch reveal, dialogs, navigation-instead-of-reload) get component-level coverage per Constitution Principle II.
- Restore semantics on the server (new version created with restored content) are unchanged; the existing restore call already reports success/failure to the client, so no reload is inherently required.
- Sub-version rows currently expose name/restore but not remove-name (matching current menu logic); that asymmetry is preserved, not "fixed".
