# Quickstart / Validation Guide: Version History Mobile/Touch Usability

Client-only feature. Validation is the Vitest component suite (Constitution Principle II) plus
a manual device/width matrix for the visual/touch criteria that jsdom cannot measure.

## Prerequisites

- Work runs in the Minikube `app-dev` pod (see `docs/dev.md`).
- Frontend deps installed (`client/`). Vitest + @testing-library/react already configured.

## Automated validation (Vitest)

Run the version-history frontend tests:

```bash
# from client/
npx vitest run src/components/__tests__/HierarchicalVersionList.test.jsx \
                src/components/__tests__/VersionNameDialog.test.jsx \
                src/components/__tests__/VersionConfirmDialog.test.jsx
```

Expected coverage (added/extended by this feature):

- **US1 reveal (FR-001/FR-002)**: menu button present and reachable on sub-rows; hover/focus
  reveal rules assert via class/structure (capability `@media` itself is visual — see manual).
- **US1 menu (FR-003)**: open menu renders (portaled) and closes on outside `pointerdown`;
  opening does not fire row selection.
- **US2 dialogs (FR-004/005/006)**: `VersionNameDialog` — pre-fill on rename, confirm disabled
  for empty/whitespace, trims on submit, Escape/backdrop/Cancel dismiss, error stays open;
  `VersionConfirmDialog` — consequence text, explicit-confirm-only, dismissal paths, error
  surfacing. List no longer calls `prompt`/`confirm` (assert via spies that they are NOT
  called; the actions still invoke `onCreateNamedVersion`/`onRenameVersion`/`onRestoreVersion`/
  `onDeleteVersion` with the same args).
- **US4 navigation (FR-012/013)**: restore success invokes the in-app navigate callback and
  NOT `window.location.reload`; close uses back vs navigate per the in-app flag.
- **US3/SC-006 regression**: existing selection, drill-down, filter, diff-toggle,
  "Showing N of M edits", on-behalf-of tests still pass.

Whole-suite regression:

```bash
# from client/
npx vitest run
```

## Manual validation (device/width matrix — SC-001, SC-003, SC-004, SC-005)

Use browser touch emulation (or a real phone) at **360px, 393px, 430px** portrait plus **one
landscape** height. Open a document's version history (`/d/{guid}/versions`).

1. **SC-001 actions on touch**: on a top-level version row AND a drill-down edit row, tap the
   three-dot menu (visible without hover) → run Name, Rename, Restore, Remove name (where
   applicable) end-to-end via in-app dialogs. All applicable paths complete.
2. **FR-003 clipping**: open the menu on the LAST visible row in the 40%-height bottom panel →
   the full menu is visible (flips above if needed), and a tap outside closes it.
3. **SC-003 targets**: element-by-element, every interactive control (back, Restore, close,
   filter, highlight toggle, month header, chevron, row, menu button, menu items, dialog
   controls) is ≥44px in its smaller dimension.
4. **SC-004 no horizontal scroll**: with maximal content (long version name, 3+ authors,
   on-behalf-of lines, open menu, open dialog) there is no horizontal page scroll at any width
   ≥360px.
5. **SC-002 no native dialogs**: no `window.prompt`/`confirm` appears for any action.
6. **US3 AC4 landscape**: in landscape, both preview and list stay usable and scroll
   internally.
7. **SC-005 navigation**: restore a version → the document view appears with restored content
   with NO full-page reload (watch: no white flash / network reload). Open
   `/d/{guid}/versions` in a fresh tab → close/back lands on the document, does not exit the
   app. Navigate to versions from the doc → back returns to the doc (one step).

## Success mapping

| Criterion | Validated by |
|-----------|--------------|
| SC-001 | Manual matrix #1 + Vitest US1/US2 |
| SC-002 | Vitest (no prompt/confirm spies) + manual #5 |
| SC-003 | Manual #3 |
| SC-004 | Manual #4 |
| SC-005 | Vitest US4 + manual #7 |
| SC-006 | Vitest whole-suite regression |
