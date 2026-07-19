# UI / Interaction Contracts: Version History Mobile/Touch Usability

Client-only feature — there is **no external/HTTP API contract** (FR-015 / D7). The existing
version endpoints (`POST /api/docs/:guid/versions`, `.../restore`, name/rename/delete) are
called unchanged through `useVersionHistory`. This document specifies the component and
interaction contracts the implementation and tests must honor.

---

## C1 — Menu reveal capability contract (FR-001, FR-002)

- On `@media (hover: none)`: the row menu button (`.hierarchy-menu-btn`) is `opacity: 1`
  (persistently visible, single-tap opens) on BOTH `.hierarchy-version` and `.hierarchy-update`
  rows.
- On hover-capable devices: menu button revealed on row hover for BOTH `.hierarchy-version`
  AND `.hierarchy-update` (the sub-row hover rule is NEW), and on `:focus` (keyboard).
- Opening the menu MUST NOT select the row (`stopPropagation` on the button preserved).

## C2 — Menu clipping + dismissal contract (FR-003)

- An open dropdown MUST render fully within the viewport, never clipped by `.hierarchy-list`'s
  `overflow-y:auto` — achieved by portaling to `document.body` with `position:fixed` coords,
  flipping above the trigger when space below is insufficient (R2).
- The menu MUST close on outside tap/click on BOTH touch and pointer devices (listener uses
  `pointerdown`; the portaled dropdown counts as "inside") and on scroll/resize.

## C3 — `VersionNameDialog` component contract (FR-004, FR-005)

Props: `{ isOpen, mode: 'name'|'rename', initialValue, onConfirm(trimmedName), onCancel, busy, error }`

- Renders a styled overlay (revived `.version-dialog*` CSS) — NOT `window.prompt`.
- Text input auto-focused (and text-selected for rename); `initialValue` pre-fills for rename.
- Confirm control DISABLED while `value.trim()` is empty/whitespace; on confirm passes
  `value.trim()`.
- Enter submits (when enabled); Escape, backdrop click, and Cancel all dismiss with no side
  effect.
- While `busy`: controls disabled/indicate progress. On `error`: message shown, dialog stays
  open (FR-005/FR-006 failure surfacing).
- At 360px: fits viewport, no horizontal overflow; controls ≥44px (SC-003/SC-004).

## C4 — `VersionConfirmDialog` component contract (FR-004, FR-006)

Props: `{ isOpen, title, message, confirmLabel, onConfirm, onCancel, busy, error }`

- Styled overlay confirmation — NOT `window.confirm`.
- `message` states the consequence (restore: "a new version will be created with the restored
  content"; remove-name: names the affected version).
- Only an explicit confirm performs the action; Escape, backdrop, and Cancel dismiss with no
  side effect.
- `busy` / `error` behavior as C3. At 360px: fits, ≥44px controls.

## C5 — Action semantics contract (FR-005, FR-014 — MUST match current behavior)

- Name: `onCreateNamedVersion(trimmedName, item.clockEnd)`.
- Rename: `onRenameVersion(item.id, trimmedName)`; renaming to the identical name is a
  no-op that still closes cleanly.
- Restore: `onRestoreVersion(item.id)` → on truthy success, in-app navigate (C7); no reload.
- Remove name: `onDeleteVersion(item.id)`.
- Role gating unchanged: viewers see no Restore (row or header) but may name/rename per current
  rules; sub-versions expose no remove-name.

## C6 — Touch-target contract (FR-008, SC-003)

On touch layouts every interactive element in version history has an effective target ≥44px in
its smaller dimension, reusing the `EditorView.css:234-256` 44px precedent: header back,
Restore, panel close, filter select, highlight toggle (via a ≥44px tappable label), month
header, expand chevron, row, menu button, menu items, dialog input, dialog buttons.

## C7 — Navigation contract (FR-012, FR-013)

- **Restore success** → `onNavigateToDoc(docGuid)` (App.jsx `navigateToDoc`, pushState to
  `/d/{guid}`) which remounts the editor with restored content — NO `window.location.reload()`.
  Applies to BOTH the header Restore button and the row-menu Restore.
- **Close/back**:
  - Reached in-app (`versionsReachedInApp === true`): `window.history.back()` (unchanged
    semantics — one step back returns to the document; browser back works). (FR-013, US4 AC3)
  - Deep-linked / fresh tab (`false`): `onNavigateToDoc(docGuid)` — lands on the document,
    never exits the app. (FR-013, US4 AC2)
- `Cmd/Ctrl/middle-click` on the back/close anchors keeps native browser behavior
  (`shouldUseBrowserLinkBehavior`, unchanged).

## C8 — Layout contract (FR-009, FR-010, FR-011)

- 360-430px: header shows back + truncating title + Restore (when permitted) with no
  horizontal overflow; Restore label may compress but stays identifiable.
- ≤768px: preview-over-list 60/40 split retained; both regions independently scrollable; all
  list content (months, versions, drill-down edits, "Showing N of M edits", footer) reachable.
- Landscape short-height: neither region collapses to an unusable strip; internal scrolling
  reaches all content.
- No horizontal PAGE scroll at any width ≥360px, including with maximal content and open
  menus/dialogs.

## C9 — No-native-dialog invariant (FR-004, SC-002)

After this feature, no code path in the version-history experience calls `window.prompt`,
`window.confirm`, or `window.alert`. (Grep-checkable: the three call sites at
`HierarchicalVersionList.jsx:333/346/353` and `EditorView.jsx:360` are removed.)
