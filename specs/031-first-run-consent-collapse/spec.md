# Feature Specification: First-Run Consent Collapse

**Feature Branch**: `031-first-run-consent-collapse`

**Created**: 2026-07-22

**Status**: Draft

**Input**: User description: "031-first-run-consent-collapse: collapse first-run agent onboarding to a single consent screen"

**Design ground truth**: `design/plugin-marketplace-publishing.md`, section "Amendment (2026-07-22, ratified by Sam): collapse first-run to a single consent screen" (commit 000c408). This feature also amends the OAuth consent contract described in `design/authentication-and-sharing.md`. This is a CONVERGE feature: code must catch up to the ratified amendment.

## Problem

Sam's first production onboarding walk surfaced that a genuine first-run user — someone whose coding agent sent them to Squire Docs to connect for the first time — passes through **three** Squire screens before the agent connects:

1. The "Connect to Squire Docs" first-run surface (the unauthenticated authorize page) — which already names the agent, states what it will do, and makes the attribution/revocability promise.
2. The generic /login "Welcome Back" page — a second Google button, with returning-user copy shown to a brand-new user.
3. The OAuth consent card ("Authorize Claude Code… Approve/Deny").

For the beachhead flow (agent-first onboarding), screens 2 and 3 are redundant: screen 2 adds nothing but a second identical button with misapplied copy, and screen 3 asks a seconds-old account holding zero documents to protect those zero documents. The amendment collapses true first-run to ONE Squire screen (plus Google's own sign-in, which is not ours to remove), while keeping the explicit consent card exactly where it still earns its keep: existing accounts with real data to protect.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - First-run user connects an agent through a single Squire screen (Priority: P1)

A developer with no Squire Docs account runs their coding agent's connect flow. The agent opens the Squire Docs authorize link in a browser. The developer sees exactly one Squire screen — the "Connect to Squire Docs" first-run surface, which states who is asking, what the grant covers, and that access is revocable — clicks Continue with Google, completes Google's own sign-in, and lands back with the agent connected. No "Welcome Back" login page, no separate Approve/Deny card.

**Why this priority**: This is the entire point of the amendment — the beachhead onboarding flow's friction, observed in Sam's first production walk. Every new agent-first user hits this path.

**Independent Test**: Reset a test identity to first-run, start an agent OAuth connect, and count Squire-owned screens between opening the authorize link and the agent receiving its authorization code. Exactly one, and the connection completes.

**Acceptance Scenarios**:

1. **Given** a person with no Squire Docs account and an agent's authorize link, **When** they open the link, **Then** they see the "Connect to Squire Docs" first-run surface, and its Continue with Google action leads directly to Google sign-in — no intermediate Squire login screen.
2. **Given** that person completes Google sign-in and their account is created in this very round-trip, **When** the sign-in returns to Squire Docs carrying this authorize request's parameters, **Then** the authorization code is issued and the browser is sent to the agent's callback — no consent card is shown.
3. **Given** the same flow, **When** the agent exchanges the code, **Then** the resulting delegation is recorded, attributed, and revocable identically to one approved via the explicit consent card.
4. **Given** the same flow, **When** the account is created, **Then** signup provenance is stamped as agent-originated and no welcome document is seeded (unchanged behavior from 029/030).

---

### User Story 2 - Returning user reconnecting an agent still gives explicit consent (Priority: P1)

A developer who already has a Squire Docs account (with documents in it) connects a new agent, or reconnects an existing one. They still see the first-run/connect surface and then the explicit consent card with Approve/Deny before any code is issued. Net: returning-user reconnect = 2 Squire screens.

**Why this priority**: This is the security half of the amendment and co-equal with Story 1. The consent card is kept exactly where the data it protects exists. If this regresses, a phishing authorize link could silently mint a token against a victim's real documents the moment they sign in.

**Independent Test**: With an existing account (signed in or signing in during the flow), start an agent OAuth connect and verify the explicit Approve step is required — no code is issued without it.

**Acceptance Scenarios**:

1. **Given** a signed-in user with an existing account, **When** they open an agent's authorize link, **Then** they see the explicit consent card and no authorization code exists until they Approve.
2. **Given** a signed-out user with an existing account, **When** they open an agent's authorize link and sign in with Google, **Then** on return they see the explicit consent card — the inline auto-issue does NOT fire, because the account was not created in this round-trip.
3. **Given** an existing account on the consent card, **When** they Deny, **Then** the agent's callback receives the standard denial and no delegation is created (unchanged behavior).

---

### User Story 3 - The single screen carries the full consent story (Priority: P2)

Since the first-run surface becomes the only consent surface a first-run user ever sees, its copy states the grant it now stands in for: what access the agent gets (read plus create/edit/delete of documents, matching the scopes actually requested) and that access can be revoked anytime in Settings → AI Agent Access. Honest, barely longer.

**Why this priority**: Informed consent is what makes the collapse defensible. Without the enriched copy, the collapse trades a redundant screen for an under-informed grant. It is P2 only because Stories 1–2 are mechanically independent of the wording.

**Independent Test**: Load the unauthenticated authorize surface for a write-scoped request and for a read-only request; verify the stated grant matches the requested scopes and the revocation line is present.

**Acceptance Scenarios**:

1. **Given** an authorize request including write scope, **When** the first-run surface renders, **Then** it states the agent will be able to read and create/edit/delete documents in the user's Squire Docs account, and that access is revocable anytime in Settings → AI Agent Access.
2. **Given** a read-only authorize request, **When** the surface renders, **Then** the stated grant is read-only — never broader than what will actually be granted.
3. **Given** any first-run surface render, **Then** the copy uses "Squire Docs" naming and the honest-confident voice — no overclaiming, no self-deprecation.

---

### Edge Cases

- **Phishing authorize link, victim has an account**: An attacker crafts an authorize URL for the attacker's client and lures a victim into signing in. The victim's account is pre-existing, so the auto-issue gate fails and the explicit consent card is shown naming the attacker's client. No token is minted without the victim's explicit Approve. (FR-008)
- **Phishing authorize link, victim has no account**: Worst case, the attacker obtains a token bound to a brand-new account containing zero documents — the account the flow itself just created. Never a token against any existing user's documents. (FR-008)
- **Round-trip state lost** (e.g., the short-lived return-destination state expires while the user dawdles on Google's screens): no auto-issue fires; the user lands in the standard browser onboarding. The agent connect does not complete and the agent's normal retry/timeout applies. No error dead-end, no partial delegation. (Pre-existing behavior; see Flagged gaps note 4.)
- **Return destination is valid but is not an authorize request** (e.g., a plain in-app path): behaves exactly as today — redirect to that path, never an auto-issue. Auto-issue requires the full validated OAuth parameter set. (FR-005)
- **Auto-issue precondition fails validation** (unknown/invalid redirect target for the client, malformed PKCE challenge, invalid scope): no code is issued inline; the user falls back to the standard authorize surface where the existing flow surfaces the error or the explicit consent card. Fail closed into the explicit path, never fail open into a minted code. (FR-010)
- **New account, but the return carries someone else's or a stale authorize request**: the parameters used for auto-issue must originate exclusively from the server-bound round-trip state established when this flow entered Google sign-in — never from any client-modifiable channel after authentication. (FR-005)
- **First-run user changes their mind**: the single screen has no Deny button — declining is abandoning (closing the tab / not clicking Continue). No account is created and nothing is granted. The existing "declined consent" behavior on the consent card remains for existing accounts. (See clarifications: RATIFIED-BY-DEFAULT D4, D6.)
- **Same person, second agent, minutes later**: the account now exists, so connecting a second agent goes through the explicit consent card — isNew is a property of this round-trip's account creation, not of account age. (FR-004)

## Requirements *(mandatory)*

### Functional Requirements

**Flow collapse**

- **FR-001**: The unauthenticated first-run authorize surface's "Continue with Google" action MUST lead directly to the Google sign-in entry, carrying the full authorize request (with its OAuth parameters) as the return destination. It MUST NOT route through the generic Squire login page, and the "Welcome Back / Don't have an account?" copy MUST NOT appear in the first-run agent-connect flow.
- **FR-002**: The return destination (the authorize request URL with its OAuth parameters) MUST survive the Google sign-in round-trip via the existing server-bound, same-origin-validated mechanism, unchanged in its validation rules (same-origin relative path, open-redirect defenses, bounded lifetime).
- **FR-003**: When Google sign-in returns and (a) the account was created in this very round-trip and (b) the return destination carries the validated OAuth parameters of this authorize request, the system MUST issue the authorization code inline and redirect the browser to the agent's callback with code and state — without showing the consent card.

**Security floor (load-bearing — this is consent-bypass territory)**

- **FR-004 (SECURITY)**: The inline auto-issue MUST fire only when the account was created during this very sign-in round-trip, as determined by the actual account-insertion outcome (the existing isNew signal from creation) — never by heuristics such as account age, empty document list, or prior session state. It MUST NEVER fire for a pre-existing account, whether that account signed in during this flow or was already authenticated.
- **FR-005 (SECURITY)**: The inline auto-issue MUST use OAuth parameters (client identifier, redirect target, PKCE code challenge and challenge method, state, scopes) that originate exclusively from the server-bound round-trip state established when this flow entered Google sign-in, and those parameters MUST pass the same validation as the standard authorize entry point (client resolution, redirect-target rules, PKCE challenge format, scope validation). Parameters from any client-modifiable channel after authentication MUST NOT be accepted for auto-issue. Any validation failure MUST prevent auto-issue.
- **FR-006 (SECURITY)**: PKCE and redirect-target validation MUST be unchanged from the existing flow, and the auto-issued delegation MUST be created through the same approval core as an explicit Approve — recorded, attributed to the agent client, and revocable in Settings → AI Agent Access exactly as if the user had clicked Approve. No parallel code-minting path.
- **FR-007 (SECURITY)**: Existing accounts MUST continue to receive the explicit consent card with Approve/Deny before any code is issued, in every arrival order (already signed in, or signing in during the flow). Net screen counts: true first-run = 1 Squire screen; returning-user reconnect = 2 Squire screens.
- **FR-008 (SECURITY)**: Under a phishing authorize URL for an attacker-controlled client that lures a victim into signing in, the system MUST guarantee the blast radius of the auto-issue path is at most a token bound to a brand-new account created by that very flow and holding zero documents — never a token against any existing user's account or documents. This MUST be covered by an explicit automated test.

**Consent surface**

- **FR-009**: The first-run surface MUST state the grant it stands in for: reading plus creating, editing, and deleting documents in the user's Squire Docs account when write scope is requested, and a strictly narrower statement for read-only requests — the stated grant MUST match the scopes actually requested and subsequently granted. It MUST include that access is revocable anytime in Settings → AI Agent Access. Copy MUST say "Squire Docs" and follow the honest-confident voice.
- **FR-010**: When the return destination is valid but auto-issue preconditions are not all met (pre-existing account, missing/invalid OAuth parameters, validation failure), the system MUST fall back to the existing behavior — redirecting to the authorize surface for explicit consent — and MUST NOT dead-end the user or leak why auto-issue was withheld into an attacker-readable channel beyond the standard flow's responses.

**Unchanged adjacent behavior (guard rails, not respecs)**

- **FR-011**: Signup provenance stamping (agent-originated at creation) and the deliberate welcome-document skip for consent-born accounts MUST remain unchanged and covered by their existing tests passing.
- **FR-012**: Auto-issued delegations MUST appear in the revocation surface (Settings → AI Agent Access) and in delegation listings identically to explicitly approved ones, and revocation MUST work identically.

**Verification**

- **FR-013**: The automated OAuth-chain verification MUST gain a first-run variant proving the collapsed flow end to end: a freshly created account's authorize round-trip yields an authorization code and completed token exchange WITHOUT any separate consent-approval action; and a companion assertion that an existing account's identical round-trip does NOT auto-issue and still requires the explicit approve. The first-run rehearsal matrix's connect-flow cells MUST be updated to the new screen count (one Squire screen for first-run connect), including any coaching-contract checklist lines that reference the old three-screen shape.

### Key Entities

- **User account**: The identity created or found at Google sign-in. Carries the creation-time signals this feature keys on: whether it was created in this round-trip (isNew), and signup provenance. A just-created account holds zero documents — the fact that makes the auto-issue safe.
- **Authorize request**: An agent's OAuth request — client identifier, redirect target, PKCE challenge (+ method), state, scopes. Exists as URL parameters on the authorize surface and, during the collapse, as the return destination carried through Google sign-in.
- **Round-trip state**: The server-bound record of the return destination established when the flow enters Google sign-in. It is the binding between "this authorize request" and "this account creation" — the thing FR-005 trusts and everything else must not.
- **Authorization code / delegation**: The short-lived code minted at approval (explicit or auto-issued) and the durable, attributed, revocable delegation created when the agent exchanges it. Identical in shape and lifecycle regardless of approval path.
- **Consent surfaces**: (1) the first-run "Connect to Squire Docs" surface — after this feature, the sole consent surface for first-run; (2) the explicit consent card with Approve/Deny — retained for existing accounts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A genuine first-run user goes from opening the agent's authorize link to the agent being connected through exactly 1 Squire-owned screen (plus Google's own sign-in) — down from 3.
- **SC-002**: A returning user connecting or reconnecting an agent passes through exactly 2 Squire-owned screens, with an explicit Approve required before any access is granted.
- **SC-003**: Zero authorization codes are ever issued without explicit approval for pre-existing accounts — demonstrated by automated tests covering both arrival orders (already signed in; signing in during the flow) and the phishing scenario.
- **SC-004**: Auto-issued delegations are indistinguishable from explicitly approved ones in attribution, listing, and revocation — revoking one takes the same steps and has the same effect.
- **SC-005**: The automated first-run verification proves the collapsed flow end to end (account creation through token exchange with no consent-approval action) and runs green in the suite.
- **SC-006**: First-run consent copy names the full grant and the revocation path on the one screen the user sees, and never states a broader grant than requested.

## Assumptions

- **Post-issue landing**: After inline auto-issue, the browser is redirected straight to the agent's callback URL; the Squire "Authorized — this window will close" interstitial is not shown on this path. Adding one would reintroduce a second screen and defeat the amendment. (RATIFIED-BY-DEFAULT D1.)
- **Binding mechanism**: "The OAuth parameters of THIS authorize request, validated and matched" (amendment wording) is realized by the server-bound round-trip state (the httpOnly return-destination cookie set at Google-entry time) being the only accepted parameter source, re-validated with the standard authorize validation on return. There is no separate server-side pending-authorize record today, and this feature does not require inventing one. (RATIFIED-BY-DEFAULT D2; see Flagged gaps note 1.)
- **Matched parameter set** includes the PKCE challenge method alongside client identifier, redirect target, challenge, and state — the amendment's list omits the method, but it is part of the request and is carried/validated today. (RATIFIED-BY-DEFAULT D3.)
- **No Deny affordance on the first-run surface**: declining is abandoning before Google sign-in; no account is created. The enriched copy (FR-009) is the informed-consent compensator. (RATIFIED-BY-DEFAULT D4.)
- **Scope of "screens"**: Google's own sign-in and consent screens are outside Squire's control and excluded from all screen counts.
- **This is a fast-follow**: it amends the ratified M2/030 consent-page design but does not reopen M2/030 sign-off. Provenance and welcome-doc behavior are guarded (FR-011), not respecified.
- **Adversarial review**: per the amendment, the auto-issue path receives an adversarial security review pass after implementation (pipeline stage, not a spec requirement).

## Flagged gaps and discrepancies vs code

Recorded per converge discipline — none silently resolved:

1. **"Matched" has no server-side pending-request ledger.** The amendment says the return "carries the OAuth parameters of THIS authorize request… validated and matched." In code there is no stored pending-authorize record to match against; the binding is the httpOnly return-destination cookie set when the flow enters Google sign-in (server-set, same-origin-validated, bounded TTL), whose value embeds the parameters. The spec pins the enforceable form of "matched" as FR-005 (server-bound state is the sole parameter source + full revalidation). If planning concludes cookie binding is insufficient, a pending-request record is the escalation path — flagged, not decided here.
2. **Amendment's security-floor parameter list omits `code_challenge_method`.** The request carries it (defaulting to S256) and the existing flow stores and validates it. Spec includes it in the matched set (FR-005). Discrepancy is between the amendment's shorthand and the actual parameter surface — resolved toward the stricter reading.
3. **Round-trip state TTL loss degrades silently today.** The return-destination cookie has a bounded lifetime; if it expires during the Google leg, the user lands in standard browser onboarding — with browser provenance and a seeded welcome doc, and the agent connect silently doesn't complete. This is pre-existing 005/029 behavior, not introduced here; the collapse makes it slightly more likely to matter (first-run users read the new copy). Out of scope to fix; flagged for awareness and a possible follow-up ticket.
4. **First-run "declined consent" shape changes.** The rehearsal matrix's declined-consent cell exercises clicking Deny on the consent card. After the collapse, a first-run user has no Deny; declining is abandoning. The existing-account flow keeps Deny. The matrix cell needs retargeting (first-run decline = abandon; explicit Deny moves to the existing-account cell) — folded into FR-013. (RATIFIED-BY-DEFAULT D6.)
5. **Auto-registered clients accept any HTTPS or localhost redirect target.** Existing behavior: clients registered on first sight have an empty allow-list and any localhost or HTTPS redirect target passes. Today the consent card shows the redirect URL so the human can judge it; on the auto-issue path no human sees it. This does not widen the blast radius beyond FR-008's ceiling (a token on a just-created empty account), and the amendment explicitly keeps redirect validation unchanged — but it is the sharpest edge of the auto-issue path and is called out for the adversarial security review pass. (RATIFIED-BY-DEFAULT D5: keep validation unchanged per the amendment; review pass owns any tightening proposal.)

## Verification approach *(informative, for planning)*

- **Tier 1 (backend integration)**: unit-level assertions on the auto-issue gate — isNew true/false × valid/invalid/missing OAuth parameters × pre-authenticated session — asserting code-mint vs consent-redirect outcomes, plus the FR-008 phishing case and FR-011 guard tests staying green.
- **Tier 2 (headless OAuth-chain driver, `test/first-run/`)**: a first-run variant of the existing chain driver using the fresh-user faucet's browser mode, asserting the chain completes 401 → metadata → registration → authorize → Google-standin sign-in (account created) → code → token WITHOUT calling any consent-approval endpoint; and the companion existing-account run asserting the chain does NOT complete without the explicit approve step.
- **Tier 3 (rehearsal matrix)**: connect-cell expectations updated to one Squire screen for first-run; declined-consent cell retargeted per gap note 4.
- **Human acceptance**: Sam's production self-test (selftest@example.com reset → real browser walk) is the acceptance gate for the real Google leg, per the ratified testing design.
