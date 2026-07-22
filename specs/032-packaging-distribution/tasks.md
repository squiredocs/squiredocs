---
description: "Task list: Packaging & Distribution — M3 Wave 1"
---

# Tasks: Packaging & Distribution — M3 Wave 1

**Input**: Design documents from `/specs/032-packaging-distribution/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md — all present.

**Tests**: The drift guard, harness switch, and cross-surface check ARE the feature's deliverables (US3/US4/US5), so their test tasks are mandatory, not optional. They ride `npm run test:first-run` (always-run CI) and the documentation-build Vitest suite — no new CI job.

**Organization**: Grouped by user story (P1→P3). US1 is the MVP: the real shipping bundle. US2/US3 are the two halves of the generate+guard mechanism. US4 switches rehearsals to the shipping bundle and retires the M2 assembler. US5 is the public surfaces.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different file, no incomplete dependency).
- **[Story]**: US1..US5; Setup/Foundational/Polish carry no story label.

## Overrides in force (from the assignment)

- Stay on `main`; NEVER branch; NEVER commit. No user interaction — defaults are RATIFIED-BY-DEFAULT (RBD-1..7).
- NEVER edit `CLAUDE.md`, `README.md`, `docs/dev.md`, `design/*`. Editing served `agents.md`, landing page, documentation source IS in scope.
- `distribution/shared/{skill.md,onboard.md}` are READ-ONLY (FR-006).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: The `distribution/` tooling scaffold that every channel and test builds on.

- [ ] T001 Create `distribution/schemas/` and vendor the pinned manifest JSON schemas (RBD-4, FR-010): the Claude Code plugin manifest schema, the marketplace manifest schema, and the Official MCP Registry `server.json` schema — each as `distribution/schemas/<name>.schema.json`. If a `.mcp.json` upstream schema does not exist, note that structural checks live in `publish.mjs` instead. Add `distribution/schemas/SOURCES.md` recording each schema's upstream URL, retrieval date, and the re-fetch-and-diff refresh procedure.
- [ ] T002 Probe for an existing JSON-schema validator in the repo dependency tree (`node -e "require.resolve('ajv')"` or equivalent, per research R8). Record the outcome in a comment at the top of `distribution/publish.mjs` (T005): use the resolvable validator if present; otherwise the self-contained structural validator (T006). MUST NOT add a new *production* dependency solely for this gate.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: `publish.mjs`'s generator core — the single source of expected bytes every later story imports (FR-008). BLOCKS US1–US4.

- [ ] T003 Create `distribution/publish.mjs` module skeleton with the M2-carried constants and transform (research R2, contracts/publish-api.md): `REPO_ROOT`, `SHARED_DIR`, `PROD_ENDPOINT = 'https://squiredocs.com/mcp'`, `DEFAULT_CLAUDE_PLUGIN_DIR = distribution/claude-plugin`, and `withGeneratedHeader(sharedContent, sourceRel)` carried VERBATIM from `test/first-run/assemble-bundle.mjs` lines 41-50 EXCEPT the regen command string, which becomes `node distribution/publish.mjs`. Frontmatter must stay first (FR-005, spec Edge Case).
- [ ] T004 In `distribution/publish.mjs`, implement the channel-registry structure (RBD-3, research R3): a `CHANNELS` map/list of descriptors (id, output dir, generated-file derivations, schema bindings, optional mirror-remote key) so wave-2/3 channels add a descriptor rather than a rearchitecture. Wire only `claude-plugin` and `mcp-registry` this wave (FR-029).
- [ ] T005 In `distribution/publish.mjs`, implement `expectedFiles({ endpoint = PROD_ENDPOINT })` returning the claude-plugin bundle map (contracts/publish-api.md): `plugin.json` (name `squire`, version `1.0.0` per RBD-5, "Squire Docs" production copy), `marketplace.json` (own marketplace, production copy — no rehearsal framing, FR-003), `.mcp.json` (`mcpServers.squire = { type:'http', url:endpoint }`, key MUST be `squire` FR-004), `skills/squire/SKILL.md` and `commands/onboard.md` via `withGeneratedHeader`. Deterministic (FR-008). And `assembleBundle({ outDir, endpoint })` writing them, never mutating `shared/` (FR-006).
- [ ] T006 In `distribution/publish.mjs`, implement `expectedRegistryServer()` returning deterministic `mcp-registry/server.json` content (FR-007): `name: "com.squiredocs/mcp"`, remote streamable-HTTP endpoint `https://squiredocs.com/mcp`, OAuth declaration, version mirroring `1.0.0`, NO package/stdio artifact.
- [ ] T007 In `distribution/publish.mjs`, implement `validateBundles()` (FR-009/010/011): validate each generated manifest against its pinned schema using the validator chosen in T002 (or the structural fallback), returning `{ ok, problems[] }` where each problem names the offending file + schema violation; offline/deterministic. Attempt the plugin-dev validator agent where available and treat its absence as a reported warning, never a failure; do NOT depend on a `claude plugin validate` CLI verb.

---

## Phase 3: User Story 1 — The real shipping plugin bundle exists (P1) 🎯 MVP

**Goal**: The committed, publishable `distribution/claude-plugin/` bundle + `distribution/mcp-registry/server.json`, all byte-derived from `shared/` and schema-valid.

**Independent test**: Add `distribution/claude-plugin` as a local-path marketplace in a scratch Claude Code config, install `squire`, observe the MCP server registered from `.mcp.json`, the skill + `/squire:onboard` present, all generated content byte-derived from `shared/`. `node distribution/publish.mjs` validates green.

- [ ] T008 [US1] Generate the committed bundle: run `node distribution/publish.mjs` (default mode) to write `distribution/claude-plugin/**` (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, `skills/squire/SKILL.md`, `commands/onboard.md`) and `distribution/mcp-registry/server.json` from `shared/`. Commit these generated files to the tree (FR-001/007). Verify the layout matches the design exactly (FR-001).
- [ ] T009 [US1] Verify the committed `.mcp.json` endpoint is exactly `https://squiredocs.com/mcp` and the server key is `squire` (FR-004); verify `plugin.json` uses name `squire`, semver `1.0.0`, and "Squire Docs" display/listing copy in the honest-confident voice (FR-002/026, RBD-5); verify `marketplace.json` carries production copy and the `/plugin marketplace add squiredocs/squire-plugin` + `/plugin install squire` install path (FR-003).
- [ ] T010 [US1] Confirm `skills/squire/SKILL.md` and `commands/onboard.md` are byte-faithful to `shared/{skill,onboard}.md` plus the do-not-hand-edit header AFTER frontmatter (FR-005), and that `distribution/shared/` is unchanged by generation (FR-006).
- [ ] T011 [US1] Confirm `server.json` validates against the pinned registry schema — `com.squiredocs/mcp`, remote streamable-HTTP + OAuth, no package/stdio (FR-007, RBD-7) — via `validateBundles()`.

**Checkpoint**: US1 is an installable, schema-valid, shared-derived bundle. MVP deliverable.

---

## Phase 4: User Story 2 — One command regenerates and validates every bundle (P2)

**Goal**: `publish.mjs` is the complete generate+validate+(Sam-run)push mechanism; dry-run by default, fail-closed push.

**Independent test**: `node distribution/publish.mjs` regenerates deterministically and reports pass/fail per bundle with offending file+problem; `--publish` with no configured targets refuses cleanly with zero side effects.

- [ ] T012 [US2] Implement the `publish.mjs` CLI default (dry-run) mode (FR-012, RBD-6, contracts INV-1): regenerate every wave-1 bundle from `shared/` into committed locations (or `--out`), run `validateBundles()`, print pass/fail per bundle, exit non-zero on any violation naming file+problem (FR-009, SC-004). MUST touch NO network and NO credentials. Support `--endpoint` for local materialization only.
- [ ] T013 [US2] Implement the `--publish` push mode with fail-closed preconditions (FR-012/013, RBD-6, contracts INV-1): require BOTH `--publish` AND mirror remotes supplied via config/environment (NEVER committed defaults); missing/unreachable remotes fail closed pre-push with zero side effects. Per mirror: clone/fetch, run the version-bump guard (T014), then commit+push with a message referencing the source-repo commit.
- [ ] T014 [US2] Implement the version-unchanged-but-content-changed refuse check in the publish path (FR-013): compare regenerated content to the mirror clone; if content differs while `plugin.json`/channel manifest version is unchanged, refuse and exit non-zero, no push.
- [ ] T015 [P] [US2] Write `test/first-run/publish-mechanism.test.mjs` exercising the push mechanism against LOCAL bare-repo fixtures only (RBD-6): a first push succeeds; a re-push with changed content but unchanged version is refused (FR-013); `--publish` with no configured remotes fails closed with zero side effects. NEVER a real remote; CI never runs the real push (contracts INV-1).
- [ ] T016 [P] [US2] Document the schema-refresh path and the Sam-op publish procedure in `distribution/publish.mjs`'s usage header/comments (FR-010, FR-028): how to re-fetch+diff the pinned schemas, and the exact `--publish` + remote-config invocation Sam runs for the first real publish.

**Checkpoint**: the publish mechanism is complete and proven against fixtures; the dangerous half is impossible to trigger accidentally.

---

## Phase 5: User Story 3 — Drift between shared content and shipped bundles fails CI (P2)

**Goal**: A deterministic drift test byte-matches every generated bundle file to a fresh regeneration; endpoint field exempt but committed value pinned to prod; M2 agreement check retired with no coverage loss.

**Independent test**: mutate one byte of a generated file → drift suite fails naming the file; restore → passes. Rewrite only `.mcp.json` endpoint in a throwaway copy → committed bundle untouched, suite still passes; a committed dev URL fails the pin.

- [ ] T017 [US3] Create `test/first-run/bundle-drift.test.mjs` (FR-014, contracts INV-3): import `expectedFiles`/`expectedRegistryServer` from `distribution/publish.mjs` (NEVER a hand-maintained fixture); assert every committed file under `distribution/claude-plugin/` and `distribution/mcp-registry/` byte-matches the regeneration; failure names the drifted file AND points at `node distribution/publish.mjs` (SC-003).
- [ ] T018 [US3] In `bundle-drift.test.mjs`, add the endpoint-field exemption (FR-015): compare `.mcp.json` with `mcpServers.squire.url` stripped from both sides (field-scoped, not file-scoped); every other byte still asserted. Reuse the M2 `mcpMatchesIgnoringEndpoint` logic pattern.
- [ ] T019 [US3] In `bundle-drift.test.mjs`, add the separate production-endpoint pin (FR-016, contracts INV-2): parse committed `distribution/claude-plugin/.mcp.json`, assert `mcpServers.squire.url === 'https://squiredocs.com/mcp'` — so the exemption cannot let a dev URL ship.
- [ ] T020 [US3] In `bundle-drift.test.mjs` (or a sibling `*.test.mjs` in the always-run suite), re-home the content-budget checks from the retiring `check-bundle-agreement.mjs` (FR-017, research R9): `checkContentBudgets()` over `distribution/shared/` returns no problems (skill description ≤250 chars, skill body ≤400 lines, onboard ≤300 lines). Carry `BUDGETS` so no coverage is lost.
- [ ] T021 [US3] Add a tamper-detection assertion (SC-003): materialize a temp bundle via `assembleBundle`, mutate one byte, assert the comparison reports that exact file. Confirms the guard actually catches hand-edits.

**Checkpoint**: drift fails CI rather than shipping; the generated-copies rule is enforced. (Retirement of the M2 agreement test happens in US4/T025.)

---

## Phase 6: User Story 4 — Rehearsals exercise the actual shipping artifact (P3)

**Goal**: The harness defaults to `distribution/claude-plugin`; the M2 assembler and committed assembled-bundle are retired; `publish.mjs` is the single generator.

**Independent test**: run the harness with no `--bundle` against the dev server — it installs from `distribution/claude-plugin`, templates a throwaway copy with the dev endpoint, never mutates the source bundle, completes a graded rehearsal. Full first-run suite green with no references to retired paths.

- [ ] T022 [US4] Edit `test/first-run/rehearsal-harness.mjs`: repoint the import from `./assemble-bundle.mjs` to `../../distribution/publish.mjs` (line 42), and change the default-bundle logic (lines 167-177) so no-`--bundle` installs the committed `distribution/claude-plugin` (FR-018) — templating the endpoint to the dev server via the existing throwaway-copy path (FR-019), keeping the source-bundle-never-mutated integrity check holding against the new source location (lines 190-199). `--bundle <dir>` still overrides.
- [ ] T023 [US4] Verify `test/first-run/matrix-runner.mjs` and `matrix-cells.mjs` inherit the new harness default (FR-018) and carry no stale `assemble-bundle`/`assembled-bundle` import or comment/help-text reference (grep-confirmed clean).
- [ ] T024 [US4] Delete `test/first-run/assemble-bundle.mjs` and the committed `test/first-run/assembled-bundle/` directory (FR-020, RBD-2) once T022/T023 confirm no consumer imports them.
- [ ] T025 [US4] Delete `test/first-run/check-bundle-agreement.mjs` and `test/first-run/bundle-agreement.test.mjs` (FR-017/020, RBD-2) — their coverage now lives in `bundle-drift.test.mjs` (T017-T021). Confirm no surviving test imports them.
- [ ] T026 [US4] Run the full deterministic first-run suite (`npm run test:first-run`) and confirm green with ZERO references to `assemble-bundle`/`assembled-bundle`/`check-bundle-agreement` anywhere under `test/` (FR-021, quickstart §4 grep = `clean`).

**Checkpoint**: what gets rehearsed is byte-for-byte what gets published (endpoint aside); one generator, one drift guard.

---

## Phase 7: User Story 5 — The install one-liners reach users on every public surface (P3)

**Goal**: The three public surfaces carry the identical plugin one-liners in the honest-confident voice, saying "Squire Docs".

**Independent test**: build the client; inspect built landing page, documentation page, served agents.md; the identical plugin one-liner appears on all three; the `claude mcp add` path survives for other clients; the doc build's terminology gate passes.

- [ ] T027 [US5] Edit `client/public/agents.md` Connect section (lines 11-60): lead the Claude Code path with the plugin route — `/plugin marketplace add squiredocs/squire-plugin` then `/plugin install squire` — as the recommended route, with the restart-after-install caveat (FR-022/023); RETAIN the `claude mcp add --transport http squire https://squiredocs.com/mcp` one-liner for other Claude CLI contexts and MCP-native clients; keep the existing in-session "don't run config commands mid-session" guidance coherent with the new leading path (FR-022). Use the canonical strings from research R8/contracts verbatim.
- [ ] T028 [P] [US5] Edit `documentation/agents-and-mcp.md` Connecting section (after line ~24): add a per-ecosystem install section mirroring the same canonical one-liners (FR-024). Keep "Squire Docs" naming (FR-026); ensure the documentation-build validation + terminology gates stay green.
- [ ] T029 [P] [US5] Edit `client/public/landing.html`: add a "works with your coding agent" block (alongside the "Connects to your favorite AI" section ~line 143) presenting the install one-liners in the honest-confident voice, saying "Squire Docs" (FR-025/026). Match the canonical strings verbatim.
- [ ] T030 [US5] Add a cross-surface command-string assertion (FR-027, SC-005): a test (first-run suite or doc-build test) asserting `/plugin marketplace add squiredocs/squire-plugin` and `/plugin install squire` appear verbatim in all three surface files, and `claude mcp add --transport http squire https://squiredocs.com/mcp` survives in `agents.md`. Wording drift between surfaces is a defect.
- [ ] T031 [US5] Run the client/documentation build (`cd client && npm run build` or the repo's doc-build entry) and confirm the documentation build (validation + terminology gates) passes with the new install section (FR-024, SC-005).

**Checkpoint**: every public surface carries the identical, correct install commands; the `claude mcp add` fallback survives.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T032 [P] Carry the Sam-only handoff checklist (FR-028, contracts/drift-and-surfaces.md §Sam-only) and the owed orchestrator items into `specs/032-packaging-distribution/promotion-notes.md` at implement time: (1) mirror-repo creation + first `--publish`; (2) MCP Registry DNS challenge + first registry publish; (3) community-directory Console submission; (4) deploy sequencing (030+031 to prod → push mirrors → deploy surfaces).
- [ ] T033 [P] Record the owed-but-barred items in promotion-notes for the merge queue (NOT done here): FR-030 Agent Surface (MCP) design-doc amendment (plugin one-liner + signup line — amend the Squire doc + `node design/sync.mjs`); the `docs/dev.md` first-run tooling refresh (promotion-note 6, staler after US4); the design channel-status-table updates as submissions land.
- [ ] T034 Full acceptance (SC-007): run `npm run test:first-run` and the client build together; confirm both green, the retired M2 assembly path fully absent, and every quickstart.md scenario (1-6) passes.

---

## Dependencies & execution order

- **Setup (T001-T002)** → **Foundational (T003-T007)** blocks everything (the generator core is the shared source of expected bytes, FR-008).
- **US1 (T008-T011)** depends on Foundational; it is the MVP and every other story consumes its bundle.
- **US2 (T012-T016)** depends on Foundational (adds CLI modes + push mechanism). Independent of US3 code-wise but both are the two halves of one mechanism.
- **US3 (T017-T021)** depends on Foundational + US1 (needs committed bundle to match against). The M2-agreement retirement it enables happens in US4/T025.
- **US4 (T022-T026)** depends on US1 (committed bundle to default to) and US3 (drift coverage must exist BEFORE deleting the M2 agreement check — T025 after T017-T021).
- **US5 (T027-T031)** depends on US1 (final install commands settled). Otherwise independent; can proceed in parallel with US2-US4.
- **Polish (T032-T034)** last.

### Critical ordering guards

- T025 (delete M2 agreement check) MUST follow T017-T021 (new drift coverage exists) — no coverage gap (FR-017).
- T024 (delete assembler + assembled-bundle) MUST follow T022-T023 (no consumer imports them) — suite must not break.
- T008 (generate committed bundle) MUST precede all US3 drift assertions and the US4 harness default.

### Parallel opportunities

- T015, T016 [P] within US2 (different files).
- T028, T029 [P] within US5 (different surface files); T027 touches `agents.md` alone.
- T032, T033 [P] in Polish (promotion-notes additions).
- US5 (surfaces) can run in parallel with US2-US4 once US1's install commands are fixed (they are fixed by research R8's canonical strings).

## Implementation strategy

- **MVP = US1** (T001-T011): the installable, schema-valid, shared-derived bundle. Everything else validates, guards, rehearses, or advertises it.
- **Increment 2 = US2+US3** (the generate+guard mechanism, two halves of one thing).
- **Increment 3 = US4** (rehearse the real artifact + retire M2) — ordering-sensitive, do after US3 coverage lands.
- **Increment 4 = US5** (surfaces) — parallelizable, gated only on US1's settled commands.
- **Close = Polish** (handoff + owed-items recording + full acceptance).

## Task count

34 tasks: Setup 2, Foundational 5, US1 4, US2 5, US3 5, US4 5, US5 5, Polish 3.
