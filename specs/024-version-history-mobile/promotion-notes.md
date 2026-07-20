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

## Post-merge review dispositions (2026-07-19, reviewer: Fable — MERGE STANDS)

- **HIGH-1 (FIXED same-day, orchestrator):** name/rename/remove-name failures
  closed the dialog as if they succeeded — the hook signals failure without
  throwing (createNamedVersion → null, renameVersion/deleteNamedVersion →
  false) and only the restore handler checked. All three handlers now treat
  false/null as failure and keep the dialog open with the error (matching
  restore); 3 wiring regression tests added.
- **MEDIUM-2 (FIXED same-day):** VersionConfirmDialog never received focus, so
  Escape was dead (the launching menu item unmounts → activeElement falls to
  body) and the tests masked it by firing keyDown at the overlay node. The
  Cancel button now takes rAF focus on open (same pattern as
  VersionNameDialog's input) + aria-modal; test asserts Escape works from the
  actually-focused element. Full focus trap NOT added (matches the
  VersionNameDialog/ShareDialog level of rigor) — fold into any future a11y
  pass.
- **MEDIUM-3 (FIXED same-day):** versionsReachedInApp was a session-global
  one-way ref, so a back-navigated deep-link entry could still exit the app on
  close. The flag is now stamped per-entry into history.state by
  navigateToVersions ({ versionsInApp: true }); close checks
  window.history.state. The ref and its prop threading were removed.
- **LOW-4 (FIXED):** stale "reload fallback if absent" comment corrected.
- **LOW-5 (ACCEPTED):** portaled menu lacks aria-haspopup/aria-expanded and
  body-end reading order — pre-existing pattern made slightly more visible;
  fold into a future a11y pass.
- **Reviewer addition to Sam's T026 manual matrix:** include a desktop keyboard
  pass (Escape/Enter/Tab in both dialogs) — that's where MEDIUM-2 lived and
  jsdom masked it.
