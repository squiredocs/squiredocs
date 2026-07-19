# Tasks: Collaborative Editor Binding Hardening

**Input**: Design documents from `/specs/021-collab-binding-hardening/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R9), data-model.md, contracts/
(binding-patch.md, guardrail-alert.md, gap-read.md, runtime-config-and-skip-report.md),
clarifications-needed.md (RBD-1..6, DR-1..3)

**Tests**: REQUIRED and tests-first — this feature's spec pins the incident repros as
tests (US1/US2/US3 Independent Tests, SC-001..007). Write each story's tests before its
implementation and confirm they FAIL (red) against the pre-fix behavior. Backend tests are
**serial-only** (constitution II) — never run jest concurrently against the shared DB.

**Hard constraints** (plan Technical Context): NO migrations; NO touching files owned by
in-flight 018 (`server/search/**`, `server/search.js`, `server/search-indexer.js`,
`server/api/chat-models.js`, `server/mcp/yjs/serialization.js`) or 019 (`server/mcp/**`,
`client/public/agents.md`).

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup (baseline bump + patch scaffolding)

**Purpose**: Land the 3.0.7 baseline and the patch-application machinery every US1 task
builds on.

- [X] T001 Pin `@tiptap/y-tiptap` to exact `3.0.7` as a direct dependency in
      `client/package.json`, run `npm install` to update `client/package-lock.json`, and
      confirm the hoisted `client/node_modules/@tiptap/y-tiptap` is 3.0.7 (research R1:
      `@tiptap/extension-collaboration`'s `^3.0.0` is satisfied; the patched functions were
      diff-verified byte-identical 3.0.1→3.0.7 except upstream's own hardening of
      `restoreRelativeSelection`/`_typeChanged`).
- [X] T002 Add `patch-package` to `client/package.json` devDependencies with
      `"postinstall": "patch-package --error-on-fail"`, create empty `client/patches/`
      directory, and verify `npm ci` in `client/` succeeds end-to-end (research R3).
- [X] T003 [P] Create the headless binding test harness in
      `client/src/test/bindingHarness.js` (research R8): two relayed `Y.Doc`s, app schema
      derived from `getBaseExtensions()` in `client/src/extensions/editorExtensions.js`,
      real `ySyncPlugin` + jsdom `EditorView` (minimal view-shim fallback documented in the
      file header), helpers `encodeState(doc)` for byte-identity assertions and
      `insertRemoteUnknownNode()` / `insertRemoteFillableNode()` failure injectors.

**Checkpoint**: `npm ci` green with 3.0.7; harness importable from a trivial smoke test.

---

## Phase 2: Foundational (drift guard red + kill-switch channel)

**Purpose**: The FR-008 guard (must exist before the patch so patch work is test-driven)
and the runtime-config channel the patch reads (DR-2).

- [X] T004 [P] Write the dependency-drift guard test
      `client/src/__tests__/binding-patch-guard.test.js` per contracts/binding-patch.md
      "Survival guard": asserts installed version `=== '3.0.7'`, all five
      `SQUIRE-021:<site-id>` sentinels present in
      `client/node_modules/@tiptap/y-tiptap/dist/y-tiptap.js`, and
      `client/patches/@tiptap+y-tiptap+3.0.7.patch` exists. MUST FAIL now (no patch yet) —
      it goes green only when T010 lands (FR-008, SC-007).
- [X] T005 [P] Server kill-switch storage + endpoints: add `collab_binding_hardening`
      accessors to `server/api/app-settings.js`, `GET`/`PUT
      /settings/collab-binding-hardening` to `server/api/admin.js` (existing shared-model
      pattern; PUT `{enabled}` writes `null`/`'false'` per
      contracts/runtime-config-and-skip-report.md), and `GET /api/client-config`
      (requireAuth) to `server/index.js` returning `{ collabBindingHardening }` with
      absent-key ⇒ `true`. Backend test in `server/__tests__/client-config.test.js`
      (default-ON, flip round-trip, auth required).
- [X] T006 [P] Client kill-switch plumbing: `client/src/hooks/useClientConfig.js` fetches
      `/api/client-config` once at app bootstrap (AuthContext axios instance), sets
      `globalThis.__SQUIRE_COLLAB_HARDENING__`; failure leaves it unset (fail-safe ON).
      Wire into `client/src/App.jsx` bootstrap. Vitest coverage in
      `client/src/__tests__/use-client-config.test.jsx` (sets global on success, leaves
      unset on failure).

**Checkpoint**: guard test red for the right reason (missing sentinels/patch); config
channel green both sides.

---

## Phase 3: User Story 1 — A watching viewer's browser can never destroy remote content (P1) 🎯 MVP

**Goal**: The four amendment behaviors + Addition refinements as a committed patch on
3.0.7, kill-switch-gated, skip-observable, with the quarantine second layer.

**Independent Test**: the harness repros in T007–T009/T012–T014 — shared Y.Doc
byte-for-byte unchanged across every forced failure path (SC-001..003, SC-007).

### Tests for User Story 1 (write FIRST — all must FAIL against stock 3.0.7)

- [X] T007 [P] [US1] Render-failure repro tests in
      `client/src/__tests__/binding-render-failure.test.js` (harness): (a) forced throwing
      node (remote inserts unknown nodeName) ⇒ remote/shared Y.Doc **byte-identical**,
      remainder renders, one bounded log with node type + doc identity + error (RBD-6),
      repeated remote updates cause no rerender loop and no further logs (SC-001, FR-001..004);
      (b) text-run failure takes the same log-and-skip path (edge case; contract site 2);
      (c) **createAndFill fill-before-skip**: a fillable node type yields a stand-in in the
      view, Y untouched (DR-1/Addition-2); (d) **front-door**: with a node skipped, a
      legitimate local edit elsewhere commits ⇒ the skipped node SURVIVES in Y and the edit
      lands (DR-1/Addition-1; contract site 5 incl. the index-translation
      neighbors case: skipped node between two edited siblings).
- [X] T008 [P] [US1] Selection + write-back repro tests in
      `client/src/__tests__/binding-selection-writeback.test.js` (harness): (a) selection
      throw via the `binding._restoreRelativeSelection` seam ⇒ render still commits with
      all remote content, selection at a clamped near position incl. empty-doc case
      (SC-002, FR-005); (b) **the incident repro**: forced view/Yjs divergence, then a
      doc-unchanged transaction (selection-only, then metadata-only) ⇒ zero editor→Yjs
      write-back, nothing deleted from Y (SC-003, FR-006); (c) divergence resolution
      re-renders FROM Yjs: view converges, Y byte-unchanged (FR-007, RBD-3).
- [X] T009 [P] [US1] Kill-switch revert test in
      `client/src/__tests__/binding-killswitch.test.js`: with
      `globalThis.__SQUIRE_COLLAB_HARDENING__ = false` the forced-throw repro **deletes
      from Y again** (stock 3.0.7 behavior — proving genuine revert, DR-2); restoring the
      flag restores hardened behavior in the same process; guardrail/quarantine
      independence is asserted structurally (patch reads only this one global).

### Implementation for User Story 1

- [X] T010 [US1] Author the patch (contracts/binding-patch.md sites 1–5) by editing
      `client/node_modules/@tiptap/y-tiptap/dist/y-tiptap.js` (+ mirrored `dist/y-tiptap.cjs`):
      render-catch element+text (createAndFill → tracked-skip → bounded log/report; NO Y
      mutation), `_restoreRelativeSelection` seam + guard + clamped fallback on the 3.0.7
      body, `docChanged` write-back gate in the plugin `update()` hook, divergence-marking +
      `_forceRerender`-from-Y resolution, tracked-skip exclusion with explicit
      filtered→real index translation in `updateYFragment`, `hardeningEnabled()` live-read
      kill-switch with verbatim stock fallback at each site, `SQUIRE-021:<site-id>`
      sentinels. Then `npx patch-package @tiptap/y-tiptap --error-on-fail` to emit
      `client/patches/@tiptap+y-tiptap+3.0.7.patch`; commit the patch file. Turns T004,
      T007, T008, T009 green.
- [X] T011 [US1] Verify patch survival: rm -rf `client/node_modules`, `npm ci`, re-run
      T004/T007/T008/T009 suites green (proves postinstall re-application; SC-007's
      install-path half).
- [X] T012 [P] [US1] Skip reporter client: `client/src/utils/skipReporter.js`
      (once-per-element dedupe per RBD-6, 2 s debounce, batched per doc, fire-and-forget
      via AuthContext axios, swallowed failures), registered as
      `globalThis.__SQUIRE_SKIP_REPORTER__` at app bootstrap alongside T006. Test
      `client/src/__tests__/skip-reporter.test.js`: a forced skip produces **exactly one**
      report per element per instance (mocked transport); transport failure never throws
      into the render path (DR-3).
- [X] T013 [US1] Skip-report server endpoint: `POST /api/collab/render-skip-report` in
      `server/index.js` per contracts/runtime-config-and-skip-report.md (requireAuth, ≤8 KB,
      shape-validated, max 20 events, rate-limited via `server/rate-limit.js`; 204;
      structured log line + OTel counter `collab.render_skip.reports` via
      `server/telemetry/metrics.js`). Backend test
      `server/__tests__/render-skip-report.test.js`: valid report logs+counts, malformed
      400s without side effects, unauthenticated 401s.
- [X] T014 [US1] Quarantine second layer: `enableContentCheck: true` + `onContentError`
      in `client/src/components/Editor.jsx` `useEditor` options (survives the
      `[isMobile, provider]` recreation at :124 by living in the options object) —
      quarantine = event's `disableCollaboration()` + `editor.setEditable(false)` + a
      refresh banner surfaced through `client/src/components/EditorView.jsx`'s existing
      banner surface; independent of the kill-switch (DR-1/Addition-4, research R5). Test
      `client/src/__tests__/editor-quarantine.test.jsx`: contentError ⇒ collab disabled,
      editor read-only, banner shown, no Y mutation.

**Checkpoint**: US1 fully green including flag-off revert; `npm ci` from scratch keeps it
green. MVP deliverable.

---

## Phase 4: User Story 2 — The incident class is visible within seconds, server-side (P2)

**Goal**: Detection-only guardrail alert on the incident signature, off the write path.

**Independent Test**: replayed signature fires with all fields; controls stay silent
(SC-004).

### Tests for User Story 2 (write FIRST — must FAIL before T016)

- [X] T015 [P] [US2] Guardrail tests in `server/__tests__/collab-guardrail.test.js`
      (jest, serial; build updates with real `Y.Doc`s so delete sets are genuine):
      (a) signature — agent-attributed row creates content, human-attributed update whose
      delete set covers it arrives within the window ⇒ exactly one `notifyException` with
      `source: 'collab-guardrail'` and extra fields docGuid/humanUserId/agentName/
      agentClockRange/overlappedItemRanges (FR-009/010, RBD-1 default 10 s via
      `GUARDRAIL_FRESHNESS_SECONDS`); (b) silence controls — normal human edit, human
      deleting agent content **older** than the window, agent-deletes-agent (RBD-2), empty
      delete set ⇒ no alert; (c) suppression — a storm of matches for one (doc,user) pages
      once then counts, next fired alert carries `suppressedSinceLastAlert`; a second
      doc/user alerts independently (FR-012, RBD-1, `GUARDRAIL_SUPPRESSION_MS`);
      (d) never-blocks — evaluation stubbed to throw ⇒ storeUpdate/broadcast unaffected,
      error logged and swallowed (FR-011, RBD-4).
- [X] T016 [US2] Implement `server/collab-guardrail.js` per contracts/guardrail-alert.md
      (Y.decodeUpdate delete-set × fresh-agent-row insert-range intersection in Yjs-ID
      space, DB-clock range in the alert, in-memory (doc,user) suppression map, env
      tunables) and wire it fire-and-forget into the bindState persistence listener in
      `server/index.js` (~:276-299, after `storeUpdate` resolves — post-persist, async,
      RBD-4). Turns T015 green.

**Checkpoint**: US2 green; write-path perf untouched (guardrail runs post-persist,
alert-path failures swallowed).

---

## Phase 5: User Story 3 — A document read never serves a torn snapshot when a brief retry would heal it (P3)

**Goal**: Gap-tolerant `getYDoc` — detect, briefly retry, serve-as-is, observable.

**Independent Test**: withheld-row tests of SC-005.

### Tests for User Story 3 (write FIRST — must FAIL before T018)

- [X] T017 [P] [US3] Gap-read tests in `server/__tests__/postgres-gap-read.test.js`
      (jest, serial; drive retry timing via `COLLAB_READ_GAP_RETRIES` /
      `COLLAB_READ_GAP_RETRY_DELAYS_MS` set to small values, not wall-clock defaults):
      (a) store clocks `…k, k+2…`, read, release `k+1` during the retry window ⇒ complete
      document returned (FR-013/014); (b) gap kept open past the window ⇒ read returns
      as-is within the bounded budget — no hang, no throw — and the gapped-serve log line
      is emitted (FR-015); (c) gap-free rows ⇒ zero retries/timers, result unchanged
      (FR-016); (d) head-of-history: contiguous rows starting at clock 5 ⇒ no gap;
      (e) multiple gaps ⇒ single (non-compounding) retry budget; (f) empty and single-row
      reads unchanged (edge cases).
- [X] T018 [US3] Implement gap tolerance in `server/postgres-persistence.js` `getYDoc`
      (:211-235) per contracts/gap-read.md: add `clock` to the SELECT, single-pass
      contiguity check, ≤`COLLAB_READ_GAP_RETRIES` full re-fetches with
      `COLLAB_READ_GAP_RETRY_DELAYS_MS` waits, serve-as-is + structured log after the
      budget, gap-free hot path byte-identical to today. Turns T017 green.

**Checkpoint**: US3 green; all readers (history, diffs, exports, MCP read, bindState)
covered via the single choke point.

---

## Phase 6: Polish & Cross-Cutting

- [X] T019 [P] SC-006 regression sweep: run the existing collaboration suites UNMODIFIED —
      `server/__tests__/attribution-bug.test.js`, `server/__tests__/origin.test.js`,
      `__tests__/integration/collaboration.test.js` (serial), full `client` vitest suite —
      all green with zero test-file edits (green-path behavior bit-identical).
- [X] T020 [P] Documentation (constitution I): update `ReadMe.md` collaboration section —
      binding patch (what/why, patch-package + guard, kill-switch admin flip), guardrail
      alert, gap-tolerant reads; note the new env vars (data-model.md table) in the
      relevant config docs; verify `docs/dev.md` needs no change (no new local-dev steps
      beyond `npm ci`).
- [X] T021 Run `specs/021-collab-binding-hardening/quickstart.md` §1–§4 end-to-end in the
      dev pod (incl. the drift-guard install-failure drill and the manual kill-switch
      flip + quarantine checks) and record results in the feature worklog. Promotion notes
      (plan.md): upstream filing (y-tiptap issue + y-prosemirror #39/#258) and the
      post-deploy kill-switch drill remain OWED follow-ups — carry them into the merge/PR
      notes; they are not closed by this feature.

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → user stories**: T001→T002 serial (same package.json); T003 [P]
  alongside T002. T004 needs T001/T002; T005, T006 independent of the patch.
- **US1 (Phase 3)**: T007–T009 after T003 (harness) + T004; T010 after T007–T009 red;
  T011 after T010; T012 after T006; T013 [P] anytime (server-side); T014 after T010
  (quarantine tested against the patched binding).
- **US2 (Phase 4)**: independent of US1; T015 → T016. Shares `server/index.js` with
  T005/T013 — coordinate edits serially, different regions.
- **US3 (Phase 5)**: fully independent; T017 → T018.
- **Phase 6** after all stories.
- Backend test tasks (T005, T013, T015, T017, T019) must run their suites serially —
  never in parallel with each other's runs.

### Parallel opportunities

- After Phase 2: US1 client work (T007–T012, T014), US2 (T015–T016), US3 (T017–T018) are
  three independent tracks.
- Within US1: T007, T008, T009 in parallel (different files); T012/T013 in parallel with
  each other.

---

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1)** — the confirmed incident's cause is removed,
kill-switch-guarded, observable. Validate US1's checkpoint (incl. the from-scratch
`npm ci`) before proceeding. US2 then removes the silence (guardrail), US3 the torn reads;
each is independently testable and deliverable. Commit after each green checkpoint.

**Task count**: 21 (Setup 3, Foundational 3, US1 8, US2 2, US3 2, Polish 3).
