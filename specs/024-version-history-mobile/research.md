# Phase 0 Research: Version History Mobile/Touch Usability

The spec left two mechanism families open (D5 close/navigation, D6 menu-clipping); D1-D4/D7
are already decided in `clarifications-needed.md`. This document resolves the open mechanisms
and records the convention anchors the implementation must match.

---

## R1 — Menu-reveal mechanism (D1, resolved by decision; anchor confirmed)

**Decision**: Capability-based CSS. Add an `@media (hover: none)` block that sets the row
menu button to `opacity: 1` for both `.hierarchy-version` and `.hierarchy-update` rows; keep
the existing hover rule for pointer devices and ADD a hover rule for `.hierarchy-update`
(currently only `.hierarchy-version:hover` reveals; sub-rows have no hover reveal — the
concrete desktop bug in Breakage #1). Keep `:focus` reveal for keyboard.

**Rationale**: `MenuCommon.css:177` already uses `@media (hover: none)` as the codebase's
touch-detection convention (D1). No JS, no UA sniff. Convertible laptops (hover + touch)
resolve to `hover: hover` and keep hover-reveal, which is acceptable and matches the existing
convention's own trade-off.

**Alternatives considered**: width-breakpoint reveal (rejected — hides menus on narrow
desktop windows, D1); always-visible everywhere (rejected — changes desktop visuals, exceeds
usability scope, D1); JS pointer detection (rejected — reinvents the CSS convention, FR-016).

**Files**: `HierarchicalVersionList.css` (reveal rules). The button already renders in the
DOM at `opacity:0`, so only CSS changes are needed for reveal.

---

## R2 — Menu-clipping mechanism (D6, open → resolved)

**Decision**: Render the open dropdown through `ReactDOM.createPortal(..., document.body)`
with `position: fixed` coordinates computed from the trigger button's
`getBoundingClientRect()` on open. Flip: if the menu's height would exceed the space below the
button, anchor its bottom to the button top (open upward). Right-align to the button's right
edge, clamped into the viewport. Close the menu on `scroll` (capture) and on `resize` so a
stale fixed position can't linger.

**Rationale**: The current dropdown is `position:absolute` inside `.hierarchy-list`
(`overflow-y:auto`), so it is clipped near the bottom of the 40%-height mobile panel
(Breakage #3). `position: fixed` is positioned relative to the viewport and is NOT clipped by
an ancestor's `overflow` (no ancestor uses `transform`/`filter`/`perspective`, verified —
`.version-history-panel`, `.hierarchy-list`, `.version-history-inner` use only flex/grid/
overflow), so a portal to `body` with fixed coords fully satisfies FR-003 "never clipped by
the list's scroll container." Portaling also keeps the dropdown out of the row's stacking/
overflow context. `createPortal` ships with `react-dom` (already a dependency) — no new
package.

**Alternatives considered**:
- CSS-only flip (open upward for last rows): rejected — still clipped if the row itself is
  near the panel's scroll edge and the menu is taller than remaining space; brittle across
  the 60/40 split and landscape.
- `scroll-into-view` on open: rejected — moves content under the user, disorienting, and
  doesn't guarantee the whole menu fits in a 40%-height panel.
- Fixed positioning WITHOUT a portal: works for clipping (fixed escapes overflow) but keeps
  the menu inside the row's DOM subtree; portaling is cleaner for stacking and is negligible
  extra cost. Chosen portal for robustness.

**Files**: `HierarchicalVersionList.jsx` (portal render + rect math + flip + close-on-scroll),
`HierarchicalVersionList.css` (fixed-position dropdown variant class). `menuRef` outside-click
logic must account for the portaled node (see R3).

---

## R3 — Outside-tap dismissal on touch (D6 / FR-003)

**Decision**: Change the document listener in `HierarchicalVersionList` from `mousedown` to
`pointerdown`. Because the dropdown is portaled outside `menuRef.current`, the "inside" test
must also treat the portaled dropdown as inside — either keep a ref on the portaled dropdown
and test both, or stop propagation from the dropdown's own `pointerdown`. Preserve
`e.stopPropagation()` on the menu button so opening the menu never also selects the row (Edge
Case: menus/dialogs vs row selection).

**Rationale**: The current `mousedown`-only listener does not fire reliably for touch taps
outside the menu (FR-003 explicitly calls this out). `pointerdown` is one event covering mouse
+ touch + pen and is well-supported in all target browsers.

**Alternatives considered**: add a separate `touchstart` listener alongside `mousedown`
(rejected — two code paths, double-fire risk on hybrids). `click` (rejected — fires too late,
lets the underlying row receive the tap first).

**Files**: `HierarchicalVersionList.jsx`.

---

## R4 — In-app dialogs (D2, resolved by decision; structure confirmed)

**Decision**: Two new local components following the ShareDialog overlay pattern:
- `VersionNameDialog` — text input (name / rename). Props: `isOpen`, `mode` (`'name'` |
  `'rename'`), `initialValue`, `onConfirm(trimmedName)`, `onCancel`, `busy`, `error`. Confirm
  disabled while the trimmed input is empty; input auto-focused and text-selected on open;
  Enter submits; Escape/backdrop/Cancel dismiss.
- `VersionConfirmDialog` — confirmation (restore / remove-name). Props: `isOpen`, `title`,
  `message` (consequence text), `confirmLabel`, `onConfirm`, `onCancel`, `busy`, `error`.
  Explicit confirm required; Escape/backdrop/Cancel dismiss.

Both mirror ShareDialog's structure: `.version-dialog-overlay` with `onClick={onCancel}`,
inner `.version-dialog` with `onClick={e => e.stopPropagation()}`, a keydown Escape handler,
and disabled/error states. Styling revives the dead `.version-dialog*` block
(`VersionHistoryPanel.css:366-450`) — already token-based (light/dark-safe) and authored for
exactly these dialogs (FR-007) — augmented with: (a) a 480px bottom-sheet treatment like
`ShareDialog.css:336-355`, (b) 44px min-height on input + action buttons (SC-003), (c) an
error-message line (FR-006 scenario 6 / FR-005 failure surfacing).

**Rationale**: No generic `Modal`/`ConfirmDialog` exists (verified — ShareDialog is bespoke);
building a shared modal system is overhaul-scope (D2). Reviving the dead CSS is the smallest
honest implementation and discharges FR-007. Keeping dialog state local to the two trigger
sites (list + header) avoids threading a global dialog manager.

**Semantics to preserve exactly (FR-005/FR-014)**:
- Name attaches to `item.clockEnd` via `onCreateNamedVersion(name, item.clockEnd)`; rename
  uses `onRenameVersion(item.id, name)` — same as current `handleNameItem`.
- Role gating unchanged: `canName = !!userRole`, `canRestore = !isCurrent && role !== viewer`,
  `canRemoveName = isNamed && !isSubVersion` (sub-rows keep no remove-name — Assumption).
- Rename-to-identical-name is a no-op that still closes cleanly; whitespace-only stays
  disabled.

**Alternatives considered**: keep native prompts (rejected — the breakage being fixed, D2);
delete dead CSS and write fresh (allowed by FR-007 but wasteful — revival chosen).

**Files**: NEW `VersionNameDialog.jsx`, `VersionConfirmDialog.jsx`; MODIFY
`VersionHistoryPanel.css` (revive + augment dialog CSS), `HierarchicalVersionList.jsx` (row
action dialog state), `EditorView.jsx` (header restore dialog state).

---

## R5 — Restore navigation + close deep-link fallback (D5, open → resolved)

**Decision**:
- **Restore → in-app nav**: after `restoreVersion(id)` resolves truthy, call
  `onNavigateToDoc(docGuid)` instead of `window.location.reload()`. `navigateToDoc` already
  exists in `App.jsx` (pushState to `/d/{guid}`), which remounts `EditorView` in normal mode
  with a fresh `useYjs`/`useVersionHistory`, showing the restored content — no reload needed
  (D5; `restoreVersion` already `fetchHistory()`s and returns success,
  `useVersionHistory.js:309-325`). Wire `navigateToDoc` into `EditorView` as a new
  `onNavigateToDoc` prop (App.jsx already passes `navigateToDoc` to other components). Thread a
  post-restore callback from `EditorView` → `VersionHistoryPanel` → `HierarchicalVersionList`
  so the row-menu restore path also navigates in-app (today the reload lives inside the list's
  `handleRestoreItem`).
- **Close deep-link fallback**: record in `App.jsx` whether the versions route was reached via
  in-app navigation (set a ref/flag in `navigateToVersions`; it is unset on a fresh page load
  that lands directly on `/d/{guid}/versions`). Pass this as e.g. `versionsReachedInApp` (or a
  ready-made `onCloseVersions`) so `handleCloseVersionHistory` does `history.back()` when true
  (preserves scenario 3 back semantics) and `onNavigateToDoc(docGuid)` when false (deep-link
  scenario 2 — never exit the app).

**Rationale**: Verified minimal (D5): version-history mode mounts no live editor, navigation
already remounts via pushState, and `history.back()` is the current behavior to preserve when
there IS in-app history. The only new machinery is a boolean "did we arrive here in-app" flag.

**Alternatives considered**:
- Always `navigateToDoc` on close (rejected — pushState adds a history entry, breaking
  scenario 3's "one step back returns to the document" and the browser-back equivalent).
- `document.referrer` sniffing (rejected — unreliable across SPA nav and privacy settings).
- `window.history.length` heuristic (rejected — unreliable; a fresh tab can still have
  length > 1).

**Files**: `App.jsx` (flag + prop wiring), `EditorView.jsx` (close handler branch + header
restore navigation), `HierarchicalVersionList.jsx` (row restore navigation via callback),
`VersionHistoryPanel.jsx` (thread callback).

---

## R6 — Small-screen layout & touch targets (D3/D4, resolved by decision; anchors confirmed)

**Decision**: Keep the 60/40 preview-over-list split (D4). Within it:
- **Header (EditorView.css version-history-header)**: at 360-430px, let `.version-history-title`
  truncate (`min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`) so
  back + Restore never overflow; compact the Restore button padding/label at ≤480px while
  keeping it identifiable (FR-009). Back button already 8px padding — bump to a 44px effective
  target on touch (FR-008).
- **44px targets (SC-003/FR-008)**: on touch layouts, size to ≥44px in the smaller dimension:
  header back, Restore, panel close (`.version-history-close`), filter `<select>`, highlight
  checkbox (+ its tappable `<label>`), month header, expand chevron button, row menu button,
  menu items, and dialog controls. Reuse the exact pattern from `EditorView.css:234-256`
  (`.tools-menu-btn` 44×44). The 14px checkbox gets a 44px-min tappable label wrapper rather
  than a giant checkbox.
- **Independent scroll (FR-010)**: `.hierarchy-list` already `overflow-y:auto`; ensure the
  panel body scrolls independently of `.version-history-main` (preview) — verify both regions
  scroll and that the "Showing N of M edits" indicator + footer remain reachable.
- **No horizontal overflow (FR-011/SC-004)**: audit long names/author lists/on-behalf-of at
  360px; on-behalf-of already wraps via `overflow-wrap:anywhere`; add wrap/truncate where
  needed. Controls row wraps if the filter + toggle don't fit (FR-009 scenario 5 / US3 AC5).
- **Landscape (FR-010/US3 AC4)**: at short viewport heights, ensure neither the 60% preview
  nor the 40% list collapses to an unusable strip and both scroll internally. Minimal
  rebalance only if genuinely needed (D4 leaves this door barely ajar).

**Rationale**: Direct restatement of the ratified D3/D4 anchors and the app's own 44px
precedent; no new system (FR-016).

**Files**: `EditorView.css` (header + split/landscape), `VersionHistoryPanel.css`
(controls/close 44px), `HierarchicalVersionList.css` (row/menu/chevron 44px).

---

## Detection note (Assumption)

Touch detection is CSS capability (`@media (hover: none)` / `(pointer: coarse)`), NOT the
UA-based `useMobile()` hook, except where the app already applies `useMobile()` (e.g.
ShareDialog's keyboard-aware bottom sheet). The new dialogs MAY reuse the ShareDialog
bottom-sheet CSS approach purely via the 480px media query without depending on `useMobile()`.
