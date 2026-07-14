# Phase 0 Research: Agent Onboarding via agents.md + MCP-Native OAuth

Feature `005-agent-onboarding`. Consolidates decisions that resolve NEEDS
CLARIFICATION and best-practice questions raised in `plan.md`. Cross-referenced
by `data-model.md`, `contracts/`, and `tasks.md`.

## R1 — returnTo continuation cookie mechanism

- **Decision**: Reuse the exact pattern already used for `oauth_redirect` in
  `server/auth/routes.js` (httpOnly, `SameSite=Lax`, `secure` in production,
  set on `GET /auth/google`, read+cleared on `GET /auth/google/callback`). Cookie
  name: **`oauth_return_to`**. **TTL: 10 minutes** (fixed here to discharge D5's
  "5–15 min band, choose at plan time" — 10 covers slow logins and password-
  manager prompts without meaningfully extending the replay window; halves
  cleanly for tests).
- **Rationale**: A new mechanism (server-session slot, Redis key, JWT-in-URL)
  would add attack surface and a persisted-state audit surface for no benefit
  the cookie doesn't already give us. Cookies are already the design-mandated
  carrier ("carried in a short-lived cookie through the Google redirect",
  `design/agent-surface-mcp.md`). Single-session and single-use follow from
  cookie mechanics (not present in a different browser; cleared on consumption).
- **Alternatives considered**: (a) Persist to `oauth_authorization_requests`
  table — rejected, adds a schema change the spec explicitly says isn't
  expected. (b) Encode returnTo into `state` — rejected, `state` is Google's,
  size/opacity risk. (c) Return-URL fragment on the login redirect — rejected,
  fragments don't survive server-side redirects.

## R2 — Server-side returnTo validation

- **Decision**: A returnTo value is accepted iff **all** of the following hold:
  1. `typeof value === 'string'`
  2. `value.length > 0 && value.length <= 512`
  3. `value.startsWith('/')`
  4. `!value.startsWith('//')` (protocol-relative)
  5. `!value.includes('\\')` (backslash open-redirect variants)
  6. `new URL(value, 'http://placeholder').host === 'placeholder'`
     (host-parseable AND embeds no authority — catches CR/LF injection, weird
     schemes, `/@evil.com/foo` authority-userinfo tricks that some browsers
     still misparse)
  Failure → drop silently, do not set the cookie, do not error. Callback also
  re-validates before honoring (defense in depth: cookie could theoretically be
  planted from a subdomain if `Domain=` were ever loosened; belt-and-braces).
- **Rationale**: The URL-based check catches variants a naive prefix check
  misses (`/\evil.com`, `/%2F%2Fevil.com` after decode, embedded `@`), while
  the syntactic checks are cheap and reject the obvious cases without
  constructing a URL. Length cap prevents accidental blowup of cookies.
- **Alternatives considered**: (a) Regex-only validator — rejected, browser
  URL parsers do things regex can't easily catch. (b) Allowlist of exact known
  paths (`/authorize`) — rejected, brittle and unnecessary once relative-only
  is enforced. (c) Sign the returnTo — overkill for a single-session cookie
  the user's own browser set, and complicates dev flows.

## R3 — WWW-Authenticate challenge shape per 401/403 branch

- **Decision** (per RFC 6750 §3 for `error=` semantics and RFC 9728 §5.3 /
  MCP-authorization for `resource_metadata=`):
  - **Missing credentials** (no `Authorization` header): `Bearer realm="mcp",
    resource_metadata="https://<origin>/.well-known/oauth-protected-resource/mcp"`.
    **No `error=` attribute** — RFC 6750 §3: "If the request lacks any
    authentication information … the resource server SHOULD NOT include an
    error code or other error information."
  - **Malformed/invalid credentials** (JWT verification error other than
    expiry, API-token lookup failure): `Bearer realm="mcp", error="invalid_token",
    error_description="Invalid agent token", resource_metadata="…"`.
  - **Expired token** (`TokenExpiredError`): `Bearer realm="mcp",
    error="invalid_token", error_description="The access token expired",
    resource_metadata="…"`. RFC 6750 §3.1 groups token-expired into
    `invalid_token`.
  - **Insufficient scope** (`requireScope` 403 branch): `Bearer realm="mcp",
    error="insufficient_scope", scope="<required scopes space-separated>",
    resource_metadata="…"`. Per RFC 6750 §3.1.
- **Rationale**: Uniform pointer (`resource_metadata`) is what D3 mandates; the
  per-branch `error=` is what makes the challenge machine-diagnosable so the
  client can tell "re-run OAuth" (invalid_token) from "ask user for higher
  scope" (insufficient_scope) from "just start OAuth" (no error, missing
  credentials).
- **Alternatives considered**: (a) Always include `error="invalid_token"`
  even when credentials absent — rejected, RFC-non-conformant. (b) Omit
  `error_description` — rejected, cheap to include and useful for logs on the
  client side; contains no sensitive info.

## R4 — Both protected-resource documents identical

- **Decision** (per D6): both `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-protected-resource` return **byte-identical** JSON
  describing the MCP endpoint as the resource:
  ```json
  {
    "resource": "https://<origin>/mcp",
    "authorization_servers": ["https://<origin>"],
    "scopes_supported": ["documents:read", "documents:write"],
    "bearer_methods_supported": ["header"],
    "resource_name": "Squire Docs MCP"
  }
  ```
  Both handlers use `buildBaseUrl(req)` from `server/url.js`.
- **Rationale**: The MCP endpoint is the origin's only OAuth-protected resource
  (the web app itself uses cookies, not Bearer); serving different content at
  the root would break the less-conformant clients the root fallback exists
  for.
- **Alternatives considered**: (a) Root returns an empty/error stub —
  rejected, defeats the fallback's purpose. (b) Root returns a list of
  multiple resources — rejected, RFC 9728 defines the doc as describing one
  resource; a client seeing a list would not know which to use.

## R5 — Callback precedence and cookie hygiene

- **Decision**: In `GET /auth/google/callback`, after minting session cookies
  and *before* the current `onboarding.resolveOnboarding` branch:
  1. Read `req.cookies.oauth_return_to`.
  2. **Always** `res.clearCookie('oauth_return_to')` (regardless of value).
  3. Re-validate the value with the R2 validator.
  4. If valid → `res.redirect(\`${clientUrl}${returnTo}\`)` and return.
  5. If missing or invalid → fall through to existing onboarding branch.
- **Rationale**: Precedence is required by FR-011 (returnTo outranks
  onboarding when present). Always-clear prevents replay via a lingering
  cookie; re-validate is defense in depth; on validation failure we still
  land the user on-origin, signed in (D4 fail-closed to default destination).

## R6 — agents.md drift-guard mechanism

- **Decision**: Automated test at `server/__tests__/agents-md-claims.test.js`
  reads `client/public/agents.md` from disk and asserts:
  1. Contains `flavor=squire|portable`.
  2. Contains substring `default \`portable\`` (backticks in markdown).
  3. Does **not** contain the exact stale phrase `default \`squire\``.
  4. Contains the exact one-liner
     `claude mcp add --transport http squire https://squiredocs.com/mcp`.
  5. Names each of: `get_tool_documentation`, `modify`, `create_access_token`,
     `read_document`, `list_documents`.
  6. References both the `sk_sqd_` and legacy `sqd_` prefixes.
- **Rationale**: FR-003 requires *a* mechanism (test or checklist item);
  automated is cheap here — these are exact-string invariants, no HTML
  rendering or LLM grading needed — and catches the exact stale-claim class
  the feature was called to close. If a future surface change breaks one of
  these assertions, the offender fixes agents.md as part of the same commit.
- **Alternatives considered**: (a) Release-checklist item — rejected, easy
  to forget in a solo workflow and the test is a two-file diff. (b) Fetch
  agents.md over HTTP in a test — rejected, unnecessary indirection; the file
  is what's shipped. (c) Semantic diff via an LLM — massive overkill.

## R7 — dev-login returnTo handling

- **Decision**: The dev-login flow (`AuthContext.devLogin`, backend
  `POST /auth/dev-login`) is JSON-in/JSON-out — no server redirect involved.
  Continue to keep it that way. When `login(returnTo)` is called with the
  bypass on, delegate to `devLogin(returnTo)`, and after the JSON response
  succeeds, the client does `window.location.href = returnTo` (validated
  client-side with the same rules the server uses; same-origin relative path
  or fall through to `/docs`).
- **Rationale**: The bypass is dev-only; matching the server's cookie
  round-trip in dev-login adds ceremony that doesn't buy real coverage. The
  round-trip is exercised by the real `/auth/google` path in production.
- **Alternatives considered**: (a) Mirror the cookie mechanism in dev-login
  — rejected, dev-login is not a redirect flow. (b) Ignore returnTo in
  dev-login — rejected, breaks the consent-page journey in local dev.

## Standards references (for reviewer/adversarial review)

- **RFC 6750** — Bearer Token Usage; especially §3 (WWW-Authenticate) and
  §3.1 (`error` values).
- **RFC 8414** — OAuth 2.0 Authorization Server Metadata (already served at
  `/.well-known/oauth-authorization-server`; unchanged by this feature).
- **RFC 7591** — OAuth 2.0 Dynamic Client Registration (already implemented
  at `/mcp/auth/register`; unchanged).
- **RFC 9728** — OAuth 2.0 Protected Resource Metadata (this feature
  introduces both discovery documents).
- **RFC 8628** — Device Authorization Grant. **Not implemented** (S1;
  FR-007). Adversarial reviewer should verify no code path calls the token
  endpoint with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
- **RFC 8707** — Resource Indicators. **Accepted and ignored** (FR-008;
  design doc "Accepted gap"). Adversarial reviewer should verify that a
  token request carrying `resource=…` succeeds and does not echo it.
- **MCP Authorization Specification** — the Model Context Protocol's own
  guidance on WWW-Authenticate + `resource_metadata` pointer; supersets RFC
  9728 with MCP-specific conventions.
