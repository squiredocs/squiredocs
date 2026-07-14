# Tasks: Dark Mode

**Input**: Design documents from `/specs/006-dark-mode/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md,
contracts/color-tokens.md, contracts/theme-control.md, quickstart.md

**Tests**: Included. Not a full TDD ceremony, but **Constitution Principle II
(Test-Backed Changes) requires** the behavioral additions (resolution,
persistence, system-follow, no-write invariant) to have Vitest coverage, and the
token migration to have the mechanical `lint:colors` gate.

**Organization**: Tasks are grouped by user story. US1 (P1) is the MVP and
carries the bulk of the work (the token migration). US2/US3 are additive.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks)
- **[Story]**: US1 / US2 / US3 (setup/foundational/polish carry no story label)
- All paths are under `client/` unless noted.

## Canvas tokenization + sanctioned exceptions (D5 OVERRIDDEN — canvas themes dark)

Sam's 2026-07-14 override means the document canvas now **migrates to tokens**
too: `src/components/EditorCommon.css`, `src/components/Editor.css`,
`src/components/VersionPreview.css` (content area included),
`src/components/DiagramNodeView.css`, and `src/components/ImageNodeView.css` are
tokenized alongside chrome. The canvas background and **default (unset)** text
come from the token layer (new `--canvas-*` roles).

The **only** sanctioned literal exceptions the lint still allows are:
(a) the constant light **media plate** for Mermaid/SVG (a token whose value is
light in both realizations — D16), (b) **forced-light print** (an `@media print`
token reset in `src/index.css` — D17), and (c) the token-definition region of
`src/index.css`. Author-set colors are inline content styles, not CSS, so the
migration never touches them (D15). Files with zero color literals
(`LineHeightDropdown.css`, `DropdownWrapper.css`, `ChatFontSizeControl.css`)
pass the lint trivially.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the token registry and the verification gate.

- [X] T001 [P] Create `client/scripts/check-color-tokens.mjs` (scan `src/**/*.css`
  for raw color literals: `#hex`, `rgb()/rgba()`, `hsl()/hsla()`, CSS named
  colors used as color values) and add an npm script `lint:colors` in
  `client/package.json`. Wire the same assertion into a Vitest test
  (`src/__tests__/color-tokens.lint.test.js`). Allowlist encoding is T005.
- [X] T002 Define Tier-1 primitives + Tier-2 semantic **light** tokens in
  `client/src/index.css` `:root` per `contracts/color-tokens.md`
  (`--surface-*`, `--text-*`, `--border-*`, `--accent-*`, feedback, `--shadow-*`,
  `--backdrop`, `--focus-ring`), co-located with the existing typography tokens.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Design-doc gate, the dark palette, no-flash mechanism, and theme
state — everything every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 **GATE — Constitution VI**: Verify the theming design doc has been
  authored in Squire and synced into `design/` (via `node design/sync.mjs`) and
  ratifies/overrides D1–D14. **Blocks all implementation** — do not proceed if
  absent (flagged in spec + `clarifications-needed.md`).
- [X] T004 Define the **dark** realization in `client/src/index.css`:
  redefine the Tier-2 semantic tokens under `:root[data-theme="dark"]`, plus a
  scoped `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }`
  fallback for the System-before-hydration case (per `contracts/color-tokens.md`).
- [X] T005 Encode the **sanctioned exceptions** (see header + `contracts/color-tokens.md`)
  into `client/scripts/check-color-tokens.mjs`: literals are permitted ONLY in
  `@media print` blocks (forced-light print) and the `index.css` token-definition
  region. The canvas is NO LONGER allowlisted (D5 overridden — it tokenizes); the
  media plate is a token reference, not a literal.
- [X] T006 Add the inline **pre-paint theme bootstrap** to
  `client/index.html` `<head>` (before `/src/main.jsx`): read
  `localStorage['squire-theme']`, resolve System via `matchMedia`, set
  `document.documentElement.dataset.theme` to `light`/`dark`; wrap in try/catch
  so it can never block render (FR-005, D11, `contracts/theme-control.md`).
- [X] T007 Create `client/src/contexts/ThemeContext.jsx`: tri-state `setting`
  state, `resolve(setting, osPrefersDark)`, `setSetting()` that persists to
  `localStorage['squire-theme']` and updates `data-theme`, defensive read
  (unknown → `system`), reconcile-on-mount without causing a flash. (Live
  OS-follow subscription is added in US2/T033.)
- [X] T008 Mount `<ThemeProvider>` in `client/src/App.jsx` (wrapping the provider
  stack) so every screen has theme context; confirm `main.jsx` load order keeps
  the bootstrap authoritative for first paint.
- [X] T009 [P] Unit tests in `client/src/contexts/__tests__/ThemeContext.test.jsx`:
  `resolve()` truth table, persistence round-trip, defensive unknown→system read,
  attribute reconciliation (data-model transitions).

**Checkpoint**: Token layer (light+dark), no-flash bootstrap, theme state, and
the lint gate exist. User stories can begin.

---

## Phase 3: User Story 1 - Switch to dark and have it stick (Priority: P1) 🎯 MVP

**Goal**: A user picks Dark from the profile menu; all app chrome restyles dark
immediately with no reload, persists per device, and renders dark from first
paint on reload.

**Independent Test**: Select Dark in the control; sweep every chrome surface for
dark styling; reload (cold+warm) and confirm the first frame is dark; select
Light and confirm it reverts and persists.

### Control

- [ ] T010 [US1] Create `client/src/components/ThemeControl.jsx` (three options
  Light/Dark/System, indicates active setting, keyboard-accessible, focus-visible
  via `--focus-ring`) and `client/src/components/ThemeControl.css` (token-based),
  consuming `ThemeContext` (`contracts/theme-control.md`).
- [ ] T011 [US1] Render `ThemeControl` inside the profile menu in
  `client/src/components/UserProfileBadge.jsx` (authenticated screens only).

### Token migration (per-file checklist — all [P], different files)

> Replace every chrome color literal with the matching `var(--role)` token from
> `contracts/color-tokens.md`. Use `*-hover`/`*-active`/`--surface-selected`/
> `--focus-ring` for interactive states. Do NOT touch canvas allowlist selectors.

- [ ] T012 [P] [US1] Migrate `client/src/App.css` (~190 literals) to tokens.
- [X] T013 [P] [US1] Migrate `client/src/index.css` body `background-color`
  (`#f5f5f5` → `--surface-base`); leave the token-definition block literals.
- [ ] T014 [P] [US1] Migrate `client/src/components/DocList.css`.
- [ ] T015 [P] [US1] Migrate `client/src/components/DocSidePane.css`.
- [ ] T016 [P] [US1] Migrate `client/src/components/UserProfileBadge.css`.
- [ ] T017 [P] [US1] Migrate `client/src/components/ConnectionStatus.css`.
- [ ] T018 [P] [US1] Migrate `client/src/components/MobileActionBar.css`.
- [ ] T019 [P] [US1] Migrate `client/src/components/Avatar.css`.
- [ ] T020 [P] [US1] Migrate `client/src/components/EditorView.css` (editor
  chrome; canvas content is EditorCommon.css, not here).
- [ ] T021 [P] [US1] Migrate `client/src/components/Toolbar.css`.
- [ ] T022 [P] [US1] Migrate `client/src/components/Editor.css`.
- [ ] T023 [P] [US1] Migrate `client/src/components/MenuCommon.css`.
- [ ] T024 [P] [US1] Migrate `client/src/components/FontSizeControl.css`.
- [ ] T025 [P] [US1] Migrate `client/src/components/FontFamilyDropdown.css`.
- [ ] T026 [P] [US1] Migrate `client/src/components/ColorPicker.css` fully to
  tokens. (The selectable swatch palette is a JS array of inline styles in
  `ColorPicker.jsx`, not in this CSS, so every literal here is picker chrome.)
- [ ] T027 [P] [US1] Migrate `client/src/components/TableMenu.css`.
- [ ] T028 [P] [US1] Migrate `client/src/components/TableContextMenu.css`.
- [ ] T029 [P] [US1] Migrate `client/src/components/SelectionChatButton.css`.
- [ ] T030 [P] [US1] Migrate `client/src/components/LinkPreview.css`.
- [ ] T031 [P] [US1] Migrate `client/src/components/AiPanel.css` (~111 literals).
- [ ] T032 [P] [US1] Migrate `client/src/components/AiChatBody.css`.
- [ ] T033 [P] [US1] Migrate `client/src/components/AiChatHistory.css`.
- [ ] T034 [P] [US1] Migrate `client/src/pages/ChatPage.css`.
- [ ] T035 [P] [US1] Migrate `client/src/components/VersionHistoryPanel.css`.
- [ ] T036 [P] [US1] Migrate `client/src/components/HierarchicalVersionList.css`.
- [ ] T037 [P] [US1] Migrate `client/src/components/VersionPreview.css` **fully**
  — chrome AND the document-content preview area (canvas now themes dark; use
  `--canvas-*` tokens for the content surface, diff marks keep author intent).
- [ ] T038 [P] [US1] Migrate `client/src/components/ShareDialog.css`.
- [ ] T039 [P] [US1] Migrate `client/src/pages/AdminPage.css` (~63 literals).
- [ ] T040 [P] [US1] Migrate `client/src/components/LoginPage.css`.
- [ ] T041 [P] [US1] Migrate `client/src/pages/LegalPage.css`.

### Presence legibility & verification

- [ ] T042 [US1] Presence identity legibility on dark (D14/FR-012): add
  token-based outline/backplate to avatar borders and presence labels in chrome
  CSS so the darkest Kelly colors stay distinguishable on dark surfaces. **Do NOT
  modify `client/src/utils/colorUtils.js`** or the user→color mapping.
- [ ] T043 [US1] Run `npm run lint:colors`; drive remaining literals to **0**
  outside the allowlist (depends on all migration tasks T012–T041 **and the
  canvas tokenization T048**). Then remove `.skip` from the Vitest completeness
  assertion (`src/__tests__/color-tokens.lint.test.js`, O1 join gate).
- [ ] T044 [US1] Unit test in `client/src/components/__tests__/ThemeControl.test.jsx`:
  selecting Dark/Light updates `data-theme` with no reload and persists; control
  reflects the active setting.

**Checkpoint**: MVP — dark chrome, manual toggle, device persistence, no-flash on
reload. Independently shippable.

---

## Phase 4: User Story 2 - Follow system preference automatically (Priority: P2)

**Goal**: With no explicit choice (System), the app follows the OS appearance
live; an explicit Light/Dark choice ignores the OS; choosing System resumes.

**Independent Test**: With no stored preference, toggle OS appearance and watch
the app follow live; make an explicit choice and confirm it stops following;
choose System and confirm it resumes.

- [ ] T045 [US2] In `client/src/contexts/ThemeContext.jsx`, subscribe to
  `matchMedia('(prefers-color-scheme: dark)')` `change` and re-resolve live
  **only while `setting === 'system'`**; detach on explicit choice/unmount
  (FR-003, Story 2, `contracts/theme-control.md`).
- [ ] T046 [US2] Verify unauthenticated routes (login, legal) resolve System at
  pre-paint via the bootstrap and render **no** control (D2); confirm no
  wrong-theme flash on those routes.
- [ ] T047 [US2] Unit tests in `client/src/contexts/__tests__/ThemeContext.system.test.jsx`:
  live OS change under System restyles; explicit Light ignores OS change;
  switching back to System resumes following.

**Checkpoint**: US1 + US2 both work independently.

---

## Phase 5: User Story 3 - Documents stay faithful in dark (Priority: P3)

**Goal**: In dark mode the document canvas **themes dark** (token-driven
background + default text); author-set colors and rendered media (diagram/SVG on
a light plate, images unplated) are untouched; print is forced light; theming
never writes to documents.

**Independent Test**: In dark mode open a doc with author colors, a diagram, an
SVG, an image, and a code block; confirm the canvas + default text are dark while
author-set colors and rendered media render identically to light; print-preview
is light; version history shows no theming entries.

- [ ] T048 [US3] **Canvas tokenization** (D5 overridden): add `--canvas-bg`,
  `--canvas-text` (default doc text), and a constant-light `--canvas-media-plate`
  to the token registry in `client/src/index.css` (light + dark realizations;
  plate light in both), then migrate `client/src/components/EditorCommon.css`,
  `client/src/components/Editor.css` (canvas parts), the content area of
  `client/src/components/VersionPreview.css`, `client/src/components/DiagramNodeView.css`
  and `client/src/components/ImageNodeView.css` to those tokens. Diagram/SVG
  containers use `--canvas-media-plate` (D16); images stay unplated; author-set
  inline colors are never touched (D15).
- [ ] T049 [US3] **Forced-light print** (D17): add an `@media print` reset in
  `client/src/index.css` that re-declares the `--canvas-*` tokens to their light
  values so printed output is identical from both themes (FR-010); document the
  print-preview check in quickstart.
- [ ] T050 [US3] Test (FR-014/SC-006): assert theme switching performs **no**
  document/version/collaboration write — e.g. a test that toggles the theme and
  verifies no Yjs mutation / no version entry is produced
  (`client/src/__tests__/theme-no-write.test.jsx`).
- [ ] T055 [US3] Canvas-theme regression test (flipped U2 + D15): the canvas
  root (`.editor-common-content`) computes a **dark** background under
  `data-theme="dark"` (via the `--canvas-bg` token), AND an author-set inline
  color (`<span style="color:#xxx">`) is left byte-for-byte untouched in the
  rendered DOM under both themes (`client/src/__tests__/canvas-theme.test.jsx`).

**Checkpoint**: All three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T051 [P] Accessibility contrast audit of dark chrome **and the dark
  canvas default styling** (text ≥ 4.5:1; large text/meaningful UI states —
  focus, hover, selection, disabled, scrollbars — ≥ 3:1); tune dark token values
  in `client/src/index.css` as needed (FR-011, SC-004). Per U3, include an
  explicit **collaborator identity-color legibility check** against dark chrome
  AND the dark canvas (Dark Olive Green `#2B3D26` is the known suspect); record
  results in the audit notes.
- [ ] T052 Full visual sweep of all 35+ styled surfaces + the dark canvas in
  dark mode for light-remnant surfaces, media-plate seams, and boundary
  correctness (SC-003, edge cases).
- [ ] T053 README appearance-setting doc — **SKIP the README.md edit** (merge
  queue reconciles docs). Write the intended README delta (now describing the
  **dark canvas**, Light/Dark/System, device-local) into
  `specs/006-dark-mode/promotion-notes.md` under "Merge-queue doc updates".
- [ ] T054 Run `quickstart.md` end-to-end: `npm run build`, `npm test`,
  `npm run lint:colors` (0 disallowed), and all three story validations.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001, T002 — start immediately. T002 (light tokens) is a
  prerequisite for all migration tasks.
- **Foundational (Phase 2)**: T003 gate blocks everything; T004 (dark tokens)
  depends on T002; T005 depends on T001; T006/T007/T008 build the mechanism;
  T009 depends on T007. **Blocks all user stories.**
- **US1 (Phase 3)**: depends on Foundational. Migration T012–T041 depend on T002
  (light tokens) + T005 (allowlist). T043 depends on T012–T041. T010/T011 depend
  on T007/T008.
- **US2 (Phase 4)**: depends on Foundational (T006/T007). Independent of the
  migration; can proceed in parallel with US1 migration once T007 exists.
- **US3 (Phase 5)**: depends on T005 (allowlist) + the migration being complete
  enough to assert canvas isolation; T050 depends on T007/T008.
- **Polish (Phase 6)**: after the desired stories; T051 depends on T004; T052/T054
  after US1 (+US2/US3 if included).

### User Story Dependencies

- **US1 (P1)**: after Foundational; no dependency on US2/US3.
- **US2 (P2)**: after Foundational; touches only `ThemeContext` — independent of
  US1's migration.
- **US3 (P3)**: after Foundational; validates the canvas invariant — mostly
  "must not change", so it constrains but does not block US1.

### Parallel Opportunities

- T001 ∥ (T002 must precede migration).
- All migration tasks **T012–T041 are [P]** — different files, no interdependency.
  This is the single biggest parallel batch.
- T009 (foundational tests) ∥ T006/T008.
- US2 (T045–T047) can run in parallel with US1's migration once T007 lands.

---

## Parallel Example: User Story 1 migration

```bash
# After T002 (light tokens) + T005 (allowlist), fan out the migration:
Task: "Migrate client/src/App.css to tokens"                 # T012
Task: "Migrate client/src/components/AiPanel.css to tokens"  # T031
Task: "Migrate client/src/pages/AdminPage.css to tokens"     # T039
Task: "Migrate client/src/components/VersionHistoryPanel.css"# T035
# …all of T012–T041 concurrently; then T043 runs lint:colors as the join gate.
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → Phase 2 Foundational (incl. the T003 design-doc gate).
2. Phase 3 US1: control + full token migration + presence affordance + lint=0.
3. **STOP and VALIDATE**: dark chrome everywhere, toggle, persistence, no-flash.
4. Ship the MVP.

### Incremental Delivery

1. Foundation ready → US1 (MVP, dark + manual + persist + no-flash).
2. US2 (system-follow) → validate → ship.
3. US3 (canvas-fidelity verification + no-write guarantee) → validate → ship.
4. Polish: AA audit, visual sweep, README, quickstart.

---

## Notes

- [P] = different files, no dependency on incomplete tasks.
- The migration (T012–T041) is the bulk of the effort and is fully parallelizable;
  `lint:colors` (T043) is the mechanical join gate proving FR-013/SC-003.
- Canvas allowlist is the guardrail for D5/FR-007–FR-010 — never tokenize it.
- Theming is presentational only (FR-014): no task may introduce a document,
  version, or collaboration write.
