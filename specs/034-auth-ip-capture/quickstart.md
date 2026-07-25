# Quickstart: validating 034 — signup/login IP + user-agent capture

**Feature**: 034-auth-ip-capture | Run everything from the repo root **inside the Minikube `app-dev` pod** (`docs/dev.md`). Claude already runs inside the pod — no `kubectl`.

## Prerequisites

- PostgreSQL reachable (app DB for the manual walk, `collab_test_db` for the suites).
- Backend tests run **serially** — never launch a second concurrent backend run against the same DB (Constitution II; memory note "backend test DB is serial-only").
- The migration must be applied to whichever database you are exercising.

## 1. Apply the schema

```bash
npm run migrate          # or the project's migrate entrypoint (server/migrate.js)
```

Confirm the shape:

```bash
psql "$DATABASE_URL" -c "\d+ auth_events"
psql "$DATABASE_URL" -c "\d users" | grep -E 'signup_ip|signup_user_agent|last_login_ip|last_login_user_agent'
```

Expected: four nullable columns on `users` (`inet`, `text`, `inet`, `text`); `auth_events` with `user_id` FK `ON DELETE CASCADE`, the two `CHECK`s, and the three indexes from [data-model.md](./data-model.md).

## 2. Automated suites (the primary gate)

```bash
npx jest --runInBand server/auth/__tests__/auth-context.test.js \
                     server/auth/__tests__/auth-events.test.js \
                     server/auth/__tests__/users.test.js \
                     server/__tests__/admin-auth-capture.test.js \
                     server/__tests__/trust-proxy-invariant.test.js
```

Then the full backend gate before merge:

```bash
npm run test:server      # jest --runInBand --forceExit, LLM reporter
npm run test:client      # Vitest — includes the AdminPage render test
```

What each suite proves (mapped to the spec):

| Suite | Proves |
|-------|--------|
| `auth-context.test.js` | IPv4/IPv6/`::ffff:` accepted; missing/`'unknown'`/zone-suffixed → `null`; UA trimmed, 512-truncated, `null` when absent; never throws on a malformed `req` (FR-007, FR-008, edge cases) |
| `users.test.js` | signup pair written at creation and **never** overwritten on a returning-user upsert; last-login pair refreshed each login; context-less calls still work (FR-001, FR-002) |
| `auth-events.test.js` | exactly one row per completed auth with the right `event`; `record()` swallows insert failures; purge deletes only rows older than 180 days and never touches `users` columns; FK cascade removes a deleted user's rows (FR-003, FR-008, FR-009, FR-010) |
| `admin-auth-capture.test.js` | admin `GET /api/admin/users` returns all four values; non-admin gets `403`; `/auth/me` keys unchanged (FR-011, FR-012, SC-005) |
| `trust-proxy-invariant.test.js` | `trust proxy` is still a numeric hop count (FR-006) |
| `AdminPage.test.jsx` | new columns render values and the `—` placeholder for pre-feature accounts (US1 acceptance 4) |

## 3. Manual walk — capture on a real sign-in

With the dev server running and `NODE_ENV` **not** production (dev-login is dev-gated):

```bash
curl -s -X POST http://localhost:3001/auth/dev-login \
     -H 'Content-Type: application/json' \
     -H 'User-Agent: QuickstartAgent/1.0' \
     -d '{"fresh":true,"nonce":"cap1"}' | jq '.email'
```

Inspect what landed:

```bash
psql "$DATABASE_URL" -c "SELECT email, signup_ip, signup_user_agent, last_login_ip, last_login_user_agent
                         FROM users WHERE email = 'test+cap1@test.local';"
psql "$DATABASE_URL" -c "SELECT event, signup_source, ip, user_agent, created_at
                         FROM auth_events ORDER BY id DESC LIMIT 5;"
```

Expected after the **first** call: one `users` row with all four values populated and identical pairs; exactly one `auth_events` row with `event='signup'`.

Repeat the same `curl` with a different `User-Agent`. Expected: `signup_*` unchanged, `last_login_*` updated to the new UA, and exactly one **new** `auth_events` row with `event='login'` (two rows total).

### Missing user-agent (US3 acceptance 1)

```bash
curl -s -X POST http://localhost:3001/auth/dev-login -H 'Content-Type: application/json' \
     -H 'User-Agent;' -d '{"fresh":true,"nonce":"cap2"}' | jq '.email'
```

Expected: HTTP success, and `signup_user_agent IS NULL` for `test+cap2@test.local` — not an error, not a placeholder string.

### Over-long user-agent (US3 acceptance 2)

Send a 600-character `User-Agent` and confirm `length(signup_user_agent) = 512`.

### Refresh appends nothing (FR-005)

Note `SELECT count(*) FROM auth_events`, hit the token-refresh endpoint with a valid refresh cookie, and confirm the count and every `users` capture column are unchanged.

## 4. Retention

```bash
# Age a row past the boundary, then purge.
psql "$DATABASE_URL" -c "UPDATE auth_events SET created_at = now() - interval '181 days' WHERE id = (SELECT min(id) FROM auth_events);"
node -e "const p=require('./server/auth/auth-events');/* init with the app pool, then: */" # or rely on the boot sweep
```

Simplest check: restart the server (the boot sweep runs) and confirm the 181-day row is gone while a 179-day row and every `users` capture column survive. `auth-events.test.js` covers this boundary automatically — the manual step is only for the boot-sweep wiring.

## 5. Admin surface

1. Sign in as an admin, open the admin page.
2. The user table shows `Signup IP` and `Login IP` columns; hovering a cell reveals the user-agent.
3. Expand a row → `Sign-in origin` lists all four values with full user-agent strings.
4. A pre-feature account (or any account created before the migration) renders `—` in all four positions and nothing errors.
5. Create two accounts from the same client and confirm the shared origin is obvious at a glance (SC-001).

## 6. Privacy policy (SC-006)

Open `/privacy` and confirm the data-collection section states that IP address and browser/client (user-agent) information are collected **at signup and sign-in for security and abuse prevention**, and that the auth event history is retained for 180 days. `LAST_UPDATED` reflects the change. This must ship **before or with** the capture (SC-006).

## 7. Non-exposure spot check (SC-005)

```bash
curl -s http://localhost:3001/auth/me -b "accessToken=$TOKEN" | jq 'keys'
```

Expected keys exactly: `emailEnabled, email, id, isAdmin, name, onboarded, picture, welcomeDocId` — no capture fields. Also confirm no MCP/agent-facing tool response carries them.

## Definition of done

- Both suites green (`npm run test:server` serially, `npm run test:client`).
- Manual walk in §3 produces the expected row counts and event types.
- Admin surface renders values and `—` gracefully; privacy policy updated.
- `server/index.js`'s `trust proxy` line is **unchanged** and still numeric.
