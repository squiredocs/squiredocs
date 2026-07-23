# Implementation Plan: Wave 2 Distribution Channels — Kiro Power + Cursor Plugin

**Branch**: `033-wave2-channels` | **Date**: 2026-07-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/033-wave2-channels/spec.md`

**Design ground truth**: `design/plugin-marketplace-publishing.md` (ratified 2026-07-21), milestone **M3 "Packaging and distro wrappers", wave 2**: channels §3 (Kiro Powers) and §4 (Cursor Marketplace), plus "One server, many storefronts", the Repo layout, "Website and docs surface", and "Publish and release process". Format ground truth: `specs/033-wave2-channels/research-inputs/kiro-power-format.md` and `cursor-plugin-format.md` (researched + cited 2026-07-22; Cursor manifest schema re-verified against `https://raw.githubusercontent.com/cursor/plugins/main/schemas/plugin.schema.json` on 2026-07-23). Clarifications resolved as 9 RATIFIED-BY-DEFAULT decisions in [clarifications-needed.md](./clarifications-needed.md) (Sam pre-authorized, 2026-07-22). This feature is a direct extension of **032-packaging-distribution** — same generator, same drift guard, same security posture.

## Summary

Add the two wave-2 distribution bundles — a **Kiro Power** at `distribution/kiro-power/` and a **Cursor plugin** at `distribution/cursor-plugin/` — to the existing single generator/validator/(Sam-run)pusher `distribution/publish.mjs`, by adding two channel descriptors to the `CHANNELS` registry (the RBD-3 promise of wave 1: wave 2 is "add a descriptor", not a rearchitecture). Each bundle is fully generated from `distribution/shared/` plus channel-specific derivations, never hand-edited; each versions independently starting at `1.0.0`; each mirrors to its own public repo behind its own `SQUIRE_MIRROR_*` env var. The feature vendors the upstream Cursor plugin manifest schema, adds hand-rolled structural validators for the Cursor manifest + `.mdc` rule + Kiro POWER.md/mcp.json (ajv remains absent — the wave-1 constraint stands), extends the always-run drift + publish-mechanism tests to cover all four channels, exports a pure Add-to-Cursor deeplink helper, and surfaces both channels honestly on the landing page and the documentation site. It publishes **nothing** — pushing stays a Sam-only op behind `--publish` + configured remotes.

The one wave-1 refactor this feature owns (spec Gap #2, FR-017): **generalize the publish version-bump guard's version-carrier lookup**. Today `diffAgainstMirror` hardcodes `versionRel` to `.claude-plugin/plugin.json` / `server.json` by channel id. Kiro has no JSON manifest — its version rides in POWER.md YAML frontmatter (RBD-2, fallback a bundle-root `VERSION` file) — and Cursor's rides in `.cursor-plugin/plugin.json`. Each channel descriptor gains a declared version-carrier (a `readVersion(files)` function, with `versionRel` as the JSON-manifest convenience form it wraps) so the guard reads the right carrier per channel **without weakening** any of its refusals (content-change-without-bump, non-forward bump, present-but-unreadable mirror version).

No server/runtime change, no migration, no new production dependency, no new CI job. The footprint is the `distribution/` tree (two new bundles + one vendored schema + generator/validator edits), the two always-run tests, and two static/built surfaces (`client/public/landing.html` + `marketing.css`, `documentation/agents-and-mcp.md`).

## Technical Context

**Language/Version**: Node.js (ESM `.mjs`, `node:test`), same runtime as the existing `distribution/publish.mjs` and `test/first-run/*.mjs` tooling. No new language.

**Primary Dependencies**: Node core only — `node:fs`, `node:path`, `node:child_process` (git in the publish path), `node:buffer` (`Buffer.from(...).toString('base64')` for the deeplink). JSON-schema validation stays the self-contained structural validator (ajv is NOT resolvable in this repo's dependency tree — re-confirmed unchanged from 032's T002 probe; SOURCES.md records it). No network dependency in the default path. YAML frontmatter parsing for POWER.md / `.mdc` reuses the same minimal regex-based frontmatter extraction the drift test already carries (`^---\n...\n---\n`) — no YAML library added.

**Storage**: Files only. `distribution/` tree (two new bundle dirs + one vendored schema), no DB, no migrations (confirmed: no schema change, no runtime state).

**Testing**: `node --test` under `npm run test:first-run` (the always-run deterministic CI suite). The drift guard (`test/first-run/bundle-drift.test.mjs`) and publish-mechanism suite (`test/first-run/publish-mechanism.test.mjs`) are extended to cover the two new channels; the deeplink round-trip + cross-surface deeplink checks are new assertions in the always-run suite. Site/doc surfaces ride the existing Vitest documentation-build test + terminology gate and the existing `install-surfaces.test.mjs` cross-surface pattern. No new CI job.

**Target Platform**: Repo tooling / CI (Linux dev pod). The shipped artifacts target the Kiro Powers ecosystem (POWER.md + mcp.json + steering) and the Cursor Marketplace (`.cursor-plugin/plugin.json` + rules + skills + mcp.json). Neither Kiro IDE nor Cursor is installed in the dev pod — the format research is the buildable stand-in; real verification is Sam's submission walk (SC-005).

**Project Type**: Repo tooling + static/built content surfaces. Not a server feature — no `server/` or runtime change.

**Performance Goals**: N/A — determinism is the property that matters: identical `shared/` inputs produce byte-identical bundle outputs, so the drift test is stable across all four channels.

**Constraints**: Default `publish.mjs` run MUST stay offline and side-effect-free. Push path MUST remain prod-pinned (no endpoint parameter), fail-closed without configured remotes, and never be exercised against a real remote (bare-repo fixtures only, real `SQUIRE_MIRROR_*` stripped). Each channel's `mcp.json` endpoint field is its sole drift exemption; committed value pinned to `https://squiredocs.com/mcp`. The deeplink string MUST be byte-identical on every surface and derived from `PROD_ENDPOINT`. Adding the two channels MUST NOT change the generated bytes of the two wave-1 channels. `distribution/shared/{skill.md,onboard.md}` are READ-ONLY.

**Scale/Scope**: Two new channel directories (`kiro-power/`, `cursor-plugin/`), ~9 new generated bundle files, one vendored schema + SOURCES.md entry, three new structural validators, one deeplink helper, the version-carrier generalization, two extended always-run tests + new deeplink/cross-surface assertions, two surface edits (landing + documentation). Wave-3 channels (Gemini/Codex/aggregators) explicitly out of scope (FR-033).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Documentation Reflects Reality** — `README.md`/`docs/dev.md`/`design/*` cannot be edited by this feature's agents (assignment override + Principle VI). `docs/dev.md` may need a wave-2 touch if the publish/harness docs reference channel count — **carried to the merge-queue docs pass** (orchestrator). No new violation introduced here; the owed doc updates (design channel-status ledger, Agent Surface amendment, `docs/dev.md`) are flagged as owed, never resolved ad hoc. **PASS (with flagged owed items).**
- **II. Test-Backed Changes** — every behavioral change is test-backed: the new bundles are guarded by the extended drift test (byte-match + extra-file guard over all four channels, FR-024); the version-carrier generalization + push path are covered by the extended publish-mechanism suite against bare-repo fixtures (FR-026); the deeplink helper by a round-trip assertion (FR-025) and a cross-surface check (FR-029); the site/doc copy by the documentation-build + terminology gate. Suite is `node --test` / Vitest, serial-safe (no DB). **PASS.**
- **III. Trunk-Based Solo Workflow** — stay on `main`, never branch, never commit (assignment override). No new ceremony; the two descriptors + version-carrier field are the minimum the design's incremental-waves model requires, not speculative scaffolding (RBD-3, YAGNI). **PASS.**
- **IV. Collaboration-Safe Document Operations** — N/A: no live-document mutation, no Yjs, no format-registry change. **PASS (not applicable).**
- **V. Secure by Default** — the security-load-bearing surface is again the publish path, and the invariant is **no regression** of the 032 review HIGH fixes as the channel count doubles: dry-run default with zero side effects; `--publish` fail-closed naming all four env vars; push path prod-pinned with no endpoint parameter; `--publish` mutually exclusive with `--out`/non-prod `--endpoint`; no committed default remotes; mirror working-tree pruned before staging; drift compares committed-bytes-vs-in-memory + extra-file guard; tests strip real `SQUIRE_MIRROR_*` and assert configured==fixture-count. The version-carrier generalization is the one place a hole could open (FR-017) — it MUST NOT let a content-change-without-bump slip through for any channel. Treated as the highest-risk area; see research.md §Security posture. No new auth/ACL/ingestion surface. **PASS — highest-risk area, guarded by unchanged-posture assertions.**
- **VI. Design Docs Are Ground Truth** — plan follows `design/plugin-marketplace-publishing.md` M3 wave-2 (§3/§4). The one place the design and research diverge — §3's "Add to Kiro button on our site" — is falsified by research (no embeddable Kiro deeplink exists); the spec follows research (repo link + import steps) and the design amendment is flagged as owed orchestrator work (Gap #1), never silently resolved. The design's repo-layout comment mapping `cursor-plugin/` to "per cursor.com/marketplace/publish template" is superseded by the real `cursor/plugins` schema (marketplace shipped after the design's sources) — shapes follow research, recorded in Flagged Gaps #7. The Agent Surface amendment (agents.md wave-2 paths) and the channel-status-ledger update are flagged as owed. **PASS (with flagged design amendment owed).**

**Initial gate: PASS.** No violations requiring Complexity Tracking. Re-checked post-design (Phase 1) below.

## Project Structure

### Documentation (this feature)

```text
specs/033-wave2-channels/
├── plan.md              # This file
├── research.md          # Phase 0 output — version-carrier design, schema vendoring, deeplink, security no-regression
├── data-model.md        # Phase 1 output — channel descriptor, both bundles, vendored schema, deeplink, env vars
├── quickstart.md        # Phase 1 output — runnable validation (regen, drift, publish fixtures, deeplink, surfaces)
├── contracts/           # Phase 1 output — publish.mjs API deltas + Kiro/Cursor manifest field contracts
├── clarifications-needed.md   # 9 RBDs (exists)
├── checklists/requirements.md # (exists)
├── research-inputs/           # kiro-power-format.md + cursor-plugin-format.md (exists — buildable ground truth)
└── tasks.md             # /speckit-tasks output (next stage)
```

### Source Code (repository root)

```text
distribution/
├── shared/                           # M2 source of truth — READ-ONLY (FR-015), unchanged
│   ├── skill.md
│   └── onboard.md
├── claude-plugin/                    # wave-1 bundle — UNCHANGED (adding wave-2 must not alter its bytes)
├── mcp-registry/                     # wave-1 bundle — UNCHANGED
├── kiro-power/                       # NEW — Kiro Power bundle (FR-001), fully generated
│   ├── POWER.md                      # frontmatter (name/displayName/description/keywords[]/author + version: 1.0.0)
│   │                                 #   + ordered body incl. License and Support (FR-002/003/008)
│   ├── mcp.json                      # squire-docs → https://squiredocs.com/mcp, type:http, no oauth (FR-004; endpoint drift-exempt)
│   └── steering/                     # Kiro-native reframing of shared/ (FR-005/006/007, split per RBD-7)
│       ├── specs-sync-workflow.md    #   the standing loop + byte channel + token rules + onboarding-as-prose
│       └── working-with-squire-docs.md  # what the doc is: two-way sync, attribution, revertibility
├── cursor-plugin/                    # NEW — Cursor plugin bundle (FR-009), fully generated
│   ├── .cursor-plugin/plugin.json    # schema-valid manifest, name squire-docs, version 1.0.0 (FR-010)
│   ├── mcp.json                      # squire-docs → bare url, NO type field (FR-011; endpoint drift-exempt)
│   ├── rules/squire-spec-loop.mdc    # Agent-Requested rule: description set, alwaysApply:false (FR-012)
│   ├── skills/squire/SKILL.md        # from shared/skill.md near-verbatim + generated header (FR-013)
│   ├── LICENSE                       # MIT, same single-source license text as wave 1 (FR-014)
│   └── README.md                     # what it is / what install does / OAuth behavior / ground-truth note (FR-014)
├── schemas/
│   ├── SOURCES.md                    # EDIT — add the vendored Cursor schema entry (FR-020)
│   ├── plugin.schema.json            # existing hand-authored Claude schema — untouched
│   ├── marketplace.schema.json       # existing — untouched
│   ├── server.schema.json            # existing — untouched
│   └── cursor-plugin.schema.json     # NEW — vendored verbatim from cursor/plugins (distinct filename, FR-020)
└── publish.mjs                       # EDIT — two CHANNELS descriptors, version-carrier generalization (FR-017),
                                      #   Cursor/Kiro/mdc validators (FR-021/022/023), deeplink helper (FR-019)

test/first-run/
├── bundle-drift.test.mjs             # EDIT — generalize the guard over CHANNELS; cover both new bundles + deeplink pin (FR-024/025)
├── publish-mechanism.test.mjs        # EDIT — exercise push + version guard for a new channel via bare-repo fixtures (FR-026)
└── install-surfaces.test.mjs         # EDIT (or sibling) — cross-surface deeplink byte-identity (FR-029)

client/public/
├── landing.html                      # EDIT — Add-to-Cursor button + Kiro repo-import section (FR-027)
└── marketing.css                     # EDIT — styles for the new controls if needed (FR-027)

documentation/
└── agents-and-mcp.md                 # EDIT — per-ecosystem Cursor + Kiro install sections (FR-028), manual snippet retained
```

**Structure Decision**: Repo tooling + static/built content surfaces (same as 032). All new code lands in the existing `distribution/` tree and `test/first-run/` suite; the two surface edits are the landing page and the documentation source. No `src/`, `server/`, or migration footprint. The channel-registry structure from wave 1 is the extension point — the two new bundles are descriptors, and the only structural change to shared machinery is the version-carrier generalization (FR-017), which is additive to the descriptor shape.

## Complexity Tracking

> No Constitution Check violations — this table is intentionally empty.

The version-carrier generalization (FR-017) is a refactor of existing wave-1 machinery, not added complexity: it removes a hardcoded two-channel `versionRel` branch and replaces it with a per-descriptor declaration, which is strictly simpler as channel count grows and is the mechanism the guard needs to cover Kiro (no JSON manifest) correctly. It is covered by the extended publish-mechanism suite so the guard's refusals are proven intact for the new carrier.

## Post-Design Constitution Re-Check (Phase 1)

Re-evaluated after research.md + data-model.md + contracts/ + quickstart.md:

- **V. Secure by Default** — the version-carrier generalization is designed so the guard's three refusals are carrier-agnostic (they compare fresh-vs-mirror version read through the same `readVersion` for both sides, and treat a present-but-unreadable mirror carrier as refuse, never first-publish). The contract (contracts/publish-api.md) pins `readVersion` as total (returns a version string or throws → refuse). The extended publish-mechanism test asserts a content-change-without-bump refusal for a NEW channel (Kiro, whose carrier is POWER.md frontmatter) and asserts configured==fixture-count with real `SQUIRE_MIRROR_*` stripped. No 032 HIGH fix is touched. **PASS.**
- **VI. Design Docs Are Ground Truth** — design amendment for §3 remains owed (flagged, orchestrator); no design file edited. **PASS.**
- All other principles unchanged from the initial gate. **Post-design gate: PASS.**

