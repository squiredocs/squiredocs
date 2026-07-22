# Implementation Plan: First-Run Test Mechanism (Plugin M1)

**Branch**: `029-first-run-test-mechanism` | **Date**: 2026-07-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/local-dev/specs/029-first-run-test-mechanism/spec.md`

**Design ground truth**: `/local-dev/design/plugin-marketplace-publishing.md` (ratified 2026-07-21) — milestone **M1 — Test mechanism** only. M2 (coaching content) and M3 (packaging) are out of scope and gated on Sam's M1 exit sign-off.

## Summary

Build the test mechanism that makes the (M2) plugin first-run flow cheap to rehearse dozens of times without burning real Google/Claude accounts or a human clicking browsers. Five deliverables, layered:

1. **Fresh-user faucet** — extend the existing `POST /auth/dev-login` with `fresh: true` (mints `test+<nonce>@test.local`) and a **browser mode** that sets session cookies and honors a validated `returnTo`, standing in for Google on the consent page's sign-in leg. Plus the small React client change so the dev-bypass consent path forwards `fresh`/nonce.
2. **Consent auto-approve** — a dev-only endpoint that completes the `/authorize` Approve step for a *synthetic* session and mints the agent's authorization code with no browser click.
3. **User reset** — a synthetic wipe (dev/staging-only, namespace-guarded) and the one deliberately prod-enabled single-account reset (hardcoded `selftest@example.com`, admin-gated).
4. **App changes** — `signup_source` provenance column + stamping (`browser` default, `agent_oauth` on the consent round-trip), the deliberate welcome-doc skip made load-bearing, the null-welcome-doc client contract, and the returnTo length-budget measurement (FR-016).
5. **Test harnesses** — tier-1 backend integration tests (in the Jest suite), tier-2 headless OAuth-chain driver, tier-3 unattended in-pod rehearsal harness with a stub plugin bundle and transcript grader.

**Gating invariant (constitution-level for this feature):** every synthetic endpoint is fail-closed behind the positive `ENABLE_DEV_ENDPOINTS === '1'` opt-in, with the existing `NODE_ENV !== 'production'` check retained as an *additional* belt (RBD-5) — never as the sole gate. The prod reset is the one deliberate exception: admin-gated, prod-reachable, target = one hardcoded compile-time constant.

## Technical Context

**Language/Version**: Node.js 22+ (server), React 18 (client), Bash + Node for harness scripts.

**Primary Dependencies**: Express + existing `server/auth/*` (routes, users, middleware, jwt), `server/mcp/auth/oauth-flow.js` + `oauth-router.js`, node-pg-migrate (schema), Jest (`--runInBand`, serial), Claude Code CLI (`claude -p`) for tier-3.

**Storage**: PostgreSQL (users table gains `signup_source`; reset is a hard `DELETE FROM users` relying on existing `ON DELETE CASCADE` FKs).

**Testing**: Jest backend suite (serial-only, constitution II) for tier-1; a standalone Node script for tier-2 (runs against the dev server); a Bash/Node harness for tier-3 (runs in the Linux dev pod).

**Target Platform**: Linux dev pod (Minikube `app-dev`). macOS pristine rehearsal is explicitly out of scope (Keychain caveat, FR-024 / finding M6).

**Project Type**: Web application (Express backend + React frontend) with added dev-support test tooling.

**Performance Goals**: SC-001 — one command yields a pristine first-run environment in under 3 minutes.

**Constraints**: Backend tests share one DB and run serially. Synthetic endpoints must be unreachable with the flag unset (SC-004). The prod reset must expose no free-form target (SC-005).

**Scale/Scope**: One migration, ~4 new/extended server endpoints, one small client change, one backend test file, two harness scripts, one stub plugin fixture. No new npm dependency anticipated.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.1.1.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Documentation Reflects Reality | PASS (deferred) | `docs/dev.md` gains a "first-run test mechanism" section describing the flag, faucet, harness command. Per parallel-agent overrides this PLAN agent MUST NOT edit `docs/dev.md`; the doc update is a task in tasks.md for the implement agent. README unaffected (dev-only tooling). |
| II. Test-Backed Changes | PASS | Every behavioral change (provenance stamping, welcome-doc skip, null-welcome-doc contract) is covered by the tier-1 Jest integration tests (FR-015), serial-only. No format/serialization change, so the round-trip registry suite is untouched. |
| III. Trunk-Based Solo Workflow | PASS | No new ceremony. Dev-support endpoints are the minimum needed to make first-run testing cheap — each earns its place against a concrete failure (real-account burn, manual browser clicking). |
| IV. Collaboration-Safe Document Operations | N/A | No live-document mutation. The reset hard-deletes whole user+doc rows (an account teardown, not an in-doc edit) — Principle IV governs *content* edits inside live docs, which this feature never performs. |
| V. Secure by Default | PASS (load-bearing) | These are session-forgery + mass-delete primitives. Security is the design's spine: positive-flag fail-closed gating (FR-001), namespace-boundary enforcement for wipe + auto-approve (RBD-1/RBD-2), no-target prod reset (FR-010/RBD-4), admin auth reused not reinvented (008/009 lesson). No new ingestion surface for agent/user *content*. |
| VI. Design Docs Are Ground Truth | PASS | Plan tracks `design/plugin-marketplace-publishing.md` §"Repeatable first-run testing" + §"Build milestones" M1 exactly. All design silences resolved as RBD-1..RBD-10 in the ledger. No design amendment needed (design is not falsified). |

**No violations. Complexity Tracking table is empty.**

Two constitution-adjacent items to keep honest during implementation:
- Constitution II serial DB: the tier-1 tests and any harness DB activity run serially; harness must not launch a concurrent backend test run against the same DB.
- The migration timestamp must exceed the current latest (`1799200000000_drop-yjs-state-vectors.js`) → use `≥ 1799300000000` (RBD-7), which subsumes the stale `>1795000000000` floor.

## Project Structure

### Documentation (this feature)

```text
specs/029-first-run-test-mechanism/
├── plan.md              # This file
├── spec.md              # Ratified spec
├── clarifications-needed.md  # RBD-1..RBD-10 ledger
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (endpoint contracts)
│   ├── dev-endpoints.md
│   └── reset-and-provenance.md
├── checklists/
│   └── requirements.md
└── tasks.md             # /speckit-tasks output (next stage)
```

### Source Code (repository root)

```text
server/
  auth/
    routes.js            # EXTEND: dev-login gains fresh/browser mode; add synthetic-wipe,
                         #   prod-reset endpoints; provenance stamping + welcome-doc skip
                         #   flow through the shared google-callback path (RBD-10)
    users.js            # EXTEND: findOrCreateUser accepts/stamps signup_source; add
                         #   deleteUserByEmail cascade helper; synthetic-namespace predicate
    middleware.js       # REUSE: requireAuth, requireAdmin (no new auth machinery)
  mcp/auth/
    oauth-flow.js       # REUSE handleApprove logic for the auto-approve endpoint
    oauth-router.js     # (unchanged; auto-approve lives on the auth router or a dev sub-router)
migrations/
  1799300000000_add-signup-source-to-users.js   # NEW (RBD-6/RBD-7)
client/src/contexts/
  AuthContext.jsx       # EXTEND: devLogin forwards {fresh, nonce, returnTo} to browser mode
server/__tests__/integration/
  first-run.test.js     # NEW tier-1 integration tests (FR-015)
test/first-run/         # NEW harness tree (tier-2 + tier-3)
  oauth-chain-driver.mjs        # tier-2 headless chain driver (FR-017/018)
  rehearsal-harness.mjs         # tier-3 in-pod rehearsal (FR-019..025)
  stub-plugin/                  # RBD-9 stub bundle (NOT distribution/)
    .claude-plugin/plugin.json
    .claude-plugin/marketplace.json
    .mcp.json
    skills/squire/SKILL.md
    commands/onboard.md
  grade-transcript.mjs          # coaching-contract checklist grader (FR-023)
```

**Structure Decision**: Web application. Backend changes extend existing `server/auth/` and reuse `server/mcp/auth/`. The migration lands in the repo-root `migrations/` tree (confirmed location; not `server/migrations/`). Test tooling lives in a new `test/first-run/` tree so the stub plugin fixture is unmistakably scaffolding and never collides with the M3 `distribution/` tree (RBD-9). The harness's marketplace-add path is a parameter defaulting to `test/first-run/stub-plugin`, switchable to `distribution/claude-plugin` when M3 creates it.

## Complexity Tracking

> No constitution violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
