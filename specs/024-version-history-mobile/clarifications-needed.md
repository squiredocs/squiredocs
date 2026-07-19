# Clarifications & Recorded Decisions — 024-version-history-mobile

No user interaction was available during specification. Per Constitution Principle VI
and Sam's pre-authorization (2026-07-19), each open product decision below was resolved
with the best default and recorded as RATIFIED-BY-DEFAULT. Overturn any of these by
amending the spec before planning/implementation.

---

## D1 — Menu reveal strategy: capability-based, not width-based (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-19)

**Question**: How should the three-dot row menu become reachable on touch — always visible everywhere, visible below a width breakpoint, or visible on non-hover devices?

**Decision**: Persistently visible on devices without hover capability (CSS `@media (hover: none)` detection); hover-reveal preserved on pointer devices, extended to also cover drill-down edit rows (currently missing); keyboard-focus reveal kept.

**Rationale**: `MenuCommon.css:177` already establishes `@media (hover: none)` as this codebase's touch-detection convention — matching it avoids inventing a second system (explicit brief requirement). Width-based reveal would wrongly hide menus on narrow desktop windows and wrongly hover-gate them on large tablets. Always-visible everywhere would change desktop visuals for no usability gain, exceeding the "usability, not redesign" scope.

## D2 — Dialog approach: revive the dead styled-dialog CSS as real in-app dialogs (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-19)

**Question**: Replace `window.prompt`/`window.confirm` with what — keep native, revive the ~90 lines of dead `.version-dialog*` CSS (`VersionHistoryPanel.css:366-450`), or build on another component?

**Decision**: Styled in-app dialogs (text-input dialog for name/rename; confirmation dialog for restore/remove-name), reviving the dead `.version-dialog*` CSS as their styling, structured to match the app's proven overlay-dialog conventions (ShareDialog pattern: token-based backdrop, centered card, Escape/backdrop dismiss, 480px small-screen handling). If revival proves worse than deleting and restyling fresh against the same conventions, the dead CSS must be deleted — it may not remain dead either way (FR-007).

**Rationale**: Native prompts are the concrete mobile breakage being fixed and are suppressed in some embedded contexts. The dead CSS is already token-based (light/dark safe) and was clearly authored for exactly these dialogs — reviving it is the smallest honest implementation. There is no generic shared dialog component in the codebase to reuse (verified: ShareDialog is bespoke; no `ConfirmDialog`/`Modal` exists), and building one is overhaul-scope, not usability-scope.

## D3 — Breakpoints and touch targets: reuse 768px/480px and the 44px precedent (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-19)

**Question**: Which breakpoints and target sizes govern the mobile layout work?

**Decision**: Reuse the existing 768px primary / 480px secondary breakpoints (EditorView.css, App.css, ShareDialog.css all use them); 44px minimum effective touch target on touch layouts, matching the existing `.tools-menu-btn`/`.ai-toggle-btn` precedent (`EditorView.css:234-256`); audit/design widths 360-430px per the brief.

**Rationale**: Explicit brief requirement to match existing conventions; 44px is both the app's own precedent and the platform-standard (Apple HIG) minimum.

## D4 — Layout: keep the preview-top / list-bottom split at ≤768px (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-19)

**Question**: Should mobile get a different arrangement (full-screen list with preview drill-in, tabbed list/preview, resizable sheet)?

**Decision**: Keep the existing 60/40 preview-over-list split; fix what's broken inside it (touch targets, header overflow, menu clipping, independent scrolling, landscape usability). No tabs, no drawer, no resize handle.

**Rationale**: Scope is explicitly "USABILITY, not redesign"; the split matches the AI panel's bottom-dock precedent. A route/view restructure is named as part of the DEFERRED overhaul. FR-010 leaves minimal room to rebalance only if landscape usability genuinely demands it.

## D5 — Restore ends in in-app navigation, not reload; close gets a deep-link fallback (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-19)

**Question**: `window.location.reload()` after restore and `window.history.back()` on close — fix or flag?

**Decision**: In scope, as P3 (Story 4): successful restore navigates in-app to the live document; close falls back to in-app navigation to `/d/{guid}` when there is no in-app history (deep link/new tab), preserving normal back semantics otherwise.

**Rationale**: Verified small: the version-history screen mounts no live editor, `restoreVersion` (useVersionHistory.js:309-325) already refetches history and returns success, and the app already navigates views via `pushState` (App.jsx), so navigation to the doc route remounts the editor with fresh content — reload adds nothing but jank. Deep-link close currently exits the app entirely, which is a real trap on mobile. Priced as P3 so it is the first thing cut if it grows beyond a small change.

## D6 — Menu clipping fix is required behavior, mechanism left to plan (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-19)

**Question**: The row dropdown can be clipped by the list's scroll container (absolute-positioned inside `overflow-y: auto`), worst in the 40%-height mobile panel. Guarantee visibility how?

**Decision**: FR-003 mandates the outcome (menu fully visible, never clipped, dismissible by outside tap on touch); the mechanism (flip-above placement, portal/fixed positioning, scroll-into-view) is a plan-phase choice.

**Rationale**: Spec stays outcome-level; all candidate mechanisms are client-only and convention-compatible. Outside-tap dismissal is called out because the current close handler listens to `mousedown` only.

## D7 — No server changes, none needed (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-19)

**Question**: Does anything in this feature truly require a server tweak (which would be out of scope)?

**Decision**: No gap flagged. Every specced behavior is achievable client-only: all four actions already have client API calls that report success/failure; restore-then-navigate needs no new endpoint; layout/dialog/menu work is pure CSS/JSX.

**Rationale**: Audited `useVersionHistory.js` — restore/name/rename/delete all return actionable results and refresh history client-side. Feature 023 (parallel, server-only) shares no files with this feature.

---

## Explicitly out of scope (restating the brief, for the record)

- Human-readable version labels, live refresh of the version list, route/view split — DEFERRED overhaul, untouched.
- Server code, API contracts, migrations — forbidden (FR-015); any discovered need becomes a ledger gap, not code.
- Redesign of the version-history information architecture — usability fixes only.
