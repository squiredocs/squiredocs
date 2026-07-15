# Contract: `login` and `login_status` MCP tools

Modules: `server/mcp/tools/login.js`, `server/mcp/tools/login-status.js`.
Registered in `server/mcp/tools/index.js`; NO entry in `TOOL_SCOPES` (no scope
required — FR-004). Callable anonymously and authenticated with identical behavior
(D2). Descriptions ≤ 2048 chars each (tool-modules guard). Standard toolset count
becomes **18**; anonymous sessions list only these two.

## `login`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "agentName": {
      "type": "string",
      "description": "Your self-declared display name, shown to the user on the consent page (max 100 chars)."
    }
  },
  "required": ["agentName"]
}
```

Validation (D9, FR-008): required; non-empty after trim; ≤ 100 chars; control
characters (`/[\x00-\x1F\x7F]/`) rejected. Failures throw the standard
`Invalid parameters for tool 'login': …` error shape (tool-result `is_error`, matching
registry validation errors). No pending authorization is created on validation failure.

Abuse gates, checked in order (FR-024/025, D10): per-IP login rate (10/min) →
per-IP pending cap (5) → global pending cap (500). Any failure returns a tool result
(not a protocol error):
```json
{ "status": "rate_limited", "retryable": true,
  "message": "Too many login attempts. Wait a minute and try again." }
```
No cap/limit failure distinguishes which gate fired beyond this uniform shape.

Success result (FR-006/FR-007):
```json
{
  "status": "pending_authorization",
  "handle": "sqlh_<43 base64url chars>",
  "userCode": "WDJB-MJHT",
  "verificationUri": "<baseUrl>/activate",
  "expiresInSeconds": 600,
  "pollIntervalSeconds": 5,
  "instructions": "Tell your user: open <baseUrl>/activate and enter code WDJB-MJHT. Print the URL bare on its own line. Then poll login_status({ handle }) every 5 seconds until approved. Never move the credential through this conversation."
}
```
- `handle`: 256-bit CSPRNG, returned ONLY here (sole session binding; no cookies/IP
  binding). Stored hashed.
- `userCode`: 8 chars from `BCDFGHJKLMNPQRSTVWXZ`, displayed grouped `XXXX-XXXX`;
  unique among outstanding pendings; never appears in the verification URI (D3).
- Works identically for authenticated callers (re-pairing/rotation).

## `login_status`

Input schema:
```json
{
  "type": "object",
  "properties": {
    "handle": { "type": "string", "description": "The handle returned by login." },
    "inline": { "type": "boolean", "description": "Opt-in: return the credential inline on approval (only for agents with no shell). Default false." }
  },
  "required": ["handle"]
}
```

Results — always a tool result with a `status` field:

| Condition | Result |
|---|---|
| Premature poll (< required interval since `last_polled_at`) | `{ "status": "slow_down", "pollIntervalSeconds": <old+5>, "message": … }` — interval +5s per violation (D8); handle/state unaffected |
| Pending, TTL live | `{ "status": "pending", "expiresInSeconds": <remaining>, "pollIntervalSeconds": <current> }` |
| Denied | `{ "status": "denied", "message": "The user denied this request. Terminal — call login again to retry." }` |
| Expired / unknown handle / payload already delivered / claimed | `{ "status": "expired", "message": "Expired or unknown. Call login to start over." }` — all four indistinguishable (D5, D12) |
| Approved, first poll, `inline` absent/false | Approved payload below, delivered AT MOST ONCE (atomic `payload_delivered_at` set) |
| Approved, credential not yet delivered, `inline: true` | Inline payload below; counts as THE one-time credential delivery; REST claim thereafter unusable (FR-012). Explicitly: inline is a *claim through the polling channel* — it succeeds on an approved, unclaimed authorization within the claim window even if the recipe payload was already delivered (D12's "polls answer expired" applies to status polling, not to this delivery; shell-less recovery after receiving an unusable recipe stays possible) |
| `inline: true` while still pending | Plain `pending` (flag matters only at approved-delivery time) |

Approved payload (FR-011 — contains NO credential):
```json
{
  "status": "approved",
  "claimCommand": "umask 077 && curl -fsS -H \"Authorization: Bearer sqlh_…\" \"<baseUrl>/api/mcp/login/claim\" -o ~/.squire/credential && chmod 600 ~/.squire/credential",
  "claimExpiresInSeconds": 300,
  "instructions": [
    "Run the claim command within 5 minutes; it writes the credential to a file with owner-only (0600) permissions.",
    "Write the credential into your MCP client config or an env file, then reconnect — no mid-session toolset upgrade happens; persist and reconnect is the contract.",
    "NEVER print, echo, or paste the credential anywhere. The handle in this transcript is acceptable residue: short-lived, one-shot, dead after the claim."
  ]
}
```
After this response the handle answers `expired` to polling but remains valid solely
for the one-shot claim until first claim or window lapse (D12).

Inline payload (FR-012):
```json
{
  "status": "approved",
  "warning": "DO NOT ECHO: the credential below is a secret. Never print, echo, paste, or log it. Write it directly into your MCP client configuration, then reconnect.",
  "credential": "sk_sqd_…",
  "expiresInDays": 30
}
```
Exactly-once: the same atomic claim transition as REST (`claim_channel = 'inline'`).

## Polling discipline

Minimum interval 5 s; each premature poll returns `slow_down` and permanently raises
that handle's required interval by 5 s (never reset, never punitive beyond throttling —
FR-013). Compliant loop ≤ 12 req/min (SC-007). Sustained abuse additionally falls under
general per-IP limits.
