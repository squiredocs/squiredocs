# Phase 1 — Data Model: Admin Per-User Agent Connection & Onboarding Detail (036)

**No schema change.** No migration, no new table, no new column, no index, no counter, no cache
(FR-011, SC-004). Everything below is a *read* over tables that already exist, verified against
`migrations/` and the dev database on 2026-07-26. This document describes what is read, what is
derived, and — as importantly — what is never read.

---

## Source tables (read-only)

### `agent_delegations` (migrations 010, 011)

| Column | Read? | Use |
|---|---|---|
| `id` | yes | row key; correlates with `mcp_api_tokens.minted_by_delegation_id` |
| `user_id` | filter | `WHERE user_id = $1` |
| `agent_id` | no | self-reported instance identifier; `agent_client_id` is the useful one |
| `agent_name` | yes | fallback display name (FR-004) — **self-reported, untrusted string** |
| `agent_client_id` | yes | nullable FK → `registered_agents.id`; also shown as sub-text |
| `agent_instance_id` | no | not needed for the question |
| `agent_metadata` | **never** | free-form client-supplied JSON; no reporting value |
| `scopes` | yes | `text[]` → JSON array |
| `created_at` | yes | original consent time (see lifecycle note) |
| `last_used_at` | yes | nullable |
| `revoked_at` | yes | drives `state`; also serialised |
| `expires_at` | yes | drives `state`; also serialised |
| `refresh_token_hash` | **NEVER** | credential-equivalent (FR-009) |
| `refresh_token_version`, `refresh_token_expires_at` | no | refresh-rotation internals |

Indexes used: `idx_agent_delegations_user` (`user_id`).

### `registered_agents` (migration 011)

Only `id` and `name` are read, via `LEFT JOIN … ON ra.id = d.agent_client_id`.
`client_secret_hash` is **NEVER** read. `is_enabled` is deliberately ignored: a
deployment-disabled client must still display under its registered name for a user who holds a
delegation to it (spec Edge Cases).

### `mcp_api_tokens` (migrations 1773172617959, 1792000000000)

| Column | Read? | Use |
|---|---|---|
| `id` | yes | row key; correlates with `minted_by_api_token_id` chains |
| `user_id` | filter | `WHERE user_id = $1` |
| `name` | yes | display name — **user-supplied, untrusted string** |
| `token_prefix` | yes | non-secret identifying prefix (FR-002/FR-009) |
| `token_hash` | **NEVER** | credential-equivalent (FR-009) |
| `scopes` | yes | `text[]` → JSON array |
| `created_at`, `last_used_at`, `revoked_at`, `expires_at` | yes | timestamps + `state` |
| `minted_by_delegation_id`, `minted_by_api_token_id` | yes | mint path (FR-002/FR-003) |

Index used: `idx_mcp_api_tokens_user_id` (`user_id`).

### `agent_activity_log` (migration 010)

Aggregate only: `COUNT(*)` and `MAX(created_at)` for `user_id = $1`. Index:
`idx_agent_activity_user_time` (`user_id, created_at`).
`metadata` is **NEVER** selected — it records `{ args }`, i.e. raw tool arguments, which can
embed user content. `delegation_id`, `agent_id`, `action`, `doc_guid` are not read: the summary
is a count and a timestamp, no timeline (FR-006, Out of Scope).

**Coverage boundary (load-bearing, not a footnote)**: rows exist only for
delegation-authenticated MCP calls (`delegation_id` is `NOT NULL`; the write is gated on it).
`sk_sqd_`-token calls and REST traffic are absent by construction. See research R6 for how the
response and the UI label this.

### `users` (migrations 1783000000000, 1795000000000, 1799300000000, 1799400000000)

Read for the onboarding block: `created_at`, `signup_source` (`'browser' | 'agent_oauth'`,
nullable for pre-029 accounts), `onboarded_at` (nullable), `welcome_email_sent_at` (nullable),
`welcome_doc_id` (nullable). Nothing else — in particular no IP/user-agent (already carried by
`GET /users`), no `is_admin`, no credit fields.

### `document_shares`

Read only inside an `EXISTS` sub-query: `user_id = $1 AND role = 'owner'` excluding
`welcome_doc_id` when it is non-null. Same ownership notion as the `docCount` sub-select in
`GET /users` (research R7).

---

## Derived values (computed per request, stored nowhere)

| Field | Rule | Requirement |
|---|---|---|
| `state` (delegation, token) | `revoked_at` set → `revoked`; else `expires_at` set and `<= now()` → `expired`; else `active` | FR-003 |
| `agentName` (delegation) | `registered_agents.name` when joined, else `agent_delegations.agent_name` | FR-004 |
| `mintedBy` (token) | `'agent'` when either `minted_by_*` is non-null, else `'interactive'` | FR-002/FR-003 |
| `authoredNonWelcomeDoc` | the `EXISTS` above | FR-005 |
| `activity.count`, `activity.lastActivityAt` | `COUNT(*)`, `MAX(created_at)`; `count: 0` / `lastActivityAt: null` when no rows | FR-006 |

## Lifecycle notes that change how a row should be read

- **Delegations are reused on re-consent.** `agent_delegations` is unique on `(user_id,
  agent_id)`; reconnecting after a revoke clears `revoked_at` on the *same* row rather than
  inserting a new one. So `createdAt` is the **original** consent time, which is the honest
  lifetime answer to "when did they first connect this agent" (spec Edge Cases) — and it is why
  the delegation list is not a connection history.
- **Revocation is soft.** `revoked_at` is set; rows are never deleted on revoke. Lifetime
  listing (FR-003) therefore needs no archive table — the rows are all still there.
- **Mint parents are `ON DELETE SET NULL`.** A hard-deleted parent leaves an orphan child that
  reads as interactively minted. Accepted (spec Edge Cases).
- **`onboarded_at` is stricter than `authoredNonWelcomeDoc`.** See research R7 / RBD-10: the
  stamp requires persisted content; this field requires only ownership. Both are displayed.

## Ordering

Delegations and tokens both `ORDER BY created_at DESC` — newest first, matching the sharing and
extra-credits panels and the user's own Settings list. State is a badge, not a sort key: an
admin looking for "did they ever" wants chronology, not the live rows floated to the top.

## Volume

Beta scale: at most a few delegations per user, `MAX_TOKENS_PER_USER = 250` as the hard ceiling
on the token list, one aggregate row for activity. Three index-served queries plus one
primary-key row read per expand — comfortably inside SC-005's 1-second budget with no
pagination, and pagination is deliberately not added (YAGNI; the cap is the bound).
