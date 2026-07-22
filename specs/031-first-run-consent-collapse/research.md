# Phase 0 Research: First-Run Consent Collapse

All decisions below resolve the spec's Technical Context and Flagged-gaps into concrete, code-anchored mechanisms. No NEEDS CLARIFICATION remained after these. Decisions D1–D6 from `clarifications-needed.md` are RATIFIED-BY-DEFAULT and are treated as settled inputs, not re-opened here.

## R1 — The server-bound binding is the `oauth_return_to` httpOnly cookie (D2, FR-005)

**Decision**: The single accepted source of the OAuth parameters for auto-issue is the value of the `oauth_return_to` httpOnly cookie set by `GET /auth/google` (routes.js:128) when the flow enters Google sign-in. Its value is the same-origin `/authorize?…` path carrying the full authorize parameter set. On return, `completePostAuth` receives it as `rawReturnTo`, re-validates it with `isValidReturnTo`, parses the query, re-validates the OAuth parameters, and only then mints.

**Rationale**: There is no server-side pending-authorize ledger today (spec Flagged gap 1). The cookie is server-set, `httpOnly` (not readable/writable by client JS), same-origin-validated (`isValidReturnTo`: relative path, no `//`, no `\`, host must be placeholder), and bounded to a 10-minute TTL (routes.js:130). Because it is `httpOnly` and set server-side, its value is not a "client-modifiable channel after authentication" — it is the exact binding FR-005 trusts. Parameters are never read from `req.query`/`req.body` on the callback for auto-issue purposes.

**Alternatives considered**:
- *Invent a server-side pending-request record keyed by state.* Rejected for this feature — D2 says no new ledger; it is the escalation path only if cookie binding proves insufficient (Flagged gap 1). The cookie already provides server-binding + TTL + same-origin. Recorded as the documented escalation, owned by the adversarial review.
- *Trust `req.query` on the callback.* Rejected — that is the client-modifiable channel FR-005 forbids.

## R2 — Auto-issue reuses `approveAuthorization`; a thin revalidation wrapper adds PKCE-format parity (FR-006, FR-005)

**Decision**: The auto-issue path calls `oauth-flow.approveAuthorization(...)` — the exact core `handleApprove` and `dev-consent-approve` already use — passing the parameters parsed from the server-bound returnTo. Before calling it, the gate runs a `handleAuthorize`-equivalent revalidation: presence of `client_id`, `redirect_uri`, `code_challenge`, `state`; **`validateCodeChallenge(code_challenge)` for PKCE format**; agent resolution + `checkRedirectUri`; `validateScopes`. `approveAuthorization` itself already re-resolves the agent, re-runs `checkRedirectUri`, and re-validates scopes (oauth-flow.js:278–307), so redirect/scope validation is enforced even if the gate is bypassed — defense in depth.

**Rationale**: FR-006 forbids a parallel mint path. `approveAuthorization` is the shared core (returns `{ok, redirectUrl, code}` with no HTTP formatting), purpose-built by feature 029 for exactly this reuse (oauth-flow.js:243–259). The one gap: `approveAuthorization` checks *presence* of `code_challenge` but not its *format*, whereas `handleAuthorize` calls `validateCodeChallenge` (oauth-flow.js:105). FR-005 requires "PKCE challenge format" validation on the auto-issue path, so the gate adds `validateCodeChallenge` explicitly. This is a revalidation the gate performs, not a change to `approveAuthorization` (leave the shared core untouched to avoid disturbing the explicit path).

**Alternatives considered**:
- *Call `handleAuthorize` and scrape its 302.* Rejected — `handleAuthorize` redirects to the consent page, not the agent callback; it does not mint. Wrong seam.
- *Add `validateCodeChallenge` inside `approveAuthorization`.* Deferred — would also affect the explicit Approve path's behavior. Keep the format check in the auto-issue gate; note for review whether the core should adopt it globally (currently the browser path validated format at handleAuthorize time before ever reaching approve).

## R3 — The gate keys on `user.isNew` from the INSERT outcome, never a heuristic (FR-004)

**Decision**: The auto-issue precondition uses the `user.isNew` value returned by `findOrCreateUser` in `completePostAuth` (routes.js:245), which derives from `RETURNING *, (xmax = 0) AS is_new` on the upsert (users.js:64). `isNew === true` iff the row was inserted in this very statement. No account-age, empty-doc-list, or session-state heuristic is consulted.

**Rationale**: FR-004 (SECURITY) mandates the actual account-insertion outcome. `xmax=0` is the postgres tell that the row came from the INSERT branch of the upsert rather than a pre-existing conflict — it is exactly "created in this round-trip." A pre-existing account, signing in during this flow or already authenticated, yields `isNew=false` and never auto-issues. This is the blast-radius cap (FR-008): a token can only ever land on an account this flow just created, which holds zero documents.

**Alternatives considered**: none viable — any age/emptiness heuristic is explicitly forbidden by FR-004 and would reopen the phishing hole.

## R4 — returnTo must be recognized as an `/authorize` request, else normal redirect (FR-010, edge cases)

**Decision**: In `completePostAuth`, when `hasReturnTo && user.isNew`, parse `rawReturnTo` (already validated same-origin) into pathname + query. Auto-issue is attempted **only if** the pathname is exactly `/authorize` (the React consent surface path that `handleAuthorize` redirects to at oauth-flow.js:166, carrying `agent_client_id`, `scope`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`). If the path is anything else (a plain in-app path), or if the required OAuth params are absent/invalid, skip auto-issue and fall through to the existing `res.redirect(\`${clientUrl}${rawReturnTo}\`)`. For non-`isNew` accounts, the existing redirect renders the ConsentCard (which the React page shows because the user is now authenticated).

**Rationale**: FR-010 requires fail-closed into the explicit path, never a dead-end. The existing early return at routes.js:267 already lands the browser on the returnTo; when that returnTo is an `/authorize` page and the user is authenticated, the React `AuthorizePage` renders the ConsentCard (AuthorizePage.jsx:361). So "fall through" is literally the pre-existing behavior — the explicit consent path — with the welcome-doc skip preserved. Auto-issue is a *shortcut* layered before that redirect, only taken when every precondition holds.

**Alternatives considered**:
- *Match on the presence of `code_challenge` alone regardless of path.* Rejected — narrower, path-anchored matching (`/authorize`) is stricter and mirrors what the server itself produced.

## R5 — Parameter set includes `code_challenge_method` (D3, FR-005)

**Decision**: The matched/validated parameter set carried through and re-validated is: `agent_client_id` (accept `client_id` alias as `handleAuthorize` does), `redirect_uri`, `code_challenge`, `code_challenge_method` (default `S256`), `state`, `scope`, and optional `agent_instance_id`. `code_challenge_method` is carried into `approveAuthorization` and stored on the auth code (oauth-flow.js:320), so PKCE verification at token exchange (oauth-flow.js:407) uses the method the request declared.

**Rationale**: D3 / Flagged gap 2 — the amendment's shorthand omits the method, but the request carries it and the flow stores/validates it. Stricter reading wins; carrying it keeps the auto-issued code byte-identical to an explicitly-approved one.

## R6 — Post-issue landing is a direct 302 to the agent callback, no interstitial (D1, FR-003, Assumptions)

**Decision**: On successful auto-issue, `completePostAuth` returns `res.redirect(result.redirectUrl)` where `result.redirectUrl` is the agent callback with `code` + `state` (built by `approveAuthorization`, oauth-flow.js:324–326). No Squire "Authorized — this window will close" interstitial (that React state at AuthorizePage.jsx:339 is only reached by the explicit POST path).

**Rationale**: D1 — an interstitial would be a second Squire screen, defeating "first-run = 1 screen." The session cookies are already set earlier in `completePostAuth` (routes.js:260) so the user stays signed in for the returning-agent (second-agent) case.

## R7 — No migration; existing tables suffice; provenance + welcome-doc skip unchanged (FR-011)

**Decision**: No schema change and no migration. `signup_source='agent_oauth'` stamping (routes.js:243, on INSERT) and the welcome-doc skip (the early `return` at routes.js:267 before onboarding seeding) are **untouched** — the auto-issue path returns *before* that same early return, so provenance and the welcome-doc skip both still apply exactly as they did (agent-first accounts get `agent_oauth` provenance and no welcome doc). The auto-issue only substitutes *where* the browser is redirected (agent callback vs the returnTo page), after the identical account/provenance/cookie work.

**Rationale**: FR-011 guards these as unchanged, covered by their existing tests passing. Placing the auto-issue branch inside the `if (hasReturnTo)` block, before `res.redirect(returnTo)`, means all provenance/skip logic runs unchanged. Latest migration is `1799300000000_add-signup-source-to-users.js`; any hypothetical new migration would need a timestamp > that — confirmed none is needed.

## R8 — Test harness seams (FR-013, SC-003/SC-005)

**Decision**:
- **Tier-1 (Jest integration)**: exercise `completePostAuth`'s auto-issue gate through the faucet browser mode (`POST /auth/dev-login {fresh:true, browser:true, returnTo:'/authorize?…'}`), which routes through the identical `completePostAuth` (routes.js:536–538, RBD-10) — production behavior, not a mock. Cases: (a) fresh + valid authorize returnTo → 302 to agent callback carrying `code` + a row in `mcp_auth_codes`, no consent POST; (b) fresh + non-authorize returnTo → 302 to that path, no code; (c) fresh + malformed PKCE/invalid redirect/missing param → 302 to the returnTo (consent fallback), no code; (d) **existing account** (re-sign-in same nonce so `isNew=false`) + valid authorize returnTo → 302 to returnTo, NO code (FR-004/FR-008); (e) FR-011 guard tests (provenance=agent_oauth, no welcome doc) stay green on the auto-issue path.
- **Tier-2 (headless chain driver)**: add a first-run variant to `oauth-chain-driver.mjs` that, instead of `dev-consent-approve`, drives the faucet **browser** mode with `returnTo` = the `/authorize?…` URL and asserts the response 302s to the agent callback with a `code` — then completes token exchange + a real MCP call — WITHOUT ever calling any consent-approval endpoint. Companion assertion: an existing-account run does NOT complete without the explicit approve.
- **Tier-3 (rehearsal matrix)**: `matrix-cells.mjs` connect cells (`fresh-happy`, `existing-never-consented`) updated to the new screen count (first-run connect = 1 Squire screen); the `declined-consent` cell retargeted per D6 (first-run decline = abandon-before-sign-in; explicit Deny stays with the existing-account/`abandoned-tab`-adjacent cells that keep the card). Update any coaching-contract checklist lines referencing the old three-screen shape.

**Rationale**: The faucet browser mode is the production-identical seam (RBD-10) — it calls the same `completePostAuth`, so tier-1 and tier-2 both test real behavior. Counter-assertion for "existing account still needs approve" is cleanest at tier-1 (deterministic `isNew=false` via nonce reuse); tier-2 asserts the positive collapse end-to-end.

**Open harness question (flag for tasks, not blocking)**: the faucet re-sign-in of a stable nonce yields `isNew=false` on the second call (find-or-create), which is exactly the existing-account fixture. Confirm `matrix-cells.mjs`'s `faucet-premint` setup already primes this so the counter-assertion reuses it rather than inventing a new fixture.

## R9 — Adversarial-review carry-forward: `checkRedirectUri` breadth on the auto-issue path (D5, Flagged gap 5)

**Decision (carry, do NOT resolve unilaterally)**: `checkRedirectUri` (oauth-flow.js:13) allows **any** localhost or HTTPS redirect target for auto-registered clients (empty allow-list). Its comment (oauth-flow.js:19–22) explicitly justifies HTTPS breadth by "the user sees the redirect URL on the consent page and can decide whether to trust it." The auto-issue path removes that human eyeball. Per D5 and the amendment ("PKCE and redirect_uri validation are unchanged"), the plan keeps validation unchanged and surfaces this to the mandated adversarial security review pass. The `isNew` gate caps blast radius at a token on a just-created empty account (FR-008), so this does not widen beyond the FR-008 ceiling.

**Proposed tightening (flagged for ratification, NOT applied)**: if the review wants to close the eyeball gap without a schema change, the narrowest safe option is to restrict the *auto-issue* path (not the explicit-consent path) to localhost redirect targets only — the beachhead agent-connect case is localhost callbacks (e.g. `http://localhost:8765/callback`). This would leave the explicit ConsentCard path (where a human still sees the URL) unchanged for HTTPS clients. Recorded as a review-owned proposal; do NOT implement without Sam's ratification.

**Rationale**: This is the sharpest edge of the collapse and the spec pins it for the adversarial pass. A task must surface/document it; a tightening is proposed but explicitly not adopted by the plan.

## Resolved unknowns summary

| Item | Resolution |
|------|-----------|
| Binding mechanism ("validated and matched") | `oauth_return_to` httpOnly cookie, sole param source, re-validated (R1) |
| Mint path | reuse `approveAuthorization`; gate adds PKCE-format check (R2) |
| isNew source | `xmax=0` INSERT outcome, no heuristic (R3) |
| returnTo recognition | path === `/authorize` + valid params, else normal redirect (R4) |
| Param set | includes `code_challenge_method` (R5) |
| Landing | direct 302 to agent callback, no interstitial (R6) |
| Migration | none needed; provenance + welcome-doc skip unchanged (R7) |
| Test seams | faucet browser mode (tier-1/2), matrix cells (tier-3) (R8) |
| Redirect-breadth edge | carried to adversarial review; tightening proposed not applied (R9) |
