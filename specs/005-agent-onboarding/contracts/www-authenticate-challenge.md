# Contract: WWW-Authenticate Challenge (RFC 6750 + RFC 9728)

Feature `005-agent-onboarding`. Defines the `WWW-Authenticate` header the MCP
endpoint's auth layer sets on every 401/403 response, so a compliant client
can bootstrap or re-bootstrap discovery without operator help.

## Scope

- Applies to every 401 response emitted by `requireAgentAuth`
  (`server/mcp/auth/middleware.js`).
- Applies to every 403 response emitted by `requireScope`
  (`server/mcp/auth/middleware.js`).
- Does not change JSON response bodies.

## Header shape

The challenge is always a single `WWW-Authenticate` header value starting with
the `Bearer` scheme. Attributes are RFC 6750-quoted-string form. The exact
attributes per branch:

### Branch A — Missing credentials (no `Authorization` header, no `?token=`)

```
WWW-Authenticate: Bearer realm="Squire Docs MCP", resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"
```

- No `error=` attribute (RFC 6750 §3: SHOULD NOT include error info when
  request lacks authentication).
- HTTP status: `401`.
- Existing JSON body unchanged: `{ "error": "No agent token provided", "code":
  "MISSING_TOKEN" }`.

### Branch B — Invalid credentials (malformed JWT, signature failure, API-token lookup miss)

```
WWW-Authenticate: Bearer realm="Squire Docs MCP", error="invalid_token", error_description="Invalid agent token", resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"
```

- HTTP status: `401`.
- Existing JSON body unchanged: `{ "error": "Invalid agent token", "code":
  "INVALID_TOKEN" }`.

### Branch C — Expired token (`TokenExpiredError`)

```
WWW-Authenticate: Bearer realm="Squire Docs MCP", error="invalid_token", error_description="The access token expired", resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"
```

- HTTP status: `401`.
- Existing JSON body unchanged: `{ "error": "Agent token expired", "code":
  "TOKEN_EXPIRED" }`.
- RFC 6750 §3.1 groups expired-token into `invalid_token`.

### Branch D — Insufficient scope (`requireScope` 403)

```
WWW-Authenticate: Bearer realm="Squire Docs MCP", error="insufficient_scope", scope="<required scopes space-separated>", resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"
```

- HTTP status: `403`.
- The `scope` attribute is the required scope(s), space-separated (e.g.
  `documents:write` or `documents:read documents:write`).
- Existing JSON body unchanged.

## Additional touchpoint

`GET /mcp` (server info) currently returns:

```json
{
  ...
  "authentication": {
    "type": "oauth2",
    "authorizationUrl": "<base>/mcp/auth/authorize",
    "tokenUrl": "<base>/mcp/auth/token",
    "metadataUrl": "<base>/.well-known/oauth-authorization-server"
  }
}
```

This feature adds one field:

```json
{
  ...
  "authentication": {
    "type": "oauth2",
    "authorizationUrl": "<base>/mcp/auth/authorize",
    "tokenUrl": "<base>/mcp/auth/token",
    "metadataUrl": "<base>/.well-known/oauth-authorization-server",
    "resource_metadata": "<base>/.well-known/oauth-protected-resource/mcp"
  }
}
```

Clients that never issued a request that got a 401 can still find the
protected-resource document from this response.

## Non-goals

- Does not change any 200 response.
- Does not change WebSocket authentication (`?token=` on the y-websocket
  presence session).
- Does not change the `/api/*` REST authentication (existing session-cookie
  or PAT flow, no discovery challenge required).

## Test contract

Covered by `server/__tests__/oauth-discovery.test.js`:
- Branch A: POST `/mcp` with no `Authorization` header → 401 + header without
  `error=`.
- Branch B: POST `/mcp` with `Authorization: Bearer not-a-real-token` → 401 +
  header with `error="invalid_token"`.
- Branch C: POST `/mcp` with an expired JWT (minted with `-1h` exp for the
  test) → 401 + header with `error="invalid_token"` and
  `error_description="The access token expired"`.
- Branch D: POST `/mcp` with a valid token missing the required scope → 403 +
  header with `error="insufficient_scope"` and the `scope` attribute.
- Positive path: POST `/mcp` with a valid, in-scope token → 200 and **no**
  `WWW-Authenticate` header set.
- `GET /mcp` returns `authentication.resource_metadata` equal to
  `<base>/.well-known/oauth-protected-resource/mcp`.
