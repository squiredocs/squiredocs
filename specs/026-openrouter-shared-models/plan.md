# Implementation Plan: OpenRouter-Backed Shared Default Models (Kimi, Qwen, MiniMax, GLM)

**Branch**: `026-openrouter-shared-models` | **Date**: 2026-07-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/026-openrouter-shared-models/spec.md`

**Parallel-pipeline note**: This feature is planned on `main` alongside the concurrent
025-durable-chat-errors pipeline. Per the pipeline overrides, no branch/commit/push happens at
plan time; product decisions were RATIFIED-BY-DEFAULT (Sam pre-authorized 2026-07-21) and live in
[clarifications-needed.md](./clarifications-needed.md) (D1–D6).

## Summary

Make the OpenRouter provider eligible to back the shared-assistant default model by declaring its
server key (`serverKeyEnv: 'OPENROUTER_API_KEY'`), so the existing *derived* eligibility mechanism
(`hasServerKey` → admin picker filter → save-time validation) surfaces a curated set of Kimi, Qwen,
MiniMax (and the already-present GLM) gateway models as shared-default choices whenever the operator
provisions the key — with zero allowlist, flag, or toggle. The change is deliberately small and
fenced off the 025-owned chat/transport surface (FR-010): one-line provider eligibility + comment
rewrite, four new curated registry entries + refreshed pricing/context on the four existing
`or-glm-*` entries (authoring-time snapshot from OpenRouter's live models API), per-entry vision
flags (fail-closed), a resolution-degradation guard so a stored gateway default degrades gracefully
when the key is removed (the rollback path), an admin-picker presentation change to provider
`<optgroup>`s mirroring the BYOK selector, and tests asserting the shared-key error/metering/BYOK
invariants hold for the `openrouter` provider. No migration; no taxonomy/orchestration/transport
changes beyond tests. The feature ships dormant-safe: with no key, behavior is byte-for-byte today's.

## Technical Context

**Language/Version**: Node.js 22+ (backend, CommonJS); React 18 (frontend, JSX)

**Primary Dependencies**: Express + AI SDK provider registry (`server/api/ai-providers.js`,
`@ai-sdk/openai-compatible` for the OpenRouter gateway client); no new dependency added.

**Storage**: PostgreSQL app_settings row (existing shared-default-model setting, migration
`1789000000000` — **no schema change**, FR-010). No new tables/columns/migrations.

**Testing**: Jest backend (`server/api/__tests__/`); Vitest frontend (`client/src/**/__tests__/`).
Backend suite is **serial-only, single shared DB** (Constitution II); implementer uses a per-agent
worktree DB (`createdb collab_test_db_026` + `DATABASE_URL`) per repo convention.

**Target Platform**: Linux server (Minikube app-dev pod locally; hardened k3s cluster in prod).

**Project Type**: Web application (Express backend + React frontend).

**Performance Goals**: N/A — no hot-path change. Provider dispatch, metering, and streaming are
untouched; the gateway shared-client code path already exists (only eligibility flips).

**Constraints**: (1) OFF-LIMITS to feature 025: `specs/025-durable-chat-errors/`,
`server/api/chat.js`, `server/api/chat-store.js`, and client chat contexts/components — the plan and
tasks MUST NOT touch them (FR-010). (2) No DB migration. (3) No error-taxonomy / classifier /
orchestration / transport code change — tests only (FR-006/FR-007/FR-008). (4) Provider knowledge
stays in `ai-providers.js`, models in `chat-models.js` (Constitution tech constraint & design doc).

**Scale/Scope**: ~4 new curated registry entries + 4 refreshed entries; 1 provider block edit; 1
resolution guard; 1 admin-endpoint effective-model + optgroup change; ~6–9 test additions. Single
solo deployment; the shared OpenRouter account is a new operational resource (credits/exhaustion).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Documentation Reflects Reality** — PASS with obligation. Design ground truth
  `design/in-app-ai-assistant.md` ("Models, providers, BYOK", commit c9b8c73) already documents this
  exact mechanism (OpenRouter shared gateway via `OPENROUTER_API_KEY`, derived eligibility,
  registry-resident gateway entries, per-entry vision) — code is *converging to* the doc, so no doc
  amendment is required and none is planned (amend only if implementation falsifies the doc).
  README/docs/dev.md are OFF-LIMITS to this agent (pipeline override) — any README touch (e.g. an
  operator-key note) is deferred to the merge/deploy owner. The stale in-code comments on the
  openrouter provider block are the local "docs reflect reality" defect this feature must fix
  (FR-001).
- **II. Test-Backed Changes** — PASS. Every behavioral change carries a test (eligibility surfacing,
  save-time validation accept, FR-005 degradation, FR-006 shared-key exhaustion → provider_overloaded
  + notify, FR-007 metered usage row, FR-008 BYOK-never-shared + byok_misconfigured-no-fallback,
  vision gating). Backend suite runs serially on a per-agent DB. No format-registry round-trip change
  (no marks/nodes added).
- **III. Trunk-Based Solo Workflow** — PASS (adapted). Pipeline runs this in a worktree with a serial
  merge queue; plan agent stays on `main` and does not commit (override). No new ceremony introduced.
- **IV. Collaboration-Safe Document Operations** — N/A. No document/CRDT mutation in scope.
- **V. Secure by Default** — PASS / strengthened. FR-005 prevents a stored-but-unauthenticated client
  from being instantiated as the steady state (no unauthenticated provider calls); FR-008 keeps BYOK
  keys isolated (a shared key must never serve a BYOK turn, and byok_misconfigured never silently
  falls back to the operator key). No new ingestion surface.
- **VI. Design Docs Are Ground Truth** — PASS. This feature *is* a converge-to-design pass for the
  c9b8c73 amendment. The six open product decisions are RATIFIED-BY-DEFAULT in the ledger (D1–D6), not
  resolved ad hoc. No exported design file is hand-edited.
- **Tech/Architecture constraints** — PASS: provider behavior stays in `ai-providers.js`, models in
  `chat-models.js`; no third-party markdown/serialization dep; no ad-hoc DDL (no migration at all).

**Result: PASS — no violations, Complexity Tracking not required.**

## Project Structure

### Documentation (this feature)

```text
specs/026-openrouter-shared-models/
├── plan.md                    # This file (/speckit-plan output)
├── spec.md                    # Feature spec (pre-existing)
├── clarifications-needed.md   # Decisions ledger D1–D6 (RATIFIED-BY-DEFAULT)
├── research.md                # Phase 0 output (this command)
├── data-model.md              # Phase 1 output (this command)
├── quickstart.md              # Phase 1 output (this command)
├── contracts/
│   └── admin-shared-model.md  # Phase 1 output — admin settings endpoint contract
├── checklists/
│   └── requirements.md        # Spec quality checklist (pre-existing, all pass)
└── tasks.md                   # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
server/api/
├── ai-providers.js        # FR-001: openrouter block — serverKeyEnv flip + comment rewrite;
│                          #   classifyOpenRouterError unchanged (FR-006 test only)
├── chat-models.js         # FR-002/003/009: curated entries + refreshed or-glm-* + vision flags;
│                          #   FR-005: resolveChatModel non-BYOK degradation guard
├── admin.js               # FR-004/005: GET reports true effective model already; add providers
│                          #   grouping data for the picker; validation unchanged (derived)
└── __tests__/
    ├── admin.test.js              # eligibility surfacing, validation accept, effective-model report
    ├── ai-providers.classify.test.js  # FR-006 openrouter shared-turn classification assertion
    └── chat-models*.test.js       # FR-005 degradation, FR-007 metering, FR-008 BYOK, vision gating

client/src/pages/
├── AdminPage.jsx          # FR-004/D2: flat <select> → provider <optgroup>s (mirror SettingsPage)
└── __tests__/             # AdminPage picker test if a harness exists (else covered by contract)
```

**Structure Decision**: Existing web-app layout; no new directories. The entire touch set is the
four files named above plus their tests, exactly matching FR-010's "expected touch set". The
025-owned files (`chat.js`, `chat-store.js`, client chat contexts/components) are explicitly NOT in
this tree and MUST NOT be edited.

## Complexity Tracking

> No Constitution violations — table intentionally empty.
