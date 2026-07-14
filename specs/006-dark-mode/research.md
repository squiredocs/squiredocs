# Phase 0 Research: Dark Mode

Product decisions (D1–D9) are pre-ratified in `spec.md` / `clarifications-needed.md`
and are **not** relitigated here. This file consolidates the *plan-phase*
(implementation-architecture) decisions D10–D14, each written back into the
ledger as RATIFIED-BY-DEFAULT. Format: Decision / Rationale / Alternatives.

Grounding facts established by codebase survey:
- 33 CSS files carry color literals (~900 total). No color tokens exist; only
  typography tokens in `client/src/index.css` `:root`.
- Dominant palette is Tailwind-ish and already coherent: accent violet
  `#7c3aed` (122×) / hover `#6d28d9`; neutral gray ramp (`#f9fafb`, `#f3f4f6`,
  `#e5e7eb`, `#d1d5db`, `#9ca3af`, `#6b7280`, `#374151`, `#1f2937`, `#111827`);
  text `#333`/`#1f2937`; danger `#dc2626`/`#dc3545`; accent tints `#f5f3ff`,
  `#ede9fe`; app bg `#f5f5f5`; surfaces `#fff`/`#ffffff`.
- Canvas content styling is centralized in `EditorCommon.css`
  (`.editor-common-content`, `.ProseMirror`), shared by the editor and version
  previews. Node views (`DiagramNodeView.css`, `ImageNodeView.css`) render on
  the canvas.
- Presence identity colors live in `client/src/utils/colorUtils.js` (`PALETTE`,
  Kelly's colors), consumed for cursors and avatar borders.
- No existing theme infrastructure: zero `data-theme`, `ThemeContext`,
  `useTheme`, or `prefers-color-scheme` usages in the client.
- Providers nest in `App.jsx` as AuthProvider → AiChatProvider → ByokProvider.
- HTML shell `client/index.html` has a `<head>` (currently gtag + meta) where a
  pre-paint bootstrap can run before `/src/main.jsx`.

---

## D10 — Token architecture: two-tier (primitives + semantic roles) in `index.css`

**Decision**: Define colors in the existing `:root` block of
`client/src/index.css` in two tiers. **Primitives** hold raw values (accent
ramp, neutral gray ramp, feedback hues, pure white/black). **Semantic role**
tokens (`--surface-*`, `--text-*`, `--border-*`, `--accent-*`, feedback
`--danger*/--success*/--warning*/--info*`, `--shadow-*`, `--backdrop`,
`--focus-ring`) reference primitives and are the *only* thing chrome CSS
consumes. Dark mode redefines the **semantic layer** (and, where needed, a few
primitives) under `:root[data-theme="dark"]`. A scoped
`@media (prefers-color-scheme: dark)` block supplies the dark values for the
System-before-hydration case without overriding an explicit
`:root[data-theme="light"]`.

**Rationale**: Two tiers keep the dark override small (swap semantic roles, not
every call site) and let contrast be reasoned about per role. Co-locating with
typography tokens follows the established precedent and the constitution's
single-registry instinct. The existing palette is already systematic, so
mapping literals → roles is largely mechanical.

**Alternatives considered**: (a) *Per-file dark overrides* — rejected by D9
(doubles surface area, guarantees drift). (b) *Single flat token layer (no
primitives)* — rejected: forces duplicate literal edits across light/dark and
loses the "same hue, different role" clarity. (c) *CSS-in-JS / library (e.g.
Tailwind, Panda)* — rejected: large dependency and rewrite for a CSS-only
feature; violates YAGNI and adds no value over native custom properties.

## D11 — Theme application: inline pre-paint bootstrap + runtime React context

**Decision**: Add a tiny synchronous inline `<script>` in `index.html` `<head>`
that (1) reads `localStorage['squire-theme']` (values `light`|`dark`|`system`;
absent or unrecognized → `system`), (2) resolves `system` via
`window.matchMedia('(prefers-color-scheme: dark)')`, and (3) sets
`document.documentElement.dataset.theme` to the resolved binary `light`/`dark`
before the app bundle loads. A new `ThemeContext.jsx` provider owns runtime
state: it exposes the tri-state *setting* and a setter, persists to
`localStorage`, updates the root attribute on change, and — only while the
setting is `system` — subscribes to `matchMedia` `change` to restyle live.
Distinguish **setting** (tri-state, persisted) from **resolved theme** (binary,
on the root attribute); CSS keys only on the resolved attribute.

**Rationale**: The inline-script approach is the well-understood, dependency-free
fix for flash-of-wrong-theme and is the only way to guarantee zero wrong-theme
frames on *every* route including unauthenticated ones (the bundle and React
mount happen too late). Keeping runtime concerns in a context keeps components
declarative and testable. Reading `localStorage` synchronously is exactly what
D3 (device-local) enables.

**Alternatives considered**: (a) *Resolve theme in React on mount* — rejected:
guarantees a flash (FR-005/SC-002 fail). (b) *Server-rendered theme cookie* —
rejected: the client is an SPA served from a static shell; no SSR, and D3 keeps
it client-only. (c) *CSS-only `prefers-color-scheme`, no JS* — rejected: cannot
honor an explicit manual override that disagrees with the OS (fails D1/FR-001).

## D12 — Canvas isolation enforced by allowlist, not convention

**Decision**: The document canvas keeps its hardcoded light values. The token
layer is deliberately **not** applied to the document-content selectors:
`.editor-common-content`, `.editor-common-content .ProseMirror` (and content
descendants), and the on-canvas node views (`DiagramNodeView.css`,
`ImageNodeView.css`). These files/selectors form the **canvas allowlist** in the
verification lint (D13). `VersionPreview.css` is split: its content-preview area
is canvas (allowlisted), its surrounding chrome is tokenized.

**Rationale**: D5/FR-007–FR-010 require the canvas to be theme-invariant.
Enforcing that via an explicit machine-checked allowlist (rather than developer
discipline) makes an accidental canvas re-theme a lint failure, and documents the
boundary in one place. Author colors, diagrams, images, and print stay
theme-independent by construction.

**Alternatives considered**: (a) *Wrap the canvas in a forced
`data-theme="light"` scope and tokenize it too* — rejected as needless: the
canvas has exactly one appearance, so tokens buy nothing and risk a dark value
leaking in. (b) *Rely on reviewer discipline* — rejected: no code review
(Principle III); the invariant must be mechanical.

## D13 — Migration verification: mechanical no-hardcoded-color lint + per-file checklist

**Decision**: Add `client/scripts/check-color-tokens.mjs` (run via
`npm run lint:colors` and asserted in a Vitest test). It scans every
`client/src/**/*.css` for raw color literals (`#hex`, `rgb()/rgba()`,
`hsl()/hsla()`, and the set of CSS named colors when used as color values) and
**fails** if any literal appears outside: (a) the token *definition* region of
`index.css`, and (b) the canvas allowlist (D12). tasks.md additionally carries an
explicit per-file migration checklist so the ~33-file migration is trackable and
no file is silently skipped.

**Rationale**: FR-013 ("no hardcoded chrome color may remain") is otherwise
unverifiable across 8,300 lines. A lint turns SC-003's "zero unthemed surfaces"
into a build-time guarantee and prevents future drift. Pairing it with a
per-file checklist gives incremental, reviewable progress.

**Alternatives considered**: (a) *Manual visual sweep only* — rejected: SC-003
needs a repeatable check; humans miss literals in 33 files. (b) *Stylelint plugin
(`declaration-property-value-disallowed-list` / custom rule)* — viable and
acceptable if the implementer prefers it, but adds a dev dependency and config;
the small bespoke script is dependency-free and tailored to the canvas allowlist.
Either satisfies the requirement; the plan specifies the script as default.

## D14 — Presence identity legibility on dark via presentation, mapping unchanged

**Decision**: Leave `colorUtils.js` `PALETTE` and the deterministic user→color
mapping completely unchanged (D8/FR-012). In dark chrome, add token-based
legibility affordances to identity surfaces — avatar borders and presence
labels get a contrast-safe outline/backplate (from `--border-*`/`--surface-*`
tokens) so the darkest Kelly colors remain distinguishable against dark chrome.
Canvas presence (cursors/selection on the light canvas) needs nothing.

**Rationale**: Identity stability across viewers/themes outweighs palette purity;
a per-theme remap would make the same collaborator a different color per viewer.
Presentation affordances solve legibility without touching the mapping — exactly
what D8 prescribes, now with a concrete mechanism.

**Alternatives considered**: (a) *Per-theme remap of identity colors* — rejected
by D8 (breaks identity invariant). (b) *Lighten dark identity colors only in
dark mode* — rejected: still alters the presented color and risks colliding two
users' hues; an outline preserves the exact hue.
