# Quickstart & Validation: Dark Mode

Runnable validation for the three user stories and the two mechanical gates.
Client-only; no server/DB setup beyond the normal dev environment.

## Prerequisites

- Dev environment per `docs/dev.md` (commands run in the `app-dev` pod / against
  the running client).
- `design/` theming design doc landed via `node design/sync.mjs` (Constitution
  VI prerequisite — build depends on it).
- From `client/`: `npm install` already done.

## Build & automated gates

```bash
# Compile / bundle check
cd client && npm run build

# Unit + behavioral tests (theme resolution, persistence, system-follow)
cd client && npm test

# Migration gate: no hardcoded chrome color literals remain (D13)
cd client && npm run lint:colors   # runs scripts/check-color-tokens.mjs
```

Expected: build succeeds; Vitest green; `lint:colors` reports **0** disallowed
literals (only the token-definition block and the canvas allowlist contain
literals).

## Story 1 — Switch to dark and have it stick (P1)

1. Load any authenticated screen (default light).
2. Open the user profile menu → theme control → select **Dark**.
   - Expect: every chrome surface (doc list, side panes, toolbar, menus,
     dialogs, version history chrome, AI/chat panel, admin) restyles dark
     immediately, no reload; no light-remnant surface (SC-003).
3. Reload the tab (warm), then fully close and reopen (cold), ×10.
   - Expect: first visible frame is dark every time — zero light flashes
     (SC-002). Verify by throttling CPU/network and watching the first paint.
4. Select **Light**.
   - Expect: returns to light immediately and persists across reload.

## Story 2 — Follow system preference (P2)

1. Clear `localStorage['squire-theme']` (simulate never-chosen) and set the OS to
   dark. Load the app **including the login screen**.
   - Expect: renders dark from first paint (D2, FR-005).
2. With the setting on **System** and app open, toggle OS appearance.
   - Expect: app restyles live, no reload — including any open dialog/menu/AI
     panel (FR-003, edge case).
3. Explicitly choose **Light**, then toggle OS to dark.
   - Expect: app stays light (explicit choice wins).
4. Choose **System** again.
   - Expect: resumes following the OS.

## Story 3 — Documents stay faithful in dark (P3)

1. In dark mode, open a document with: author-set text/background colors (color
   picker), a Mermaid diagram, an SVG block, an image, and a code block.
   - Expect: the canvas is light "paper"; every author color and embedded item
     renders identically to light mode (FR-007–FR-009, SC-005). Compare
     side-by-side with light mode.
2. Print-preview the document from dark mode.
   - Expect: output identical to printing from light mode (FR-010, D7).
3. Perform several theme switches during a collaborative edit session, then
   inspect version history.
   - Expect: zero version entries attributable to theming (FR-014, SC-006).
4. Confirm the light↔dark seam reads as an intentional page edge, not a bug
   (edge case).

## Accessibility gate (SC-004 / FR-011)

- Run a contrast audit (e.g. axe / Lighthouse / manual contrast checks) over
  dark chrome: text ≥ 4.5:1, large text & meaningful UI states (focus, hover,
  selection, disabled) ≥ 3:1. Expect zero AA failures.
- Verify presence identity colors (avatar borders / labels) remain
  distinguishable against dark chrome, including the darkest Kelly color
  (Dark Olive Green `#2B3D26`), with mapping unchanged (D8/D14, FR-012).
- Confirm theme switching introduces no motion that violates the global
  reduced-motion behavior.

## References

- Token roles & canvas allowlist: [contracts/color-tokens.md](./contracts/color-tokens.md)
- Control/resolver behavior: [contracts/theme-control.md](./contracts/theme-control.md)
- State model: [data-model.md](./data-model.md)
