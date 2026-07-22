# Phase 1 Data Model: First-Run Consent Collapse

No schema changes. This feature adds a decision path, not persistent structure. The entities below are the ones the auto-issue gate reads and writes — all pre-existing.

## Entities

### User account (`users`)
- **Source**: `findOrCreateUser` upsert (server/auth/users.js).
- **Fields read by this feature**:
  - `isNew` (derived, transient) — `(xmax = 0)` from the INSERT `RETURNING`. `true` iff the row was created in this very statement. **The load-bearing gate signal (FR-004).**
  - `signup_source` — stamped `'agent_oauth'` at creation when a valid same-origin returnTo is present (unchanged, FR-011).
  - `id`, `email` — passed to `approveAuthorization` (`userId`) and used for synthetic-email checks.
- **Invariant**: A `isNew=true` account holds zero documents at this instant — the fact that makes auto-issue's blast radius safe (FR-008).
- **State transition**: none added. The row is created/updated exactly as today; only the subsequent redirect differs.

### Authorize request (parsed from the server-bound returnTo)
- **Source**: the `oauth_return_to` httpOnly cookie value (`/authorize?…`), NOT `req.query`/`req.body`.
- **Fields**: `agent_client_id` (or `client_id` alias), `redirect_uri`, `code_challenge`, `code_challenge_method` (default `S256`), `state`, `scope`, optional `agent_instance_id`.
- **Validation (must all pass for auto-issue — FR-005)**:
  1. `isValidReturnTo(rawReturnTo)` — same-origin relative path (pre-existing).
  2. pathname === `/authorize`.
  3. presence of `agent_client_id`/`client_id`, `redirect_uri`, `code_challenge`, `state`.
  4. `validateCodeChallenge(code_challenge)` — PKCE format.
  5. agent resolution (`getRegisteredAgent`, auto-register as `handleAuthorize` does) + `checkRedirectUri` (unchanged, D5).
  6. `validateScopes(agent, scope)`.
- **Any failure → fail closed**: skip auto-issue, fall through to the standard returnTo redirect (consent card / error surfaced by the existing flow — FR-010).

### Round-trip state (the binding)
- **Realization**: `oauth_return_to` cookie — `httpOnly`, `sameSite:'lax'`, `secure` in prod, `maxAge` 10 min (routes.js:128).
- **Role**: the ONLY accepted source of the authorize parameters for auto-issue (R1, FR-005). Not client-modifiable after auth.
- **Lifecycle**: set at `GET /auth/google`; cleared on EVERY callback exit (routes.js:178); expiry → no auto-issue, standard onboarding (pre-existing degrade, spec Flagged gap 3, out of scope).

### Authorization code (`mcp_auth_codes`) — written unchanged
- Minted by `approveAuthorization` (oauth-flow.js:314–321): `code_hash`, `user_id`, `agent_client_id`, `agent_instance_id`, `scopes`, `code_challenge`, `code_challenge_method`, `redirect_uri`, `expires_at` (5 min).
- **Identical row shape** whether minted via explicit Approve or auto-issue — FR-006. Single-use; consumed at token exchange.

### Delegation (`agent_delegations`) — written unchanged
- Created at token exchange (oauth-flow.js:433), attributed to the agent client, listed and revoked via Settings → AI Agent Access (`handleListDelegations` / `handleDeleteDelegation`).
- **Indistinguishable** from an explicitly-approved delegation in attribution, listing, revocation (FR-012, SC-004).

## Decision flow (in `completePostAuth`, after cookies are set, inside `if (hasReturnTo)`)

```text
hasReturnTo (isValidReturnTo(rawReturnTo)) ?
  └─ yes:
       user.isNew ?
         ├─ yes: parse rawReturnTo
         │        path === /authorize AND all OAuth params present & valid ?
         │          ├─ yes: approveAuthorization(...)  →  ok ?
         │          │          ├─ ok:   res.redirect(result.redirectUrl)  ← agent callback + code (AUTO-ISSUE)
         │          │          └─ !ok:  res.redirect(clientUrl + rawReturnTo)  ← fail closed → consent
         │          └─ no:  res.redirect(clientUrl + rawReturnTo)  ← consent / plain path (unchanged)
         └─ no (existing account): res.redirect(clientUrl + rawReturnTo)  ← consent card (unchanged, FR-007)
  └─ no: onboarding → welcome doc / doc list (unchanged)
```

The welcome-doc skip is preserved: every auto-issue and every fall-through returns before the onboarding seeding block (routes.js:271+), exactly as the existing `hasReturnTo` early return does.
