# Quickstart: Agent Onboarding via agents.md + MCP-Native OAuth

Feature `005-agent-onboarding`. End-to-end validation guide. Follow this after
`/speckit-implement` to prove the feature works. All commands assume you are
in the local `app-dev` pod (see `docs/dev.md`) or the equivalent local shell
if running the backend suite outside the pod.

## Prerequisites

- Backend and frontend running (dev pod: the dev servers auto-restart; local:
  see `docs/dev.md` for the standard setup).
- Base URL: `http://localhost:5173` (Vite proxy) or `http://localhost:3001`
  (direct Express) depending on your setup.

## 1. Static asset serves

```
curl -s -o /tmp/agents.md -w "%{http_code}\n" http://localhost:5173/agents.md
```

Expected: `200`, `/tmp/agents.md` contains the five FR-002 mandated elements.
Sanity-check with grep:

```
grep -q 'claude mcp add --transport http squire https://squiredocs.com/mcp' /tmp/agents.md && echo OK
grep -q 'default `portable`' /tmp/agents.md && echo OK
grep -q 'get_tool_documentation' /tmp/agents.md && echo OK
```

All three should print `OK`.

## 2. Protected-resource metadata (both forms)

```
curl -s http://localhost:5173/.well-known/oauth-protected-resource/mcp | jq .
curl -s http://localhost:5173/.well-known/oauth-protected-resource | jq .
```

Both should return byte-identical JSON like:

```json
{
  "resource": "http://localhost:5173/mcp",
  "authorization_servers": ["http://localhost:5173"],
  "scopes_supported": ["documents:read", "documents:write"],
  "bearer_methods_supported": ["header"],
  "resource_name": "Squire Docs MCP"
}
```

## 3. Unauthenticated 401 carries the pointer

```
curl -si -X POST http://localhost:5173/mcp \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -20
```

Expected: `HTTP/1.1 401` and a `WWW-Authenticate: Bearer realm="mcp",
resource_metadata="…/.well-known/oauth-protected-resource/mcp"` header. No
`error=` attribute in this branch.

Repeat with a bogus token:

```
curl -si -X POST http://localhost:5173/mcp \
     -H 'Authorization: Bearer not-a-real-token' \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -20
```

Expected: `401` and `WWW-Authenticate: Bearer realm="mcp",
error="invalid_token", error_description="Invalid agent token",
resource_metadata="…"`.

## 4. GET /mcp advertises the pointer

```
curl -s http://localhost:5173/mcp | jq .authentication
```

Expected to include `"resource_metadata":
"…/.well-known/oauth-protected-resource/mcp"`.

## 5. Consent login round-trip (browser, incognito)

1. Open an incognito window with no Squire session.
2. Visit `http://localhost:5173/authorize?client_id=<any registered client>&
   response_type=code&redirect_uri=http://localhost:5173/oauth-callback&
   code_challenge=<pkce challenge>&code_challenge_method=S256&
   state=quickstart&scope=documents%3Aread`.
3. AuthorizePage should render "Sign in required" with a "Sign in with Google"
   button.
4. Click through Google login (dev-login bypass in dev mode). After login,
   the browser should land back on `/authorize?...` with the original
   parameters intact — NOT on `/docs` or the welcome doc.
5. Approve consent. The client should receive the code.

## 6. returnTo validation (open-redirect defense)

Try each of these hostile returnTo values by visiting them directly:

```
/login?returnTo=//evil.com/
/login?returnTo=%2F%2Fevil.com%2F      # encoded protocol-relative
/login?returnTo=%2Fevil.com            # nb: %2F = "/" — this IS valid (on-origin path)
/login?returnTo=%5Cevil.com            # backslash form
/login?returnTo=http%3A%2F%2Fevil.com  # absolute URL, encoded
```

Expected: the hostile ones are silently dropped (login lands on the default
destination, on-origin); the on-origin path forms are honored. Nothing
redirects off-origin.

## 7. Landing footer link

```
curl -s http://localhost:5173/ | grep -c '/agents.md'
```

Expected: exactly `1`.

## 8. Settings blurb

Sign in and visit `/settings`. The "AI Agent Access" section should display:
- The MCP URL row (existing).
- A link to `/agents.md` (new).
- Existing PAT and delegation lists.

## 9. Automated backend suite (serial only!)

From the repo root, using the standard local backend runner (or the pod's
serial-safe runner — see MEMORY: local-backend-test-stack):

```
npx jest server/__tests__/oauth-discovery.test.js \
        server/__tests__/auth-return-to.test.js \
        server/__tests__/agents-md-claims.test.js \
        --runInBand
```

Expected: three green suites. `--runInBand` is mandatory (backend test DB is
serial-only per Constitution II).

## 10. No regression: normal login still onboards

Sign out. Visit `/login` directly (no `returnTo`). Complete Google login.
Expected: land on `/d/<welcomeDocId>?welcome=1` for a new user, or `/docs`
for an existing user — the existing behavior, unchanged (SC-006).
