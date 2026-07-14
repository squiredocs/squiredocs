<!-- source: https://squiredocs.com/d/43a8653c-28f0-4598-9f92-9122ba686883
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire UI Theming and Dark Mode

**Status**: Ratified design (feature `006-dark-mode`, 2026-07-14). Authored from the ratified feature spec (`specs/006-dark-mode/`); decisions D1–D9 in that feature's `clarifications-needed.md` are the decision record. Amend this doc first for any theming design change, then `node design/sync.mjs`.

## Why

The client is styled in plain per-component CSS (~8,300 lines across 35+ files) whose only design tokens are the typography tokens in `client/src/index.css` `:root`. Colors are hardcoded per surface, so no theme can exist until color is centralized. Dark mode is therefore two mechanisms: a **semantic color-token layer** that all app chrome consumes, and a **theme switch** that swaps palettes behind it.

## The paper model (the load-bearing decision)

The **document canvas stays light in both themes** — the editor surface and document-content rendering in version previews render as light "paper" inside dark chrome. Documents are shared, printed, exported artifacts whose colors are author-chosen content; remapping them per viewer would break WYSIWYG, collaboration fidelity, and print. Consequences:

- Author-set colors (color picker, agent-authored) are never remapped, inverted, or adjusted by theme.
- Embedded content — Mermaid diagrams, SVG blocks, images, code blocks — renders identically in both themes; no dark re-theming of rendered content exists.
- Print output is theme-independent (always the light/print styling).
- Chat/AI panel content is **chrome**, not canvas — it themes dark. Only surfaces that render document content stay light.
- Where light canvas meets dark chrome, the canvas must read as an intentional page edge, not a bug.

A true dark reading/editing canvas (with an author-color legibility strategy) is explicitly future work and needs its own design treatment here first.

## Semantic color-token layer

- Every color used by themed app chrome is defined exactly once, by **semantic role** (surface tiers, text tiers, borders, accents, interactive states), as CSS custom properties alongside the existing typography tokens in `client/src/index.css`.
- Themes are wholesale palette swaps: the light palette is the `:root` default; the dark palette overrides the same custom properties under a root-level theme attribute (e.g. `[data-theme="dark"]`).
- After migration, no themed chrome surface may carry a hardcoded color literal that bypasses the layer. The migration must be mechanically verifiable (no stray color literals in migrated chrome CSS).
- Typography tokens are unchanged; the color layer follows the same pattern.

## Theme selection and application

- Exactly three appearance settings: **Light / Dark / System**; default is System. Under System the app follows the OS `prefers-color-scheme`, live, without reload.
- The control lives in the user profile menu on every authenticated screen and shows the active setting.
- Persistence is **device-local (localStorage)** in v1; no server-side or account-level storage. Syncing the preference to the user profile is future work.
- **No flash of wrong theme**: the resolved theme is applied to the document root before first paint on every page — authenticated or not (login/legal honor the stored device choice, else OS preference).
- Theme switching is purely presentational: it never writes to documents, creates versions, or touches collaboration state.

## Accessibility and identity colors

- All themed chrome meets WCAG 2.1 AA: 4.5:1 normal text, 3:1 large text and meaningful UI components/states (focus, hover, selection, perceivable-disabled). States are in scope, not just resting surfaces — selection, focus rings, scrollbars, hover.
- Collaborator identity colors (avatars, presence cursors, selection attribution) keep the same user→color mapping in both themes; dark chrome must keep every identity color distinguishable and legible via presentation affordances (not by changing the mapping).
- Theme switching introduces no animation that violates the global reduced-motion behavior.

## Out of scope (v1)

Dark document canvas; server-side preference persistence; custom or high-contrast themes; per-document appearance; re-theming exports, print, or rendered diagram/SVG content; live cross-tab propagation of theme changes (every tab honors the stored choice on load).