# Contract: Rate Limiting, Registration Caps & Trust Proxy

## Limited routes & default budgets (RD-1, all env-overridable)

| Route(s) | Scope | Class | Default | Env var |
|----------|-------|-------|---------|---------|
| `/auth/*` | per-IP | `auth` | 30 / min | `RL_AUTH_PER_MIN` |
| `POST /mcp/auth/token` | per-IP | `token` | 30 / min | `RL_TOKEN_PER_MIN` |
| `POST /mcp/auth/register` + authorize/approve auto-register | per-IP | `register` | 5 / hour | `RL_REGISTER_PER_HOUR` |
| anonymous registration (aggregate) | global | `register:global` | 200 / day | `RL_REGISTER_GLOBAL_PER_DAY` |
| content search (`GET /api/docs?searchMode=content`) | per-user | `search` | 30 / min | `RL_SEARCH_PER_MIN` |
| markdown import (`POST /api/docs/import`, `PUT /api/docs/:id/import`) | per-user | `import` | 10 / min | `RL_IMPORT_PER_MIN` |
| document export (`GET /api/docs/:id/export`) | per-user | `export` | 20 / min | `RL_EXPORT_PER_MIN` |
| chat (`POST /api/chat`) | per-user | `chat` | 30 / min | `RL_CHAT_PER_MIN` |

Per-user classes key on `req.user.userId` (mounted after `requireAuth`), so a user's budget is
shared across their IPs/connections (FR-006). Per-IP classes key on `req.ip` — correct only because
of the numeric trust-proxy change below (FR-005/014).

## 429 response shape (FR-009)

```
HTTP/1.1 429 Too Many Requests
Retry-After: <seconds>            # from rejRes.msBeforeNext when known
Content-Type: application/json

{ "error": "Rate limit exceeded. Retry later." }
```

- Neutral body — no budget internals beyond the retry hint.
- `Retry-After` present whenever a retry time is known.

## Exemptions & degrade behavior

- `GET /health` and `GET /ready` are **never** rate-limited (FR-012).
- Store is Redis (`RateLimiterRedis` on the existing ioredis client); budgets survive restart and
  span both replicas (FR-007). Keys carry a TTL = window so storage is bounded (Edge Cases).
- **Redis unavailable ⇒ degrade to per-process `RateLimiterMemory` of the same budget** (RD-3,
  FR-008): never crash, never reject all traffic, never fully unlimited. Dev without Redis uses the
  memory limiter via the same code path.

## Registration admission (FR-011, RD-2)

Before any `registerAgent(...)` that would create a **new** row (in `handleRegister`,
`handleAuthorize`, `handleApprove`):
- consume the per-IP `register` budget (shared key across all three paths), **and**
- consume the global daily counter (`rl:register:global`).
Over either bound → uniform 429, **no row written** (SC-004). Existing-agent lookups and idempotent
re-registration do not consume the budget.

## Trust proxy (FR-014/015, RD-5)

- `app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1))` — numeric hop count, never
  blanket `true`.
- Default 1 (immediate ingress / dev); prod sets 2 (CloudFront + Traefik) via 011 deploy config.
- A forged `X-Forwarded-For` chain (extra client-appended entries) MUST NOT change `req.ip`, the
  limiter key, or the logged client IP (covered by an automated test — FR-015, SC-003).
- Existing `req.protocol`/`buildBaseUrl` consumers (HTTPS redirect, base-URL construction, OAuth
  discovery metadata) MUST keep working at the configured hop count (FR-015).

## Composition with 008/009 login budgets (FR-013, RD-9)

- **Vacuous in this worktree** (HEAD `881aa9f` has no 008/009 login code).
- Limiter keys are namespaced (`rl:auth:ip:`, `rl:chat:user:`, …) so that if a merge later brings
  the login-flow budgets in, the flow-specific budget stays authoritative for the login pairing
  surface and this feature's middleware does not double-limit it. The merge/converge step owns any
  actual de-dup; no login route is limited by this feature here.

## Test seams

- `RL_FORCE_MEMORY=1` forces the memory limiter (deterministic budget tests without a live Redis).
- `_reset()` clears in-process counters between tests.
