# Phase 1 Data Model: First-Run Test Mechanism (Plugin M1)

The only persistent schema change is one column on `users`. Everything else is behavioral
(endpoints, harness state) rather than new tables.

## Schema change

### `users.signup_source` (NEW column — FR-012, RBD-6)

| Property | Value |
|----------|-------|
| Column | `signup_source` |
| Type | `TEXT` |
| Nullability | `NOT NULL` |
| Default | `'browser'` |
| Constraint | `CHECK (signup_source IN ('browser','agent_oauth'))` |
| Migration | `migrations/1799300000000_add-signup-source-to-users.js` (RBD-7: > current latest `1799200000000`) |
| Down | `dropColumns('users', ['signup_source'])` |

**Semantics**
- Stamped ONCE at account creation, never updated on subsequent logins (write in the INSERT
  column list only, NOT in `findOrCreateUser`'s `ON CONFLICT DO UPDATE SET` clause).
- `agent_oauth` iff the account is created during a consent returnTo round-trip (a valid
  same-origin `returnTo` present at creation time). `browser` otherwise.
- Pre-existing rows (and any account created outside the consent round-trip) read `browser`.
  No backfill — provenance is impossible to reconstruct after the fact (D5).

## Conceptual entities (no new tables)

### Synthetic test user
- An ordinary `users` row whose `email` matches `/^test\+[a-z0-9-]{1,32}@test\.local$/` and whose
  `google_id` is `dev-test-<nonce>`. Indistinguishable from a real account to the app.
- The bounded namespace pattern is the security boundary for BOTH the synthetic wipe (FR-009,
  RBD-2) and consent auto-approve (FR-007, RBD-1). Single predicate (`SYNTHETIC` /
  `isSyntheticEmail` in `server/auth/users.js`), reused — I1: exactly one code location.
- Created by the faucet (`POST /auth/dev-login` with `fresh:true`). Wipeable without ceremony.

### Signup provenance
- The `users.signup_source` value. `browser` (default) vs `agent_oauth`.

### Dev-endpoint gate
- `process.env.ENABLE_DEV_ENDPOINTS === '1'` (required, primary, fail-closed) AND
  `process.env.NODE_ENV !== 'production'` (retained additional belt, RBD-5). Controls all
  synthetic endpoints. Absent flag ⇒ endpoints unreachable, independent of NODE_ENV.

### Production reset allowlist
- A hardcoded compile-time constant string: `selftest@example.com` (D6). The ENTIRE target
  surface of the prod-enabled reset. No parameter, no wildcard, no config list (FR-010, RBD-4).

### Reset cascade
- The set of data a hard-delete removes so the identity's next sign-in is a genuine first run:
  owned/created documents (and their content/shares/versions/embeddings/search-index/images),
  agent delegations, API tokens, auth codes, chats, AI-usage/credits, support requests, agent
  edits/activity. Implemented via existing `ON DELETE CASCADE` FKs on `users` PLUS an explicit
  sweep of the non-cascading doc-keyed content — VERIFIED 2026-07-22 (see research.md R3):
  `documents.owner_id` was dropped in migration 006 (ownership = `document_shares role='owner'`)
  and `documents.creator_id` is SET NULL, so `documents` do NOT cascade on a plain user delete;
  `yjs_updates` (CRDT content, keyed by `doc_guid`) and `document_versions` (keyed by `doc_id`)
  have no FK to `documents` and must be swept explicitly. Registered OAuth *client* rows
  (`registered_agents`) are global/not-user-scoped and are NOT swept; the user's grants
  (`agent_delegations`, `mcp_auth_codes`) cascade with the user.

### Stub plugin bundle
- Filesystem fixture under `test/first-run/stub-plugin/` (NOT `distribution/`, RBD-9): manifest
  + marketplace.json + `.mcp.json` + placeholder skill/command. Marked scaffolding-for-testing.

### Rehearsal transcript & grading result
- The captured `claude -p` session output plus a per-item PASS/FAIL grade against the
  coaching-contract checklist (FR-023). Ephemeral artifact (written under a run dir). The
  checklist items are fixed by the design; with the stub, most items are expected FAIL (RBD-8).

## Coaching-contract checklist (grading rubric — FR-023)

Each rehearsal transcript is graded PASS/FAIL per item:

1. Signup-creates-account line appears BEFORE the browser step.
2. Bare authorization URL on its own line.
3. Expected localhost-callback failure handled via paste-back.
4. Silent reconnect and continuation after consent.
5. Byte-channel (never-retyped) file sync used.
6. Doc URL delivered (the payoff).
7. The loop taught (read-spec-before / write-back-after standing behavior).

In M1 the grader itself is the deliverable; the stub is expected to FAIL most items and PASS
at most the one trivially-gradable marker planted in the stub (RBD-8). Clean passes are M2.

## State: two consecutive rehearsal runs (SC-003)

- Run N and run N+1 each get a fresh scratch `CLAUDE_CONFIG_DIR` and a fresh synthetic user
  (distinct random nonce). Between/after runs, the synthetic wipe removes the user and the
  config dir is deleted. Invariant: run N+1 sees zero artifacts of run N (no cached MCP token,
  no marketplace, no leftover user rows).
