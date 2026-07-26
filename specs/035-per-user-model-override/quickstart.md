# Quickstart — Validating the Per-User Chat Model Override (035)

A runnable walk that proves every acceptance scenario. Commands run **inside the Minikube
`app-dev` pod** (`docs/dev.md`); the working directory is the repo root. Mutagen sync can
leave a dev server on stale code — restart it if behavior looks impossible.

## Prerequisites

- Migrations applied: `npm run migrate` (expects `1799500000000_add-chat-model-override-to-users`
  as the newest entry).
- At least one shared server key configured (`ANTHROPIC_API_KEY` is the load-bearing one —
  `claude-opus` is the terminal fallback). `OPENROUTER_API_KEY` makes the gateway entries
  eligible and is what the stale-override step toggles.
- Two accounts: an admin (`users.is_admin = true`) and a normal user.

## 1. Automated suites (the primary gate)

Backend — **serial only** (Constitution Principle II; concurrent runs corrupt the shared
`collab_test_db`):

```bash
npm run test:server -- server/api/__tests__/chat-model-override.test.js \
                       server/__tests__/chat-model-override-wiring.test.js \
                       server/__tests__/admin-chat-model-override.test.js \
                       server/__tests__/byok-settings.test.js
```

Regression sweep of the suites that touch the resolution seam:

```bash
npm run test:server -- server/__tests__/chat-models-byok.test.js \
                       server/api/__tests__/chat-models.test.js \
                       server/api/__tests__/chat.durable-failures.test.js \
                       server/__tests__/chat-reservation-release.test.js \
                       server/__tests__/admin-auth-capture.test.js
```

Client:

```bash
npm run test:client -- src/pages/__tests__/AdminPage.test.jsx
```

Then the full suites once before hand-off: `npm run test:server` and `npm run test:client`.

**Expected**: all green. The pre-existing suites must pass **unmodified** — `userOverrideKey`
is optional, so omitting it reproduces today's resolution exactly.

## 2. Schema (FR-001)

```bash
psql "$DATABASE_URL" -c "\d users" | grep chat_model_override
psql "$DATABASE_URL" -c "SELECT count(*) FROM users WHERE chat_model_override IS NOT NULL;"
```

**Expected**: one nullable `text` column, no default; the count is `0` immediately after the
migration — every pre-existing account is untouched (US2 acceptance 4).

Roll-back sanity (dev DB only): `npm run migrate:down` drops the column cleanly, then
`npm run migrate` re-applies.

## 3. Admin API walk (US1, US2 — FR-007/FR-008)

With an admin session cookie (or `Authorization: Bearer <admin access token>`) and
`$USER_ID` = the normal user's id:

```bash
# set
curl -sX PATCH localhost:3001/api/admin/users/$USER_ID/chat-model \
     -H 'Content-Type: application/json' -d '{"modelKey":"claude-haiku"}'
# → {"chatModelOverride":"claude-haiku","effectiveModelKey":"claude-haiku"}

# reject unknown
curl -sX PATCH … -d '{"modelKey":"ghost-model"}'         # → 400 Unknown model: ghost-model

# reject known-but-ineligible (no shared OpenAI key in this deployment)
curl -sX PATCH … -d '{"modelKey":"gpt-5.5"}'             # → 400 …no shared server key…

# clear
curl -sX PATCH … -d '{"modelKey":null}'
# → {"chatModelOverride":null,"effectiveModelKey":"<current shared default>"}
```

Authorization (US1 acceptance 5):

```bash
curl -sX PATCH … -H "Authorization: Bearer $NON_ADMIN_TOKEN" -d '{"modelKey":"claude-haiku"}'  # → 403
curl -sX PATCH …                                              -d '{"modelKey":"claude-haiku"}'  # → 401
```

**Expected**: `403`/`401` bodies carry no override data at all.

## 4. Serving path (US1 acceptance 1/2, US2 acceptance 1/3)

1. As admin, pin `claude-haiku` for the normal user.
2. As that user, send one assistant message. Watch the server log / `ai_usage_log`:

```bash
psql "$DATABASE_URL" -c \
  "SELECT model_key, is_byok, created_at FROM ai_usage_log WHERE user_id = '$USER_ID' ORDER BY created_at DESC LIMIT 3;"
```

**Expected**: the newest row's `model_key` is `claude-haiku`, `is_byok = false`.

3. As a *different* non-overridden user, send a message → their row shows the shared default
   (US1 acceptance 2).
4. As admin, change the **shared default** in the admin picker, then have the non-overridden
   user send another message → it follows the new default (US2 acceptance 1) while the
   overridden user stays on `claude-haiku` (US2 acceptance 2).
5. Clear the override, have the overridden user send one more message → it runs on the *new*
   shared default, not the one in force when the pin was set (US2 acceptance 3 / SC-003).

No re-login, no restart at any step (FR-012). A turn already streaming when the admin flips
the value finishes on its original model.

## 5. Stale override (US3 acceptance 3 — SC-004)

1. Ensure `OPENROUTER_API_KEY` is set; pin `or-glm-4.7` for the user; confirm one turn runs on it.
2. Unset `OPENROUTER_API_KEY` and restart the server.
3. Have the user send a message.

**Expected**: the turn **succeeds** on the shared default; the server log carries one warning
naming `or-glm-4.7`; and the stored value is still there (RBD-2):

```bash
psql "$DATABASE_URL" -c "SELECT chat_model_override FROM users WHERE id = '$USER_ID';"  # → or-glm-4.7
```

4. Re-set the key and restart → the very next turn runs on `or-glm-4.7` again, with no admin
   action (spec Edge Cases).

## 6. BYOK invariants (US3 acceptance 1/2/4 — SC-006)

With the override still stored:

1. As the user, enable BYOK with a valid key + model → their turns use **their** model and key;
   `ai_usage_log` shows `is_byok = true` and their BYOK model (US3-1).
2. Break the BYOK setup (clear the provider key row column directly, leaving `byok_enabled`
   on) → the next turn returns the existing `byok_misconfigured` error. It must **not** run on
   the override or the shared default, and must write **no** shared-key usage row (US3-2).
3. Disable BYOK → the next turn runs on the pinned override (US3-4).

## 7. Non-disclosure (FR-011 — SC-005)

As the overridden user (never the admin):

```bash
curl -s localhost:3001/api/settings/byok  -H "Authorization: Bearer $USER_TOKEN" | jq 'keys'
curl -s localhost:3001/auth/me            -H "Authorization: Bearer $USER_TOKEN" | jq 'keys'
```

**Expected**: neither payload contains `chatModelOverride`, `chat_model_override`, or the
pinned key anywhere. Also walk the Settings page and the chat UI in a browser — nothing names
or hints at the pin.

## 8. Admin UI (US1 acceptance 3, FR-009/FR-010, SC-001)

1. Open `/admin`, expand the user's row → the "Assistant model" section shows a picker whose
   options are exactly the shared-default picker's models, grouped by provider, plus
   `Default (<label>)`.
2. Pick a model → the row re-reads and shows it selected; the whole interaction is well under
   30 seconds from opening the admin area (SC-001).
3. With the stale value from step 5 stored (provider key withdrawn), reload → the picker shows
   `or-glm-4.7 (unavailable — using <shared default label>)` as a disabled selected option,
   never "Default" (FR-010).
4. Choose `Default` → the user rejoins the dynamic shared default.
5. Repeat step 1 on the **admin's own** row — allowed, no special-casing (RBD-8).

## Done when

- Every suite in §1 passes (serially).
- §2–§8 behave as described, with the two BYOK invariants (§6) and the non-disclosure check
  (§7) explicitly confirmed.
- Owed to the merge queue, not to this walk: `README.md` / `docs/dev.md` touch-up if either
  documents the resolution chain or the admin capability list, and the non-blocking Squire-doc
  amendments flagged in `clarifications-needed.md`.
