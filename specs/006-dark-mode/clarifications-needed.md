# Clarifications Ledger: 006-dark-mode

Decisions for this feature, per pipeline rules. Sam's verbatim ask was
"darkmode css in a worktree" — everything beyond that is a default chosen
without user interaction, recorded here as
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**. Any of these can be
overturned by amending the (to-be-authored) Squire design doc
(Constitution VI) and this spec together.

---

## 1. Decisions made by Sam — recorded, not defaults

### S1 — Feature exists; implementation runs in a worktree

- **Decision (Sam, 2026-07-14, verbatim)**: "darkmode css in a worktree".
  Dark mode is wanted; the work follows the /the-pipeline worktree process.
- **Recorded in**: this artifact set's existence; spec Assumptions ("in a
  worktree" read as process, not product requirement).

---

## 2. RATIFIED-BY-DEFAULT decisions (Sam pre-authorized, 2026-07-14)

### D1 — Theme selection: System-following default plus manual override (three-state)

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: Does the app follow the OS appearance preference
  (`prefers-color-scheme`), offer a manual toggle, or both?
- **Why it matters**: Defines the entire selection UX and the state model;
  system-only means no UI but no user control, manual-only ignores the
  platform signal users already set.
- **Default chosen**: **Both — a three-state setting (Light / Dark /
  System), defaulting to System**, which follows the OS live, including
  mid-session OS changes (spec FR-001, FR-003; Story 2).
- **Rationale**: This is the settled convention across comparable apps
  (GitHub, Linear, Slack, VS Code). System-default gives new users the right
  appearance with zero configuration; the explicit override covers users
  whose OS setting doesn't match how they want to read documents. Cost over
  a plain toggle is one extra enum value.

### D2 — Theme control lives in the user profile menu; unauthenticated screens follow device choice, else OS

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: Where does the theme control live, and what do screens
  without it (login, legal) do?
- **Why it matters**: There is no settings page today; the control's home
  determines discoverability, and pre-auth screens must still resolve *some*
  theme without flashing.
- **Default chosen**: **The control lives in the user profile badge menu,
  available on every authenticated screen** (spec FR-002). **Unauthenticated
  screens carry no control; they honor the device's stored choice if one
  exists, otherwise the OS preference** (spec edge cases; FR-005 still
  applies to them).
- **Rationale**: The profile menu is the app's only existing
  account/preferences surface — no new settings page gets invented for one
  enum. Honoring the stored device choice pre-auth keeps the login screen
  consistent for returning users on the same device; falling back to OS
  matches D1's default.

### D3 — Persistence is device-local (localStorage); server-side profile sync is future work

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: Persist the preference in browser localStorage or on the
  user profile server-side?
- **Why it matters**: Server persistence makes the preference roam across
  devices but drags in API, migration, and auth-state scope — turning a CSS
  feature into a full-stack one.
- **Default chosen**: **Device-local persistence (localStorage) in v1; no
  schema change, no API, no server involvement.** Server-side profile sync
  recorded as future work (spec FR-004, Assumptions, Out of Scope).
- **Rationale**: Sam's ask is "darkmode css"; scope honesty says don't
  invent backend work persistence doesn't strictly need. Device-local is
  also what pre-paint resolution (D4) wants — synchronously readable before
  any network round-trip. The upgrade path (later syncing localStorage to
  profile) is additive and loses nothing.

### D4 — Flash-of-wrong-theme prevention: resolve and apply theme before first paint

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: Is a brief flash of the light theme on load acceptable, or
  must the resolved theme be applied before anything renders?
- **Why it matters**: A dark-mode app that flashes white on every load reads
  as broken and is the single most common dark-mode implementation defect;
  preventing it constrains where theme resolution runs (before the app
  bundle).
- **Default chosen**: **No flash, guaranteed: the stored/OS-resolved theme
  is applied before the first visible frame on every page, authenticated or
  not** (spec FR-005, SC-002). Mechanism (e.g., a tiny inline bootstrap in
  the HTML shell setting a root attribute) is plan-phase detail; the
  requirement is zero wrong-theme frames.
- **Rationale**: The fix is cheap and well-understood; accepting the flash
  buys nothing. Making it a hard requirement now prevents it from being
  discovered as a bug after implementation.

### D5 — Document canvas stays light in v1; dark mode is chrome-only

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: In dark mode, does the document canvas (editor surface,
  version previews) also go dark, or stay light "paper" inside dark chrome?
- **Why it matters**: This is the biggest product decision in the feature.
  Documents carry author-chosen text/background colors (color picker,
  agents), rendered Mermaid/SVG diagrams, and images — all authored against
  a light page. A dark canvas either silently remaps author colors
  (breaking WYSIWYG, collaboration fidelity, and the hard constraint that
  user-set colors must not be remapped) or renders them illegibly
  (dark-blue heading on near-black). It also splits screen appearance from
  print/export appearance.
- **Default chosen**: **Canvas stays light in both themes in v1** — the
  Word/Google-Docs-desktop "paper" model. All app chrome themes dark; the
  surfaces styled as document content (editor and version previews — the
  only consumers of the shared document-content styling) keep their light
  background and untouched author colors. Embedded content (diagrams, SVG,
  images, code blocks) is therefore unchanged by theme, and print stays
  trivially theme-independent (spec FR-007–FR-010, Story 3). Dark canvas is
  explicitly future work requiring its own design treatment (Out of Scope).
- **Rationale**: It is the only option that satisfies "author colors are
  never silently remapped" without inventing a color-mapping strategy the
  design docs don't cover. It keeps v1 an honest CSS feature, ships the
  chrome value now, and loses nothing: a future dark-canvas mode is purely
  additive on top of the token layer this feature builds. The chat/AI panel
  is classified as chrome (it renders conversation, not document canvas)
  and themes dark.

### D6 — Accessibility contrast target: WCAG 2.1 AA

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: What contrast standard must the dark palette meet — AA,
  AAA, or "looks fine"?
- **Why it matters**: Dark themes fail contrast more easily than light ones
  (low-contrast gray-on-gray is the default failure mode); without a named
  target, "done" is unverifiable.
- **Default chosen**: **WCAG 2.1 AA — 4.5:1 for normal text, 3:1 for large
  text and meaningful UI components/states** (focus, hover, selection
  visibility included), verified by an audit pass (spec FR-011, SC-004).
- **Rationale**: AA is the industry-standard bar and what every serious
  design system targets; AAA (7:1) would force a washed-out dark palette
  for no audience-specific reason. The existing light theme is not audited
  to AAA either — AA keeps parity achievable.

### D7 — Print always uses light/print styling, regardless of UI theme

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: Does printing from dark mode produce dark output, or is
  print theme-independent?
- **Why it matters**: Dark print output wastes toner, breaks the existing
  print stylesheet's assumptions (it already darkens grays *for paper*),
  and would make printed output depend on an invisible viewer setting.
- **Default chosen**: **Print output is identical from both themes — always
  the existing light/print styling** (spec FR-010, SC-005).
- **Rationale**: Follows directly from D5 (the canvas — the thing that
  prints — is light anyway); stating it separately makes it a testable
  requirement so a chrome-theming regression can't leak into print.

### D8 — Collaborator identity colors: mapping unchanged, legibility guaranteed on dark

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: The presence palette (avatar borders, cursors, selection
  attribution — Kelly's max-contrast colors chosen against light
  backgrounds, some quite dark) may vanish against dark chrome. Remap
  identity colors per theme, or keep them and guarantee legibility another
  way?
- **Why it matters**: These colors *are* identity — collaborators recognize
  each other by them, and attribution is a product invariant (Constitution
  IV territory). But an invisible cursor in dark mode breaks presence.
- **Default chosen**: **The user→color mapping never changes with theme;
  the dark theme must instead guarantee each identity color remains
  distinguishable and legible against dark chrome by presentation means**
  (e.g., contrast-safe outlines/backplates — mechanism is plan-phase). Spec
  FR-012, edge cases.
- **Rationale**: Identity stability across viewers and themes matters more
  than palette purity; a per-theme remap would mean the same collaborator
  is "green on my screen, teal on yours dependent on theme". Presentation
  affordances solve legibility without touching the mapping. Note: presence
  colors on the *canvas* are unaffected anyway (D5).

### D9 — A semantic color-token layer is a requirement, not an implementation choice

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: Ship dark mode as a second set of per-file color overrides
  (fastest possible diff), or require migrating all chrome colors to a
  single semantic token layer first?
- **Why it matters**: With ~8,300 lines of CSS and zero color tokens,
  per-file overrides would roughly double the color surface area and make
  every future style change a two-theme change; a token layer makes the
  theme swap wholesale and keeps future drift impossible by construction.
- **Default chosen**: **Token layer required: every themed chrome color is
  defined once by semantic role; theme switch is a palette swap; no
  hardcoded colors may remain in themed chrome after migration** (spec
  FR-013). Token naming/architecture is plan-phase.
- **Rationale**: This mirrors the constitution's single-registry instinct
  (one source of truth beats parallel duplicates) and the existing
  typography-token precedent in `index.css`. The migration *is* the bulk of
  the work either way; doing it without the layer just does it twice.

---

## 3. RATIFIED-BY-DEFAULT decisions — plan phase (Sam pre-authorized, 2026-07-14)

These are implementation-architecture decisions made during /speckit-plan,
inside the constraints of D1–D9. They are candidates for ratification/overturn
in the theming design doc alongside D1–D9.

### D10 — Token architecture: two-tier (primitives + semantic roles) in `index.css`

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: How is the D9 token layer structured and named?
- **Default chosen**: Two tiers in `client/src/index.css` `:root` — raw
  **primitive** values plus a **semantic role** layer (`--surface-*`,
  `--text-*`, `--border-*`, `--accent-*`, feedback, `--shadow-*`, `--backdrop`,
  `--focus-ring`) that is the only thing chrome CSS references. Dark redefines
  the semantic tier under `:root[data-theme="dark"]`, with a scoped
  `@media (prefers-color-scheme: dark)` fallback for the System-before-hydration
  case. Full taxonomy in `contracts/color-tokens.md`.
- **Rationale**: Small dark override, per-role contrast reasoning, co-located
  with the existing typography tokens (single registry).

### D11 — Theme application: inline pre-paint bootstrap + runtime React context

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: How is the no-flash guarantee (D4/FR-005) implemented, and where
  does runtime theme state live?
- **Default chosen**: A synchronous inline `<script>` in `index.html` `<head>`
  (before the bundle) reads `localStorage['squire-theme']`, resolves System via
  `matchMedia`, and sets `document.documentElement.dataset.theme` to the binary
  `light`/`dark` before first paint on every route. A new `ThemeContext`
  provider owns the tri-state setting at runtime: persists it, updates the
  attribute, and subscribes to `matchMedia` change only while set to System.
  Storage key `squire-theme`; unknown value → System.
- **Rationale**: Inline bootstrap is the only way to guarantee zero wrong-theme
  frames on unauthenticated routes too; context keeps components declarative.

### D12 — Canvas isolation enforced by an allowlist, not convention

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: How is "canvas stays light" (D5/FR-007) guaranteed against
  accidental tokenization?
- **Default chosen**: The document-content selectors (`.editor-common-content`,
  `.ProseMirror` content in `EditorCommon.css`, `VersionPreview` content area,
  `DiagramNodeView.css`, `ImageNodeView.css`, and `@media print`) keep fixed
  light literals and form an explicit **canvas allowlist** in the migration lint
  (D13). VersionPreview's surrounding chrome is tokenized.
- **Rationale**: Makes an accidental canvas re-theme a lint failure, not a
  review miss (no code review — Principle III).

### D13 — Migration verification: mechanical no-hardcoded-color lint + per-file checklist

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: How is FR-013 ("no hardcoded chrome color remains") made
  verifiable across 8,300 lines?
- **Default chosen**: `client/scripts/check-color-tokens.mjs` (npm
  `lint:colors`, asserted in Vitest) fails if any raw color literal appears
  outside the `index.css` token-definition block and the D12 canvas allowlist.
  tasks.md also carries a per-file migration checklist. (A Stylelint rule is an
  acceptable equivalent; the bespoke script is the dependency-free default.)
- **Rationale**: Turns SC-003 into a build-time guarantee and blocks future
  drift.

### D14 — Presence identity legibility on dark via presentation; mapping unchanged

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: Concrete mechanism for D8 (identity colors legible on dark
  without remapping)?
- **Default chosen**: `colorUtils.js` `PALETTE`/mapping untouched; dark chrome
  adds token-based outline/backplate affordances to avatar borders and presence
  labels so the darkest Kelly colors stay distinguishable. Canvas presence is
  unaffected (canvas is light).
- **Rationale**: Preserves the identity invariant (same hue for a user across
  viewers/themes) while solving legibility by presentation only.

---

## Flagged (not resolved here) — for the design doc / later features

- **Design gap — theming absent from design/ (Constitution VI)**: the design
  docs are completely silent on dark mode, theming, and color tokens. Per
  Principle VI this spec flags the gap rather than resolving it silently:
  **the orchestrator must author the Squire design doc for theming from
  this spec (and sync it into design/) before implementation begins.** All
  D-decisions above are candidates for ratification or overturn in that
  doc. This spec agent deliberately did not author it.
- **Dark document canvas (future feature)**: requires an author-color
  strategy (legibility mapping vs. author-declared dark variants vs.
  per-document appearance), diagram/SVG/image treatment, and an
  export/print story. Needs its own design-doc treatment; the token layer
  built here is its foundation.
- **Server-side preference sync (future)**: additive later — persist the
  device-local preference to the user profile so it roams. Deliberately
  excluded from v1 (D3).
- **Token architecture details** (naming scheme, role taxonomy, how the
  dark palette is expressed) are plan-phase decisions inside D9's
  constraint, not product decisions.
