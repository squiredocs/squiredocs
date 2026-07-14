<!-- source: https://squiredocs.com/d/43a8653c-28f0-4598-9f92-9122ba686883
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire UI Theming and Dark Mode

**Status**: Ratified design (feature `006-dark-mode`, 2026-07-14). Authored from the ratified feature spec (`specs/006-dark-mode/`); decisions D1–D9 in that feature's `clarifications-needed.md` are the decision record. Amend this doc first for any theming design change, then `node design/sync.mjs`. **Amended 2026-07-14 (Sam): the document canvas themes dark in dark mode — the original light-paper decision (D5) is superseded; see "The dark canvas".**

## Why

The client is styled in plain per-component CSS (~8,300 lines across 35+ files) whose only design tokens are the typography tokens in `client/src/index.css` `:root`. Colors are hardcoded per surface, so no theme can exist until color is centralized. Dark mode is therefore two mechanisms: a **semantic color-token layer** that all themed surfaces — chrome and document canvas — consume, and a **theme switch** that swaps palettes behind it.

## The dark canvas (amended 2026-07-14)

Originally this design kept the canvas light (the "paper model", decision D5). **Sam overrode that on 2026-07-14: the document canvas — the editable surface and document-content rendering in version previews — themes dark in dark mode.** The invariants that survive the override:

- Stored content never changes: theming remains purely presentational — no document writes, no version entries, no collaboration-state changes.
- Author-set colors (color picker, agent-authored) render exactly as authored in both themes — no remap, inversion, or adjustment in v1. Default (unset) text and the canvas background come from the semantic token layer, so unstyled documents read natively in both themes. A contrast-adaptive display remap for author colors is explicit future work.
- **Mermaid diagrams invert in dark mode (Sam directive, 2026-07-14): **a presentational CSS inversion filter (token-driven, `--canvas-mermaid-filter`: none in light, invert+hue-rotate in dark) flips the rendered diagram and its plate to dark while roughly preserving hue. The filter is display-only: stored diagram source, print output (filter forced off in the print token reset), clipboard PNG copies, and exports all remain light-rendered. SVG blocks keep the constant light media plate — arbitrary author markup cannot be safely re-themed. Images render unplated (raster content is self-contained). Code blocks are plain-styled text and tokenize with the canvas.
- Print is always light: forced-light print styles make printed output identical from both themes.
- Selection highlights, presence cursors, and attribution on the dark canvas meet the same AA-legibility bar as chrome; the user→color identity mapping never changes.

Known v1 caveat, accepted: author-chosen dark colors on the default background can read low-contrast against the dark canvas. The author sees what any dark-theme viewer sees; the adaptive display remap above is the designed fix, later.

## Semantic color-token layer

- Every color used by themed surfaces (app chrome and the document canvas) is defined exactly once, by **semantic role** (surface tiers, text tiers, borders, accents, interactive states), as CSS custom properties alongside the existing typography tokens in `client/src/index.css`.
- Themes are wholesale palette swaps: the light palette is the `:root` default; the dark palette overrides the same custom properties under a root-level theme attribute (e.g. `[data-theme="dark"]`).
- After migration, no themed surface may carry a hardcoded color literal (the constant light media plate for diagram/SVG blocks and forced-light print styles are the only sanctioned exceptions, defined once as tokens themselves) that bypasses the layer. The migration must be mechanically verifiable (no stray color literals in migrated chrome CSS).
- Typography tokens are unchanged; the color layer follows the same pattern.

## Theme selection and application

- Exactly three appearance settings: **Light / Dark / System**; default is System. Under System the app follows the OS `prefers-color-scheme`, live, without reload.
- The control lives in the user profile menu on every authenticated screen and shows the active setting.
- Persistence is **device-local (localStorage)** in v1; no server-side or account-level storage. Syncing the preference to the user profile is future work.
- **No flash of wrong theme**: the resolved theme is applied to the document root before first paint on every page — authenticated or not (login/legal honor the stored device choice, else OS preference).
- Theme switching is purely presentational: it never writes to documents, creates versions, or touches collaboration state.

## Accessibility and identity colors

- All themed surfaces — chrome and the canvas’s default (token-driven) styling — meet WCAG 2.1 AA: 4.5:1 normal text, 3:1 large text and meaningful UI components/states (focus, hover, selection, perceivable-disabled). States are in scope, not just resting surfaces — selection, focus rings, scrollbars, hover.
- Collaborator identity colors (avatars, presence cursors, selection attribution) keep the same user→color mapping in both themes; dark chrome must keep every identity color distinguishable and legible via presentation affordances (not by changing the mapping).
- Theme switching introduces no animation that violates the global reduced-motion behavior.

## Out of scope (v1)

Contrast-adaptive display remap of author-set colors on the dark canvas; server-side preference persistence; custom or high-contrast themes; per-document appearance; re-theming exports, print, or rendered SVG-block content (the display-only mermaid inversion above is the one sanctioned exception); live cross-tab propagation of theme changes (every tab honors the stored choice on load).