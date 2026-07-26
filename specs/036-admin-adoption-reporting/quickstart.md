# Quickstart — validating 036 (Admin Per-User Agent Connection & Onboarding Detail)

A runnable walk that proves the feature works end to end. Commands run inside the Minikube
`app-dev` pod (`docs/dev.md`). Implementation details live in [tasks.md](./tasks.md); the exact
payload lives in [contracts/admin-adoption-api.md](./contracts/admin-adoption-api.md).

## 0. Prerequisites

- `main` **already contains feature 035** (it edits the same two files — see the plan's
  sequencing section). Confirm before starting: `git log --oneline | grep -i "chat model override"`.
- Dev server running against the dev database; an admin account you can sign in as.
- No migration to run — 036 adds none. `ls migrations | sort | tail -1` should be unchanged by
  this feature.

## 1. Automated suites

```bash
# Backend — SERIAL (constitution II; the DB is shared and concurrent runs corrupt it)
npm run test:server -- admin-agent-adoption
npm run test:server -- admin-auth-capture admin-sharing admin-welcome-email   # no regressions

# Client — via the npm script so the LLM reporter stays wired (constitution: test output stays LLM-friendly)
npm run test:client -- src/pages/__tests__/AdminPage.test.jsx
```

Expected: the new backend suite covers payload correctness, the non-vacuous 403/401, the
secret-material scan and the zero-writes assertion; the client suite covers rendering, the empty
state, the honest activity label and failure isolation.

## 2. Seed one user with a full spread of state

Against the dev DB, for a throwaway account (`$UID`), create the five credential shapes the
spec's US1 independent test names:

| Row | How |
|---|---|
| active delegation with a catalog link | `agent_delegations` with `agent_client_id = 'claude-code'`, `revoked_at NULL` |
| revoked delegation with **no** catalog link | `agent_client_id NULL`, `agent_name = 'Some Unregistered Agent'`, `revoked_at = now()` |
| expired delegation | `expires_at = now() - interval '1 day'`, `revoked_at NULL` (exercises `expired` on the delegation side too) |
| active interactive token | `mcp_api_tokens`, both `minted_by_*` NULL |
| agent-minted token | `minted_by_delegation_id` = the active delegation's id |
| expired token | `expires_at = now() - interval '1 day'`, `revoked_at NULL` |

Add a couple of `agent_activity_log` rows for that user (any `action`; `delegation_id` must
reference the active delegation — the column is `NOT NULL`).

Keep a second account with **none** of the above for the empty-state check.

## 3. US1 — connections and keys (P1)

1. Sign in as admin, open **Admin**, expand the seeded user's row.
2. **Connected agents** lists both delegations — the catalog-linked one under **Claude Code**
   (registry name), the unlinked one under its self-reported name (FR-004: it must be *present*,
   not dropped or blank). Each shows scopes, created, last used, and an `ACTIVE` / `REVOKED`
   badge.
3. **API tokens** lists all three: name, `sk_sqd_…` prefix (never a full token), scopes,
   created/last-used/expires, an `ACTIVE` / `EXPIRED` badge, and a mint column reading
   *interactive* vs *agent*.
4. Expand the second account: **"No agent connections."** / **"No API tokens."** — an empty
   state, not an error and not a missing section.
5. Confirm the detail arrived **on expand**, not with the list: with the network tab open,
   loading `/admin` fires `GET /api/admin/users` only; expanding fires
   `GET /api/admin/users/<id>/adoption` (FR-007).

## 4. US2 — onboarding and activity (P2)

1. In the same expanded row, **Onboarding** shows: signup source (`browser` / `agent_oauth` /
   `—` for pre-029 accounts), signed up, onboarded (timestamp or "Not yet"), *Owns a doc besides
   the welcome doc* (Yes/No), and welcome email (timestamp or "Not sent").
2. Flip the predicate: create a second owned document for the account and re-expand — the row
   turns Yes. Delete it, re-expand — No.
3. **Agent sessions (OAuth-delegated MCP calls)** shows the count you seeded and the newest
   timestamp. The note reads *"API-token and REST traffic are not logged — see each token's Last
   used."* — this wording is contractual (FR-006), not decoration.
4. Expand a user with no log rows: the summary reads zero / none, not an error.

## 5. US3 — read-only and leak-free (P3)

```bash
# Capture the raw payload as admin (session cookie or bearer):
curl -s -H "Authorization: Bearer $ADMIN_JWT" \
  "$BASE/api/admin/users/$UID/adoption" | tee /tmp/adoption.json | jq .

# Nothing hash-shaped, nothing token-shaped, no metadata:
grep -Eio 'token_hash|tokenHash|refresh_token_hash|refreshTokenHash|client_secret_hash|clientSecretHash|metadata|sk_sqd_[A-Za-z0-9_-]{12,}|[0-9a-f]{64}' /tmp/adoption.json
# → expected: NO OUTPUT
```

Then:

1. **Zero writes** — snapshot and compare across ten repeated requests:
   ```sql
   SELECT (SELECT count(*) FROM agent_delegations) AS d,
          (SELECT count(*) FROM mcp_api_tokens)     AS t,
          (SELECT count(*) FROM agent_activity_log) AS a,
          (SELECT max(last_used_at) FROM agent_delegations WHERE user_id = '<uid>') AS lu;
   ```
   Identical before and after (FR-011, SC-004).
2. **No mutation surface** — the panel offers no revoke/mint/edit control, and
   `grep -n "router\.\(post\|put\|patch\|delete\)" server/api/admin.js` shows only the handlers
   that existed before 036 (plus 035's `PATCH /users/:userId/chat-model`).
3. **Gate** — repeat the `curl` as a signed-in non-admin → `403` with no adoption data; with no
   credentials → `401`.
4. **Not found** — `GET /api/admin/users/00000000-0000-0000-0000-000000000000/adoption` → `404`;
   `GET /api/admin/users/not-a-uuid/adoption` → `404` (not a `500`).

## 6. Robustness and performance

- **Failure isolation (FR-012)**: block the adoption request (DevTools request blocking) and
  expand a row — the agent panel shows *"Couldn't load agent detail."* while sharing, extra
  credits, sign-in origin and the assistant-model picker all still render and work.
- **Untrusted strings**: set a delegation's `agent_name` to `<img src=x onerror=alert(1)>` and a
  token's `name` to `<b>bold</b>`; both must render as literal text — no alert, no bold.
- **SC-005**: expand a user with the largest credential set you have; detail is visible in well
  under a second, and the user list itself loads no slower than before (it is untouched).

## 7. Cleanup

Delete the throwaway account (`DELETE FROM users WHERE id = '<uid>'` cascades the delegations,
tokens and activity rows) and any documents created in step 4.2.
