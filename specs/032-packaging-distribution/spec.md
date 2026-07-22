# Feature Specification: Packaging & Distribution — M3 Wave 1

**Feature Branch**: `032-packaging-distribution`

**Created**: 2026-07-22

**Status**: Draft

**Input**: User description: "032-packaging-distribution: M3 wave-1 packaging and distribution wrappers per design/plugin-marketplace-publishing.md"

**Design ground truth**: `design/plugin-marketplace-publishing.md` (ratified 2026-07-21), build milestone **M3 "Packaging and distro wrappers", wave 1 only**. M1 (029 test mechanism) and M2 (030 plugin logic, 031 consent collapse) are done and signed off. The M2→M3 obligations are recorded in `specs/030-plugin-logic/promotion-notes.md` and are incorporated here (items 2, 3, 4 are in scope; items 1, 5, 6 are orchestrator/Sam work flagged below).

This feature builds everything up to "ready to submit": the real shipping plugin bundle and registry entry under `distribution/`, the publish mechanism, the drift guard, the rehearsal-harness switch to the shipping bundle, and the three public install surfaces. It performs **no actual publishing, pushing, or submission** — those are Sam-only operations, handed off as a checklist.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The real shipping plugin bundle exists (Priority: P1)

A developer using Claude Code wants to connect their coding agent to Squire Docs with a plugin install instead of hand-running `claude mcp add`. The repository gains the real, publishable Claude Code plugin bundle at `distribution/claude-plugin/` — a self-contained directory that, once mirrored to the public repo, lets any user run `/plugin marketplace add squiredocs/squire-plugin` then `/plugin install squire` and end up with the Squire Docs MCP server registered, the `squire` skill installed, and `/squire:onboard` available. Alongside it, `distribution/mcp-registry/server.json` describes the remote server for the Official MCP Registry (`com.squiredocs/mcp`), the wave-1 baseline every aggregator mirrors.

**Why this priority**: This is the flagship deliverable of the whole design — without the bundle there is nothing to validate, rehearse, publish, or advertise. Every other story consumes it.

**Independent Test**: Add `distribution/claude-plugin` as a local-path marketplace in a scratch Claude Code config, install the plugin, and observe: the `squire` MCP server registered from `.mcp.json`, the skill and `/squire:onboard` command present, and all generated content byte-derived from `distribution/shared/`.

**Acceptance Scenarios**:

1. **Given** a scratch Claude Code configuration, **When** `distribution/claude-plugin` is added as a local-path marketplace and the `squire` plugin is installed, **Then** the plugin installs cleanly, the MCP server entry points at the production endpoint, and the skill and onboard command are present under their expected names.
2. **Given** the bundle's manifests, **When** they are validated against the ecosystem's manifest schemas, **Then** validation passes with the manifest name `squire`, display/listing copy saying "Squire Docs", and a valid semver version.
3. **Given** `distribution/shared/skill.md` and `distribution/shared/onboard.md`, **When** the bundle is generated, **Then** `skills/squire/SKILL.md` and `commands/onboard.md` are derived from them byte-faithfully (plus a do-not-hand-edit header placed after any leading frontmatter), and the shared files themselves are unchanged.
4. **Given** `distribution/mcp-registry/server.json`, **When** it is validated against the official registry's server schema, **Then** it passes, naming `com.squiredocs/mcp` and describing the remote streamable-HTTP endpoint with OAuth — no stdio wrapper, no package artifact.

---

### User Story 2 - One command regenerates and validates every bundle (Priority: P2)

A maintainer (or the pipeline) edits `distribution/shared/` content or a manifest and runs `node distribution/publish.mjs`. The script regenerates every wave-1 bundle from `shared/`, validates each bundle against the manifest JSON schemas (the authoritative gate), runs the plugin-dev validator agent where available, and — only when explicitly asked, with mirror-repo access configured — commits and pushes each mirror repo with a generated message referencing the source commit. Without the explicit publish flag it is a safe generate-and-validate dry run.

**Why this priority**: The publish mechanism is what makes the mirrors "build artifacts, never hand-edited" (design principle 2). It must exist and be proven before any real publish, but it depends on the bundles of US1.

**Independent Test**: Run the script with no arguments — bundles regenerate deterministically and validation reports pass/fail with the offending file and problem. Run it with the publish flag but no configured mirror targets — it refuses cleanly without side effects.

**Acceptance Scenarios**:

1. **Given** an edit to `distribution/shared/skill.md`, **When** `publish.mjs` runs in its default mode, **Then** the generated bundle files are rewritten from the new shared content and validation runs; nothing is committed or pushed anywhere.
2. **Given** a bundle manifest that violates its JSON schema, **When** `publish.mjs` runs, **Then** it exits non-zero naming the offending file and the schema problem.
3. **Given** the publish flag and configured mirror targets, **When** `publish.mjs` publishes, **Then** each mirror receives a commit whose message references the source repository commit — and this path is never exercised by tests or CI.
4. **Given** an environment where the plugin-dev validator agent is unavailable, **When** `publish.mjs` runs, **Then** schema validation still gates authoritatively and the missing validator is reported as a warning, not a failure.

---

### User Story 3 - Drift between shared content and shipped bundles fails CI (Priority: P2)

A contributor hand-edits a generated file in `distribution/claude-plugin/` (or edits `shared/` without regenerating). The next CI run fails a deterministic drift test that asserts every generated bundle file byte-matches what `publish.mjs` regenerates from `shared/` — so drift fails CI rather than shipping. The one exemption is the `.mcp.json` endpoint URL field, which the rehearsal harness overrides per-run to point at the dev server; a separate assertion still pins the committed value to the production endpoint.

**Why this priority**: The generated-copies rule is only safe with an enforcement mechanism; this is the guard that lets `shared/` stay the single source of truth. Same priority tier as US2 — they are two halves of one mechanism.

**Independent Test**: Mutate one byte of a generated bundle file, run the drift suite, watch it fail naming the file; restore, watch it pass. Mutate only the `.mcp.json` endpoint URL to a dev-server URL in a harness-templated copy — the committed bundle is untouched and the suite still passes.

**Acceptance Scenarios**:

1. **Given** a hand-edit to `distribution/claude-plugin/skills/squire/SKILL.md`, **When** the repo test suite runs, **Then** the drift test fails, naming the drifted file and pointing at the regeneration command.
2. **Given** bundles freshly regenerated by `publish.mjs`, **When** the drift test runs, **Then** it passes.
3. **Given** the committed `distribution/claude-plugin/.mcp.json`, **When** the suite runs, **Then** an assertion verifies its endpoint URL is exactly the production MCP endpoint, even though that field is exempt from the byte-match drift assertion.
4. **Given** the retirement of the M2 single-bundle agreement check, **When** the suite runs, **Then** no test still depends on the retired M2 assembly path, and the new drift test is wired into the same always-run suite (the deterministic first-run test set CI already executes).

---

### User Story 4 - Rehearsals exercise the actual shipping artifact (Priority: P3)

A maintainer runs the 029/030 rehearsal harness or matrix runner. By default it now installs the real shipping bundle from `distribution/claude-plugin` (not the M2 rehearsal assembly), with the MCP endpoint still overridable to the dev server via the existing throwaway-copy templating — so what gets rehearsed is byte-for-byte what gets published, minus only the endpoint field. The M2 `assemble-bundle.mjs` and its committed `assembled-bundle/` output are retired; `publish.mjs` is the single generator.

**Why this priority**: Fulfils promotion-note obligation 4 (the harness `--bundle` default moves to the shipping bundle). Depends on US1–US3 existing; rehearsal value is real but the harness already works against the M2 bundle in the interim.

**Independent Test**: Run the rehearsal harness with no `--bundle` argument against the dev server — it installs from `distribution/claude-plugin`, templates a throwaway copy with the dev endpoint, never mutates the source bundle, and completes a graded rehearsal.

**Acceptance Scenarios**:

1. **Given** no `--bundle` argument, **When** the harness runs, **Then** the bundle installed into the scratch client comes from `distribution/claude-plugin`, and an explicit `--bundle <dir>` still overrides it.
2. **Given** a harness run pointed at the dev server, **When** the throwaway bundle copy is templated with the dev endpoint, **Then** the source bundle under `distribution/` is verifiably unmutated (the existing source-integrity check keeps passing).
3. **Given** the retirement of `test/first-run/assemble-bundle.mjs` and `test/first-run/assembled-bundle/`, **When** the full deterministic first-run suite runs, **Then** it is green with no references to the retired paths.

---

### User Story 5 - The install one-liners reach users on every public surface (Priority: P3)

A developer evaluating Squire Docs lands on the site. The landing page has a "works with your coding agent" block with the install one-liners; the documentation page for agents and MCP has a per-ecosystem install section; and the served `agents.md` leads its Claude Code path with the plugin install as the recommended route while keeping the raw `claude mcp add` one-liner for every other MCP client. All three surfaces carry the same commands, in the honest-confident voice, saying "Squire Docs" in user-facing copy.

**Why this priority**: The surfaces are how anyone discovers the plugin, but they must not go live before the mirror repos exist (see Sequencing), and they depend on the bundle's final install commands being settled (US1).

**Independent Test**: Build the client; inspect the built landing page, documentation page, and served agents.md; verify the identical plugin one-liner appears on all three, the `claude mcp add` path survives for other clients, and the documentation build's terminology gate passes.

**Acceptance Scenarios**:

1. **Given** the served `agents.md`, **When** a Claude Code user (or their agent) reads the Connect section, **Then** the plugin route (`/plugin marketplace add squiredocs/squire-plugin` then `/plugin install squire`) leads as the recommended path, includes the may-need-restart-after-install caveat, and the raw `claude mcp add` one-liner remains for other Claude CLI contexts and MCP clients — with the existing in-session agent guidance (don't run config commands mid-session) preserved coherently.
2. **Given** the documentation site source, **When** the site builds, **Then** the agents-and-MCP page contains a per-ecosystem install section mirroring the same one-liners, and the build's validation and terminology gates pass.
3. **Given** the landing page, **When** it renders, **Then** a "works with your coding agent" block presents the install one-liners in the honest-confident voice with "Squire Docs" naming.
4. **Given** all three surfaces, **When** their command strings are compared, **Then** the plugin install commands are textually identical across surfaces (no wording drift between surfaces).

---

### Edge Cases

- **Shared content with YAML frontmatter**: the generated-file header must be inserted after any leading frontmatter block (frontmatter must stay first for the client to honor it), and the drift test must re-derive with the exact same transform — the M2 transform (`withGeneratedHeader`) is the proven reference behavior.
- **Publish invoked without mirror access**: `publish.mjs` with the publish flag but missing/unreachable mirror targets must fail closed with a clear message and zero partial side effects; the default (no flag) mode must never require network or credentials.
- **Upstream schema changes**: the manifest JSON schemas are pinned locally so validation is deterministic and offline in CI; a documented refresh path exists for when the ecosystems revise their schemas.
- **Version not bumped**: publishing content changes without a semver bump would ship an update users' clients may not pick up coherently; the publish path must detect a content-changed-but-version-unchanged state against the mirror and refuse.
- **Endpoint exemption abuse**: the drift exemption covers only the endpoint URL field of the claude-plugin `.mcp.json`; every other byte of that file is still asserted, and the committed value is separately pinned to production — a dev URL can never ship silently.
- **Validator agent unavailable** (CI, offline pod): schema validation is the authoritative gate; the plugin-dev validator is best-effort advisory and its absence must not block generation or CI.
- **Surfaces live before mirrors exist**: if the site deploys the plugin one-liner before Sam creates and pushes the public mirror, users get a broken instruction. This is a deploy-sequencing constraint (see Sequencing), not a code guard.
- **Server key mismatch**: the `.mcp.json` server key must remain `squire` — the served agents.md, onboard flow ("pick the squire server in /mcp"), and harness all key off it; a rename would break the coached flow.

## Requirements *(mandatory)*

### Functional Requirements

**The distribution tree (US1)**

- **FR-001**: The repository MUST contain `distribution/claude-plugin/` as the real shipping Claude Code plugin bundle with exactly the design's layout: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, `skills/squire/SKILL.md`, `commands/onboard.md`.
- **FR-002**: `plugin.json` MUST use manifest name `squire` (per design D2, so commands namespace as `/squire:...`), a valid semver version, and display/listing copy that says "Squire Docs" in the honest-confident voice.
- **FR-003**: `marketplace.json` MUST define Squire's own marketplace in the same bundle such that, once mirrored, `/plugin marketplace add squiredocs/squire-plugin` followed by `/plugin install squire` installs the plugin. Its listing copy MUST be production copy (no rehearsal framing).
- **FR-004**: `.mcp.json` MUST register the remote server under the key `squire` as a streamable-HTTP entry pointing at `https://squiredocs.com/mcp` — the key MUST match the name used by the served agents.md one-liner and the onboard flow's `/mcp` coaching.
- **FR-005**: `skills/squire/SKILL.md` and `commands/onboard.md` MUST be generated from `distribution/shared/skill.md` and `distribution/shared/onboard.md` respectively: byte-faithful content plus a do-not-hand-edit header (naming the shared source and the regeneration command) inserted after any leading frontmatter.
- **FR-006**: The feature MUST NOT rewrite the content of `distribution/shared/skill.md` or `distribution/shared/onboard.md` — they are the M2-signed-off source of truth and are only consumed.
- **FR-007**: The repository MUST contain `distribution/mcp-registry/server.json` describing `com.squiredocs/mcp` for the Official MCP Registry: the remote streamable-HTTP endpoint with OAuth, conforming to the registry's server schema, with no package/stdio artifacts.

**The publish mechanism (US2)**

- **FR-008**: `distribution/publish.mjs` MUST regenerate every wave-1 bundle from `distribution/shared/` deterministically — identical inputs produce byte-identical outputs — and MUST expose its expected-file derivation programmatically so the drift test and the harness compute from the same single source.
- **FR-009**: `publish.mjs` MUST validate each bundle against the applicable manifest JSON schemas as the authoritative gate: any violation exits non-zero naming the offending file and problem.
- **FR-010**: The JSON schemas used for validation MUST be pinned in-repo so validation is offline and deterministic (CI-safe), with a documented refresh path for upstream schema updates.
- **FR-011**: `publish.mjs` MUST attempt the plugin-dev validator agent where available and treat its absence as a reported warning, never a failure; the implementation MUST NOT depend on a first-party `claude plugin validate` CLI verb (none exists).
- **FR-012**: `publish.mjs` MUST support a publish mode — explicit opt-in flag plus configured mirror targets — that commits and pushes each mirror repo with a generated message referencing the source commit; without the flag it MUST be a side-effect-free generate-and-validate run. Tests and CI MUST never exercise the push path; actually running a publish is a Sam operation.
- **FR-013**: The publish path MUST refuse to push a mirror whose content would change while the manifest version is unchanged (the design's bump-on-any-change rule enforced at the moment it matters).

**The drift guard (US3)**

- **FR-014**: A deterministic repo test MUST assert that every generated file in `distribution/claude-plugin/` and `distribution/mcp-registry/` byte-matches what `publish.mjs` regenerates from `shared/`, and it MUST run in the always-run CI suite (the deterministic first-run test set wired into `npm run test:first-run`).
- **FR-015**: The `.mcp.json` endpoint URL field MUST be exempt from the byte-match drift assertion (it is the one field the rehearsal harness overrides per-run); all other content of `.mcp.json` remains asserted.
- **FR-016**: A separate assertion MUST pin the committed `.mcp.json` endpoint to exactly `https://squiredocs.com/mcp`, so the exemption cannot let a non-production endpoint ship.
- **FR-017**: The M2 single-bundle agreement check MUST be retired or replaced by the new drift test with no loss of coverage; no surviving test may depend on the retired M2 assembly path.

**The harness switch (US4)**

- **FR-018**: The rehearsal harness's default `--bundle` MUST become `distribution/claude-plugin`; an explicit `--bundle <dir>` MUST still override it, and the matrix runner MUST inherit the same default.
- **FR-019**: The harness MUST retain its dev-endpoint override via the existing throwaway-copy templating, and the existing source-bundle-never-mutated integrity check MUST keep holding against the new source location.
- **FR-020**: `test/first-run/assemble-bundle.mjs` and the committed `test/first-run/assembled-bundle/` MUST be retired; every consumer (harness, agreement check, matrix runner, docs/comments) MUST be migrated to `publish.mjs`'s programmatic interface or removed.
- **FR-021**: The full deterministic first-run suite MUST pass after the switch.

**The install surfaces (US5)**

- **FR-022**: The served `agents.md` (`client/public/agents.md`) MUST lead its Claude Code connect path with the plugin install route (`/plugin marketplace add squiredocs/squire-plugin`, `/plugin install squire`) as the recommended route, retain the raw `claude mcp add` one-liner for other Claude CLI contexts and MCP-native clients, and keep the existing in-session agent guidance (config commands don't take effect mid-session) coherent with the new leading path.
- **FR-023**: The plugin route on every surface that carries it MUST include the restart-after-install caveat (the client may need a restart before `/squire:onboard` appears) per the design's command-availability finding.
- **FR-024**: `documentation/agents-and-mcp.md` MUST gain a per-ecosystem install section mirroring the same one-liners, and the documentation build (including its validation and terminology gates) MUST pass.
- **FR-025**: The landing page (`client/public/landing.html`) MUST gain a "works with your coding agent" block presenting the install one-liners in the honest-confident voice.
- **FR-026**: All user-facing copy across the bundle and surfaces MUST say "Squire Docs" (the product-name standard); the bare manifest name `squire` appears only where it is namespacing, not copy.
- **FR-027**: The plugin install command strings MUST be textually identical wherever they appear (bundle docs, agents.md, documentation page, landing page) — cross-surface wording drift is a defect.

**Boundaries and handoff (cross-cutting)**

- **FR-028**: The feature MUST NOT perform any actual publishing: no pushes to mirror repos, no registry publish, no directory submissions, no DNS changes. The Sam-only operations MUST be recorded as a handoff checklist (in this spec's Sam-Only Operations section, carried into promotion notes at implement time).
- **FR-029**: The feature MUST NOT create wave-2/3 channel directories (`kiro-power/`, `cursor-plugin/`, `gemini-extension/`, `codex-plugin/`) or their manifests — those are follow-on features (033+); the design's full `distribution/` layout is reached incrementally.
- **FR-030**: The served agents.md content MUST be written to match the *intended* Agent Surface (MCP) contract amendment (plugin one-liner as the recommended Claude Code route); the design-doc amendment itself is orchestrator work and MUST be flagged as an owed step, never performed by this feature.

### Key Entities

- **Shipping plugin bundle** (`distribution/claude-plugin/`): the self-contained, installable Claude Code plugin — manifests, MCP config, generated skill and command. The unit that gets mirrored, rehearsed, validated, and published.
- **Plugin manifest** (`plugin.json`): name `squire`, semver version, "Squire Docs" listing copy. The version is the update signal for every downstream ecosystem.
- **Marketplace manifest** (`marketplace.json`): makes the same public repo its own marketplace — the zero-review day-one install path.
- **MCP connection config** (`.mcp.json`): the single remote-server entry (`squire` → production endpoint). Its endpoint URL is the one drift-exempt, harness-overridable field.
- **Registry server entry** (`distribution/mcp-registry/server.json`): `com.squiredocs/mcp` — the wave-1 baseline that subregistries mirror.
- **Shared content** (`distribution/shared/{skill.md,onboard.md}`): M2's signed-off canonical content; read-only input to generation.
- **Publish script** (`distribution/publish.mjs`): the single generator + validator + (Sam-run) mirror pusher; also the programmatic source of expected bundle bytes.
- **Drift guard**: the CI test asserting bundles ≡ regeneration from shared, endpoint field exempted, production endpoint pinned.
- **Rehearsal harness** (`test/first-run/rehearsal-harness.mjs` + matrix runner): now defaulting to the shipping bundle; the throwaway-copy endpoint templating is its dev-server bridge.
- **Install surfaces**: served `agents.md`, `documentation/agents-and-mcp.md`, `client/public/landing.html` — the three places users meet the one-liners.
- **Mirror repos** (external, `github.com/squiredocs/squire-plugin`): build artifacts receiving generated pushes; created and credentialed by Sam.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From a pristine Claude Code configuration, a user (or the rehearsal harness standing in for one) can go from the published two-command install to a session with the Squire server registered, the skill loaded, and `/squire:onboard` invocable — using only commands that appear verbatim on the public surfaces.
- **SC-002**: The artifact rehearsed by the harness and the artifact staged for publishing are the same bytes (endpoint field aside): zero divergence is possible without a failing CI run.
- **SC-003**: A one-byte hand-edit to any generated bundle file is caught by the standard CI suite on the next run, with the failure naming the file and the regeneration command.
- **SC-004**: A full generate-and-validate run of the publish script completes offline (no network) and reports an unambiguous pass/fail per bundle.
- **SC-005**: The plugin install instructions appear on all three public surfaces with textually identical command strings, and the documentation build's existing quality gates stay green.
- **SC-006**: Sam receives a handoff checklist sufficient to execute every wave-1 external operation (mirror repos, registry publish, directory submission) without further code changes — "ready to submit" per the design's M3 exit.
- **SC-007**: The full deterministic first-run suite and the client build pass after the harness switch and surface edits, with the retired M2 assembly path fully absent.

## Out of Scope (follow-on)

- **Wave 2 channels** — Kiro Powers (`kiro-power/`), Cursor Marketplace (`cursor-plugin/`): later features (033+), pending the design's open question on Cursor's verified-listing requirements.
- **Wave 3 channels** — Gemini CLI extension, OpenAI Codex, MCP aggregators batch: later features.
- **Any actual publish/push/submission** — see Sam-Only Operations below.
- **Agent Surface (MCP) design-doc amendment** (plugin one-liner + signup line into the contract): orchestrator work, flagged as owed (FR-030; promotion-note obligation 1).
- **`docs/dev.md` first-run tooling refresh** (promotion-note obligation 6): docs pass owed by the orchestrator — this feature's agents cannot edit `docs/dev.md`. The harness-default change in US4 makes the drift worse, so the docs pass should land with this feature's merge.
- **Channel-status table updates** in the design doc (Not started → Ready to submit / Listed): design-doc edits, orchestrator/Sam work as submissions land.

## Sam-Only Operations (handoff checklist)

External-identity operations this feature documents but never performs:

1. **Mirror repos**: create `github.com/squiredocs/squire-plugin` under the existing `squiredocs` org (org exists, empty — design D1) and grant push access to the publishing environment; then run the first real `publish.mjs` publish.
2. **MCP Registry**: DNS challenge for `mcp-publisher` domain verification — Sam grants temporary Route 53 access for the TXT record when this step is reached (per design, the challenge itself need not be hands-on) — then run the first registry publish of `server.json`.
3. **Community directory**: submit via the Console form (free individual account); confirm at submission the directory accepts signup-on-first-use remote OAuth servers (design open question) and any naming constraints.
4. **Deploy sequencing** (see below): deploy 030+031 to prod, then push mirrors, then deploy the site surfaces.

## Sequencing

- **Publish gate (Sam op, not a code dependency)**: the published plugin points at production `squiredocs.com/mcp`. The tuned first-run flow (030) and the consent collapse (031) MUST be deployed to prod **before** any actual publish or submission — otherwise the marketplaces' first users get the pre-collapse, pre-tuning experience the design explicitly forbids shipping first.
- **Surface-vs-mirror ordering**: the site surfaces advertise `/plugin marketplace add squiredocs/squire-plugin`, which only works once the mirror repo exists and is pushed. The surface changes merge with this feature but their **deploy** should follow the mirror push (deploys are Sam's; the checklist orders it).

## Assumptions

- `distribution/shared/` content is final per M2's sign-off; any content change during M3 would go back through the M2 harness, not be made ad hoc here.
- The M2 rehearsal assembler's manifest shapes and generated-header transform (`test/first-run/assemble-bundle.mjs`) are the proven reference behavior for the real bundle's shapes — carried forward into `publish.mjs`, not reinvented (marketplace/plugin manifest skeletons, `squire` server key, header-after-frontmatter transform).
- The rehearsal harness's existing throwaway-copy endpoint templating (verified present in `test/first-run/rehearsal-harness.mjs`) satisfies the design's "MCP endpoint indirection" requirement without depending on client-side env interpolation in `.mcp.json` (see RBD-1 in the clarifications ledger).
- CI's `test:first-run` job (`.github/workflows/test.yml`) is the always-run home for the drift test; no new CI job is needed.
- The public GitHub org is `squiredocs` (design D1, done); the mirror repo name is `squire-plugin` per the design's layout comment.
- No server/runtime code changes are needed: the bundle, registry entry, publish script, tests, and three static/built surfaces are the entire footprint.

## Flagged Gaps & Discrepancies vs. Code/Design

- **Design repo-layout shows all channel dirs**: the design's `distribution/` tree lists wave-2/3 directories; this feature deliberately creates only the wave-1 subset (FR-029). Not a contradiction — the milestones and D3 waves make the layout incremental — recorded to preempt a converge-time false gap.
- **Env-interpolation verification (design "M3 indirection")**: the design asks to verify whether Claude Code's `.mcp.json` supports env interpolation, with throwaway-copy templating as the fallback. Repo reality: the fallback is already built, proven, and integrity-checked in the harness. Default taken: keep the templating mechanism and skip a dependency on client interpolation behavior (RBD-1).
- **`docs/dev.md` already stale re first-run tooling** (030 promotion note 6) and gets staler with US4's harness-default change; this feature's agents are barred from editing it — orchestrator docs pass owed at merge time (constitution I).
- **Agent Surface doc amendment owed** (plugin one-liner + signup line): orchestrator work; served agents.md is written here to the intended contract so the amendment is a doc catch-up, not a content change (FR-030).
