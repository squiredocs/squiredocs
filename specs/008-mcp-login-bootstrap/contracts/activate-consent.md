# Contract: `/activate` page and consent endpoints

Client: `client/src/pages/ActivatePage.jsx`, routed via `parseRoute()` in
`client/src/App.jsx` (mirrors `/authorize` → `AuthorizePage.jsx`). Server:
two session-authenticated routes in a new `server/mcp/auth/login-router.js`
mounted at `/mcp/login` (sibling of `oauth-router.js`; carries no OAuth semantics —
the transport OAuth surface is untouched).

## Page flow (FR-014)

1. Signed-out visitor at `/activate` → sign-in prompt linking
   `/login?returnTo=${encodeURIComponent(pathname + search)}` — the exact
   feature-005 round-trip (same-origin relative `returnTo` only, cookie through the
   Google redirect, precedence over signup/onboarding redirects, open-redirect
   defenses). First-time users complete account creation and land back on `/activate`.
2. Signed-in: code entry form. Client normalizes for UX; **server normalization is
   authoritative**: uppercase, strip hyphens/whitespace, then SHA-256 → lookup (FR-015).
3. Valid code → consent card. 4. Approve/Deny → result state.

## `POST /mcp/login/code`  (session auth: `requireAuth`)

Body: `{ "code": "wdjb-mjht" }` (any case, separators optional).

Gates in order: rate limit (5/min/user, 20/hour/IP → `429 { "error": "rate_limited" }`)
→ normalize → one-shot consume:
`UPDATE … SET code_entered_at=NOW(), entered_by_user_id=$u WHERE user_code_hash=$1
AND state='pending' AND code_entered_at IS NULL AND expires_at > NOW() RETURNING …`.

| Case | Status | Body |
|---|---|---|
| Success | `200` | `{ "authorizationId": "<uuid>", "agentName": "<as stored>", "scopes": ["documents:read","documents:write"], "expiresAt": "<iso>" }` |
| Wrong / expired / already used / malformed | `400` | `{ "error": "invalid_or_expired", "message": "That code is invalid or has expired. Ask your agent to run login again." }` — identical across causes (FR-015) |
| Rate limited | `429` | uniform rate-limit shape |

`agentName` in the response is the raw stored string; the client renders it as a React
text node (inert by construction — FR-008/FR-016). It must never be interpolated into
HTML/markup server- or client-side.

## `POST /mcp/login/decision`  (session auth: `requireAuth`)

Body: `{ "authorizationId": "<uuid>", "approved": true|false }`.

Ownership: the row's `entered_by_user_id` must equal the session user (the person who
entered the code decides); mismatch → the uniform `400 invalid_or_expired`.

**Approve** (single pg transaction):
1. Active-token cap pre-check (D7): if the user already has ≥ 25 active `sk_sqd_`
   tokens → `409 { "error": "token_limit", "message": "You've reached your API-token
   limit. Revoke a token in Settings → API Tokens, then approve again." }`;
   authorization **stays pending** (retriable until TTL).
2. `createDelegation(userId, 'mcp-login:<authorizationId>', agentName,
   { scopes: ['documents:read','documents:write'] })` — a standard delegation: same
   store, cascade, attribution, Settings visibility (FR-017). No `registered_agents`
   row.
3. `UPDATE … SET state='approved', approved_at=NOW(), approved_by_user_id=$u,
   delegation_id=$d, claim_expires_at=NOW() + interval '5 minutes'
   WHERE id=$1 AND state='pending' AND expires_at > NOW() RETURNING id` — zero rows ⇒
   TTL lapsed between code entry and click ⇒ rollback (delegation is not created) and
   `410 { "error": "expired", "message": "This request expired — ask your agent to run
   login again." }` (FR-018, US3 scenario 7).
4. `200 { "status": "approved", "message": "…the agent can now connect. Manage or
   revoke this access anytime in Settings → AI Agent Access." }`

**Deny**: `UPDATE … SET state='denied' WHERE id=$1 AND state='pending' RETURNING id`;
creates nothing; `200 { "status": "denied", "message": "Nothing was granted." }`.
Zero rows → uniform `400 invalid_or_expired`.

## Consent card content (FR-016)

- Skeptical identity line: `An agent calling itself “<agentName>” requests access to
  your documents.` plus explicit sub-text: name is self-declared and NOT verified.
- Exact scopes with the existing `SCOPE_DESCRIPTIONS` copy (`documents:read`,
  `documents:write`) — never any admin capability.
- Approve + Deny buttons; "Revoke access anytime in Settings → AI Agent Access" note
  (reuses AuthorizePage patterns/styles).
- Signed-in-as email row (phishing mitigation context, mirrors AuthorizePage).

## Post-decision user-visible guarantees

- Approved+claimed pairing appears in Settings → AI Agent Access (delegation) and
  Settings → API Tokens (token named "<agentName> (via MCP login)"); revoking either
  kills the credential via the existing cascade (FR-023).
- An approval never claimed within 5 minutes is auto-expired and its delegation
  revoked (lazy, FR-021) — Settings shows no zombie pairing.
