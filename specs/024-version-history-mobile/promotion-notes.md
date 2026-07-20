# Promotion Notes — 024-version-history-mobile

Implementation completed 2026-07-19/20. Client-only. All 24 code/test tasks landed;
T025 (full Vitest) run green during implementation, T026 (manual device matrix) left
for Sam per the pipeline (browser E2E owner).

## Owed manual verification (T026 — Sam)

jsdom cannot measure layout/geometry, so these SC criteria need the browser matrix at
360/393/430px portrait + one landscape height:

- **FR-011 / SC-004 (no horizontal page scroll)**: explicitly confirm that both **open
  row menus** (now portaled to `document.body`, fixed-positioned, viewport-clamped) AND
  **open dialogs** (name/rename/restore/remove-name, incl. the ≤480px bottom-sheet) at
  360px introduce **no** horizontal page scroll, with maximal content (long version name,
  3+ authors, on-behalf-of lines).
- **SC-003 (44px targets)**: element-by-element audit of every interactive control on a
  touch layout (`@media (hover: none)`), since the sizing is CSS-media-driven.
- **SC-001 / SC-005**: full touch action walk-through and the no-reload restore + deep-link
  close behaviors on a real device / emulation.

## Deviations from tasks.md (folded, low-risk)

- **Reload fallback removed, not just replaced (T023/T024 intent).** The row-menu restore
  (`HierarchicalVersionList.handleConfirmRestore`) and header restore
  (`EditorView.handleConfirmHeaderRestore`) now call `onNavigateToDoc(docGuid)` with **no**
  `window.location.reload()` fallback. `onNavigateToDoc` is always wired
  (App → EditorView → VersionHistoryPanel → list), so the fallback was dead and would have
  tripped the T024 no-reload grep. If `onNavigateToDoc` were ever absent, restore succeeds
  server-side and the user stays on the (already-refetched) version screen — no reload.

## Future / out-of-scope candidates (not implemented — deferred overhaul)

- Human-readable version labels, live version-list refresh, and the route/view split remain
  DEFERRED per the brief and clarifications D-notes; untouched here.
- A shared `Modal`/`ConfirmDialog` primitive: this feature intentionally kept the two dialogs
  local (D2). If more surfaces need styled confirms, promoting these into a shared component
  is a reasonable future extraction.
