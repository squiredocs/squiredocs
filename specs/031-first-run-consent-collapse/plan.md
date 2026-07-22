# Implementation Plan: First-Run Consent Collapse

**Branch**: `031-first-run-consent-collapse` | **Date**: 2026-07-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/031-first-run-consent-collapse/spec.md`

## Summary

Collapse the true first-run agent-connect flow from three Squire-owned screens to one, without weakening consent for anyone who has data to protect. Two code changes plus enriched copy:

1. **Kill screen 2 (client).** The unauthenticated first-run "Continue with Google" link in `AuthorizePage.jsx` points at `/login?returnTo=…` today, which routes a brand-new user through the generic "Welcome Back" login page. Repoint it at the direct Google entry `/auth/google?returnTo=…` (the exact path `AuthContext.login()` already uses), carrying the full `/authorize?…` request as the same-origin `returnTo`.
2. **Fold screen 3 into screen 1 (server).** In `completePostAuth` (server/auth/routes.js), after the user is created/found, when **both** (a) `user.isNew` is true (account created in this very round-trip) **and** (b) the validated `returnTo` is an `/authorize` request whose OAuth parameters pass full `handleAuthorize`-equivalent revalidation, mint the authorization code inline via the shared `approveAuthorization` core and 302 the browser straight to the agent's callback — no ConsentCard. Fail closed to the existing `res.redirect(returnTo)` (which renders the ConsentCard) on any miss.
3. **Enrich screen 1 copy (client).** Since the first-run surface becomes the sole consent surface, its copy must state the full grant (read + create/edit/delete for write scope; narrower for read-only) and the "revoke anytime in Settings → AI Agent Access" line, plus a tight 2–3 line value reminder drawn only from verified messaging — transparency first, above the mobile fold.

The security crux: the inline auto-issue is gated on `user.isNew` (a just-created account holds zero documents, so the ConsentCard would protect nothing) AND on OAuth parameters sourced **exclusively** from the server-bound `oauth_return_to` httpOnly cookie, re-validated with the standard authorize validation. Existing accounts — in both arrival orders — always get the explicit ConsentCard. No parallel mint path: auto-issue reuses `approveAuthorization`, the same core the browser Approve click and the dev-consent-approve endpoint already drive.

**No migration.** No schema change: `mcp_auth_codes` and `agent_delegations` already exist and are written by `approveAuthorization` / the token exchange unchanged. (If one were ever needed it must be timestamped > 1799300000000, the current latest.)

## Technical Context

**Language/Version**: Node.js (CommonJS server) + React (client, Vite/JSX). ESM for `test/first-run/*.mjs`.

**Primary Dependencies**: Express (server/auth/routes.js, server/mcp/auth/oauth-flow.js), React + react-router (client/src/pages/AuthorizePage.jsx, client/src/contexts/AuthContext.jsx). PKCE/PostgreSQL via existing `oauth-flow` + `pkce` + `delegation` modules.

**Storage**: PostgreSQL — existing tables only: `mcp_auth_codes` (code mint), `agent_delegations` (durable delegation), `users` (isNew via `xmax=0` on INSERT, `signup_source`). No new tables, no migration.

**Testing**: Jest backend integration (`server/__tests__/`, `__tests__/integration/`) run serially against the shared DB; ESM headless harness in `test/first-run/` (oauth-chain-driver.mjs, matrix-cells.mjs, rehearsal-harness.mjs). Client behavior covered by the tier-2/tier-3 harness + Sam's prod self-test for the real Google leg.

**Target Platform**: Linux server (Minikube app-dev pod) + browser client.

**Project Type**: Web application (server + client + test harness) — Option 2 structure.

**Performance Goals**: N/A (single redirect on the hot path; auto-issue adds one DB insert already present in the explicit path).

**Constraints**: Fail-closed security floor (consent-bypass territory); 030 mobile-fold constraint on the first-run surface; honest-confident voice + "Squire Docs" naming.

**Scale/Scope**: ~3 production code touch-points (1 client component, 1 client copy block, 1 server function + a small revalidation helper), plus test harness extensions. Beachhead onboarding flow — every new agent-first user.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Documentation Reflects Reality** — CLAUDE.md/README/docs/dev.md are OFF-LIMITS for this agent per task overrides; design/* is ground truth and must not be hand-edited. The design amendment already exists (commit 000c408). No doc drift introduced by the plan. PASS (docs untouched by mandate; design already amended).
- **II. Test-Backed Changes** — Every behavioral change is covered: tier-1 Jest integration for the auto-issue gate (isNew × param validity × arrival order + FR-008 phishing), tier-2 first-run chain driver (positive: code minted with no consent POST; counter: existing account still needs approve), tier-3 rehearsal-matrix cell updates. Backend suite runs serially (shared DB). PASS.
- **III. Trunk-Based Solo Workflow** — Stay on main, never branch, never commit (task override). No new ceremony. PASS.
- **IV/V (Tech & Architecture Constraints)** — Reuse `approveAuthorization`; no parallel code-mint path; PKCE + redirect validation unchanged (D5). No new dependencies. PASS.
- **VI. Design Docs Are Ground Truth** — This is a CONVERGE feature; code catches up to the ratified amendment in design/plugin-marketplace-publishing.md and the OAuth consent contract in design/authentication-and-sharing.md. Flagged gaps recorded, none silently resolved. PASS.

**Result: PASS.** No violations; Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/031-first-run-consent-collapse/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (auto-issue gate + first-run copy contracts)
├── clarifications-needed.md   # D1–D6 (RATIFIED-BY-DEFAULT)
├── checklists/requirements.md
├── spec.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
client/src/
├── pages/AuthorizePage.jsx          # FR-001: repoint first-run "Continue with Google"
│                                    #   href /login?returnTo -> /auth/google?returnTo
│                                    # FR-009/FR-014: enrich first-run copy (grant +
│                                    #   revocation + 2-3 value lines, mobile-fold safe)
└── contexts/AuthContext.jsx         # reference only - login() already uses /auth/google?returnTo

server/auth/
└── routes.js                        # FR-003/004/005/006/010: completePostAuth auto-issue
                                     #   gate (isNew + server-bound returnTo -> approveAuthorization
                                     #   -> 302 to agent callback; else fall through to consent)
                                     # isValidReturnTo, /auth/google (sets oauth_return_to cookie),
                                     #   /auth/google/callback + faucet browser mode all feed here

server/mcp/auth/
├── oauth-flow.js                    # reuse approveAuthorization (mint core) + checkRedirectUri;
│                                    #   handleAuthorize validation is the revalidation reference
├── pkce.js                          # validateCodeChallenge (PKCE format re-check on auto-issue)
└── registered-agents.js            # getRegisteredAgent / registerAgent / validateScopes

test/first-run/
├── oauth-chain-driver.mjs           # FR-013: add first-run variant (faucet browser mode,
│                                    #   returnTo=/authorize?... -> 302 callback+code, NO consent POST)
│                                    #   + companion existing-account counter-assertion
└── matrix-cells.mjs                 # FR-013/D6: connect-cell screen count -> 1 for first-run;
                                     #   declined-consent cell retarget (first-run = abandon)

server/__tests__/  (or __tests__/integration/)
└── *.test.js                        # tier-1 auto-issue gate integration tests (Jest, serial)
```

**Structure Decision**: Option 2 (web application). Production changes are confined to one client component (`AuthorizePage.jsx`) and one server function (`completePostAuth` in `routes.js`) plus a small server-side revalidation helper. All new mint logic delegates to the existing `approveAuthorization` core in `oauth-flow.js` — no new module, no parallel path. Tests extend the existing `test/first-run/` harness and the Jest backend suite.

## Complexity Tracking

No constitution violations — section intentionally empty.

