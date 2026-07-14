# Feature Specification: Dark Mode

**Feature Branch**: `006-dark-mode`

**Created**: 2026-07-14

**Status**: Draft

**Input**: User description: "darkmode css in a worktree"

## Overview

Squire's client is styled entirely in per-component CSS (~8,300 lines across
35+ files) with hardcoded colors everywhere; the only design tokens today are
the typography tokens in the `:root` block of `client/src/index.css`. There
are zero color tokens. "Dark mode" therefore means two things at once:

1. Introduce a **semantic color layer** — every color used by app chrome is
   defined once, by role, in a shared palette — and migrate the hardcoded
   chrome colors onto it.
2. Ship a **dark theme** as a second palette behind that layer, with a user
   control (Light / Dark / System) that persists per device.

The **document canvas themes dark in dark mode** as well (amended 2026-07-14 by
Sam — the original light-"paper" decision D5 is superseded; see
`clarifications-needed.md`). The canvas background and the **default (unset)**
document text color come from the semantic token layer, so unstyled documents
read natively in both themes. The invariants that survive the override:
**author-set colors** (color picker / agent-authored) render exactly as
authored in both themes — never remapped or inverted (stored content is never
touched); Mermaid diagrams and SVG blocks render on a constant **light "media
plate"** for faithful rendering; images render unplated; and **print is always
light**. A contrast-adaptive display remap for author-chosen dark colors on the
dark canvas is explicit future work (accepted v1 caveat: author dark colors can
read low-contrast on the dark canvas).

**Flagged design gap (Constitution VI)**: `design/` is completely silent on
theming and dark mode. Per Principle VI this spec does not resolve that ad
hoc: the gap is flagged here and in `clarifications-needed.md`, and the
pipeline orchestrator will author the Squire design doc from this spec
**before implementation begins**. Implementation depends on that doc landing
in `design/` via `node design/sync.mjs`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Switch the app to dark mode and have it stick (Priority: P1)

A user working at night opens their theme setting from the user profile menu,
picks **Dark**, and the entire application chrome — document list, side
panes, toolbar, menus, dialogs, version history, AI/chat panel, admin — turns
dark immediately, without a reload. When they close the tab and come back
tomorrow on the same device, the app is still dark from the very first paint.

**Why this priority**: This is the feature. A manual, persistent dark theme
for the app chrome is the smallest slice that delivers the value Sam asked
for; everything else refines it.

**Independent Test**: On any authenticated screen, select Dark in the theme
control; visually sweep every chrome surface for dark styling and AA
contrast; reload and confirm the first rendered frame is dark.

**Acceptance Scenarios**:

1. **Given** the app in its default (light) appearance, **When** the user
   selects Dark from the theme control, **Then** all app chrome surfaces
   restyle to the dark palette immediately, with no page reload and no
   surface left in light styling.
2. **Given** a user who previously chose Dark on this device, **When** they
   open the app again (fresh tab, after restart), **Then** the app renders
   dark from the first visible frame — no flash of the light theme.
3. **Given** dark mode is active, **When** the user selects Light, **Then**
   the app returns to the light appearance immediately and that choice
   persists the same way.

---

### User Story 2 - The app follows my system preference automatically (Priority: P2)

A user whose operating system is set to dark mode opens Squire for the first
time and the app is already dark — no setting hunted for. Their OS switches
appearance on a schedule at sunset; Squire follows along live. Users who have
made an explicit Light/Dark choice are not affected; they can return to
following the OS by choosing **System**.

**Why this priority**: Zero-configuration correctness for new users and the
expected modern default; but it only matters once the dark palette from
Story 1 exists.

**Independent Test**: With no stored preference, toggle the OS appearance and
observe the app follow it live; make an explicit choice and confirm the app
stops following the OS; choose System and confirm it resumes.

**Acceptance Scenarios**:

1. **Given** a user with no stored theme choice and an OS set to dark
   appearance, **When** they load the app (including the login screen),
   **Then** it renders dark from first paint.
2. **Given** the theme setting is System, **When** the OS appearance changes
   while the app is open, **Then** the app restyles to match without a
   reload.
3. **Given** the user explicitly chose Light, **When** the OS switches to
   dark appearance, **Then** the app stays light.

---

### User Story 3 - My documents stay faithful in dark mode (Priority: P3)

A user in dark mode opens a document where a collaborator colored headings
dark blue and left the body text default, and embedded a Mermaid diagram and
images. The dark canvas shows the default body text in a light token color
(readable), the author's dark-blue heading exactly as authored (unchanged),
the diagram on a light media plate, and images untouched. Printing the
document produces the same light output it would in light mode.

**Why this priority**: This is the fidelity guarantee that makes Stories 1–2
safe to ship. Fidelity now means: **author-set colors and rendered media are
never altered by theme, and print is always light** — not that the canvas is
pixel-equivalent between modes.

**Independent Test**: In dark mode, open a document containing user-set text
and background colors, a rendered diagram, an SVG block, images, and a code
block; confirm author-set colors and rendered media (diagram/SVG/images)
render identically to light mode while the canvas background and default text
are dark; print-preview and confirm output is light and unaffected by the UI
theme; confirm the stored document was not modified by any theme switching.

**Acceptance Scenarios**:

1. **Given** dark mode is active, **When** a document with **author-set** text
   and background colors is opened, **Then** those author-set colors render
   identically to light mode, while the canvas background and any **default
   (unset)** text render in the dark token colors.
2. **Given** dark mode is active, **When** a document containing rendered
   diagrams and SVG blocks is viewed, **Then** they render on a constant light
   media plate identically to light mode; images render unplated and unchanged.
3. **Given** dark mode is active, **When** the user prints a document,
   **Then** the printed output is light and identical to printing from light
   mode.
4. **Given** any sequence of theme switches, **When** the document's stored
   content is inspected (e.g., via version history), **Then** no change was
   recorded — theming never writes to documents.

---

### Edge Cases

- **Unauthenticated screens** (login, legal): no profile menu exists there;
  they honor the device's stored choice if one exists, otherwise the OS
  preference (D2). They must not flash the wrong theme either.
- **Collaborator identity colors** (avatar borders, presence cursors,
  selection highlights) are functional identity, not decoration: the
  user→color mapping must not change with theme, but every identity color
  must remain distinguishable and legible against dark chrome (some palette
  colors, e.g. dark olive green, rely on a light background today).
- **Mid-session OS appearance change while set to System** must restyle live
  (Story 2) — including any open dialogs, menus, and the AI panel.
- **Two tabs, same device**: a theme change in one tab may (but need not)
  propagate live to the other; on next load every tab must honor the stored
  choice. Live cross-tab sync is not required in v1.
- **Text selection, focus rings, scrollbars, and hover states** in dark
  chrome must remain visible — states, not just resting surfaces, meet the
  contrast requirement.
- **Chat/AI panel content** (assistant messages, tool cards, chat-embedded
  code snippets) is chrome — it themes dark alongside the canvas.
- **Selection highlights, presence cursors, and attribution on the dark
  canvas** must meet the same AA-legibility bar as chrome; the user→color
  identity mapping never changes (include canvas presence in the AA audit).
- **Media plates**: a Mermaid diagram or SVG block sits on a constant light
  plate inside the dark canvas — the plate edge must read as an intentional
  frame for rendered media, not a rendering bug.
- **Reduced motion**: theme switching must not introduce animation that
  violates the existing global reduced-motion behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The application MUST offer exactly three appearance settings:
  **Light**, **Dark**, and **System**; the default for users who have never
  chosen is **System**.
- **FR-002**: The theme control MUST be reachable from the user profile menu
  on every authenticated screen, and MUST show which setting is currently
  active.
- **FR-003**: Under **System**, the application MUST follow the operating
  system's appearance preference, including live changes while the app is
  open, without a reload.
- **FR-004**: An explicit Light/Dark choice MUST persist on that device and
  browser across sessions and reloads. Persistence is device-local in v1; no
  account-level or server-side storage of the preference (see D3).
- **FR-005**: On every page load, the resolved theme MUST be applied before
  the first visible frame — no flash of the wrong theme, on any screen,
  authenticated or not.
- **FR-006**: In dark mode, **all application chrome** MUST render in the
  dark palette: document list, side panes, editor toolbar and menus, dialogs
  (share, etc.), dropdowns and context menus, version history and previews'
  surrounding chrome, AI panel and chat surfaces, chat page, admin page,
  login page, legal page, mobile action bar, connection status, avatars'
  surrounds, and any empty/loading/error states.
- **FR-007**: The **document canvas** — the editable document surface and
  document-content rendering in version previews — MUST theme dark in dark
  mode: its background and its **default (unset)** text color are driven by
  the semantic token layer, so an unstyled document reads natively (dark text
  on light canvas in light mode; light text on dark canvas in dark mode).
- **FR-008**: Author-chosen document colors (text and background colors set
  via the color picker, or by agents) MUST NEVER be remapped, inverted, or
  otherwise altered by the viewer's theme — they render exactly as authored in
  both modes, and the stored document is never changed.
- **FR-009**: Rendered **Mermaid diagrams** MUST invert to dark in dark mode
  via a **display-only presentational filter** (D19, Sam directive 2026-07-14):
  stored source, print output, clipboard PNG copies, and exports remain
  light-rendered. **SVG blocks** MUST render on a constant **light "media
  plate"** in both modes (arbitrary author markup is never re-themed);
  **images** render unplated; **code blocks** are plain-styled text and theme
  with the canvas via the token layer.
- **FR-010**: Printing MUST be unaffected by the UI theme: printed output
  from dark mode MUST be identical to printed output from light mode.
- **FR-011**: All themed chrome **and the canvas's token-driven default
  styling** MUST meet WCAG 2.1 AA contrast: at least 4.5:1 for normal text,
  3:1 for large text and for meaningful UI components and states (focus,
  hover, selection, disabled affordances that must remain perceivable).
  (Author-set colors are exempt — they are content, per the accepted v1
  caveat.)
- **FR-012**: Collaborator identity colors (avatars, presence cursors,
  selection attribution) MUST keep the same user→color mapping in both
  themes, and MUST remain visually distinguishable and legible against dark
  chrome **and against the dark canvas** (selection/cursor/attribution).
- **FR-013**: Every color used by themed application chrome MUST be defined
  exactly once, by semantic role, in a shared palette layer; switching theme
  MUST be a wholesale palette swap. After migration, no themed chrome
  surface may carry a hardcoded, per-surface color that bypasses the layer.
- **FR-014**: Theme switching MUST be purely presentational: it MUST NOT
  write to any document, create versions, or alter any stored content or
  collaboration state.

### Key Entities

- **Appearance preference**: the user's per-device setting — one of Light,
  Dark, or System; absent means System. Stored on the device only (v1); read
  before first paint; never transmitted into documents.
- **Semantic color palette**: the set of named color roles (surfaces, text
  tiers, borders, accents, states) that all themed chrome consumes; exists in
  (at least) a light and a dark realization. Typography tokens already model
  this pattern and are unaffected.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From any authenticated screen, a user can switch between light
  and dark appearance in under 5 seconds, and the change is complete —
  every visible chrome surface restyles — with no reload.
- **SC-002**: Across 10 consecutive reloads in dark mode (cold and warm),
  zero frames of light-themed content are visible before the app renders.
- **SC-003**: A full visual sweep of the application's screen inventory
  (every page and every dialog/menu/panel — all 35+ styled surfaces) in dark
  mode finds zero unthemed (light-remnant) chrome surfaces.
- **SC-004**: An accessibility contrast audit of dark chrome reports zero
  AA failures for text and meaningful UI states.
- **SC-005**: A document containing author-set colors, a diagram, an SVG
  block, and images renders those author-set colors and rendered media
  pixel-equivalent in light and dark modes (media on a light plate), while the
  canvas background and default text follow the theme; its print output is
  light and identical from both modes.
- **SC-006**: After an arbitrary sequence of theme switches during a
  collaborative editing session, document version history shows zero
  entries attributable to theming.

## Assumptions

- "Darkmode css" is interpreted as a client-only presentation feature: no
  server-side or account-level scope. Preference persistence is
  device-local in v1; syncing the preference to the user profile is noted
  as future work, not built now (D3).
- The document canvas themes dark in dark mode (D5 overridden by Sam,
  2026-07-14). Its background and default text are token-driven; author-set
  colors are preserved as-is. A contrast-adaptive display remap for
  author-chosen colors on the dark canvas is future work (accepted caveat:
  author dark colors can read low-contrast on the dark canvas).
- There is no syntax-highlighting library in the client today; code blocks
  are plain-styled on the canvas. No highlighting theme work exists or is
  in scope.
- The existing typography tokens in `:root` establish the token pattern the
  color layer follows; typography itself does not change.
- "In a worktree" in Sam's ask is pipeline process (implementation runs in a
  worktree per /the-pipeline), not a product requirement.
- The Squire design doc for theming will be authored by the orchestrator
  from this spec before implementation (Constitution VI dependency; see
  Flagged section of `clarifications-needed.md`).

## Out of Scope (v1)

- Contrast-adaptive display remap of author-chosen colors on the dark canvas
  (the accepted v1 caveat; author dark colors may read low-contrast).
- Server-side or account-level persistence of the appearance preference
  (future work; would let the preference roam across devices).
- Custom themes, high-contrast themes, or per-document appearance.
- Theming of exported artifacts (markdown/portable export) or printed
  output — both remain theme-independent by requirement.
- Re-theming rendered diagram/SVG content for dark backgrounds (they render
  on a constant light media plate instead).
- Live cross-tab propagation of a theme change (each tab honors the stored
  choice on load; live sync is a nice-to-have, not required).
