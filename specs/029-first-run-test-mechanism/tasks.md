---

description: "Task list for First-Run Test Mechanism (Plugin M1)"
---

# Tasks: First-Run Test Mechanism (Plugin M1)

**Input**: Design documents from `/specs/029-first-run-test-mechanism/`

**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/dev-endpoints.md, contracts/reset-and-provenance.md, quickstart.md

**Design ground truth**: `design/plugin-marketplace-publishing.md` — milestone **M1 — Test mechanism** only. M2 (coaching content) and M3 (packaging) are out of scope, gated on Sam's M1 exit sign-off.

**Tests**: Tests are first-class deliverables for this feature (constitution II + FR-015/017/018/023). Test tasks are included per user story. Backend tests are **serial-only** (constitution II — shared DB, `--runInBand`).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US5)
- Exact file paths are included in each task

## Path Conventions

Web application: Express backend (`server/`), React frontend (`client/src/`), repo-root `migrations/` and `test/`. Paths below are repo-root absolute-within-repo.

> **⚠️ Shared-file caveat (read before parallelizing):** `server/auth/routes.js` is edited by US1 (faucet + wipe), US2 (auto-approve), US3 (shared post-auth path + returnTo cap), and US5 (prod reset). Those endpoint tasks are **NOT** `[P]` with each other despite being in different stories — they serialize on `routes.js`. Likewise `server/auth/users.js` is edited by Foundational (predicate + cascade helper) and US3 (stamping). See Dependencies section.

> **⚠️ Layering caveat:** This feature is deliberately layered, not a set of independent stories. US2/US4 **compose on** US1's faucet; US4 also composes on US2's auto-approve and US3's stamping. US5 needs only the Foundational cascade helper. See Dependencies for the real order.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffolding and environment confirmation. No new npm dependencies are anticipated.

- [X] T001 [P] Create the harness tree `test/first-run/` (empty dirs for the tier-2 driver, tier-3 harness, grader, and `stub-plugin/`) so later tasks drop files into a known layout.
- [X] T002 Confirm the dev/staging overlay exports `ENABLE_DEV_ENDPOINTS=1` and record the dev-server base URL used by the quickstart validations (research R11); if the overlay does not set it, note the exact file to set it in (do not edit prod overlays).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared primitives every synthetic endpoint and both reset callers depend on.

**⚠️ CRITICAL**: No user-story endpoint work can begin until this phase is complete.

- [X] T003 [P] Create migration `migrations/1799300000000_add-signup-source-to-users.js` adding `signup_source TEXT NOT NULL DEFAULT 'browser'` with `CHECK (signup_source IN ('browser','agent_oauth'))`; down = `dropColumns('users', ['signup_source'])` (FR-012, RBD-6/RBD-7; timestamp > current latest `1799200000000`).
- [X] T004 [P] Add a reusable dev-endpoint gate helper enforcing `process.env.ENABLE_DEV_ENDPOINTS === '1' && process.env.NODE_ENV !== 'production'` (positive flag primary + NODE_ENV belt, RBD-5) in `server/auth/middleware.js`, mirroring the existing `2b9d6be` gate on `dev-login`; used by all synthetic endpoints (FR-001).
- [X] T005 [P] Add the shared synthetic-namespace predicate `SYNTHETIC = /^test\+[a-z0-9-]{1,32}@test\.local$/` and an `isSyntheticEmail(email)` helper in `server/auth/users.js` — the single boundary reused by the synthetic wipe (US1) and consent auto-approve (US2) (RBD-1/RBD-2).
- [X] T006 Verify the reset cascade (research R3): confirm whether `yjs_updates` content rows (keyed by `doc_guid`) and dynamically-registered OAuth client rows cascade on `DELETE FROM users`, or need explicit teardown; record the finding in `research.md` §R3 and drive T007's sweep list from it.
- [X] T007 Implement `deleteUserByEmail(email)` cascade helper in `server/auth/users.js` — single hard `DELETE FROM users WHERE lower(email)=lower($1)` in a transaction, relying on `ON DELETE CASCADE` FKs plus an explicit sweep of any non-cascading artifacts found in T006; idempotent (no row ⇒ no-op); does NOT widen targets (callers enforce their own target rule). Shared by US1 wipe and US5 prod reset (FR-008/FR-010/FR-011). Depends on T006; same file as T005 (serialize).

**Checkpoint**: Column, gate, namespace predicate, and cascade helper exist — synthetic endpoints and both resets can now be built.

---

## Phase 3: User Story 1 - Mint a genuine first-run user on demand (Priority: P1) 🎯 MVP

**Goal**: The fresh-user faucet (JSON + browser mode) plus the synthetic wipe and the small React client change — the primitives every other deliverable composes on.

**Independent Test**: On a dev server with the flag on, mint a fresh user via the faucet (JSON), confirm it exists and is session-authenticated; walk the consent sign-in leg via browser mode with a `returnTo` (cookies + 302); wipe the user and confirm the row and all dependents are gone and a re-mint is a genuinely new account. With the flag unset, every call is unreachable.

### Tests for User Story 1 ⚠️ (write first, expect FAIL before implementation)

- [ ] T008 [P] [US1] Integration tests in `server/__tests__/integration/faucet-wipe.test.js`: fresh JSON mints distinct `test+<nonce>@test.local` on repeated calls (Acc 1.1); reused explicit nonce = re-login not error; browser mode sets `accessToken`/`refreshToken` cookies + 302 to a validated `returnTo` and drops an invalid/oversized `returnTo` safely (Acc 1.2, no open redirect); synthetic wipe deletes a synthetic user + cascade and is idempotent (Acc 1.4), refuses a non-synthetic address (Acc 1.5), and `all:true` deletes only namespace rows; every faucet/wipe path is unreachable with `ENABLE_DEV_ENDPOINTS` unset and in a production-like `NODE_ENV` (Acc 1.6, SC-004). Serial suite.

### Implementation for User Story 1

- [ ] T009 [US1] Extend `POST /auth/dev-login` in `server/auth/routes.js` with **fresh mode**: `{fresh:true}` mints `test+<nonce>@test.local` (googleId `dev-test-<nonce>`) instead of the fixed dev user; server-generated short-hex nonce when none supplied, else validate caller nonce `/^[a-z0-9-]{1,32}$/` (RBD-3); JSON response echoes `{ accessToken, user, email, nonce }`; empty body still mints the fixed `dev@test.local` (backward compatible). Behind the T004 gate (FR-003).
- [ ] T010 [US1] Add **browser mode** to `POST /auth/dev-login` in `server/auth/routes.js`: `{fresh:true, browser:true, returnTo}` sets httpOnly `accessToken`/`refreshToken` cookies and responds `302` to a `returnTo` validated by the existing `isValidReturnTo` (routes.js:81-94), routing account creation / provenance / welcome-doc / returnTo handling through the **same shared post-auth logic** the Google callback uses — substituting only the identity leg (RBD-10; the stamping enrichment of that path lands in US3 T018/T019). Depends T009; same file (FR-004).
- [ ] T011 [US1] Add `POST /auth/dev-wipe-user` in `server/auth/routes.js` behind the T004 gate: accepts `{email}` matching `isSyntheticEmail` ⇒ `deleteUserByEmail` + success; `{all:true}` ⇒ delete only namespace-matching rows; non-synthetic address ⇒ refuse; non-existent synthetic ⇒ idempotent no-op (FR-008/FR-009/FR-011, RBD-2). Depends T007; same file as T009/T010 (serialize).
- [ ] T012 [P] [US1] Extend `devLogin` in `client/src/contexts/AuthContext.jsx` (~:134-149, today posts no body) to forward `{ fresh, nonce, returnTo }` and use browser mode, so the React dev-bypass consent path (AuthorizePage → /login → devLogin) composes with the faucet (FR-005).

**Checkpoint**: Faucet (both modes) + wipe + client change work and are green independently; every other tier can now be built on these primitives.

---

## Phase 4: User Story 2 - Prove the agent OAuth chain headlessly (Priority: P1)

**Goal**: The consent auto-approve endpoint and the tier-2 headless OAuth-chain driver — the regression net proving an agent can connect end to end with no browser.

**Independent Test**: Run the driver against a clean dev server; it walks 401 → resource metadata → AS metadata → dynamic client registration → PKCE authorize → (faucet browser-mode sign-in) → (auto-approve consent) → token, and finishes by calling a real MCP tool with the resulting token — zero human interaction.

**Composes on**: US1 faucet browser mode (sign-in leg) + Foundational namespace predicate/gate.

### Tests for User Story 2 ⚠️ (write first, expect FAIL before implementation)

- [ ] T013 [P] [US2] Integration tests in `server/__tests__/integration/auto-approve.test.js`: a faucet-minted synthetic session ⇒ auto-approve completes the Approve step and mints the authorization code (Acc 2.2); a non-synthetic (real) user's session ⇒ **403 refuse** (Acc 2.3, RBD-1); unreachable with the flag unset / production-like `NODE_ENV` (SC-004). Serial suite.

### Implementation for User Story 2

- [ ] T014 [US2] Factor the Approve core out of `server/mcp/auth/oauth-flow.js` `handleApprove` so it can be called after a synthetic-session check without duplicating code-mint logic; confirm the exact request fields it needs (`client_id`, `redirect_uri`, `state`, `code_challenge`, `scope`) and that they can be reconstructed from / carried consistent with the pending authorize request (research R2).
- [ ] T015 [US2] Add `POST /auth/dev-consent-approve` in `server/auth/routes.js` behind the T004 gate + `requireAuth`: refuse unless `req.user.email` matches `isSyntheticEmail` (Acc 2.3), else call the T014 approve core and return the authorization code / redirect target exactly as a browser Approve would (FR-006/FR-007). Depends T014; shared `routes.js` (serialize with US1 endpoint tasks).
- [ ] T016 [US2] Write the tier-2 headless driver `test/first-run/oauth-chain-driver.mjs` (single command, `--server $DEV`): walks unauthenticated 401 → protected-resource metadata → authorization-server metadata → dynamic client registration → PKCE authorize → faucet browser-mode sign-in → auto-approve consent → token exchange, then authenticates a real MCP tool call with the token (FR-017/FR-018, SC-002). Depends T010, T015.

**Checkpoint**: The whole agent connect chain runs headlessly on one command and re-runs as a regression check.

---

## Phase 5: User Story 3 - Signup provenance and the load-bearing welcome-doc skip (Priority: P2)

**Goal**: The only production app changes in M1 — provenance stamping (`browser`/`agent_oauth`), the deliberate welcome-doc skip, the null-welcome-doc client contract, the returnTo length-budget measurement — plus the tier-1 backend integration suite the cheapest tier asserts.

**Independent Test**: Backend integration tests create accounts through both paths and assert stamping, the welcome-doc skip for consent-born accounts, the existing-account default, and the null-welcome-doc client contract — runnable in the standard serial suite with no human.

**Composes on**: Foundational migration (T003) for the column; enriches the shared post-auth path that US1 T010 routes through.

### Tests for User Story 3 ⚠️ (write first, expect FAIL before implementation)

- [ ] T017 [P] [US3] Tier-1 integration tests in `server/__tests__/integration/first-run.test.js` (FR-015): (a) the consent returnTo round-trip with mid-flow account creation; (b) signup-source stamping — `browser` for the plain sign-in path (Acc 3.1), `agent_oauth` for the consent round-trip (Acc 3.2), default `browser` for a pre-existing row with no breakage (Acc 3.3); (c) the deliberate welcome-doc skip for consent-born accounts (Acc 3.2); (d) the null-welcome-doc client contract (Acc 3.4); (e) flag-off / production-like unreachability of every synthetic endpoint (SC-004). Serial suite.

### Implementation for User Story 3

- [X] T018 [US3] Extend `findOrCreateUser(profile, { signupSource })` in `server/auth/users.js`: default `'browser'`; write `signup_source` ONLY in the INSERT column list, NEVER in the `ON CONFLICT DO UPDATE SET` clause (stamp-once at creation, never overwritten on later login) (FR-012, RBD-10). Same file as T005/T007 (serialize).
- [ ] T019 [US3] In the shared Google-callback / post-auth logic in `server/auth/routes.js`: pass `signupSource: 'agent_oauth'` when a valid same-origin `returnTo` is present at account creation, `'browser'` otherwise; keep the existing early `return` on the consent returnTo branch (routes.js:223-225) that skips welcome-doc seeding, now documented + test-covered as deliberate and load-bearing (FR-012/FR-013). Depends T018; shared `routes.js` (serialize).
- [ ] T020 [P] [US3] Audit client surfaces that read welcome/onboarding state (`welcomeDocId`/`onboarded` in auth responses, `?welcome=1`/`?signup=1` redirects, `AuthContext` consumers, any welcome-doc gate) and ensure none error, break redirects, or stick on an onboarding prompt when `welcome_doc_id` is null; fix any that misbehave (FR-014, Acc 3.4).
- [ ] T021 [US3] returnTo length-budget measurement (FR-016, finding M4): measure a real Claude Code authorize URL's `returnTo` payload (PKCE `code_challenge`, `state`, `redirect_uri`, client id) against the 512-char cap (routes.js:83); record the measured length + decision in `research.md` §R7; if near/over cap, raise the (still same-origin-validated) cap OR carry OAuth params server-side, in `server/auth/routes.js`. Shared `routes.js` (serialize).

**Checkpoint**: Provenance + welcome-doc contract are live and test-covered; the cheapest test tier is green.

---

## Phase 6: User Story 4 - Unattended in-pod rehearsal of the first-run flow (Priority: P2)

**Goal**: The tier-3 rehearsal harness (one command → pristine first-run environment in the Linux dev pod), the stub plugin bundle it installs, and the transcript grader — M1's exit criterion.

**Independent Test**: Run the harness's one command in the dev pod; it produces a pristine environment (scratch config + fresh synthetic user + installed stub plugin pointed at the dev server), completes an unattended rehearsal, and emits a graded transcript — repeatably, with no state bleed between runs.

**Composes on**: US1 faucet + wipe, US2 auto-approve. Grader/stub are independent fixtures buildable in parallel.

### Implementation for User Story 4

- [ ] T022 [P] [US4] Create the stub plugin bundle under `test/first-run/stub-plugin/` (NOT `distribution/`, RBD-9): `.claude-plugin/plugin.json` (name `squire` for `/squire:*`), `.claude-plugin/marketplace.json` (local-path marketplace), `.mcp.json` (dev endpoint via indirection), `skills/squire/SKILL.md`, `commands/onboard.md` — all clearly marked "SCAFFOLDING FOR TESTING — real content is M2", with exactly one trivially-gradable coaching marker so the grader can demonstrate a PASS as well as expected FAILs (FR-021, RBD-8).
- [ ] T023 [P] [US4] Write the transcript grader `test/first-run/grade-transcript.mjs`: emits an explicit PASS/FAIL per coaching-contract checklist item (signup-creates-account line before the browser step; bare authorization URL on its own line; localhost-callback failure handled via paste-back; silent reconnect + continuation; byte-channel never-retyped sync; doc URL delivered; loop taught) (FR-023, SC-008).
- [ ] T024 [US4] Write the rehearsal harness `test/first-run/rehearsal-harness.mjs` (defaults: stub bundle path param → `test/first-run/stub-plugin`, dev server, random synthetic user): create a scratch `CLAUDE_CONFIG_DIR`; add the bundle as a local-path marketplace and install it with the MCP endpoint pointed at the dev server via **endpoint indirection that never mutates the source bundle** — throwaway templated copy, or env interpolation if Claude Code supports it (verify at implement, FR-020); mint a fresh synthetic user (faucet); drive Claude Code non-interactively (`claude -p`); complete consent via auto-approve; the pod's localhost OAuth callback naturally fails ⇒ exercise the paste-back branch (FR-023 Acc 5); capture the full transcript, grade it via T023, and clean up (synthetic wipe + config-dir removal). Document the macOS Keychain caveat / Linux-pod-only limitation in the harness; do NOT build Keychain purging (FR-019/FR-022/FR-024/FR-025, SC-001). Depends T010, T011, T015, T022, T023.
- [ ] T025 [P] [US4] State-bleed validation: run the harness twice and assert run 2 gets a genuinely new synthetic user and pristine client state — no cached MCP token, no leftover marketplace, no run-1 rows (SC-003, Acc 4.6). Depends T024.

**Checkpoint**: One command yields a pristine first-run environment in under 3 minutes with a graded transcript — M1 exit demonstrable.

---

## Phase 7: User Story 5 - Production single-account reset (Priority: P3)

**Goal**: The one deliberately prod-enabled endpoint — admin-gated, target = one hardcoded compile-time constant `selftest@example.com`, no free-form target surface.

**Independent Test**: As an admin, invoke the prod reset; confirm it deletes only the hardcoded account's data and that there is no target parameter to widen; non-admin is rejected; already-reset account is an idempotent no-op.

**Composes on**: Foundational `deleteUserByEmail` (T007) only.

### Tests for User Story 5 ⚠️ (write first, expect FAIL before implementation)

- [ ] T026 [P] [US5] Integration tests in `server/__tests__/integration/prod-reset.test.js`: an admin caller resets ONLY the hardcoded account with full cascade (Acc 5.1); a non-admin is rejected (Acc 5.3); an already-reset account is an idempotent no-op success (Acc 5.4); the endpoint consults no request body for targeting — no user id / email / wildcard / list exists (Acc 5.2, SC-005); the endpoint is reachable WITHOUT `ENABLE_DEV_ENDPOINTS` but requires admin (FR-002). Serial suite.

### Implementation for User Story 5

- [ ] T027 [US5] Add `POST /auth/prod-reset-selftest-account` in `server/auth/routes.js` gated by `requireAdmin` (existing gate, server/auth/middleware.js:95 — no new auth machinery) and NOT by `ENABLE_DEV_ENDPOINTS` (FR-002); target = a hardcoded compile-time constant `PROD_RESET_ACCOUNT = 'selftest@example.com'` (D6) with NO target parameter consulted; call `deleteUserByEmail(PROD_RESET_ACCOUNT)`; idempotent no-op when absent (FR-010/FR-011, RBD-4). Shared `routes.js` (serialize with other endpoint tasks).

**Checkpoint**: The prod reset affects exactly one predefined dataless account and nothing else, by construction.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Cross-story validation, docs, and the M1 exit demonstration.

- [ ] T028 Endpoint inventory audit (SC-004/SC-005): confirm the prod reset is the ONLY dev-support endpoint from this feature reachable in production, and every synthetic endpoint (faucet fresh/browser, auto-approve, wipe) is unreachable with the flag unset and in a production-like `NODE_ENV`; record the audit result in the feature artifacts.
- [ ] T029 Add a "first-run test mechanism" section to `docs/dev.md` (the flag, the faucet modes, the wipe, the tier-2 driver command, the tier-3 harness command, Linux-pod-only caveat) — Principle I. (Implement-agent task; the plan agent must not edit `docs/dev.md`.)
- [ ] T030 Run the `quickstart.md` validations end to end in the `app-dev` pod: tier-1 suite green, faucet/wipe smoke, tier-2 driver completes with a working tool call, tier-3 harness yields a pristine environment in under 3 minutes with a graded transcript, prod-reset inspection — the M1 exit demonstration (FR-025, SC-001).

---

## Dependencies & Execution Order

### Phase order

- **Setup (P1)** → **Foundational (P2)** blocks everything → **User Stories (P3–P7)** → **Polish (P8)**.
- Foundational T006 → T007 (cascade verification before the helper). T005 and T007 both edit `server/auth/users.js` (serialize). T003/T004/T005 are mutually `[P]`.

### Real story dependency graph (this feature is layered, not fully independent)

- **US1 (P1)** — depends only on Foundational. **This is the MVP.** T009→T010→T011 serialize on `routes.js`; T012 (client) is `[P]`.
- **US2 (P1)** — composes on **US1 T010** (browser-mode sign-in leg) + Foundational. T014→T015→T016. T015 serializes on `routes.js` with US1.
- **US3 (P2)** — depends on Foundational T003 (column). T018→T019→T021 serialize on `users.js`/`routes.js`; T020 (client audit) is `[P]`. US1 T010's `agent_oauth` stamping only becomes observable once US3 T018/T019 land (expected cross-story integration).
- **US4 (P2)** — composes on **US1** (faucet + wipe), **US2** (auto-approve). T022/T023 are `[P]` fixtures; T024 depends on them + US1/US2; T025 depends on T024.
- **US5 (P3)** — depends only on Foundational T007. T027 serializes on `routes.js` with US1/US2/US3.

### Shared-file serialization (NOT parallel despite different stories)

- `server/auth/routes.js`: T009, T010, T011 (US1), T015 (US2), T019, T021 (US3), T027 (US5) — one writer at a time.
- `server/auth/users.js`: T005, T007 (Foundational), T018 (US3).

### Parallel opportunities

- Setup: T001 `[P]`.
- Foundational: T003, T004, T005 `[P]` together (T006/T007 follow).
- Cross-story fixtures with no shared-file conflict can proceed in parallel once their deps land: T012 (US1 client), T020 (US3 client audit), T022 + T023 (US4 fixtures), and all four test-file tasks (T008, T013, T017, T026 — distinct files).

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL) → 3. Phase 3 US1 → **STOP & VALIDATE**: faucet (both modes) + wipe green independently. This is the primitive layer everything else needs.

### Incremental delivery (respecting the layering)

1. Setup + Foundational → foundation ready.
2. US1 (faucet + wipe + client) → the primitives.
3. US2 (auto-approve + tier-2 driver) → headless chain regression net.
4. US3 (provenance + welcome-doc contract + tier-1 suite) → the production app changes + cheapest tier.
5. US4 (tier-3 harness + stub + grader) → M1 exit criterion.
6. US5 (prod reset) → the human self-test capability (small, Foundational-only dep).
7. Polish → audit, docs, quickstart end-to-end demonstration.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task. Heed the shared-file serialization list above — several cross-story tasks touch `routes.js`/`users.js` and are NOT parallel.
- Backend tests are serial-only (constitution II, `--runInBand`); the tier-3 harness must not launch a concurrent backend test run against the same DB.
- Tests are first-class here (FR-015/017/018/023): write the per-story test tasks first and expect FAIL before implementation.
- The stub plugin is scaffolding-for-testing under `test/first-run/stub-plugin/`, NEVER the shipping bundle and NEVER at `distribution/` (RBD-9). Full checklist passes are M2's exit; M1 delivers the grading mechanism (RBD-8).
- Commit after each task or logical group; stay on `main`.

