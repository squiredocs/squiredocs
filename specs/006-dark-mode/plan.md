# Implementation Plan: Dark Mode

**Branch**: `006-dark-mode` | **Date**: 2026-07-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-dark-mode/spec.md`

## Summary

Dark mode is two coupled deliverables against a client that has ~8,300 lines of
per-component CSS with ~900 hardcoded color literals across 33 styled files and
**zero color tokens** (only typography tokens exist in `client/src/index.css`
`:root`):

1. **A semantic color-token layer** — every color used by app *chrome* is
   defined once by role in a shared palette in `index.css`, with a light and a
   dark realization; all hardcoded chrome colors migrate onto it (spec FR-013,
   D9).
2. **A three-state theme control** (Light / Dark / System, default System) in
   the user profile menu, persisted device-local in `localStorage`, applied
   **before first paint** via an inline bootstrap in the HTML shell, following
   the OS live under System (FR-001–FR-005, D1–D4).

The **document canvas stays light "paper" in both themes** (D5): the shared
document-content styling (`.editor-common-content` / `.ProseMirror` in
`EditorCommon.css`, consumed by both the editor and version previews) keeps its
white background and untouched author colors, so embedded diagrams/SVG/images
and print are theme-independent by construction (FR-007–FR-010). The chat/AI
panel is chrome and themes dark. Collaborator identity colors keep their
mapping and get theme-aware legibility affordances (D8).

Client-only: no server, no schema migration, no API. Verified by `npm run build`
in `client`, Vitest unit tests, and a mechanical **no-hardcoded-color lint** over
migrated chrome CSS with an explicit canvas allowlist.

## Technical Context

**Language/Version**: JavaScript (ES modules), React 18, CSS (plain per-component)

**Primary Dependencies**: React 18, Vite (build), TipTap/ProseMirror + Yjs
(editor — untouched here), Vitest (client tests). No new runtime dependency.

**Storage**: `localStorage` (device-local, key `squire-theme`); no server-side
or account-level persistence in v1 (D3). No DB, no migration.

**Testing**: Vitest (`client/src/**/__tests__/`); `npm run build` in `client`
verifies compilation; a repo lint script verifies token migration completeness.

**Target Platform**: Modern evergreen browsers (desktop + mobile web) that
support CSS custom properties, `data-*` attribute selectors,
`prefers-color-scheme`, and `matchMedia` change events.

**Project Type**: Web application, client-only feature (React+Vite SPA in
`client/`).

**Performance Goals**: Zero frames of wrong-theme content on load (SC-002);
theme switch complete with no reload in < 5 s of user action (SC-001) — in
practice a single synchronous attribute swap, effectively instant.

**Constraints**: No-flash before first paint on every route incl.
unauthenticated ones (FR-005); WCAG 2.1 AA contrast for chrome text and
meaningful UI states (FR-011); theming is purely presentational — never writes
documents/versions (FR-014); reduced-motion behavior preserved (edge case).

**Scale/Scope**: 33 CSS files with color literals (~900 literals), 35+ styled
surfaces, ~8,300 CSS lines. The migration is the bulk of the work.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Documentation Reflects Reality | PASS | Feature adds a user-visible theme control; README's UI/feature description will be updated in the implementing commit (task in Polish phase). `docs/dev.md` unaffected (no dev-workflow change). No doc drift introduced by planning. |
| II. Test-Backed Changes | PASS | Behavioral additions (theme resolution, persistence, system-follow, no-flash bootstrap) are covered by Vitest unit tests; the token migration is covered by a mechanical no-hardcoded-color lint. No backend/format-registry surface touched, so the round-trip suite is not implicated. |
| III. Trunk-Based Solo Workflow | PASS | No new ceremony. Runs in a pipeline worktree per /the-pipeline (Sam's "in a worktree"); merges to `main`. |
| IV. Collaboration-Safe Document Operations | PASS | Purely presentational (FR-014). Touches no Yjs/CRDT path, no document mutation, no attribution. Presence identity **mapping is unchanged** (D8/FR-012) — only chrome presentation of identity colors gains legibility affordances. |
| V. Secure by Default | PASS | No new ingestion surface, no agent/user content trust boundary, no script/SVG/image path touched. `localStorage` theme value is a bounded enum read defensively (unknown value → System). |
| VI. Design Docs Are Ground Truth | GATED (external dependency) | `design/` is silent on theming — flagged in spec and clarifications ledger. **Implementation depends on the orchestrator authoring the Squire theming design doc and syncing it via `node design/sync.mjs` before build begins.** This is not a plan violation; it is a sequencing prerequisite recorded in tasks (Phase 2 gate). All D1–D14 decisions are candidates for ratification in that doc. |

No violations require Complexity Tracking. The single-token-registry approach
(D9) actively *satisfies* the constitution's single-source-of-truth instinct
(cf. Principle IV's format-registry rule and the existing typography-token
precedent) rather than straining it.

**Post-Phase-1 re-check**: still PASS. The design introduces no new entity that
mutates documents, no server surface, and no new dependency; the token layer is
a CSS-only registry co-located with the existing typography tokens.

## Project Structure

### Documentation (this feature)

```text
specs/006-dark-mode/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions D10–D14 (plan-phase) consolidated
├── data-model.md        # Phase 1 — token role taxonomy + preference/theme state model
├── quickstart.md        # Phase 1 — runnable validation guide
├── contracts/
│   ├── color-tokens.md   # Semantic token registry contract (role names + realizations)
│   └── theme-control.md  # Theme setting/resolution/persistence behavioral contract
├── clarifications-needed.md  # ledger (D1–D9 ratified; D10–D14 appended this phase)
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
client/
├── index.html                         # + inline pre-paint theme bootstrap (no-flash)
└── src/
    ├── index.css                      # + semantic color tokens: :root (light) +
    │                                  #   :root[data-theme="dark"] + @media fallback
    ├── main.jsx                       # mounts ThemeProvider (runtime sync only)
    ├── App.jsx                        # ThemeProvider wraps app; profile menu wiring
    ├── contexts/
    │   └── ThemeContext.jsx           # NEW: setting state, resolution, persistence,
    │                                  #   matchMedia system-follow, attribute sync
    ├── components/
    │   ├── ThemeControl.jsx           # NEW: three-state Light/Dark/System control
    │   ├── ThemeControl.css           # NEW: token-based styling
    │   ├── UserProfileBadge.jsx       # + render ThemeControl in the menu
    │   ├── UserProfileBadge.css       # migrate to tokens
    │   ├── EditorCommon.css           # CANVAS — intentionally NOT tokenized (stays light)
    │   ├── VersionPreview.css         # canvas content stays light; surrounding chrome tokenized
    │   ├── DiagramNodeView.css        # CANVAS content — not tokenized
    │   ├── ImageNodeView.css          # CANVAS content — not tokenized
    │   └── <all other *.css>          # migrate chrome colors to tokens
    ├── pages/                         # AdminPage.css, ChatPage.css, LegalPage.css → tokens
    └── utils/
        └── colorUtils.js              # presence PALETTE mapping UNCHANGED (D8);
                                       #   legibility affordances added in chrome CSS
client/scripts/
└── check-color-tokens.mjs             # NEW: mechanical no-hardcoded-color lint + allowlist
```

**Structure Decision**: Single existing React+Vite client (`client/`). No new
top-level project. The token layer lives in the existing `index.css` `:root`
alongside typography tokens (same precedent, one registry). Theme runtime state
is a new React context; the no-flash guarantee is met by an inline script in
`index.html` that runs before the module bundle. The migration touches existing
per-component CSS in place. A verification script
(`client/scripts/check-color-tokens.mjs`, run via an npm script and in Vitest)
is the mechanical gate on migration completeness.

## Architecture Decisions (plan-phase, recorded as D10–D14 in the ledger)

- **D10 — Token architecture**: two tiers in `index.css` `:root`. A small set of
  **primitive** values (raw palette: violet accent `#7c3aed`/`#6d28d9`, a neutral
  gray ramp, feedback hues) and a **semantic role** layer that all chrome
  consumes (`--surface-*`, `--text-*`, `--border-*`, `--accent-*`,
  `--state-*`/feedback, `--shadow-*`, `--backdrop`). Dark is a wholesale swap of
  the semantic layer under `:root[data-theme="dark"]`, with an
  `@media (prefers-color-scheme: dark)` block (scoped so it does not override an
  explicit light attribute) covering the pre-hydration System case. Full role
  taxonomy in `contracts/color-tokens.md`.
- **D11 — Theme application / no-flash**: an inline `<script>` in
  `index.html` `<head>` reads `localStorage['squire-theme']` (`light`|`dark`|
  `system`|absent→`system`), resolves System via `matchMedia`, and sets
  `document.documentElement.dataset.theme` to the resolved `light`/`dark` value
  **before** the bundle loads — zero wrong-theme frames on every route. At
  runtime, `ThemeContext` owns the setting, writes `localStorage`, re-resolves,
  updates the root attribute, and subscribes to `matchMedia` change events when
  the setting is System. Setting (tri-state) and resolved attribute (binary) are
  distinct: CSS keys only on the resolved `data-theme`.
- **D12 — Canvas isolation**: the document canvas keeps its hardcoded light
  values; the token layer is simply *not* applied to the document-content
  selectors (`.editor-common-content`, `.editor-common-content .ProseMirror` and
  descendants, diagram/image node views). This is enforced by the allowlist in
  the lint (D13), not by discipline alone. VersionPreview's *surrounding* chrome
  is tokenized; its content area is canvas.
- **D13 — Migration verification**: `check-color-tokens.mjs` scans every CSS
  file for raw color literals (`#hex`, `rgb(a)`, `hsl(a)`, and CSS named colors
  used as colors) and fails if any appear outside (a) the token *definition*
  block in `index.css` and (b) an explicit **canvas allowlist** of
  files/selectors. This makes "no hardcoded chrome color remains" (FR-013)
  mechanically checkable and keeps future drift impossible by construction.
  Tasks also carry a per-file migration checklist so progress is trackable
  file-by-file.
- **D14 — Presence legibility on dark**: the user→color mapping in
  `colorUtils.js` is untouched (D8/FR-012). Where identity colors surface in
  *chrome* (avatar borders, presence labels), the dark theme adds a token-based
  contrast affordance (outline/backplate via `--border-*`/`--surface-*`) so even
  the darkest Kelly colors (e.g. Dark Olive Green `#2B3D26`) stay distinguishable
  against dark chrome. Presence colors on the canvas are unaffected (canvas is
  light).

## Phase 0 — Research

See [research.md](./research.md). All plan-phase unknowns resolved into D10–D14;
no `NEEDS CLARIFICATION` remain. Product decisions (D1–D9) were pre-ratified in
the spec/ledger and are not relitigated here.

## Phase 1 — Design & Contracts

- [data-model.md](./data-model.md): the Appearance Preference state model
  (setting enum, resolution function, persistence) and the Semantic Color
  Palette role taxonomy with light/dark realizations.
- [contracts/color-tokens.md](./contracts/color-tokens.md): the token registry
  contract — the canonical list of semantic role names every chrome surface must
  consume, the canvas exclusion set, and the lint's allowlist definition.
- [contracts/theme-control.md](./contracts/theme-control.md): the behavioral
  contract for the control and resolver (states, transitions, persistence key,
  system-follow, pre-paint application).
- [quickstart.md](./quickstart.md): runnable validation for the three user
  stories plus the no-flash and no-hardcoded-color gates.

## Complexity Tracking

No Constitution Check violations — table intentionally empty.
