# Data Model — 008-mcp-login-bootstrap

One new table. Everything else reuses `agent_delegations` and `mcp_api_tokens` as-is.
Migration: `migrations/1794000000000_create-mcp-pending-authorizations.js` (the feature's
single in-flight migration slot).

## New table: `mcp_pending_authorizations`

The short-lived record binding one `login` call to one eventual human decision
(spec Key Entity "Pending Authorization"). No secrets in plaintext: handle and user
code are stored as SHA-256 hex digests only.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK, default `gen_random_uuid()` | Also the suffix of the delegation `agent_id` (`mcp-login:<id>`) |
| `handle_hash` | text | NOT NULL, UNIQUE | SHA-256 hex of the `sqlh_…` handle (256-bit, base64url). Sole session binding; lookup key for poll + claim |
| `user_code_hash` | text | NOT NULL | SHA-256 hex of the normalized 8-char code (uppercase, separators stripped). Partial UNIQUE index `WHERE state = 'pending'` — unique among outstanding only (FR-009); insert retries on conflict |
| `agent_name` | text | NOT NULL, length ≤ 100 enforced in service layer | Self-declared display name (D9: trimmed, non-empty, no control chars). Rendered inert-escaped everywhere |
| `state` | text | NOT NULL, default `'pending'`, CHECK in (`pending`,`approved`,`denied`,`expired`,`claimed`) | See state machine below |
| `origin_ip` | inet | NOT NULL | Per-IP cap accounting (FR-024). Never revealed |
| `created_at` | timestamptz | NOT NULL, default NOW() | |
| `expires_at` | timestamptz | NOT NULL | `created_at + 10 minutes` (D4). Pending rows past this are dead (lazy-expired) |
| `code_entered_at` | timestamptz | NULL | Set once by the code-consumption UPDATE; one-shot code (FR-009) |
| `entered_by_user_id` | uuid | NULL, FK → users(id) ON DELETE CASCADE | Who entered the code (consent page binding) |
| `approved_at` | timestamptz | NULL | Set by the approve transition |
| `approved_by_user_id` | uuid | NULL, FK → users(id) ON DELETE CASCADE | The delegating user (spec Assumption: whoever approves delegates) |
| `delegation_id` | uuid | NULL, FK → agent_delegations(id) ON DELETE SET NULL | Created at approval; auto-revoked if claim window lapses (FR-021). SET NULL mirrors minted-by precedent |
| `claim_expires_at` | timestamptz | NULL | `approved_at + 5 minutes` (D4). Claim/inline delivery valid only before this |
| `payload_delivered_at` | timestamptz | NULL | Set once by the one-shot approved-payload UPDATE (FR-011); later polls indistinguishable from expired (D12) |
| `claimed_at` | timestamptz | NULL | Set by the atomic claim transition |
| `claim_channel` | text | NULL, CHECK in (`rest`,`inline`) | Which one-time delivery happened (FR-012: one delivery, one channel) |
| `last_polled_at` | timestamptz | NULL | Poll-interval enforcement (D8) |
| `required_poll_interval_seconds` | integer | NOT NULL, default 5 | +5 per premature poll (slow_down, FR-013); never resets, never invalidates |

### Indexes

- `UNIQUE (handle_hash)` — poll + claim lookup.
- `UNIQUE (user_code_hash) WHERE state = 'pending'` — outstanding-code uniqueness (partial).
- `(origin_ip) WHERE state = 'pending'` — per-IP cap count (partial).
- `(state, claim_expires_at)` partial `WHERE state = 'approved'` — lazy auto-revoke sweep.
- (Global cap count uses the `state = 'pending'` predicate; covered by the origin_ip partial index scan or a plain state check at this scale.)

### State machine

```
                    login()                       ┌──────────┐
  (anonymous or authenticated caller) ──────────▶ │ pending  │
                                                  └────┬─────┘
     code entry (one-shot: code_entered_at set,        │
     entered_by_user_id bound; state unchanged)        │
                                                       │
        ┌──────────────┬───────────────┬──────────────┘
        │ Approve      │ Deny          │ TTL lapse (lazy)
        ▼              ▼               ▼
   ┌──────────┐   ┌─────────┐    ┌──────────┐
   │ approved │   │ denied  │    │ expired  │   denied/expired: TERMINAL
   └────┬─────┘   └─────────┘    └──────────┘
        │ approve also: creates delegation (same tx),
        │ sets claim_expires_at = now + 5 min
        │
        ├─ one-shot approved payload (payload_delivered_at set; state unchanged;
        │  subsequent polls answer as if expired — D12)
        │
        ├─ claim (REST or inline, atomic UPDATE, exactly one winner)
        │      ──▶ state = 'claimed'  (mint sk_sqd_ token in same tx — D6)
        │          claimed: TERMINAL
        │
        └─ claim window lapses unclaimed (lazy, observed at poll/claim/login-GC)
               ──▶ state = 'expired' + revokeDelegation(delegation_id) (FR-021)
```

Invariants (SC-005):
- Every consuming transition is a single conditional `UPDATE … RETURNING` (research R5).
- `denied`/`expired` rows never transition again (no UPDATE predicate matches them).
- `claimed` requires prior `approved` with live `claim_expires_at`; exactly one
  concurrent claim succeeds (row lock).
- Unknown handle ≡ consumed handle ≡ expired handle in every external response (D5).
- Mint-time token-cap failure rolls back the claim UPDATE (row stays `approved`,
  retriable within the window — FR-022).

### Lazy expiry & GC

No background job. `expires_at`/`claim_expires_at` predicates make dead rows
unusable immediately; an opportunistic sweep at each `login` call (a) marks lapsed
`approved` rows `expired` and revokes their delegations (FR-021), (b) marks lapsed
`pending` rows `expired`, (c) deletes terminal rows older than 24 h (bounded audit
residue; nothing secret is stored).

## Reused entities (no schema change)

- **`agent_delegations`**: approval calls `createDelegation(userId,
  'mcp-login:<authorization id>', agentName, { scopes: ['documents:read',
  'documents:write'] })`. Unique per-pairing `agent_id` makes the upsert collision-free
  (research R6). No `registered_agents` row — Settings LEFT JOIN falls back to
  `agent_name` (research R10). Revocation cascade untouched (FR-023).
- **`mcp_api_tokens`**: minted at delivery via `createToken(userId, "<agentName> (via
  MCP login)", { scopes: delegation.scopes, expiresAt: now + 30 days,
  mintedByDelegationId: delegation.id })`. Hashed at rest, `MAX_TOKENS_PER_USER = 25`
  cap checked at approval and re-checked at mint (D7/FR-022), revocation via existing
  cascade.

## Operational constants (named, tunable — D4/D10)

Module: `server/mcp/auth/login-constants.js` (imported by the service/tools/routers; exported for tests).

| Constant | Value |
|---|---|
| `AUTHORIZATION_TTL_SECONDS` | 600 |
| `CLAIM_WINDOW_SECONDS` | 300 |
| `MIN_POLL_INTERVAL_SECONDS` | 5 |
| `SLOW_DOWN_INCREMENT_SECONDS` | 5 |
| `CREDENTIAL_TTL_DAYS` | 30 |
| `USER_CODE_LENGTH` / `USER_CODE_ALPHABET` | 8 / `BCDFGHJKLMNPQRSTVWXZ` |
| `AGENT_NAME_MAX_LENGTH` | 100 |
| `MAX_PENDING_PER_IP` / `MAX_PENDING_GLOBAL` | 5 / 500 |
| `LOGIN_CALLS_PER_MINUTE_PER_IP` | 10 |
| `CODE_ATTEMPTS_PER_MINUTE_PER_USER` / `CODE_ATTEMPTS_PER_HOUR_PER_IP` | 5 / 20 |
| `CLAIM_ATTEMPTS_PER_MINUTE_PER_IP` | 10 |
| `HANDLE_PREFIX` | `sqlh_` |
