# Contract: Protected Resource Metadata Document (RFC 9728)

Feature `005-agent-onboarding`. Serves the two `.well-known` documents that
turn Squire's `/mcp` endpoint into a self-discoverable OAuth-protected
resource.

## Endpoints

- `GET /.well-known/oauth-protected-resource/mcp` — path-suffix form (RFC 9728
  §3.1 style, extended per the MCP authorization convention).
- `GET /.well-known/oauth-protected-resource` — root fallback for clients that
  do not implement RFC 9728 path insertion.

Both endpoints return **identical bytes** (design decision D6). Both are
public (no authentication).

## Response

- Status: `200 OK`
- `Content-Type: application/json`
- Body (JSON object):

```json
{
  "resource": "https://<origin>/mcp",
  "authorization_servers": ["https://<origin>"],
  "scopes_supported": ["documents:read", "documents:write"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Squire Docs MCP"
}
```

### Field semantics

| Field | Type | Notes |
|---|---|---|
| `resource` | string (URL) | The MCP endpoint URL. Absolute, `https` in production, matches `${buildBaseUrl(req)}/mcp`. |
| `authorization_servers` | array of strings (URLs) | Exactly one entry: the issuer of the existing authorization-server metadata document served at `/.well-known/oauth-authorization-server`. |
| `scopes_supported` | array of strings | The scopes an agent may request. Currently `documents:read` and `documents:write` — matches `server/mcp/tools/` registry declarations. |
| `bearer_methods_supported` | array of strings | `["header"]` — MCP requires `Authorization: Bearer …`. |
| `resource_name` | string | Human-readable label for logs and consent screens (should the client render it). |

### Origin construction

Both handlers MUST use `buildBaseUrl(req)` from `server/url.js`. This forces
`https` for the `squiredocs.com` production host and echoes `req.protocol`
otherwise (dev over http, k8s tunnels, etc.).

## Caching

- No `Cache-Control` header emitted (default private caching per Express).
- Content is effectively immutable per origin; a light CDN/edge cache is
  acceptable but not required by this feature.

## Test contract

Covered by `server/__tests__/oauth-discovery.test.js`:
- Both endpoints return 200.
- Response body matches the schema above exactly (field-by-field assertion).
- `resource` equals `<baseUrl>/mcp`.
- `authorization_servers[0]` equals the same base URL used by
  `/.well-known/oauth-authorization-server`'s `issuer` claim.
