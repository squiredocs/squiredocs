# Contract: `GET /api/mcp/login/claim`

Module: `server/api/mcp-login-claim.js` (`createLoginClaimRouter(persistence)`),
mounted in `server/index.js` beside the export/import routers. NOT behind
`requireAuth` — the handle is the sole authentication (FR-020).

## Request

```
GET /api/mcp/login/claim
Authorization: Bearer sqlh_<handle>          (preferred)
```
Fallback accepted: `GET /api/mcp/login/claim?handle=sqlh_…` (for environments where
setting headers is awkward). The recipe emitted by `login_status` always uses the
header form (keeps the handle out of URL-logging paths).

## Responses

| Case | Status | Body |
|---|---|---|
| First claim, handle valid, state `approved`, within 5-min window | `200` | `Content-Type: text/plain; charset=utf-8`, `Cache-Control: no-store` — body is the `sk_sqd_` token + `\n`, suitable for `curl -o file` |
| Rate limit exceeded (10/min/IP) | `429` | `{ "error": "rate_limited", "retryAfterSeconds": <n> }` + `Retry-After` |
| Mint-time token-cap failure (FR-022 carve-out) | `409` | `{ "error": "token_limit", "message": "This account has reached its API-token limit. Revoke a token in Settings → API Tokens, then run the claim again — the approval stays valid until its window expires." }` |
| EVERYTHING else — unknown handle, malformed/missing handle, consumed (claimed or inline-delivered), denied, expired, window lapsed, fabricated | `404` | `{ "error": "invalid_or_expired" }` — byte-identical across all causes (D5, FR-020, FR-026) |

## Semantics

- **Atomic one-shot**: the claim is a single conditional
  `UPDATE mcp_pending_authorizations SET state='claimed', claimed_at=NOW(),
  claim_channel='rest' WHERE handle_hash=$1 AND state='approved' AND
  claim_expires_at > NOW() RETURNING *` inside a transaction. Under concurrent
  duplicates exactly one request wins; every loser gets the uniform 404. Never
  read-then-write.
- **Mint at delivery (D6)**: the winner mints the token in the same transaction:
  `apiTokens.createToken(approved_by_user_id, "<agentName> (via MCP login)",
  { scopes: delegation scopes, expiresAt: now + 30 days, mintedByDelegationId })`.
  On mint failure the transaction rolls back → row stays `approved`, claim retriable
  within the window; token-cap failure surfaces as the 409 above, any other mint error
  as a 500 with no token/handle detail.
- **Lapse handling**: a claim arriving after `claim_expires_at` triggers the lazy
  auto-revoke (row → `expired`, `revokeDelegation(delegation_id)` cascades) and returns
  the uniform 404 (FR-021).
- **No oracle**: response shape and status for never-existed vs consumed vs expired
  handles are identical; handle lookup is by SHA-256 digest index (no secret-dependent
  comparison on attacker-controlled length); rate limiting is per-IP, keyed before any
  handle inspection.
- **Delegation re-check**: mint verifies the delegation is still valid
  (`checkDelegation`) — a user who revoked in Settings between approve and claim gets
  the uniform 404 and no token.

## Claim recipe (emitted by `login_status`, FR-011)

```
umask 077 && curl -fsS -H "Authorization: Bearer <handle>" \
  "<baseUrl>/api/mcp/login/claim" -o ~/.squire/credential && chmod 600 ~/.squire/credential
```
0600/owner-only is agent-side guidance carried by the recipe (spec Assumption); the
default command implements it (`umask 077` + explicit `chmod 600`).
