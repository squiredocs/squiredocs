# Contract: REST login endpoints (start / status / claim + alias)

Modules: `server/api/login.js` (NEW — start, status), `server/api/mcp-login-claim.js` (EDIT —
canonical + alias). All three are **thin wrappers over `server/mcp/auth/login-service.js`** — no
second implementation of any flow step. Anonymous (no `requireAuth`). Handle carried ONLY in
`Authorization: Bearer` (008 review rule, every login route). Baseline: 008
`contracts/login-tools.md` + `claim-endpoint.md`, inherited unchanged except the additions below.

## `POST /api/login/start`

Request: JSON body `{ "agentName": "<string>" }`.

Gates, in order (identical to the `login` tool, RD-8 shared budgets):
1. `agentName` validation (008 D9, via `loginService.validateAgentName`): required; non-empty after
   trim; ≤ 100 chars; no control chars. **Failure → HTTP 400**, actionable message, **no pending
   authorization created**.
2. Per-IP login rate limit — the **shared** `login:ip:<ip>` budget (`LOGIN_CALLS_PER_MINUTE_PER_IP`,
   10/min), via the same helper the tool uses. Breach → **HTTP 429** + `Retry-After`, uniform
   rate-limited body.
3. Per-IP pending cap (5) + global pending cap (500), inside `createPendingAuthorization` (Postgres
   COUNTs, flow-wide). Breach → **HTTP 429** (+ `Retry-After` where a retry time is known), uniform
   rate-limited body.

Success → **HTTP 200**, plain JSON, superset of the enumerated fields (RD-1):
```json
{
  "status": "pending_authorization",
  "handle": "sqlh_<43 base64url chars>",
  "userCode": "WDJB-MJHT",
  "verificationUri": "<baseUrl>/activate",
  "expiresInSeconds": 600,
  "pollIntervalSeconds": 5,
  "instructions": "Open <baseUrl>/activate and enter WDJB-MJHT. Then poll GET <baseUrl>/api/login/status with Authorization: Bearer <handle> every 5 seconds until approved. Never move the credential through this conversation."
}
```
Enumerated minimum (design): `userCode`, `verificationUri`, `handle`, `pollIntervalSeconds`. No
JSON-RPC envelope, no double-encoded text blocks. `instructions` are the REST-channel rephrasing
(poll the status URL with the Bearer handle, not the tool).

Unexpected error → **HTTP 500** `{ "error": "server_error" }` (no internals leaked).

## `GET /api/login/status`

Auth: handle in `Authorization: Bearer <handle>` ONLY. Missing / malformed / wrong-scheme →
**HTTP 200 `{ "status": "expired", ... }`** — byte-identical to a fabricated handle (RD-6, no
oracle). Never accept the handle via query string or any other carrier.

Query: `?inline=true` opt-in (RD-5) — mirrors the tool's `inline: true`.

Delegates to `loginService.getStatus(handle, { inline, baseUrl })`. **Every** decision-table outcome
is **HTTP 200** with the outcome in `status` (RD-2):

| `status` | Meaning | Notes |
|---|---|---|
| `slow_down` | premature poll | `pollIntervalSeconds` raised +5s per violation; one-shot NOT consumed |
| `pending` | TTL live | `expiresInSeconds`, `pollIntervalSeconds` |
| `denied` | terminal | |
| `expired` | expired/unknown/already-delivered/claimed/auth-defect | uniform, indistinguishable (RD-6) |
| `approved` (default) | first delivery | one-shot `claimCommand` (canonical path) + `instructions` + **`nextSteps`** (no credential) |
| `approved` (`inline=true`) | one-time in-band credential | `warning` first, `credential`, `expiresInDays`, **`nextSteps`**; `Cache-Control: no-store` |
| `token_limit` | mint-time cap on inline | actionable message (008 D13); approval stays valid in window |

One-shot semantics hold across ALL channels jointly (FR-008): exactly one approved-payload delivery
and exactly one credential delivery per pairing, across tool/REST/inline/canonical-claim/alias-claim;
any later attempt on any channel → uniform failure. Poll-interval state is per-handle, shared.

No per-IP transport limit (G2, ratified — identical to the tool; per-handle slow-down only).

## `GET /api/login/claim` (canonical) and `GET /api/mcp/login/claim` (alias)

**One handler, mounted at both paths** (FR-007). Byte-identical request handling (Bearer-only) and
responses. Both draw from the single `claim:ip:<ip>` budget (`CLAIM_ATTEMPTS_PER_MINUTE_PER_IP`,
10/min) — one budget for both URLs (RD-8), automatic because it is the same handler.

Mapping (008, unchanged — RD-2):
- **200** `text/plain; charset=utf-8`, `Cache-Control: no-store`, credential bytes + trailing `\n`
  (raw credential ONLY — `nextSteps` NEVER on the byte channel, RD-3).
- **404** `{ "error": "invalid_or_expired" }` — uniform for fabricated/consumed/expired/missing/
  malformed handle and concurrent-claim losers (no oracle).
- **429** `{ "error": "rate_limited", "retryAfterSeconds": <n> }` + `Retry-After`, keyed before
  handle inspection.
- **409** `{ "error": "token_limit", ... }` — mint-time cap; row stays approved, retriable in window.
- **500** `{ "error": "server_error" }`.

`buildClaimCommand` emits the **canonical** `/api/login/claim` URL (RD-4); the alias is documented at
most as a compatibility note and is never removed (spec Out of Scope).

## Invariants (must hold, tested)

- No login state-machine, `/activate`, delegation, mint, or OAuth/PKCE change (FR-010).
- MCP `login`/`login_status` observe no behavior change beyond `nextSteps` + canonical claim path in
  emitted recipes (FR-009, FR-012).
- Every gate's effective budget is unchanged by the new door (SC-002 — no budget doubled).
