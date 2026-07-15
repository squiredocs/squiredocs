# Contract: the anonymous MCP surface and byte-identical invariance

Enforcement point: `server/mcp/index.js` — the JSON-RPC dispatch where anonymous
requests 401 today (`POST /mcp`, and the convenience `POST /mcp/tools/call`).

## Anonymous allowlist (D1, FR-001/FR-002)

A request with **no credential** (nothing extracted by `extractAgentToken`) is allowed
to proceed anonymously iff:

| JSON-RPC method | Anonymous behavior |
|---|---|
| `initialize` | Succeeds; returns `ANON_SERVER_INSTRUCTIONS` (< 2048 chars: session is unauthenticated; call `login` + relay code/URL + poll `login_status`; or use the client's native OAuth; never move the credential through the conversation) |
| `tools/list` | Succeeds; returns exactly `login` and `login_status` (filtered from the single registry) |
| `ping` | Succeeds (`{}`) |
| `tools/call` with `params.name` ∈ {`login`, `login_status`} | Executes with a synthetic anonymous context `{ isAnonymous: true, baseUrl, clientIp }`; `logAgentAction` skipped (no delegation) |
| `tools/call` with any other name | **The untouched 401**: same `WWW-Authenticate` via `buildChallenge(req, { branch: 'missing' })`, same `{ error: 'No agent token provided', code: 'MISSING_TOKEN' }` body |
| any other method | Same untouched 401 |

A request presenting an **invalid or expired** credential keeps today's behavior
exactly (invalid/expired 401 branches) for every method including the login tools —
anonymous means absent credential, not broken credential. (An agent with a broken
token that wants the login flow retries with no Authorization header; the anon
instructions say so.)

Authenticated sessions: both login tools present and callable identically (D2);
full toolset = 18.

**Convenience endpoints**: `POST /mcp/tools/call` gets the same allowlist treatment as
JSON-RPC `tools/call`. `POST /mcp/tools/list` (debug convenience, unauthenticated
today) gets the same anonymous filter as `tools/list` — anonymous callers see only the
two login tools; authenticated behavior unchanged. (This narrows an undocumented
anonymous response that previously listed all tool names; the MCP protocol surface and
OAuth surface are unaffected.)

## Byte-identical guarantee (FR-003, SC-003)

For clients that never call `login`, every response on the authentication surface is
byte-identical to pre-feature behavior:

- 401 challenge contents (all three branches of `buildChallenge`) — unchanged file:
  `server/mcp/auth/middleware.js`.
- `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`
  — untouched.
- `POST /mcp/auth/register` (RFC 7591), `GET /mcp/auth/authorize`,
  `POST /mcp/auth/approve`, `POST /mcp/auth/token` (auth-code + PKCE, refresh),
  `POST /mcp/auth/revoke` — untouched files (`oauth-flow.js`, `oauth-router.js` gains
  no OAuth-path changes; login page routes live in a separate router).
- No RFC 8628 grant at the token endpoint.

**Flagged consequence (G1, carried from the ledger)**: clients that trigger OAuth only
off a handshake 401 will now handshake anonymously first; their users authenticate via
the login tool or the client's explicit authenticate action. Mitigated by the anonymous
instructions and tool descriptions.

## Abuse posture summary (FR-024/025/026 — full details in the other contracts)

- `login`: 10/min/IP; pending caps 5/IP, 500 global; uniform retriable
  `rate_limited` result.
- `login_status`: per-handle slow_down (+5 s/violation); handles unguessable
  (256-bit, hashed at rest); unknown ≡ consumed ≡ expired (D5).
- Code entry: 5/min/user, 20/hour/IP; uniform invalid-or-expired.
- Claim: 10/min/IP; uniform 404.
- No response on the anonymous surface reveals account/user/agent existence
  (timing included: digest-indexed lookups, no secret-length-dependent comparisons);
  the anonymous surface touches no documents and no user data.
- Hostile `agentName`: validated per D9, stored raw, rendered only as inert text.

## Test obligations

`server/mcp/__tests__/auth/anonymous-surface.test.js` must assert:
1. Anonymous `initialize`/`tools/list`/`ping` succeed; tool list is exactly the two.
2. Anonymous `tools/call` on every other registered tool name → 401 with header +
   body deep-equal to `buildChallenge` output captured from the pre-feature branch
   shape (string-literal pinned).
3. Invalid-token requests behave exactly as today for all methods.
4. Existing OAuth suites (`server/mcp/__tests__/auth/*`) pass unchanged (SC-003).
