# Data Model: Identity and Local Mode (059)

One migration: `migrations/1799830000000_add-user-identities-and-signin-links.js`.
It is the only migration in the 058/059/060 campaign so far. Its timestamp is
greater than every file in `migrations/` (latest `1799820000000`) and than the
retired phantom `1794000000000` that `script/migrate.js` removes. Any later
migration in this campaign must use a timestamp above `1799830000000`.

---

## Table `user_identities` (new)

One way a person proves who they are to a provider.

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | uuid | no | `uuid_generate_v4()` | primary key |
| `user_id` | uuid | no | | references `users(id)` ON DELETE CASCADE (FR-001) |
| `issuer` | text | no | | `https://accounts.google.com` or `dev` in 059; 061 adds OIDC issuers |
| `subject` | text | no | | provider's stable subject id (`sub`); for `dev`, `dev-test-user` or `dev-test-<nonce>` |
| `email_verified` | boolean | yes | | provider's claim when sent; NULL for backfilled rows (RBD-059-8). Nothing reads it in 059. |
| `created_at` | timestamptz | no | `now()` | backfill copies `users.created_at` |
| `last_used_at` | timestamptz | yes | | set on each sign-in through this identity |

Constraints and indexes:

- `UNIQUE (issuer, subject)` named `user_identities_issuer_subject_key` (the lookup path and the concurrency backstop, FR-005).
- Index on `user_id` (`user_identities_user_id_idx`): Postgres does not index FK columns, and every user delete cascades here (feature 029's wipe, the prod reset).
- `CHECK (length(issuer) BETWEEN 1 AND 512)`, `CHECK (length(subject) BETWEEN 1 AND 255)`.

Validation (application): the Google provider passes `payload.sub` as subject and `payload.email_verified` (boolean or absent) as `email_verified`. The faucet passes issuer `dev` and never sets `email_verified`.

Lifecycle: created at first sign-in (or by the backfill); `last_used_at` and `email_verified` refreshed on each sign-in; deleted only by the user cascade. 059 offers no unlink path (feature 061).

## Table `signin_links` (new)

A single-use, 15-minute proof of control of the machine (D5).

| Column | Type | Null | Default | Notes |
| --- | --- | --- | --- | --- |
| `id` | uuid | no | `uuid_generate_v4()` | primary key; the only identifier ever logged |
| `token_hash` | text | no | | hex SHA-256 of the 32-byte token; UNIQUE |
| `kind` | text | no | | `claim` or `signin`; CHECK |
| `user_id` | uuid | yes | | target for `signin`; NULL for `claim`; references `users(id)` ON DELETE CASCADE |
| `prefill_name` | text | yes | | claim only, from `--name` |
| `prefill_email` | text | yes | | claim only, from `--email` |
| `source` | text | no | | `cli` or `startup`; CHECK |
| `created_at` | timestamptz | no | `now()` | |
| `expires_at` | timestamptz | no | | `created_at + interval '15 minutes'` set by the minter |
| `used_at` | timestamptz | yes | | set on redemption, or on voiding (FR-030) |

Constraints:

- `CHECK ((kind = 'claim' AND user_id IS NULL) OR (kind = 'signin' AND user_id IS NOT NULL))`.
- `CHECK (kind = 'claim' OR (prefill_name IS NULL AND prefill_email IS NULL))`.
- Index on `expires_at` for the prune.

State transitions:

```
minted (used_at NULL, now < expires_at)
   |-- redeem succeeds --------------> used (used_at = redemption time)
   |-- another claim link creates the owner (claim kind only) --> voided (used_at = claim time)
   |-- now >= expires_at ------------> expired (row unchanged; refused on redeem)
used/expired for > 24 h --- next mint prunes ---> deleted (RBD-059-12)
```

Peek reads a row and changes nothing. Redeem's first statement is the
conditional `UPDATE ... SET used_at = now() WHERE token_hash = $1 AND used_at IS
NULL AND expires_at > now() RETURNING *`.

## Table `users` (changed)

| Change | Detail |
| --- | --- |
| `google_id` | `DROP NOT NULL`. The `UNIQUE` constraint and `idx_users_google_id` stay. Existing values kept. New rows never write it (RBD-059-2). No sign-in path reads it (FR-003). |
| `signup_source` CHECK | Now `IN ('browser', 'agent_oauth', 'signin_link')` (RBD-059-6). Owner creation by claim writes `signin_link`. Still written only on INSERT. |
| Trigger `users_google_id_identity` | AFTER INSERT, only when `NEW.google_id IS NOT NULL`: inserts the matching identity (issuer rule as in the backfill), `ON CONFLICT DO NOTHING`. New code never sets `google_id`, so it is inert for 059's own writes. It covers rows written the old way: by pre-059 pods during the rolling deploy, by test fixtures, and by dev scripts (RBD-059-24). Dropped together with `google_id` in the later cleanup. |

Unchanged and load-bearing for regression parity: `signup_ip`,
`signup_user_agent`, `signup_source` written once at INSERT; `last_login_at`,
`last_login_ip`, `last_login_user_agent` refreshed by `updateLastLogin`;
`is_admin`; `token_version`; `email` UNIQUE (case-sensitive at the database
level; the application's collision check is case-insensitive, RBD-059-17).

## Table `auth_events` (changed)

| Change | Detail |
| --- | --- |
| `signup_source` CHECK | Now `IN ('browser', 'agent_oauth', 'signin_link')`. A sign-in by link writes `signin_link`, whether it created the owner (`event = signup`) or signed someone in (`event = login`). |

`server/auth/auth-events.js` `safeSignupSource` gains `signin_link`; the
append-only and never-throws invariants are unchanged.

## Table `app_settings` (new key, no schema change)

| Key | Value | Writer | Reader |
| --- | --- | --- | --- |
| `instance_owner_user_id` | user uuid as text | the claim transaction (`recordOwner`) | `resolveOwner` with direct SQL (not the in-process cache) |

If the recorded user was deleted, `resolveOwner` treats the record as absent
and falls back to the single-administrator rule (RBD-059-4).

## Non-persisted entities

- **Instance mode**: `local` | `team`, resolved from `SQUIRE_MODE` once per process as `getInstanceConfig().mode` in 058's `server/instance-config.js` (RBD-058-16: one configuration module).
- **Provider**: `{ id, label, startPath, listed, countsForBoot }` from `server/auth/providers.js`. Public projection: `{ id, label, startPath }`.
- **Instance owner**: the result of `resolveOwner`: `{ user, via: 'record' | 'single_admin' }` or `{ user: null, reason: 'no_users' | 'ambiguous_admins' }`.

## Backfill rule (FR-002, RBD-059-16)

```
for each users row with google_id NOT NULL:
  issuer  = 'dev' if google_id starts with 'dev-test-' else 'https://accounts.google.com'
  subject = google_id
  insert (user_id, issuer, subject, created_at = users.created_at), skip on conflict
```

Expected result on the hosted database: one Google identity per user, zero
`dev` identities (the faucet has never been enabled in production), zero users
modified. On development databases: faucet users get `dev` identities, so the
faucet keeps finding them after the migration.
