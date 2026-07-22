---
description: "Task list for 031-first-run-consent-collapse"
---

# Tasks: First-Run Consent Collapse

**Input**: Design documents from `/specs/031-first-run-consent-collapse/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md (all present)

**Tests**: INCLUDED — the spec explicitly mandates automated verification (FR-008, FR-013, SC-003, SC-005) across three tiers. This is consent-bypass territory; the security tests are load-bearing, not optional.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1 (first-run collapse), US2 (existing-account explicit consent), US3 (single-screen copy)
- Backend Jest suite is SERIAL against the shared DB — never run concurrent backend runs.

## Path Conventions

Web app. Server: `server/auth/routes.js`, `server/mcp/auth/*`. Client: `client/src/pages/`, `client/src/contexts/`. Harness: `test/first-run/*.mjs`. Backend tests: `server/__tests__/` or `__tests__/integration/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the ground before touching the consent-bypass path. No new deps, no migration.

- [ ] T001 Confirm no migration is required: verify `mcp_auth_codes`, `agent_delegations`, and `users.signup_source` exist and that `server/migrations/` (or `migrations/`) latest is `1799300000000`; if any schema gap is discovered, STOP and escalate (a migration would need a timestamp > 1799300000000). Record the confirmation in the implement notes.
- [ ] T002 Confirm dev harness prerequisites: `ENABLE_DEV_ENDPOINTS=1` reaches `/auth/dev-login` (faucet browser mode) and `/auth/dev-consent-approve` on the local dev server per `docs/dev.md`; confirm `test/first-run/oauth-chain-driver.mjs` runs green today as the baseline.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The server-side auto-issue gate — the single load-bearing mechanism US1 depends on and US2 must prove it does NOT fire. MUST complete before US1/US2 test assertions can pass. No parallelism: all edits land in `completePostAuth` in one file.

- [ ] T003 [US1] Add a private revalidation helper in `server/auth/routes.js` (near `completePostAuth`) — `tryParseAuthorizeReturnTo(rawReturnTo)` — that: returns null unless `isValidReturnTo(rawReturnTo)` AND the parsed pathname === `/authorize`; extracts `agent_client_id`||`client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method` (default `S256`), `state`, `scope`, `agent_instance_id` from the query; returns null if any of `client_id`/`redirect_uri`/`code_challenge`/`state` is missing; runs `validateCodeChallenge(code_challenge)` (require from `server/mcp/auth/pkce`) and returns null on invalid format. Reads ONLY the passed-in cookie-derived string — never `req.query`/`req.body` (FR-005, contract INV-3).
- [ ] T004 [US1] In `completePostAuth` (`server/auth/routes.js`), inside the existing `if (hasReturnTo)` block AFTER session cookies are set (routes.js:260) and BEFORE the existing `res.redirect(\`${clientUrl}${rawReturnTo}\`)` (routes.js:268): when `user.isNew === true`, call `tryParseAuthorizeReturnTo(rawReturnTo)`; if it returns params, call `mcpOauthFlow.approveAuthorization({ userId: user.id, agent_client_id, agent_instance_id, scopes: scope, redirect_uri, state, code_challenge, code_challenge_method })`. On `result.ok` → `return res.redirect(result.redirectUrl)` (agent callback + code, AUTO-ISSUE, D1 no interstitial). On `!result.ok` OR null params → fall through to the existing `res.redirect(returnTo)` (FAIL CLOSED → consent). Ensure `user.isNew === false` never enters this branch (FR-004/FR-007). Wrap `approveAuthorization` in try/catch → on throw, fall through to the consent redirect (never a 500 dead-end, FR-010/INV-4).
- [ ] T005 [US1] Verify wiring: `approveAuthorization` is already imported as `mcpOauthFlow` in `routes.js` (used by `/auth/dev-consent-approve`, routes.js:644) — reuse that exact import; do NOT add a second/parallel mint path (FR-006, INV-2). Confirm `user.id` is the right principal field passed as `userId` (matches `dev-consent-approve` usage).

**Checkpoint**: The gate exists and fail-closes. Faucet browser mode (`/auth/dev-login {fresh,browser,returnTo}`) now inherits auto-issue automatically because it calls the same `completePostAuth` (RBD-10) — this is the test seam, not new code.

---

## Phase 3: User Story 1 — First-run user connects through a single Squire screen (P1)

**Goal**: A brand-new account's authorize round-trip issues the code inline and lands on the agent callback with no consent card and no `/login` hop.

**Independent test**: Reset a test identity to first-run, start an agent OAuth connect, count Squire screens between opening the authorize link and the agent receiving its code — exactly one, and the connection completes (Scenario 1, quickstart).

### Client change (kill screen 2)

- [ ] T006 [P] [US1] In `client/src/pages/AuthorizePage.jsx` (~line 330), change the first-run "Continue with Google" `href` from `/login?returnTo=${encodeURIComponent(...)}` to `/auth/google?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}` (the direct Google entry `AuthContext.login()` already uses, AuthContext.jsx:215). Do not alter the authenticated/ConsentCard branches (contract C1).

### Tests for US1 (auto-issue happy path)

- [ ] T007 [US1] Tier-1 backend integration (`server/__tests__/` or `__tests__/integration/`): drive faucet browser mode `POST /auth/dev-login {fresh:true, browser:true, nonce:<random>, returnTo:'/authorize?agent_client_id=…&redirect_uri=http://localhost:8765/callback&code_challenge=<valid S256>&code_challenge_method=S256&state=…&scope=documents:read%20documents:write'}`; assert the response is a 302 to the agent callback carrying `code` + `state`, a row exists in `mcp_auth_codes` for the new user, and NO consent-approval endpoint was called (INV-1 positive, SC-005, FR-003).
- [ ] T008 [US1] Tier-2: add a `--first-run` variant to `test/first-run/oauth-chain-driver.mjs` that, in place of steps 6–7 (faucet JSON + `dev-consent-approve`), drives faucet BROWSER mode with `returnTo` = the `/authorize?…` URL (built from the registered `clientId`, PKCE challenge, state, scope), follows the 302 to the agent callback, extracts `code` from it WITHOUT calling `/auth/dev-consent-approve` or `/mcp/auth/approve`, then continues to token exchange + a real authenticated MCP `list_documents` call. Exit 0 only if a code was obtained with zero consent POSTs (FR-013, SC-005).

**Checkpoint**: US1 delivers the collapse — first-run connect completes headlessly with no consent action. This is the MVP.

---

## Phase 4: User Story 2 — Returning user reconnecting still gives explicit consent (P1, SECURITY)

**Goal**: Existing accounts — both arrival orders — always hit the explicit ConsentCard; no inline auto-issue ever fires for a pre-existing account. Co-equal with US1.

**Independent test**: With an existing account (signed in or signing in during the flow), start an agent OAuth connect and verify no code is issued without an explicit approve (Scenario 2, quickstart).

### Tests for US2 (counter-assertions + fail-closed + phishing)

- [ ] T009 [US2] Tier-1: existing-account counter-assertion — first faucet call mints identity `nonce=N` (isNew), then a SECOND faucet browser call with the SAME `nonce=N` (find-or-create → `isNew=false`) and a valid `/authorize` returnTo; assert 302 to the returnTo (consent page), NO `code`, NO new `mcp_auth_codes` row (FR-004/FR-007, INV-1 negative, SC-003).
- [ ] T010 [US2] Tier-1 FR-008 phishing test (REQUIRED by spec): attacker-controlled `agent_client_id` + attacker `redirect_uri`, victim account PRE-EXISTS (pre-mint via a first faucet call), victim signs in during the flow (`isNew=false`); assert zero codes/delegations minted without an explicit approve and that the fall-through renders the consent path. Also assert the positive ceiling: a fresh victimless account under the same attacker params yields at most a token on that just-created empty account (blast-radius ceiling, FR-008).
- [ ] T011 [P] [US2] Tier-1 fail-closed matrix (FR-005/FR-010, INV-3/INV-4): fresh account with (a) non-`/authorize` returnTo path → normal redirect, no code; (b) `/authorize` returnTo with malformed `code_challenge` → consent fallback, no code; (c) `/authorize` returnTo with a `redirect_uri` `checkRedirectUri` rejects (non-localhost, non-HTTPS) → consent fallback, no code; (d) divergent `req.query` vs the cookie params → any minted code reflects COOKIE params only, tampered query ignored.
- [ ] T012 [P] [US2] Tier-3: in `test/first-run/matrix-cells.mjs` retarget the `declined-consent` cell per D6 — first-run decline = abandon-before-sign-in (no account created); move/keep the explicit-Deny exercise on the existing-account (card-bearing) flow. Update the `abandoned-tab`/`declined-consent` prose expectations if they assume a first-run Deny click.

**Checkpoint**: US2 proves the security half — existing accounts never auto-issue, every fail path fails closed. US1+US2 together are the shippable security-complete increment.

---

## Phase 5: User Story 3 — The single screen carries the full consent story (P2)

**Goal**: The first-run surface states the full grant + revocation (transparency primary) and a tight value reminder (secondary), mobile-fold-safe.

**Independent test**: Load the unauthenticated surface for write-scoped and read-only requests; verify the stated grant matches scopes and the revocation line is present (Scenario 7, quickstart).

- [ ] T013 [US3] In `client/src/pages/AuthorizePage.jsx` first-run branch, enrich the grant copy (contract C2): extend the `ask` derivation (line ~305) so write scope states "read and create, edit, and delete documents in your Squire Docs account" and read-only stays strictly narrower ("read documents"); add the "revocable anytime in Settings → AI Agent Access" line. "Squire Docs" naming, honest-confident voice, transparency visually first (FR-009).
- [ ] T014 [US3] In the same first-run branch, add a 2–3 line value reminder (contract C3) drawn ONLY from spec §"Value-reminder source messaging" (humans+agents write the same spec; both agent-workable + team-reviewable with two-way repo-markdown sync; every edit attributed & revertible). No invented claims. Keep it subordinate to the transparency copy (FR-014).
- [ ] T015 [US3] Enforce the 030 mobile-fold constraint (contract C4): ensure the value reminder does not push "Continue with Google" below the fold on common mobile viewports — trim to 2–3 lines / adjust the existing `authorize-firstrun-*` layout as needed. Note this copy feeds the tone/marketing-copy sign-off (owed) and a manual mobile visual check (SC-007).

**Checkpoint**: US3 makes the collapse defensible — the one screen carries informed consent + a value reminder without breaking the fold.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Guard rails, matrix screen counts, and the review carry-forward. No production-behavior changes here beyond the matrix/docs.

- [ ] T016 [P] Tier-3 screen counts: in `test/first-run/matrix-cells.mjs` (and any coaching-contract checklist lines it references) update the connect-flow cells (`fresh-happy`, `existing-never-consented`) to the new screen count — first-run connect = 1 Squire screen; returning-user reconnect = 2 (FR-013, SC-001/SC-002).
- [ ] T017 [P] FR-011 guard: confirm the existing 029/030 provenance + welcome-doc-skip tests still pass on the auto-issue path (signup_source='agent_oauth' stamped, no welcome doc seeded); if any assert only the pre-collapse redirect, extend it to also cover the auto-issue branch (INV-5).
- [ ] T018 [P] FR-012 revocation parity: assert an auto-issued delegation appears in `handleListDelegations` and is revocable via `handleDeleteDelegation` identically to an explicitly-approved one (SC-004) — reuse existing delegation-listing/revocation tests, add an auto-issue-born case if not covered.
- [ ] T019 Adversarial-review carry-forward (research R9, D5, spec Flagged gap 5): add a clearly-marked comment at the `checkRedirectUri` call site on the auto-issue path (and a note in the implement brief) surfacing that auto-registered clients accept any localhost/HTTPS redirect and the auto-issue path removes the human eyeball; state that validation is UNCHANGED per D5 and that any tightening (proposed: restrict the auto-issue path to localhost-only redirects) is owned by the adversarial security review pass and MUST NOT be applied without Sam's ratification. Do NOT tighten in this feature.
- [ ] T020 Run the full affected suites serially (backend Jest + `test/first-run/` harness incl. `oauth-chain-driver.mjs --first-run` and the matrix runner); confirm green. Record results for the implement brief / exit gate.

---

## Dependencies & Execution Order

- **Setup (T001–T002)** → gate everything.
- **Foundational (T003–T005)** → BLOCKS US1 and US2 test assertions (the gate is the mechanism both stories exercise). Serial — all in `completePostAuth`.
- **US1 (T006–T008)**: T006 (client) is independent [P] and can land alongside the gate; T007–T008 require T003–T005.
- **US2 (T009–T012)**: require T003–T005. T009/T010 share the tier-1 test file (serialize or coordinate); T011/T012 are [P] against other files.
- **US3 (T013–T015)**: client-only, independent of the server gate — can proceed in parallel with US1/US2 server work, but T013→T014→T015 are sequential (same JSX branch).
- **Polish (T016–T020)**: after the stories they verify; T016/T017/T018 are [P] (different files); T019 is a comment/doc note; T020 is the final serial gate.

## Parallel Opportunities

- T006 (client href) ∥ T003–T005 (server gate) — different files.
- US3 (T013–T015) client copy ∥ all server/test work.
- Within polish: T016 ∥ T017 ∥ T018 (distinct test files); T011 ∥ T012 within US2.
- Backend Jest tasks (T007, T009, T010, T011) MUST NOT run concurrently at execution time (shared DB, serial) even though authored in parallel.

## Implementation Strategy

- **MVP = US1 (Phase 2 + Phase 3)**: the collapse itself — first-run connects through one screen. Demonstrable via `oauth-chain-driver.mjs --first-run`.
- **Security-complete increment = US1 + US2**: ship only once the counter-assertions, fail-closed matrix, and FR-008 phishing test are green. This is the true minimum shippable for a consent-bypass feature.
- **US3** hardens informed consent and can follow closely; it does not gate the security proof but IS required for FR-009/FR-014 before the tone sign-off.
- **Adversarial review pass** (T019 surfaces it) runs after implementation per the amendment — owns any redirect-tightening decision.
