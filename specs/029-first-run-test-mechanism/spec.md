# Feature Specification: First-Run Test Mechanism (Plugin M1)

**Feature Branch**: `029-first-run-test-mechanism`

**Created**: 2026-07-21

**Status**: Draft

**Input**: User description: "Feature 029-first-run-test-mechanism: M1 test mechanism from plugin-marketplace-publishing design"

**Design ground truth**: `/local-dev/design/plugin-marketplace-publishing.md` (ratified 2026-07-21) — sections "Repeatable first-run testing", "Dev-server support", and Build milestone **M1 — Test mechanism** only. M2 (plugin logic/coaching content) and M3 (packaging/distribution) are explicitly out of scope and gated on Sam's M1 exit sign-off.

## Overview

The plugin first-run onboarding flow (`/squire:onboard`, built in M2) must be cheap to rehearse dozens of times while its coaching is tuned — without burning real Google accounts, real Claude accounts, or a human clicking through browsers. This feature builds the test mechanism that makes that possible: a fresh-user faucet, a consent auto-approve step, user reset (synthetic wipe + one deliberately prod-enabled single-account reset), a headless driver for the full agent OAuth chain, an unattended in-pod rehearsal harness with transcript grading, and the small app changes (signup provenance, load-bearing welcome-doc skip) that the cheapest test tier asserts.

Two verified facts underpin the design (re-verified against code 2026-07-21 during spec authoring):

- A "new Squire user" is just a missing users row — sign-in is find-or-create, so hard-deleting a user row makes the next sign-in a genuine first run.
- The Claude Code client's auth state lives in its config dir (on Linux), so a scratch config dir is a client that has never seen the plugin or the server.

**Gating invariant (constitution-level for this feature):** every dev endpoint is fail-closed behind an explicit positive `ENABLE_DEV_ENDPOINTS` opt-in — never gated solely by a `NODE_ENV !== 'production'` negative (the 2026-07-21 prod incident: `NODE_ENV` was unset in prod, so negatively-gated dev routes were reachable). The production single-account reset is the ONE deliberate prod-enabled exception, neutered by a hardcoded single-email allowlist.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Mint a genuine first-run user on demand (Priority: P1)

A developer (or automated harness) working on the first-run flow needs a brand-new Squire account — one that has never signed in, has no docs, no delegations, no tokens — on demand, in seconds, without a real Google identity. They call the fresh-user faucet and get a synthetic `test+<nonce>@test.local` user; a browser mode of the same faucet stands in for Google on the consent page's sign-in leg (sets session cookies, honors a validated returnTo) so the real consent round-trip can be exercised end to end. When done, a synthetic wipe hard-deletes the test user and everything hanging off it, so the identity is first-run again.

**Why this priority**: Every other deliverable in this feature (headless driver, rehearsal harness, tier-1 tests) composes on top of these primitives. Without them nothing else is testable.

**Independent Test**: On a dev server with dev endpoints enabled, mint a fresh user via the faucet, confirm the account exists and is session-authenticated, walk the consent sign-in leg via browser mode with a returnTo, then wipe the user and confirm the row and all dependent data are gone and a re-mint produces a genuinely new account.

**Acceptance Scenarios**:

1. **Given** a dev server with dev endpoints enabled, **When** the faucet is called with `fresh: true`, **Then** a new `test+<nonce>@test.local` user is created (not the fixed dev user) and authenticated, and repeated calls produce distinct users.
2. **Given** an unauthenticated browser-like client on the consent page's sign-in leg, **When** it uses the faucet's browser mode with a valid same-origin returnTo, **Then** session cookies are set and the client is redirected to the returnTo destination — exactly the shape of the real Google round-trip.
3. **Given** the dev-bypass consent path in the client (AuthorizePage → /login → dev login), **When** a fresh synthetic sign-in is requested, **Then** the client forwards the fresh/nonce request to the browser-mode endpoint (today the client posts no body — this client change is in scope).
4. **Given** a synthetic test user with docs, delegations, registered clients, and tokens, **When** the synthetic wipe targets it, **Then** the user row and all dependent data are hard-deleted and the next sign-in for that identity is a genuine first run.
5. **Given** the synthetic wipe endpoint, **When** it is asked to delete any account whose email does not match the synthetic test pattern, **Then** it refuses.
6. **Given** a server where `ENABLE_DEV_ENDPOINTS` is not set, **When** any faucet/wipe/auto-approve endpoint is requested, **Then** it is not reachable (fail-closed), regardless of `NODE_ENV`.

---

### User Story 2 - Prove the agent OAuth chain headlessly (Priority: P1)

A developer changes anything touching auth, consent, or the MCP surface and wants proof the entire agent connect chain still works — without opening a browser. They run the headless OAuth-chain driver, which walks the real chain against the dev server: unauthenticated tool call (401) → protected-resource metadata → authorization-server metadata → dynamic client registration → PKCE authorize → consent → token → authenticated tool call. The two browser legs (sign-in and consent approval) are driven by the faucet's browser mode and the consent auto-approve endpoint.

**Why this priority**: This is the regression net for the whole machinery: it proves end to end, on every change, that an agent can connect — the product's core activation event.

**Independent Test**: Run the driver against a clean dev server; it must complete every step of the chain unattended and finish with a working access token that can call a real MCP tool.

**Acceptance Scenarios**:

1. **Given** a dev server with dev endpoints enabled, **When** the driver runs, **Then** every step of the chain (401 challenge, resource metadata, AS metadata, dynamic client registration, PKCE authorize, consent, token exchange) completes with no human interaction and the resulting token successfully authenticates a tool call.
2. **Given** a synthetic session created by the faucet, **When** the consent auto-approve endpoint is called, **Then** the /authorize Approve step completes and the authorization code is minted without a browser click.
3. **Given** a session belonging to a non-synthetic (real) user, **When** the consent auto-approve endpoint is called, **Then** it refuses — auto-approve is synthetic-session-only.
4. **Given** a real Claude Code authorize URL (with PKCE code_challenge, state, redirect_uri, client id), **When** its length is measured against the 512-character returnTo cap, **Then** the measurement is recorded, and if the URL is near or over the cap the cap is raised (still same-origin-validated) or the OAuth parameters are carried server-side — so the post-sign-in round-trip never silently loses its OAuth parameters.

---

### User Story 3 - Signup provenance and the load-bearing welcome-doc skip (Priority: P2)

The business needs to distinguish agent-first accounts (born through an agent consent flow) from browser signups — data that is cheap to record now and impossible to backfill later. Accounts record a signup source at creation: `browser` by default, `agent_oauth` when the account is created during a consent returnTo round-trip. Separately, accounts born through consent deliberately get no browser welcome doc (today true by accident — this feature makes it intentional and test-covered), and no client surface may misbehave when a user's welcome doc is null.

**Why this priority**: These are the only production app changes in M1 and what the cheapest test tier asserts; they must exist before the rehearsal loop starts generating agent-first accounts, or the provenance data is lost forever.

**Independent Test**: Backend integration tests create accounts through both paths and assert stamping, the welcome-doc skip, and the null-welcome-doc contract — runnable in the standard backend suite with no human.

**Acceptance Scenarios**:

1. **Given** a new account created through the browser sign-in path, **When** the account row is inspected, **Then** its signup source is `browser`.
2. **Given** a new account created mid consent returnTo round-trip (sign-in leg carrying a validated returnTo back to the consent page), **When** the account row is inspected, **Then** its signup source is `agent_oauth` and it has no welcome doc.
3. **Given** an existing account (created before this feature), **When** it is read, **Then** it reports the default `browser` source — no backfill, no breakage.
4. **Given** a user whose welcome doc is null, **When** they use any client surface that references onboarding/welcome state, **Then** nothing misbehaves (no errors, no broken redirects, no stuck onboarding prompts).
5. **Given** the tier-1 backend integration suite, **When** it runs, **Then** it covers: the consent returnTo round-trip with account creation, signup-source stamping, the deliberate welcome-doc skip, and the null-welcome-doc client contract.

---

### User Story 4 - Unattended in-pod rehearsal of the first-run flow (Priority: P2)

A developer (or the pipeline) wants to rehearse the *entire* plugin first-run experience — pristine client, plugin install, connect coaching, consent, first tool call — unattended, in the Linux dev pod. A harness creates a scratch client config dir (a Claude Code that has never seen the plugin or server), adds the plugin bundle as a local-path marketplace, installs it pointed at the dev server, mints a fresh synthetic user, drives Claude Code non-interactively, completes consent via auto-approve, and grades the resulting transcript against a coaching-contract checklist. One command produces a pristine first-run environment in a couple of minutes.

**Why this priority**: This is the tuning loop M2 will iterate against, and its one-command pristine environment is M1's exit criterion — but it composes the P1 primitives, so it lands after them.

**Independent Test**: Run the harness's one command in the dev pod; it must produce a pristine environment, complete an unattended rehearsal, and emit a graded transcript — repeatably, with no state bleed between runs.

**Acceptance Scenarios**:

1. **Given** the dev pod, **When** the harness command runs, **Then** a pristine first-run environment (scratch client config, fresh synthetic user, installed plugin pointed at the dev server) exists within a couple of minutes, with no human interaction.
2. **Given** the shipped plugin bundle must point at production while the harness needs the dev server, **When** the harness installs the plugin, **Then** the MCP endpoint is redirected to the dev server either via environment interpolation (if the client's MCP config supports it — verify at implement time) or by templating a throwaway copy of the bundle — never by mutating the source bundle.
3. **Given** that the real plugin content is M2/M3 work and `distribution/` does not exist yet, **When** the harness needs a plugin to install, **Then** it uses a minimal stub bundle (manifest + MCP config + placeholder skill/command) that is sufficient to install and connect — explicitly scaffolding-for-testing, not the shipping bundle.
4. **Given** a completed rehearsal, **When** the transcript is graded, **Then** each coaching-contract checklist item (signup-creates-account line before the browser step, bare URL on its own line, silent reconnect, byte-channel sync, doc URL delivered, loop taught) gets an explicit pass/fail — with stub content, the grading mechanism is what's validated in M1; full passes arrive with M2's content.
5. **Given** the harness runs in the pod, **When** the OAuth localhost callback naturally fails, **Then** the remote paste-back branch is exercised by default — a feature, not a bug.
6. **Given** two consecutive harness runs, **When** the second runs, **Then** it gets a genuinely new user and pristine client state — no bleed from the first.
7. **Given** the platform caveat that macOS stores client OAuth credentials in the system Keychain (which a scratch config dir does not clear), **When** pristine rehearsals are needed, **Then** they run in the Linux dev pod; macOS support is documented as out of scope, not built.

---

### User Story 5 - Production single-account reset for the human self-test (Priority: P3)

Sam's acceptance gate before any publish is walking the real first-run flow in production — real Google consent screen, real browser, real prod. He uses `selftest@example.com` (a deliberately empty throwaway Google account) as a disposable first-run identity. One admin-authenticated command resets *only that account* to first-run (hard-delete of the row and everything hanging off it), so each reset makes the next real sign-in a genuine first run. He can repeat this as often as he likes.

**Why this priority**: The human self-test itself is M2's exit; M1 only ships the reset capability. It is last because it is small and depends on the reset machinery from Story 1.

**Independent Test**: As an admin, invoke the production reset; confirm it deletes only the hardcoded account's data and that any attempt to widen the target fails by construction (there is no target parameter to widen).

**Acceptance Scenarios**:

1. **Given** an admin-authenticated caller in production, **When** the single-account reset is invoked, **Then** the account matching the hardcoded address — and only that account — is hard-deleted with all dependent data (docs, delegations, registered clients, tokens), and the next sign-in for that identity is a genuine first run.
2. **Given** the reset endpoint, **When** its interface is inspected, **Then** it accepts no free-form target: no user id, no email parameter, no wildcard, no configuration-driven list — the sole target is a hardcoded compile-time constant, `selftest@example.com` (D6, ratified by Sam 2026-07-21).
3. **Given** a non-admin caller, **When** the reset is invoked, **Then** it is rejected.
4. **Given** the hardcoded account does not currently exist (already reset), **When** the reset is invoked, **Then** it succeeds as a no-op — reset is idempotent.
5. **Given** the fail-closed gating rule, **When** the endpoint inventory is audited, **Then** this reset is the only dev-support endpoint reachable in production, and its worst case is the deletion of one deliberately-empty account (recoverable from database backup — a heavy last-resort restore, not routine undo).

---

### Edge Cases

- `ENABLE_DEV_ENDPOINTS` unset (prod or anywhere): all synthetic endpoints (faucet, browser mode, auto-approve, synthetic wipe) are unreachable — fail-closed, independent of `NODE_ENV`.
- `ENABLE_DEV_ENDPOINTS` accidentally set in a production-like environment: the existing belt-and-suspenders `NODE_ENV !== 'production'` secondary guard still blocks the synthetic endpoints (the invariant forbids the negative check as the *only* gate, not as an *additional* one).
- returnTo value exceeding the length cap: today silently dropped, losing the OAuth round-trip — the measurement requirement (FR-019) exists precisely to catch this before M2 rehearsals hit it.
- Faucet nonce collision: minting must yield a distinct user per call; colliding with an existing synthetic user must not corrupt it (find-or-create semantics make the collision a login, not an error — harness runs should use fresh nonces).
- Synthetic wipe pointed at a real user's email: refused by pattern check; the wipe can only ever target the synthetic namespace.
- Auto-approve called for a real user's session: refused; auto-approve only completes consent for faucet-minted synthetic sessions.
- Rehearsal harness on macOS: pristine state is not achievable via scratch config dir (Keychain caveat); harness documents Linux-pod-only and does not attempt Keychain purging.
- Client MCP config does not support environment interpolation for the endpoint: harness falls back to templating a throwaway bundle copy; the source bundle is never mutated.
- Backend tests share one database and must run serially (constitution II); the new tier-1 tests and any harness-driven DB activity must respect the serial-only constraint.
- The existing `dev-onboarding-reset` endpoint (browser welcome-flow reset) remains unchanged — it is not sufficient for first-run testing because first-run means no account at all, but it still serves the browser-first welcome flow.
- Production reset invoked while the throwaway account has an active agent session: hard-delete proceeds; dependent tokens/delegations die with the cascade and the agent's next call fails authentication — acceptable for a dataless test account.

## Requirements *(mandatory)*

### Functional Requirements

**Gating invariant**

- **FR-001**: Every dev-support endpoint introduced by this feature MUST be fail-closed behind the explicit positive opt-in `ENABLE_DEV_ENDPOINTS` — off by default, enabled only in the dev/staging overlay. Gating MUST NOT rely on a `NODE_ENV !== 'production'` negative as the sole condition. (The existing additional `NODE_ENV` secondary guard is retained for all synthetic endpoints.)
- **FR-002**: The production single-account reset (FR-014) is the ONLY endpoint from this feature reachable in production. It MUST be gated behind admin authentication and MUST NOT depend on `ENABLE_DEV_ENDPOINTS`.

**Fresh-user faucet**

- **FR-003**: The existing dev-login endpoint MUST accept a `fresh: true` option that mints a new synthetic user with email `test+<nonce>@test.local` (distinct per nonce) instead of the fixed dev user, authenticated exactly as the existing dev login authenticates.
- **FR-004**: The faucet MUST offer a browser mode that sets session cookies and responds with a redirect honoring a validated same-origin returnTo (reusing the existing returnTo validation predicate) — standing in for Google on the consent page's sign-in leg, following the same code path that stamps signup provenance and skips welcome-doc seeding on the consent round-trip.
- **FR-005**: The client's dev-bypass consent path (consent page → login → dev login, which today posts no request body) MUST be extended to forward the fresh/nonce request and use the browser-mode endpoint, so the React consent path composes with the faucet. This client change is explicitly in M1 scope.

**Consent auto-approve**

- **FR-006**: A dev-only endpoint MUST complete the consent Approve step for a synthetic session — minting the agent's authorization code — without a browser click.
- **FR-007**: Auto-approve MUST refuse sessions that do not belong to a faucet-minted synthetic user (synthetic-session-only).

**User reset**

- **FR-008**: A synthetic wipe MUST hard-delete a synthetic test user and everything hanging off the row — documents, delegations, registered OAuth clients, and tokens — so the identity's next sign-in is a genuine first run.
- **FR-009**: The synthetic wipe MUST only accept targets in the synthetic namespace (`test+<nonce>@test.local`); any other target is refused. It is dev/staging-only, behind `ENABLE_DEV_ENDPOINTS`, and never available in production.
- **FR-010**: The production single-account reset MUST perform the same hard-delete cascade for exactly one account whose address is a hardcoded compile-time constant: `selftest@example.com` (D6). The endpoint MUST NOT accept any free-form target — no user id, email parameter, wildcard, or configuration-driven list.
- **FR-011**: Both resets MUST be idempotent: resetting an identity with no account row succeeds as a no-op.

**Signup provenance and welcome-doc contract (app changes)**

- **FR-012**: User accounts MUST record a signup source at creation: `browser` (default, including all pre-existing accounts) or `agent_oauth` (account created during a consent returnTo round-trip). The schema change MUST go through the standard migration mechanism with a timestamp greater than the current latest migration (1799200000000; see clarifications ledger — the >1795000000000 floor from the rolled-back-008 cleanup is subsumed).
- **FR-013**: Accounts created through the consent returnTo round-trip MUST NOT receive a browser welcome doc — the existing accidental skip becomes deliberate, load-bearing, and test-covered.
- **FR-014**: No client surface may misbehave for accounts with a null welcome doc; this contract MUST be verified by test.

**Tier-1 backend integration tests**

- **FR-015**: The backend suite MUST gain integration tests covering: (a) the consent returnTo round-trip with mid-flow account creation, (b) signup-source stamping for both paths, (c) the deliberate welcome-doc skip for consent-born accounts, (d) the null-welcome-doc client contract. These run serially with the existing suite, no human required.

**returnTo length budget (adversarial-review finding M4)**

- **FR-016**: A real Claude Code authorize URL (carrying PKCE code_challenge, state, redirect_uri, and client id) MUST be measured against the 512-character returnTo cap. If the measurement is near or over the cap, the cap MUST be raised (retaining same-origin validation) or the OAuth parameters carried server-side instead of in returnTo. The measurement and the decision MUST be recorded in the feature's artifacts.

**Headless OAuth-chain driver (tier 2)**

- **FR-017**: A scripted driver MUST walk the real agent connect chain against the dev server — unauthenticated call (401) → protected-resource metadata → authorization-server metadata → dynamic client registration → PKCE authorize → consent → token — completing both browser legs via the faucet's browser mode and the auto-approve endpoint, with zero human interaction, and finishing with a token that successfully authenticates a real tool call.
- **FR-018**: The driver MUST be runnable on every change (single command, dev server) as a regression check for the whole chain.

**Rehearsal harness (tier 3)**

- **FR-019**: A harness MUST produce a pristine first-run environment unattended: scratch client config dir (a client that has never seen the plugin or server), the plugin bundle added as a local-path marketplace and installed, a fresh synthetic user minted, and the plugin's MCP endpoint pointed at the dev server.
- **FR-020**: Endpoint indirection MUST NOT mutate the source bundle: if the client's MCP config supports environment interpolation for the endpoint URL, use it (verify at implement time); otherwise the harness templates a throwaway copy.
- **FR-021**: Because `distribution/` does not exist yet (M3 work), the harness MUST include a minimal stub plugin bundle — manifest, MCP config, placeholder skill and command — sufficient to install and connect. The stub is scaffolding-for-testing, clearly marked as such, and is NOT the shipping bundle (whose content is M2/M3).
- **FR-022**: The harness MUST drive the client non-interactively (non-interactive prompt mode, or a scripted user-simulator on an interactive session), complete consent via auto-approve, and capture the full transcript.
- **FR-023**: Each transcript MUST be graded against the coaching-contract checklist with an explicit pass/fail per item: signup-creates-account line before the browser step, bare authorization URL on its own line, expected localhost-callback failure handled via paste-back, silent reconnect and continuation, byte-channel (never retyped) sync, doc URL delivered, loop taught. In M1, with stub content, the grading mechanism itself is the deliverable; full checklist passes are M2's exit, not M1's.
- **FR-024**: Pristine rehearsals are Linux-pod-only (macOS Keychain caveat, finding M6): the limitation MUST be documented by the harness; macOS Keychain-purge support MUST NOT be built.

**Exit criterion**

- **FR-025**: One command MUST produce a pristine first-run environment in a couple of minutes, demonstrated end to end; human-in-the-loop remains only where a browser inherently is (i.e., nowhere in the synthetic tiers).

### Key Entities

- **Synthetic test user**: an account in the `test+<nonce>@test.local` namespace, minted by the faucet, indistinguishable from a real account to the application, wipeable without ceremony. The namespace is the security boundary for the wipe and auto-approve.
- **Signup provenance**: a per-account attribute recording how the account was born — `browser` (default) or `agent_oauth` (created mid consent round-trip). Stamped once at creation; never backfilled.
- **Dev-endpoint gate**: the positive `ENABLE_DEV_ENDPOINTS` opt-in controlling all synthetic endpoints; absent means off.
- **Production reset allowlist**: a hardcoded compile-time constant containing exactly one address (`selftest@example.com`); the entire target surface of the prod-enabled reset.
- **Stub plugin bundle**: minimal installable plugin (manifest + MCP config + placeholder skill/command) used only by the rehearsal harness until the real bundle exists; marked scaffolding-for-testing.
- **Rehearsal transcript & grading checklist**: the captured non-interactive session output plus the per-item coaching-contract pass/fail grade — the artifact M2 will iterate against.
- **Reset cascade**: the set of data hanging off a user row that hard-delete must remove — documents, delegations, registered OAuth clients, tokens — such that the identity's next sign-in is a genuine first run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: One command yields a pristine first-run environment (fresh account + pristine client state + installed plugin pointed at the dev server) in under 3 minutes, with zero human interaction. (M1 exit criterion.)
- **SC-002**: The full agent connect chain — from unauthenticated 401 to an authenticated tool call — completes headlessly on demand, and can be re-run after any change as a single command.
- **SC-003**: Two consecutive rehearsal runs each get a genuinely new account and pristine client state — zero state bleed, verified by run N+1 seeing no artifacts of run N.
- **SC-004**: With the enabling flag unset, every synthetic endpoint is unreachable — verified by test in both flag-off and production-like configurations.
- **SC-005**: The production reset can affect exactly one predefined dataless account and nothing else — verified by inspection (no target parameter exists) and by test (only the hardcoded identity's data is removed).
- **SC-006**: 100% of accounts created after this feature ships carry accurate signup provenance, separable into agent-first vs browser cohorts from day one.
- **SC-007**: The tier-1 assertions (consent round-trip account creation, provenance stamping, welcome-doc skip, null-welcome-doc contract) run green in the standard backend suite with no human.
- **SC-008**: Every rehearsal produces a graded transcript with an explicit pass/fail per coaching-contract checklist item.

## Assumptions

- The verified-2026-07-21 code claims in the design doc were re-verified during spec authoring and hold: the returnTo validator caps at 512 chars with same-origin checks; Google sign-in is find-or-create with the account created mid-flow; the consent returnTo branch returns before welcome-doc seeding; the current dev login mints only the fixed dev user, returns JSON only, and the client posts no body. No discrepancies found (see clarifications ledger for minor notes).
- The existing admin-authentication mechanism (admin-flagged users) is sufficient for the production reset; no new auth machinery is introduced (008/009 lesson).
- The dev/staging overlay already sets `ENABLE_DEV_ENDPOINTS=1` (introduced in the 2026-07-21 hardening fix); this feature extends what lives behind it rather than inventing new gating.
- The rehearsal harness runs in the Linux dev pod, where the localhost OAuth callback naturally fails — deliberately exercising the remote paste-back branch by default.
- Backend tests share one database and run serially (constitution II); all new tests comply.
- The coaching-contract checklist items are fixed by the design doc; their full satisfaction is M2's exit. M1 delivers the mechanism that grades them.
- The sign-off test matrix in the design (declined consent, abandoned tab, repo-shape variants, etc.) is M2's rehearsal content; M1 delivers the harness those rehearsals run on.
- M2 and M3 are NOT specced or built until Sam signs off M1's exit (milestone gating, ratified 2026-07-21).

## Out of Scope

- `shared/skill.md` / `shared/onboard.md` content, first-run coaching, and tone (M2).
- The consent-page first-run copy/framing change (M2).
- All manifests, mirror repos, `publish.mjs`, drift tests, and wave submissions (M3) — including the real `distribution/` tree; only the test stub ships here.
- macOS Keychain-purge support for pristine rehearsals (recorded caveat, Linux-pod-only).
- Redefining `onboarded_at` or any activation-metric semantics (stays with the strategy doc).
- Everything the design doc lists as out of scope (browser signup funnel reordering, GitHub App, ChatGPT directory, Claude Connectors Directory).
