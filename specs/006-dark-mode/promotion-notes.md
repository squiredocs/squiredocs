# Promotion Notes: 006-dark-mode

Items the merge queue / reviewer / maintainer should know. Nothing here blocks
merge; all decisions have a documented default (see `clarifications-needed.md`).

## Mid-flight design override (folded in)

Sam overrode D5 during implementation: **the document canvas themes dark** (was
light "paper"). The design doc (`design/ui-theming-dark-mode.md`, commit on main)
and all spec artifacts here were amended in a single spec-delta commit before the
canvas implementation. Author-set colors, forced-light print, and the no-write
invariant still hold.

## Merge-queue doc updates (T053 — README delta, NOT applied here)

Per the orchestrator disposition, the README edit is deferred to the merge queue.
Intended README delta — add an **Appearance / Dark mode** note to the UI/features
section:

> **Appearance (Light / Dark / System).** Squire has a dark mode. A theme control
> in the user profile menu offers **Light**, **Dark**, or **System** (the
> default, which follows the OS `prefers-color-scheme` live). The choice is saved
> per device (localStorage, key `squire-theme`) and applied before first paint,
> so there is no flash of the wrong theme on load — on every screen, signed in or
> out. **Both the app chrome and the document canvas theme dark**; author-set
> text/background colors render exactly as authored in both themes, Mermaid/SVG
> diagrams render on a light "media plate", and **printing is always light**.
> Color is centralized in a semantic token layer in `client/src/index.css`
> (light + dark realizations); a `lint:colors` gate (`cd client && npm run
> lint:colors`, also a Vitest test) keeps every themed surface literal-free.

If the README documents dev/test commands, also note: `cd client && npm run
lint:colors` is the migration-completeness gate.

## Manual verifications still owed (no browser E2E built — orchestrator V1)

The following are manual per the brief (no browser E2E infra was built):
- **SC-002 no-flash**: verify via `quickstart.md` Story 1 step 3 (throttle
  CPU/network, cold+warm reload ×10 in dark; expect zero light frames). The
  mechanism (inline pre-paint bootstrap in `index.html`) is unit-reasoned but the
  visual no-flash is a human check. **Not yet run by a human.**
- **SC-003 full visual sweep (T052)**: a human pass over all 35+ surfaces + the
  dark canvas for light-remnants and media-plate seams. The mechanical
  `lint:colors` gate proves zero unthemed literals remain (the structural half);
  the visual half is **owed**.
- **Print-preview (T049)**: confirm dark-mode print output is light in a real
  browser print dialog. Forced-light `@media print` token reset is in place.

## Token layer notes for reviewers

- New token roles beyond the original contract (all sanctioned by data-model's
  "text/bg variants as needed" + the dark-canvas override): feedback subtles/
  borders (`--danger/success/warning/info-subtle|-border`, `--danger-hover`),
  `--shadow-color`, `--accent-glow`, the full `--canvas-*` set (bg/text/muted/
  border/code-bg/th-bg/link/selection/media-plate/diff-add|del), and constant
  `--presence-*` chips + `--presence-ring`. Primitives added: `--gray-600`,
  `--amber-500`, `--blue-selection`.
- `AiPanel.css` uses `color-mix(in srgb, var(--on-accent) N%, transparent)` for
  translucent-on-accent layers (a subagent choice) — first `color-mix` use in the
  repo; fine for the modern-evergreen target, and it is a token reference so it
  passes `lint:colors`.
- **Accepted minor visual regressions** flagged by migration agents (nearest-role
  mappings; not AA failures): (a) BYOK-panel accent overrides collapse onto the
  default violet accent (blue BYOK identity lost — needs dedicated BYOK tokens,
  out of scope); (b) a few link/hover states that darkened-on-hover now hold the
  base color (no `-hover` text token); (c) two dark tooltips (`MenuCommon`,
  `DocList` share-badge) map to `--text-primary` bg + `--text-inverse` text, so
  they invert (light chip) in dark mode — intentional and legible.

## Post-merge review dispositions (2026-07-14)

Adversarial review of merge `df43771` (feature 006-dark-mode). All findings
landed on `main` the same day. The review's other lenses came back clean:
security and trust lenses **clean**, the FR-014 no-write invariant **proven**
(theming is purely presentational — no document writes / version entries /
collaboration-state changes), and the lint-gate false-negative claims (a)/(b)/(c)
**verified** empirically before fixing.

- **HIGH — inline diagram/SVG previews lacked the light media plate (FR-009/D16).**
  Fixed: the rendered `.diagram-preview` (shared by Mermaid and SVG blocks) now
  sits on `--canvas-media-plate`, matching the fullscreen canvas; scoped to
  exclude the `.diagram-loading` placeholder so its `--canvas-text-muted` status
  text stays AA-legible on the dark canvas. Commit `fc1819a`. **Applied with
  strict defaults — flagged for Sam to ratify** (the plate on inline previews is
  a visible dark-mode presentation choice).
- **MEDIUM — native form controls rendered UA-light in dark mode (FR-005).**
  Fixed: added `color-scheme: light` to light `:root` and `color-scheme: dark`
  to both `:root[data-theme="dark"]` and the prefers-color-scheme fallback; gave
  the app's text inputs/textareas explicit `--surface-raised` + `--text-primary`.
  Commit `fd4b4fc`. The **`color-scheme` addition is applied with strict
  defaults — flagged for Sam to ratify** (it changes native scrollbar/spinner/
  field chrome globally). Placeholders kept on `--text-tertiary` (AA on dark).
- **LOW — lint:colors gate false-negatives.** Fixed all four: flush the pending
  declaration at `}` (no-trailing-semicolon case); scan `var(--x, <fallback>)`
  fallback literals; complete NAMED_COLORS to the full CSS Color Module L4 list
  (148); anchor the index.css `:root` allowlist to genuine token-definition
  blocks only. Tightened gate still reports **0 violations**. Commit `356e88d`.
- **LOW — ThemeControl radio semantics without radio keyboard behavior.** Fixed:
  roving tabIndex + Arrow{Left,Up,Right,Down} cycling with wrap-around moving
  both focus and selection; test suite extended to 8 tests. Commit `c521000`.
- **Nit — token-role misuse.** `.app-title-input:focus` background changed from
  `--on-accent` to `--surface-raised` (resolves identically today). Commit
  `c521000`.

## Merge-queue: expected conflicts / coordination

- **Broad CSS churn**: 32 CSS files under `client/src/` changed (26 chrome + 5
  canvas + `index.css`). Any other in-flight feature touching these files will
  conflict; this feature's changes are value-only (literal → `var(--token)`) plus
  the `index.css` token registry, so conflicts should resolve by taking both.
- **`client/index.html`**: added the inline pre-paint theme bootstrap in `<head>`.
- **`client/src/App.jsx`**: wrapped the provider stack in `<ThemeProvider>`.
- **`client/package.json`**: added the `lint:colors` script.
- **Spec artifacts**: `spec.md`, `clarifications-needed.md`, `tasks.md`,
  `contracts/color-tokens.md`, `quickstart.md`, `aa-audit-notes.md`, and this
  file were all updated for the D5 override — the merge queue sees one coherent
  side.
- **Design doc**: `design/ui-theming-dark-mode.md` came from `main` via merge (no
  edit here — it is ground truth).
- **Zero server files changed** (client-only feature).
