# Phase 1 Data Model: Signup/Login IP + User-Agent Capture

**Feature**: 034-auth-ip-capture | **Date**: 2026-07-25 | **Migration**: `migrations/1799400000000_add-auth-ip-capture.js`

Ground truth: `design/authentication-and-sharing.md` → "Abuse signals: signup/login IP + user-agent" and the amended "Data model" line. Column names, types, and the table name below are taken verbatim from that document.

## E1 — `users` (extended)

Four **nullable** columns added to the existing table. No default, no backfill, no `NOT NULL` (FR-014: pre-feature rows stay absent forever).

| Column | Type | Null | Written by | Overwrite policy |
|--------|------|------|-----------|------------------|
| `signup_ip` | `inet` | yes | `findOrCreateUser` — INSERT column list only | **Never** overwritten. Absent from `ON CONFLICT DO UPDATE SET`, exactly like `signup_source` (feature 029). FR-001. |
| `signup_user_agent` | `text` (≤ 512 chars, enforced app-side) | yes | `findOrCreateUser` — INSERT column list only | **Never** overwritten. FR-001. |
| `last_login_ip` | `inet` | yes | `updateLastLogin` | Refreshed on **every** completed login, in the same `UPDATE` as `last_login_at`. FR-002. |
| `last_login_user_agent` | `text` (≤ 512 chars, enforced app-side) | yes | `updateLastLogin` | Refreshed on every completed login. FR-002. |

**Retention**: for the life of the account (FR-010 explicitly exempts these from the purge). They disappear only when the user row does.

**Why no length `CHECK` on the `*_user_agent` columns**: truncation is a single app-side operation in `authContext` (FR-007), and a database constraint would convert an out-of-bound value into a *thrown error inside the auth path* — the precise outcome FR-008 forbids. The bound is asserted by tests, not by a constraint that fails open into a broken login.

**Why `inet` and not `text`**: the design fixes it; it validates on write, normalizes IPv4/IPv6, accepts the `::ffff:` dual-stack form Express produces, and gives the follow-on detector real address operators (`<<=`, network containment) instead of string prefix matching. The write-side risk this creates — an unparsable value raising inside the auth statement — is closed in JS by `net.isIP()` before the value is ever bound (research R2).

## E2 — `auth_events` (new, append-only)

One row per **completed** signup or login. Application code only ever `INSERT`s; there is no update path and no per-row delete outside retention and FK cascade (FR-003).

| Column | Type | Null | Notes |
|--------|------|------|-------|
| `id` | `bigserial` PK | no | Matches the `agent_edits` convention; monotonic and cheap. No UUID needed — the trail is never addressed externally. |
| `user_id` | `uuid` | no | `REFERENCES users ON DELETE CASCADE` — FR-009. |
| `event` | `text` | no | `CHECK (event IN ('signup','login'))`. |
| `signup_source` | `text` | no | `CHECK (signup_source IN ('browser','agent_oauth'))`, `DEFAULT 'browser'`. Same value domain as `users.signup_source`; for a `login` row it records the channel of **this event**, not how the account was born (design gap **G-1**, spec default). Dev-login records `browser`. |
| `ip` | `inet` | yes | The proxy-resolved client address, or `NULL` when unavailable/unparsable. |
| `user_agent` | `text` | yes | ≤ 512 chars (app-side), or `NULL` when the header is absent. |
| `created_at` | `timestamptz` | no | `DEFAULT now()`. The event time; drives the 180-day purge. |

The two nullable fields are independent — either may be `NULL` while the other is present (spec Edge Cases).

### Indexes

| Index | Columns | Justification |
|-------|---------|---------------|
| `auth_events_created_at_idx` | `(created_at)` | FR-010 names an event-time index for the purge. Also serves recency scans. |
| `auth_events_user_id_idx` | `(user_id)` | Postgres does **not** auto-index FK columns; without it, every user delete (029's `deleteUserByEmail`, admin cleanup, synthetic wipe) sequentially scans `auth_events` to cascade. Correctness-adjacent, not speculative. |
| `auth_events_ip_created_at_idx` | `(ip, created_at)` | The trail's stated purpose in the design is "shared-IP grouping across accounts and exhaust-grant-then-respawn relay detection", and US2 calls day-one manual queries part of the value. This is the query shape both need. Recorded as **RBD-6** — the alternative (defer to the detector feature) would cost a second migration for one line. |

### Lifecycle

| Trigger | Effect |
|---------|--------|
| Completed signup | Exactly one row, `event='signup'` (research R1: written by `updateLastLogin` with `isNew=true`). |
| Completed login | Exactly one row, `event='login'`. |
| Token refresh | **No row**, and no change to any `users` capture column (FR-005; holds by construction — refresh calls neither helper). |
| Failed authentication | **No row** (design gap **G-3**, spec default; capture lives in post-verification helpers). |
| Row age > 180 days | Deleted by `purgeOlderThan(180)` — boot sweep + daily interval (FR-010). `users` columns untouched. |
| User deleted | All of that user's rows deleted by FK cascade (FR-009). |
| Insert fails | Caught, logged, swallowed — authentication still succeeds (FR-008). |

## Relationships

```text
users (1) ──< auth_events (N)          FK user_id, ON DELETE CASCADE
  │
  ├─ signup_ip / signup_user_agent          write-once snapshot  (lifetime of account)
  └─ last_login_ip / last_login_user_agent  latest-login snapshot (lifetime of account)
```

The `users` columns are a deliberate denormalization of the trail: they are the at-a-glance admin signal (one row per user, no aggregation) and they outlive the 180-day trail.

## Validation rules (enforced in `server/auth/auth-context.js`, one place)

| Input | Rule | Result |
|-------|------|--------|
| `req.ip` / `req.socket.remoteAddress` | `net.isIP(value) !== 0` | valid → stored as-is; anything else (missing, empty, `'unknown'`, zone-suffixed) → `null` |
| `req.headers['user-agent']` | non-empty string after trim | absent/empty → `null` |
| user-agent length | `> 512` | truncated to exactly 512 chars (FR-007), applied once so both storage locations get the bounded value |

## Exposure boundary

| Surface | Exposes capture fields? |
|---------|------------------------|
| `GET /api/admin/users` (behind `requireAdmin`) | **Yes** — all four (FR-011). |
| Admin page user table + detail row | **Yes** — all four (FR-011). |
| `GET /auth/me`, `PATCH /auth/me` | **No** — explicit field whitelists (verified). |
| MCP / agent-facing tools, public APIs, share/collaborator payloads | **No** (FR-012). |
| `auth_events` | **No API surface at all** — SQL-only for now; the reporting UI is the out-of-scope follow-on. |

## Migration notes

- Timestamp `1799400000000` > current latest `1799300000000` and > the `1795000000000` rolled-back-008 floor. This is the only migration-adding feature in flight.
- `up`: `pgm.addColumns('users', {...})` then `pgm.createTable('auth_events', {...})` then the three `pgm.createIndex` calls.
- `down`: drop the table (indexes go with it) then drop the four columns — reversible, no data preservation expected.
- Additive only: no `NOT NULL` on the new `users` columns, no default, no rewrite of existing rows, so the migration is fast and safe on a live table.
