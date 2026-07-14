# Phase 1 Data Model: Agent Onboarding via agents.md + MCP-Native OAuth

Feature `005-agent-onboarding`. This feature introduces **no new persisted
entities**. It defines one transient entity (the returnTo continuation, held
in a cookie), and it references several existing entities without modifying
them. No database migrations are required.

## New (transient) entities

### returnTo continuation

- **Identity**: not identified by a database key — identified by the browser
  session that holds the `oauth_return_to` cookie.
- **Fields**:
  - `value` (string): a same-origin relative URL path (must start with `/`;
    see `research.md` §R2 for the full validation predicate).
- **Lifetime**: 10 minutes maximum (`maxAge: 10 * 60 * 1000` on the cookie).
  Consumed on the first `GET /auth/google/callback` served after login,
  regardless of whether the value is honored or rejected on re-validation.
- **Constraints** (all enforced server-side; see contracts/returnto-continuation.md):
  - length ≤ 512 chars
  - starts with `/`
  - does not start with `//`
  - contains no backslash
  - `new URL(value, 'http://placeholder').host === 'placeholder'`
- **State transitions**:
  ```
  (nonexistent) ──[GET /auth/google?returnTo=<valid>]──▶ pending
                                                            │
                                                            ├─[callback within 10m, still valid]──▶ consumed → redirect(returnTo)
                                                            ├─[callback within 10m, revalidation fails]──▶ discarded → default onboarding redirect
                                                            └─[10m elapsed with no callback]──▶ expired (cookie gone)
  ```
- **Failure mode**: on any rejection (validation, expiry, foreign session), the
  user still lands on-origin, signed in, at the default destination (D4).

## Existing entities (referenced, unchanged)

### OAuth Delegation
- Owned by design doc "Credentials" and by feature 004's OAuth surface.
- Fields: `client_id`, `user_id`, `granted_scopes`, `refresh_token_family`,
  `revoked_at`, timestamps.
- This feature reaches Delegation via the same paths as today: consent
  approval creates one, revocation cascades to tokens. **Unchanged.**

### OAuth Registered Client (RFC 7591)
- `registered_agents` table (via `server/mcp/auth/registered-agents.js`).
- Dynamic client registration remains at `POST /mcp/auth/register`.
- **Unchanged** by this feature.

### Access Token (JWT) / Refresh Token
- Access token: JWT signed by the MCP secret, 1-hour TTL. Refresh token: 30-day
  rotating.
- Emission path (`generateAgentToken` at `server/mcp/auth/jwt.js`) is
  **unchanged**.
- The only change touching tokens is that a 401 for an expired or invalid
  token now emits a `WWW-Authenticate` challenge — no token *shape* change.

### Personal Access Token (`sk_sqd_` / legacy `sqd_`)
- `api_tokens` table (via `server/mcp/auth/api-tokens.js`).
- SHA-256-hashed at rest; 25-per-user cap; scoped; expiring.
- **Unchanged.** agents.md documents both prefixes as of this feature (they
  already both work; the documentation just names the fact).

### Application User Session (browser cookie session)
- `accessToken` + `refreshToken` httpOnly cookies set by
  `server/auth/routes.js`.
- **Unchanged** apart from the callback learning to redirect to the returnTo
  destination in precedence over onboarding.

## Discovery documents (static content, not persisted entities)

These are *not* rows in a table; they are content the server generates
per-request from the request's host header. They are documented in
`contracts/` and included here for reference:

- **Protected-resource metadata document** — a JSON object returned by
  `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/mcp`. See
  `contracts/protected-resource-metadata.md`.
- **Authorization-server metadata document** — already served at
  `/.well-known/oauth-authorization-server`. **Unchanged in shape** by this
  feature (refactored in the same commit to use `buildBaseUrl` for internal
  consistency — no observable change).
- **agents.md** — public static markdown served at `/agents.md`. Content
  contract in `contracts/agents-md.md`.

## Migration and rollout

**No database migration.** If implementation discovers a schema change is
needed (e.g., persisting the returnTo continuation), STOP and escalate — this
would break both a plan assumption and a spec assumption. Rolling back this
feature is a straight code revert.
