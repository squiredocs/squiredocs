# Implementation Plan: Plugin Logic (Plugin M2)

**Branch**: `030-plugin-logic` (work stays on `main` per feature overrides) | **Date**: 2026-07-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/030-plugin-logic/spec.md`

**Design ground truth**: `design/plugin-marketplace-publishing.md` (ratified 2026-07-21), milestone **M2 only**. Agents.md contract owned by `design/agent-surface-mcp.md`. Clarifications ledger: `clarifications-needed.md` (RBD-1..RBD-12).

## Summary

M2 delivers the real plugin coaching content the M1 (feature 029) machinery exists to tune, plus the harness/grader hardening and matrix runner that judge it. Four kinds of work:

1. **Canonical content** — author `distribution/shared/skill.md` (when-to-use-Squire-Docs steering) and `distribution/shared/onboard.md` (the `/squire:onboard` flow) as the single source of truth, restating the Agent Surface (MCP) contract without forking it (FR-001..FR-018).
2. **Rehearsal bundle assembly** — a minimal test-harness-side assembler (`test/first-run/assemble-bundle.mjs`, explicitly NOT `distribution/publish.mjs`) that generates an installable plugin bundle from `distribution/shared/`, guarded by an agreement check; the 029 harness `--bundle` default switches to it (FR-019..FR-021, RBD-1).
3. **Harness + grader hardening** — extend 029's capture to structured tool-call events, rework the grader to anchor performable items to tool-call events and the rehearsal-server origin (closing the quote-vs-perform and incidental-`/d/…` false-PASS vectors), regrade the silent-reconnect item behaviorally, and add the harness cell-enabling extensions (unauthenticated mode, scripted user turns, token-fallback mode, fixture repos) (FR-025..FR-029, FR-032, RBD-2/3/5/6/7/10).
4. **Matrix runner + consent first-run surface** — a single-command 11-cell matrix runner with per-cell expected-outcome profiles that always enforces `--require-claude` (FR-030..FR-033), and a copy-only reframe of `AuthorizePage`'s unauthenticated state into a first-run surface (FR-022..FR-024). The twofold exit gate (clean matrix run + Sam's HITL mechanics-and-tone sign-off) and the M3 obligations ledger are recorded artifacts (FR-034, FR-035).

Nothing is published in M2. No server endpoints, no migrations, no new auth machinery. The only production-app change is the consent page's unauthenticated copy.

## Technical Context

**Language/Version**: Node.js 22+ (ESM `.mjs` test machinery, matching 029's `test/first-run/`); React 18 for the one client change; Markdown for the canonical content files.

**Primary Dependencies**: No new runtime dependencies. Reuses 029's `test/first-run/` machinery (rehearsal-harness, grade-transcript, oauth-chain-driver), the existing dev endpoints (faucet `/auth/dev-login`, `/auth/dev-consent-approve`, `/auth/dev-wipe-user`), the existing `sk_sqd_` token machinery and `create_access_token` claim flow, and `import_markdown_file` (the byte-channel recipe). Client change touches `client/src/pages/AuthorizePage.jsx` + its CSS only.

**Storage**: N/A — no schema change, no migration. (Constitution: migrations go through node-pg-migrate; none needed here.)

**Testing**: Backend Jest (`server/__tests__/`, `__tests__/integration/`, serial, shared DB — constitution II); frontend Vitest (`client/src/**/__tests__/`, run via `npm run test:client`). Deterministic M2 additions join these suites: grader regression fixtures + bundle agreement check (Node, runnable under the backend suite or standalone `node`), and the consent-page unauthenticated-state client test (Vitest). The non-deterministic matrix runner is an on-demand/pre-sign-off gate, NOT per-commit CI (RBD-3).

**Target Platform**: Linux dev pod for rehearsals/matrix (029 FR-024 — macOS Keychain caveat means pristine rehearsals are pod-only); Sam's prod self-test covers the real-browser/macOS half. Consent page renders in the user's browser.

**Project Type**: Web application (React client + Express/Node backend) plus repo-level content + test tooling. This feature is content + test-machinery heavy; the app change is a single client component's copy.

**Performance Goals**: Each rehearsal cell completes within the 029 budget (< 180s, SC-001-shaped); the full 11-cell matrix runs serially and unattended (no concurrency — backend-DB-touching activity is serial, constitution II + spec Edge Cases).

**Constraints**: No new server/dev endpoints beyond M1's set (FR-032, Out of Scope). No new auth path (008/009 lesson — FR-013). `distribution/shared/` is never mutated by assembly or rehearsal (FR-019, endpoint indirection via the harness throwaway-copy mechanism). Token bytes never appear in any transcript (FR-004, RBD-6). Consent copy must not push the primary action below the fold on common mobile viewports (spec Edge Cases). All user-facing copy says "Squire Docs", honest-confident voice (FR-006).

**Scale/Scope**: 2 canonical content files; 1 bundle assembler + 1 agreement check; grader rework + ~3 regression fixtures; 4 harness extensions; 1 matrix runner with 11 cell profiles + 4 fixture repos; 1 client component copy change + 1 client test; 2 recorded exit-gate/M3-obligation artifacts.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Checked against `.specify/memory/constitution.md` v1.1.1.

| Principle | Status | Notes |
|---|---|---|
| **I. Documentation Reflects Reality** | PASS | No behavior/API/workflow change to README/docs/dev.md (feature override forbids editing those anyway). The consent-copy change is user-facing UI, not documented dev behavior. The M3-obligations record (FR-035) and exit sign-off record (FR-034) are feature artifacts, not the core docs. agents.md / documentation-site / landing-page updates are explicitly M3 (Out of Scope). |
| **II. Test-Backed Changes** | PASS | Consent-page change covered by a Vitest client test (FR-024, SC-005); grader hardening covered by regression fixtures in the standard suite (FR-028, SC-003); bundle drift covered by the agreement check (FR-021, SC-004); existing tier-1 backend consent tests stay green (FR-024). Backend additions share one DB and run serially; the matrix runner enforces serial cells (spec Edge Cases). No format-registry/round-trip change (no new marks/nodes). |
| **III. Trunk-Based Solo Workflow** | PASS | Work stays on `main`, no branch, no commit (feature override). No new ceremony: the matrix runner is on-demand, not a new CI job (RBD-3) — it exists because the design's M2 exit criterion demands it, a concrete failure it prevents (a broken model leg reading as a pass). |
| **IV. Collaboration-Safe Document Operations** | PASS | No document-mutation code. The content's sync move uses `import_markdown_file` (byte channel) — targeted, in-place, attributed; it never delete-recreates. Format knowledge stays in the registry (untouched). Provenance/attribution is restated in the content (FR-016), not re-implemented. |
| **V. Secure by Default for Agent & User Content** | PASS | No new endpoints, no new auth path (008/009 lesson — FR-013). Token handling restated per the file-based `~/.squire/token` rule; token bytes never in transcripts (FR-004, RBD-6). The token-fallback cell uses only existing `sk_sqd_` machinery. No new ingestion surface. Dev endpoints reused are M1's, already fail-closed gated behind `ENABLE_DEV_ENDPOINTS`. |
| **VI. Design Docs Are Ground Truth** | PASS | Content restates `design/agent-surface-mcp.md` and `design/plugin-marketplace-publishing.md`, never forks (FR-005, documented cross-check SC-006). Gaps/discrepancies recorded in the ledger as RBD-1..12 (never resolved ad hoc). The deferred Agent Surface signup-line amendment is recorded as an M3 obligation (FR-035, ledger gap 5), NOT hand-edited into the export now. No `design/` export is hand-edited. |

**Gate result: PASS — no violations. Complexity Tracking table not required.**

Design-authority note (matches 029's disposition): the spec/plan name concrete paths (`distribution/shared/skill.md`, `~/.squire/token`), tool/command names (`import_markdown_file`, `/mcp`, `/squire:onboard`), and the matrix-cell list. These are design-doc-mandated product contracts (ground truth per Principle VI), not implementation choices this plan is free to re-decide.

## Project Structure

### Documentation (this feature)

```text
specs/030-plugin-logic/
├── spec.md                      # feature spec (exists)
├── clarifications-needed.md     # RBD-1..12 ledger (exists)
├── plan.md                      # this file
├── research.md                  # Phase 0 — decisions on capture format, harness extensions, grader anchoring
├── data-model.md                # Phase 1 — the M2 entities (content, bundle, checklist, cell profiles, records)
├── quickstart.md                # Phase 1 — how to run the assembler, grader fixtures, and the matrix runner
├── contracts/                   # Phase 1 — the grader checklist contract, cell-profile schema, assembler contract
│   ├── coaching-checklist.md    # the hardened 7-item contract (event-anchored)
│   ├── matrix-cell-profile.md   # per-cell expected-outcome profile schema + the 11 cells
│   └── bundle-assembly.md       # assembler inputs/outputs + agreement-check contract
├── checklists/requirements.md   # spec quality checklist (exists)
├── promotion-notes.md           # Phase-1/implement output — M3 obligations record (FR-035)
└── tasks.md                     # /speckit-tasks output (next stage)
```

### Source Code (repository root)

```text
distribution/                        # NEW — canonical content only (no M3 artifacts, FR-020)
└── shared/
    ├── skill.md                     # FR-001..006 — when-to-use-Squire-Docs steering
    └── onboard.md                   # FR-007..018 — the /squire:onboard flow

test/first-run/                      # 029 machinery, EXTENDED here
├── rehearsal-harness.mjs            # EDIT — structured capture (RBD-2); unauthenticated mode,
│                                    #        token-fallback mode, scripted user turns, fixture-repo cwd (FR-032)
├── grade-transcript.mjs             # EDIT — event-anchored performable items (FR-025/026),
│                                    #        origin-anchored doc-URL item, behavioral silent-reconnect (FR-027/RBD-10)
├── assemble-bundle.mjs              # NEW — bundle assembler from distribution/shared/ (FR-019, RBD-1)
├── check-bundle-agreement.mjs       # NEW — drift check: generated bundle vs shared/ (FR-021)
├── matrix-runner.mjs                # NEW — 11-cell runner, per-cell profiles, always --require-claude (FR-030..033)
├── matrix-cells.mjs                 # NEW — cell definitions + expected-outcome profiles (FR-031, RBD-4/11)
├── oauth-chain-driver.mjs           # reused as-is (tier-2 machinery)
├── state-bleed-check.mjs            # reused as-is
├── fixtures/                        # grader regression fixtures
│   ├── full-coaching-transcript.txt # exists (may be regenerated to include events)
│   ├── stub-transcript.txt          # exists
│   ├── quote-only-transcript.*      # NEW — must FAIL performable items (FR-028)
│   ├── incidental-docpath.*         # NEW — must FAIL the doc-URL item (FR-028)
│   └── genuine-performing.*         # NEW — must PASS performable items (FR-028)
├── repo-fixtures/                   # NEW — 4 repo-shape fixtures (FR-032, RBD-7)
│   ├── kiro-specs/  specs/  claude-md/  bare/
└── stub-plugin/                     # 029 stub retained as a grader-demonstration fixture only

client/src/pages/
├── AuthorizePage.jsx                # EDIT — unauthenticated first-run framing (copy only, FR-022/023)
├── __tests__/AuthorizePage.test.jsx # NEW — asserts the 4 first-run framing elements (FR-024, SC-005)
└── (LoginPage.css / a scoped style) # EDIT — first-run copy layout (no below-the-fold on mobile)
```

**Structure Decision**: Web application (existing `client/` + `server/`) plus two repo-level additions: the new `distribution/shared/` canonical content tree and the extended `test/first-run/` machinery. The only production-code edit is `client/src/pages/AuthorizePage.jsx` (copy/presentation). No `server/` change, no migration, no new endpoint. The bundle assembler deliberately lives under `test/first-run/`, not `distribution/`, so `distribution/` holds only `shared/` after this feature (FR-020, RBD-1).

## Complexity Tracking

> No Constitution Check violations — this table is intentionally empty.

The one place M2 touches already-merged M1 code (the 029 harness/grader) is mandated, not gold-plating: the design's M2 method is "iterate the real content against the M1 harness," and 029's promotion notes explicitly assign the grader-hardening and `--require-claude`-wiring debts to M2. The harness extensions (unauthenticated mode, scripted turns, token-fallback, fixture repos) are the minimum needed to reach the matrix cells the design names — the spec's flagged gap 2 shows the walkthrough branch is otherwise unreachable. No simpler alternative exists that still exercises the coaching the milestone exists to tune.
