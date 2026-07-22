# Implementation Plan: Packaging & Distribution — M3 Wave 1

**Branch**: `032-packaging-distribution` | **Date**: 2026-07-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/032-packaging-distribution/spec.md`

**Design ground truth**: `design/plugin-marketplace-publishing.md` (ratified 2026-07-21), milestone **M3 "Packaging and distro wrappers", wave 1 only**. Clarifications resolved as RBD-1..7 in [clarifications-needed.md](./clarifications-needed.md), all RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22).

## Summary

Build everything up to "ready to submit": the real, publishable Claude Code plugin bundle at `distribution/claude-plugin/`, the MCP-registry `server.json` at `distribution/mcp-registry/`, the single generator/validator/pusher `distribution/publish.mjs`, a CI drift guard that byte-matches the committed bundles to a fresh regeneration from `distribution/shared/`, the rehearsal-harness switch to the shipping bundle, and the three public install surfaces (served `agents.md`, `documentation/agents-and-mcp.md`, landing page). The feature performs **no actual publishing** — pushing is gated behind an explicit `--publish` flag + configured remotes (dry-run by default, RBD-6) and remains a Sam-only op. The M2 rehearsal assembler (`test/first-run/assemble-bundle.mjs`, `assembled-bundle/`, `check-bundle-agreement.mjs` + its test) is retired; `publish.mjs` becomes the single generator, exporting the same programmatic `expectedFiles`/`assembleBundle` API the harness and drift test consume (RBD-2).

Technical approach: carry the proven M2 shapes and `withGeneratedHeader` transform verbatim into `publish.mjs` (spec Assumption; do not reinvent), extend them to (a) a real `1.0.0` version (RBD-5), (b) production listing copy (no rehearsal framing), (c) the `mcp-registry/server.json` channel, and (d) vendored/pinned manifest JSON schemas validated offline (RBD-4). Structure `publish.mjs` around a channel registry so wave-2/3 channels (033+) add a generator entry rather than a rearchitecture (RBD-3). No server/runtime code changes — the footprint is the `distribution/` tree, the pinned schemas + tooling, the tests, and three static/built surfaces.

## Technical Context

**Language/Version**: Node.js (ESM `.mjs`, `node:test`), same runtime the existing `test/first-run/*.mjs` tooling targets. No new language.

**Primary Dependencies**: Node core only for `publish.mjs` generation/drift (`node:fs`, `node:path`, `node:child_process` for git in the publish path). JSON-schema validation uses a vendored validator already available in the repo dependency tree — **RESOLVED in research.md** (prefer an already-present dependency; fall back to a small vendored/hand-rolled structural validator if none is present, since the schemas are small and pinned). No network dependency in the default path (RBD-4).

**Storage**: Files only. `distribution/` tree (bundles + pinned schemas), no DB, no migrations.

**Testing**: `node --test` under `npm run test:first-run` (the always-run deterministic CI suite, `.github/workflows/test.yml` line 63-64). Client/doc surfaces covered by the existing Vitest documentation-build test (`client/src/__tests__/documentation-build.test.js`) and its terminology gate. No new CI job (spec Assumption).

**Target Platform**: Repo tooling / CI (Linux dev pod). The shipped artifacts target Claude Code (plugin) and the Official MCP Registry (`server.json`); those ecosystems are exercised only at Sam's publish, not in CI.

**Project Type**: Repo tooling + static/built content surfaces. Not a server feature — no `server/` or runtime change.

**Performance Goals**: N/A — determinism is the property that matters: identical `shared/` inputs produce byte-identical bundle outputs (FR-008), so the drift test is stable.

**Constraints**: Default `publish.mjs` run MUST be offline and side-effect-free (no network, no credentials — RBD-6). Push path MUST fail closed without configured remotes and MUST never be exercised by tests/CI (FR-012). Drift test MUST run offline and deterministically. Endpoint field is the sole drift exemption; committed value pinned to `https://squiredocs.com/mcp` (FR-015/016). Cross-surface command strings MUST be textually identical (FR-027).

**Scale/Scope**: Two channel directories this wave (`claude-plugin/`, `mcp-registry/`), five generated bundle files + one registry file, one publish script, ~2 pinned schemas, one drift test, one harness-default switch (+ matrix inheritance), three surface edits. Wave-2/3 channels explicitly out of scope (FR-029, RBD-3).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Documentation Reflects Reality** — `README.md`/`docs/dev.md` cannot be edited by this feature's agents; the design constitution bars it and the assignment confirms it. `docs/dev.md` first-run section is already stale (030 note 6) and US4 makes it staler. **Carried to the merge-queue docs pass** (spec Out-of-Scope; orchestrator work). No new violation introduced by code here; the owed doc update is explicitly flagged, not resolved ad hoc. **PASS (with flagged owed item).**
- **II. Test-Backed Changes** — every behavioral change is test-backed: the drift guard (FR-014, US3) is itself the test for the generator; the harness switch is covered by the first-run suite (FR-021); surface edits ride the documentation-build test + terminology gate (FR-024). Suite is `node --test` / Vitest, serial-safe (no DB). **PASS.**
- **III. Trunk-Based Solo Workflow** — stay on `main`, never branch, never commit (assignment override). No new ceremony; the channel-registry structure is the minimum needed for the design's incremental waves, not speculative scaffolding (RBD-3, YAGNI). **PASS.**
- **IV. Collaboration-Safe Document Operations** — N/A: no live-document mutation, no Yjs, no format-registry change. **PASS (not applicable).**
- **V. Secure by Default** — the security-load-bearing surface here is the publish path: it MUST be impossible to push by default (RBD-6, fail-closed like the dev-endpoint posture the project just adopted in 2b9d6be), the shipped `.mcp.json` MUST never carry a dev endpoint (drift exemption is endpoint-field-only + committed value pinned to prod, FR-015/016), and the bundle MUST ship no dev endpoint or dev-only artifact. No new auth/ACL surface, no ingestion surface. **PASS — treated as the highest-risk area; see research.md §Security posture.**
- **VI. Design Docs Are Ground Truth** — plan follows `design/plugin-marketplace-publishing.md` M3 wave-1 exactly; the one place the design and repo reality diverge (env-interpolation vs throwaway templating for the endpoint) is resolved as RBD-1 with the design's own named fallback, not ad hoc. Wave-2/3 layout omission (FR-029) is recorded as an incremental-layout non-contradiction, not a silent gap. The Agent Surface doc amendment (FR-030) and the design channel-status-table update are flagged as owed orchestrator work, never performed here. **PASS.**

**Initial gate: PASS.** No violations requiring Complexity Tracking. Re-checked post-design (Phase 1) below.

## Project Structure

### Documentation (this feature)

```text
specs/032-packaging-distribution/
├── plan.md              # This file
├── research.md          # Phase 0 output — RBD rationale, schema/validator choice, security posture
├── data-model.md        # Phase 1 output — artifact entities (bundle files, manifests, schemas)
├── quickstart.md        # Phase 1 output — runnable validation (regen, drift, harness, surfaces)
├── contracts/           # Phase 1 output — publish.mjs programmatic API + manifest field contracts
├── clarifications-needed.md   # RBD-1..7 (exists)
├── checklists/requirements.md # (exists)
└── tasks.md             # /speckit-tasks output (next stage)
```

### Source Code (repository root)

```text
distribution/
├── shared/                       # M2 source of truth — READ-ONLY (FR-006), unchanged
│   ├── skill.md
│   └── onboard.md
├── claude-plugin/                # NEW — real shipping Claude Code plugin bundle (FR-001)
│   ├── .claude-plugin/
│   │   ├── plugin.json           # name "squire", version 1.0.0, "Squire Docs" copy (FR-002, RBD-5)
│   │   └── marketplace.json      # own marketplace; production copy (FR-003)
│   ├── .mcp.json                 # squire → https://squiredocs.com/mcp (FR-004; endpoint drift-exempt)
│   ├── skills/squire/SKILL.md    # generated from shared/skill.md (FR-005)
│   └── commands/onboard.md       # generated from shared/onboard.md (FR-005)
├── mcp-registry/
│   └── server.json               # NEW — com.squiredocs/mcp for the Official MCP Registry (FR-007)
├── schemas/                      # NEW — vendored/pinned JSON schemas + provenance (RBD-4, FR-010)
│   ├── plugin.schema.json
│   ├── marketplace.schema.json
│   ├── mcp.schema.json           # (if an upstream schema exists; else structural checks in publish.mjs)
│   ├── server.schema.json        # Official MCP Registry server schema
│   └── SOURCES.md                # upstream URL + retrieval date + refresh procedure per schema
└── publish.mjs                   # NEW — single generator + validator + (Sam-run) pusher (FR-008..013)

test/first-run/
├── rehearsal-harness.mjs         # EDIT — default --bundle → distribution/claude-plugin (FR-018/019)
├── matrix-runner.mjs             # inherits harness default (FR-018) — verify no assembler import
├── matrix-cells.mjs              # verify no assembler import
├── bundle-drift.test.mjs         # NEW — drift guard in test:first-run (FR-014..016), replaces retiree
├── assemble-bundle.mjs           # RETIRED — deleted (FR-020, RBD-2)
├── assembled-bundle/             # RETIRED — deleted (FR-020, RBD-2)
├── check-bundle-agreement.mjs    # RETIRED — deleted; coverage moves to bundle-drift.test.mjs (FR-017)
└── bundle-agreement.test.mjs     # RETIRED — deleted; content-budget checks re-homed (see research.md)

client/public/agents.md           # EDIT — plugin route leads Claude Code path (FR-022/023)
documentation/agents-and-mcp.md   # EDIT — per-ecosystem install section (FR-024)
client/public/landing.html        # EDIT — "works with your coding agent" block (FR-025)
```

**Structure Decision**: Repo-tooling + content-surface layout. All generated/publishable files live under `distribution/` (design principle 2: ground truth here, public repos are build artifacts). `publish.mjs` owns generation, validation, and the gated push; it exports the programmatic `expectedFiles`/`assembleBundle` interface so the harness and the drift test compute expected bytes from one source (FR-008). The retired M2 assembler's proven shapes + `withGeneratedHeader` transform are carried into `publish.mjs` unchanged in behavior; the content-budget checks currently in `check-bundle-agreement.mjs` are re-homed into the new drift test so no coverage is lost (FR-017). Test artifacts stay under `test/first-run/` and ride `npm run test:first-run` (no new CI job).

## Constitution Check — post-design re-evaluation

*Re-checked after Phase 1 (research.md, data-model.md, contracts/, quickstart.md).*

- **I. Documentation Reflects Reality** — unchanged: `docs/dev.md`/`README.md` edits are barred; the owed `docs/dev.md` first-run pass is flagged in the plan, spec Out-of-Scope, and contracts/drift-and-surfaces.md §Owed. **PASS (flagged owed item carried to merge queue).**
- **II. Test-Backed Changes** — the design produced concrete tests: `bundle-drift.test.mjs` (byte-match + endpoint pin + tamper + re-homed budgets), the harness-switch coverage in the first-run suite, the cross-surface command-string check, and the documentation-build/terminology gate for the doc surface. All ride `npm run test:first-run` / Vitest, serial-safe. **PASS.**
- **III. Trunk-Based Solo Workflow** — no branch/commit; the channel-registry structure (RBD-3) is the minimum for incremental waves, justified in research R3 (not speculative). **PASS.**
- **IV. Collaboration-Safe Document Operations** — still N/A (no Yjs/format-registry/live-doc mutation). **PASS.**
- **V. Secure by Default** — the design hardened the highest-risk area: publish is dry-run by default and push is fail-closed behind `--publish` + externally-configured remotes (INV-1); no dev endpoint/artifact ships (INV-2, committed endpoint pinned to prod); the drift test imports expected bytes from `publish.mjs` so it cannot pass on a hand-edited bundle (INV-3). These three invariants are recorded in contracts/publish-api.md and research R10, and the analyze stage treats any violation as HIGH. **PASS.**
- **VI. Design Docs Are Ground Truth** — design followed exactly; RBD-1 uses the design's own named fallback; FR-029 layout omission recorded as incremental non-contradiction; FR-030 Agent Surface amendment + channel-status-table updates flagged as owed orchestrator work, never performed here. **PASS.**

**Post-design gate: PASS.** No violations; Complexity Tracking table stays empty.

## Complexity Tracking

No constitution violations to justify — table intentionally empty. The one structural choice beyond the minimum (channel-registry shape of `publish.mjs`) is not a violation: it is the design's explicit incremental-waves requirement (D3, RBD-3), and it is *less* code than special-casing wave-2/3 placeholders would be.
