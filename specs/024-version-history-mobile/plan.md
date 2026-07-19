# Implementation Plan: Version History Mobile/Touch Usability

**Branch**: `024-version-history-mobile` | **Date**: 2026-07-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/024-version-history-mobile/spec.md`

## Summary

Make the version-history screen genuinely usable on touch/small-screen devices without
redesigning it. Four client-only slices, in priority order: (P1) reveal the per-row
options menu on touch and on desktop drill-down rows, and stop the dropdown being clipped
by the panel's scroll container; (P2) replace `window.prompt`/`window.confirm` with styled
in-app dialogs (reviving the dead `.version-dialog*` CSS); (P2) fix small-screen layout —
44px touch targets, non-overflowing header, independent scroll regions, landscape usability;
(P3) end restore with in-app navigation instead of `window.location.reload()`, and give
close a deep-link fallback so it never exits the app.

Technical approach: pure CSS/JSX changes across the existing version-history components plus
two new local dialog components. No server, API, migration, or shared-schema changes
(FR-015 / D7). All adaptations reuse existing conventions — `@media (hover: none)`
(MenuCommon.css:177), 768px/480px breakpoints, the 44px header-button precedent
(EditorView.css:234-256), and the ShareDialog overlay pattern (D1/D3/D16).

## Technical Context

**Language/Version**: JavaScript (ES2022), React 18 function components + hooks

**Primary Dependencies**: React 18, existing app CSS token system; `react-dom`'s
`createPortal` (already available via react-dom) for the menu-clipping fix. No new npm
dependencies.

**Storage**: N/A (client-only; no persistence changes)

**Testing**: Vitest + @testing-library/react (`client/src/**/__tests__/`), jsdom environment

**Target Platform**: Web (mobile/touch browsers 360-430px portrait + landscape, plus desktop
regression-free). Touch detected via CSS hover/pointer capability, not UA sniffing.

**Project Type**: Web application — this feature touches the React client only
(`client/src/`).

**Performance Goals**: No new performance budget; removing the full-page reload is itself the
perf win. Portal-menu reposition on scroll/resize must not thrash (reposition-on-open +
close-on-scroll, or rAF-throttled).

**Constraints**: No horizontal page scroll from 360px up (SC-004); every interactive element
≥44px effective target on touch layouts (SC-003); zero native prompt/confirm in the version
experience (SC-002); desktop behavior regression-free (SC-006); no server/API/schema change
(FR-015).

**Scale/Scope**: 2 modified components + 3 modified CSS files + App.jsx one-line prop wiring
+ 2 new dialog components (sharing revived CSS); extend one existing test file and add two
dialog test files. Usability fixes only — no IA redesign.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Documentation Reflects Reality**: No behavior described in `README.md` / `docs/dev.md`
  changes at a level this touches. Parallel-agent override forbids editing those files.
  → PASS (no doc drift introduced).
- **II. Test-Backed Changes**: Every behavioral change gets Vitest coverage — capability-based
  reveal, dialog open/confirm/cancel/disabled/error, navigation-instead-of-reload, outside-tap
  dismissal. Extends `HierarchicalVersionList.test.jsx`; adds dialog tests. Frontend suite is
  the reviewer. → PASS.
- **III. Trunk-Based Solo Workflow**: Planning only; no branch/commit here (parallel-agent
  override: stay on main, never commit). → PASS.
- **IV. Collaboration-Safe Document Operations**: No document-mutation code changes. Restore
  still goes through the existing `restoreVersion` API call unchanged — no Yjs tree edits, no
  delete-and-recreate; provenance/attribution untouched. → PASS.
- **V. Secure by Default**: No new ingestion surface, script execution, or endpoints.
  Untrusted metadata (author / on-behalf-of) stays rendered inertly as today. → PASS.
- **VI. Design Docs Are Ground Truth**: No `design/` export contradicts this usability work;
  the broader UX overhaul remains DEFERRED. Open product decisions were resolved as
  RATIFIED-BY-DEFAULT (D1-D7) in `clarifications-needed.md`; D7 confirms no server gap.
  → PASS.

**Result**: PASS — no violations, Complexity Tracking not required. Re-checked post-Phase 1:
still PASS (design introduces only local client components + revived CSS; no new dependency,
no boundary crossed).

## Project Structure

### Documentation (this feature)

```text
specs/024-version-history-mobile/
├── plan.md              # This file
├── research.md          # Phase 0 — mechanism decisions (menu clipping, close fallback, dialog placement)
├── data-model.md        # Phase 1 — client state shapes (no new persisted entities)
├── quickstart.md        # Phase 1 — validation guide (Vitest + manual device matrix)
├── contracts/
│   └── ui-contract.md   # Phase 1 — component/interaction contracts (no external API)
├── clarifications-needed.md   # D1-D7 ratified decisions (pre-existing)
├── checklists/requirements.md # pre-existing
└── tasks.md             # /speckit-tasks output
```

### Source Code (repository root)

```text
client/src/
├── components/
│   ├── HierarchicalVersionList.jsx     # MODIFY: dialog state for row actions; menu portal+flip; pointer outside-dismiss; drop prompt/confirm; post-restore callback
│   ├── HierarchicalVersionList.css     # MODIFY: @media (hover:none) reveal + sub-row hover reveal; 44px targets; portal-menu positioning classes
│   ├── VersionHistoryPanel.jsx         # MODIFY: thread onNavigateToDoc post-restore callback down to the list
│   ├── VersionHistoryPanel.css         # MODIFY: revive .version-dialog* CSS as real dialog styling (+480px sheet, 44px targets, error text); 44px controls (filter, toggle, close)
│   ├── VersionNameDialog.jsx           # NEW: text-input dialog (name/rename) — ShareDialog overlay conventions
│   ├── VersionConfirmDialog.jsx        # NEW: confirmation dialog (restore/remove-name) with consequence text + error surface
│   ├── EditorView.jsx                  # MODIFY: header Restore → confirm dialog + in-app nav (no reload); close deep-link fallback
│   ├── EditorView.css                  # MODIFY: version-history header no-overflow at 360-430px, truncating title, compact Restore; landscape split usability
│   └── __tests__/
│       ├── HierarchicalVersionList.test.jsx   # EXTEND: reveal, menu, dialog-trigger, post-restore, outside-tap
│       ├── VersionNameDialog.test.jsx         # NEW
│       └── VersionConfirmDialog.test.jsx      # NEW
├── hooks/
│   └── useVersionHistory.js            # UNCHANGED (restoreVersion already refetches + returns success)
└── App.jsx                             # MODIFY (minimal): pass navigateToDoc into EditorView as onNavigateToDoc for in-app restore/close
```

**Structure Decision**: Web-app client only. All work lives under `client/src/`. Two new
sibling dialog components are colocated with the version-history components; their styling
revives the existing `.version-dialog*` block in `VersionHistoryPanel.css` (shared by both
dialogs) rather than adding a new stylesheet, satisfying FR-007. No `backend/`, `server/`, or
`shared/` paths are touched (FR-015 / D7).

## Phase 0 — Research

See [research.md](./research.md). Three mechanism decisions were open per D6 and D5; all are
resolved there:

1. **Menu-clipping mechanism (D6)**: portal the dropdown to `document.body` with fixed
   positioning anchored to the trigger button, flipping above when space below is
   insufficient; close on scroll. Escapes the `overflow-y:auto` clip entirely (FR-003).
2. **Outside-tap dismissal on touch (D6/FR-003)**: switch the click-outside listener from
   `mousedown` to `pointerdown` so a single code path covers mouse + touch.
3. **Close deep-link fallback + restore navigation (D5)**: App.jsx records whether the
   versions view was reached via in-app navigation; close uses `history.back()` when it was,
   else in-app `navigateToDoc(guid)`. Restore success calls `onNavigateToDoc(guid)` instead of
   `window.location.reload()`. Dialog placement: row-action dialogs live in
   `HierarchicalVersionList`; the header-Restore dialog lives in `EditorView`; both reuse the
   two new dialog components.

## Phase 1 — Design & Contracts

- [data-model.md](./data-model.md): no new persisted entities; documents the client-only
  dialog/menu state shapes and the unchanged version/sub-version/role representations.
- [contracts/ui-contract.md](./contracts/ui-contract.md): component props and interaction
  contracts for the two dialogs, the menu-reveal capability rules, the touch-target contract,
  and the navigation contract. No external/HTTP API contract (client-only feature).
- [quickstart.md](./quickstart.md): how to run the extended Vitest suite plus the manual
  device/width matrix that proves SC-001..SC-006.

## Complexity Tracking

> No Constitution violations — table intentionally empty.
