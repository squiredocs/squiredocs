# Contract: Inline Auto-Issue Gate (server)

Location: `completePostAuth` in `server/auth/routes.js`, inside the existing `if (hasReturnTo)` block, after session cookies are set (routes.js:260) and before the existing `res.redirect(\`${clientUrl}${rawReturnTo}\`)` (routes.js:268).

## Preconditions (ALL must hold to auto-issue — fail closed otherwise)

| # | Condition | Source | FR |
|---|-----------|--------|----|
| 1 | `isValidReturnTo(rawReturnTo)` true | pre-existing validation | FR-002 |
| 2 | `user.isNew === true` | `findOrCreateUser` INSERT `xmax=0` — NOT age/emptiness/session | FR-004 |
| 3 | parsed pathname === `/authorize` | parse of the server-bound cookie value ONLY | FR-005 |
| 4 | `client_id`(or `agent_client_id`), `redirect_uri`, `code_challenge`, `state` all present | parsed query | FR-005 |
| 5 | `validateCodeChallenge(code_challenge)` valid | PKCE format re-check | FR-005/FR-006 |
| 6 | agent resolves + `checkRedirectUri` allows | unchanged validation (D5) | FR-006 |
| 7 | `validateScopes` valid | unchanged validation | FR-005 |

Parameters are read EXCLUSIVELY from the parsed `oauth_return_to` cookie value. `req.query`/`req.body`/headers MUST NOT be consulted for auto-issue parameters (FR-005).

## Behavior

- **All preconditions hold** → call `approveAuthorization({ userId: user.id, agent_client_id, agent_instance_id, scopes, redirect_uri, state, code_challenge, code_challenge_method })`.
  - `result.ok` → `res.redirect(result.redirectUrl)` (agent callback carrying `code` + `state`). No consent card, no interstitial (D1). **[AUTO-ISSUE]**
  - `!result.ok` → fall through to `res.redirect(\`${clientUrl}${rawReturnTo}\`)`. **[FAIL CLOSED → consent]**
- **Any precondition fails** → fall through to `res.redirect(\`${clientUrl}${rawReturnTo}\`)` (the existing behavior: renders ConsentCard for an authorize path once authenticated, or navigates a plain path). **[FAIL CLOSED]** (FR-010)
- **`user.isNew === false`** (existing account, either arrival order) → never enters the auto-issue branch; existing redirect → ConsentCard. (FR-004, FR-007)

## Invariants (testable)

- **INV-1 (FR-004/FR-008)**: No code is ever minted for `user.isNew === false`. Automated test required.
- **INV-2 (FR-006)**: The only code-minting call is `approveAuthorization` — no `INSERT INTO mcp_auth_codes` outside it. Grep-assertable + behavioral.
- **INV-3 (FR-005)**: With a well-formed authorize returnTo but a tampered `req.query` differing from the cookie, the minted code (if any) reflects the COOKIE parameters, never `req.query`. (The code path never reads `req.query` — assert by construction + a test that passes divergent query params and confirms they are ignored.)
- **INV-4 (FR-010)**: A malformed `code_challenge` / disallowed `redirect_uri` / missing `state` in the returnTo yields NO code and a redirect to the returnTo (consent/error), never a 500 dead-end.
- **INV-5 (FR-011)**: On the auto-issue path, `signup_source='agent_oauth'` is still stamped and no welcome doc is seeded (the branch returns before onboarding seeding).
- **INV-6 (FR-006/D5)**: `checkRedirectUri` and PKCE verification are byte-for-byte the same validators the explicit path uses (no forked copy).

## Non-goals / unchanged

- `approveAuthorization` internals unchanged (no parallel mint path).
- `checkRedirectUri` breadth for auto-registered clients unchanged (D5) — carried to adversarial review (research R9).
- Faucet browser mode (`/auth/dev-login {fresh,browser,returnTo}`) inherits this behavior automatically because it calls the same `completePostAuth` (RBD-10) — this is the tier-1/tier-2 test seam, not a separate code path.
