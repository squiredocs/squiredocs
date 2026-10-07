# Quickstart: validating 059 (Identity and Local Mode)

Run everything inside the app-dev pod (`docs/dev.md`). Commands below assume
`/local-dev` (or the implementing worktree) as the working directory and a
per-worktree test database base (`createdb collab_test_db_059` and
`DATABASE_URL=postgres://.../collab_test_db_059`). Feature 058 must already be
merged (APP_URL, the secrets resolver, the data directory).

Contracts referenced: `contracts/auth-providers.md`,
`contracts/signin-links.md`, `contracts/squire-cli.md`,
`contracts/identity-and-post-auth.md`, `contracts/pages.md`. Schema:
`data-model.md`.

## 1. Automated suites

```bash
# Backend (parallel workers, per-worker databases; SQUIRE_MODE defaults to team in Jest setup)
npm run test:server

# Single suites while iterating (keep --forceExit)
npx jest server/__tests__/integration/identity-regression.test.js --forceExit
npx jest server/__tests__/migration-user-identities.test.js --forceExit
npx jest server/__tests__/integration/signin-link.test.js --forceExit
npx jest server/__tests__/integration/local-mode-lockdown.test.js --forceExit
npx jest server/cli --forceExit

# Frontend
npm run test:client
```

Expected: all green. The regression set that must pass with no assertion
changes other than `google_id` lookups: `server/__tests__/integration/first-run*.test.js`,
`auto-approve.test.js`, `faucet-wipe.test.js`, `prod-reset.test.js`,
`server/__tests__/auth-return-to.test.js`, `invite-conversion.test.js`,
`admin-auth-capture.test.js`, `server/auth/__tests__/*.test.js`,
`trust-proxy-invariant.test.js`, and `client/src/pages/__tests__/AuthorizePage.test.jsx`.

## 2. Hosted parity by hand (team mode, Google)

1. Dev pod has `SQUIRE_MODE=team` (overlay) and Google credentials.
2. `curl -s localhost:3001/auth/providers` returns `mode: "team"` and one
   `google` provider with `startPath: "/auth/google"`, and no secrets.
3. Open `/login` and `/signup`: same headline, button text, and footer as
   before the change. Open `/authorize-preview`: the team card reads "Sign in
   to Squire Docs with your Google Account" and "Continue with Google".
4. Sign in with Google as an existing user; in psql:
   `SELECT event, signup_source FROM auth_events WHERE user_id = '<id>' ORDER BY created_at DESC LIMIT 1;`
   shows one new `login` row.

## 3. Local mode end to end (fresh database)

```bash
# A scratch database and a server in local mode on another port
createdb collab_local_059 && DB_NAME=collab_local_059 npm run migrate
SQUIRE_MODE=local DB_NAME=collab_local_059 PORT=3911 APP_URL=http://localhost:3911 node server/index.js
```

Expected in the log: `[Auth] Instance mode: local ...` and the marked
"claim this instance" block with one `http://localhost:3911/claim#...` line.

```bash
DB_NAME=collab_local_059 PORT=3911 node bin/squire.js doctor --json   # ok: true, owner.hasOwner: false
DB_NAME=collab_local_059 node bin/squire.js claim-link --name "Sam" --email "sam@example.com"
```

Open the printed link: Name and Email are prefilled; the address bar shows
`/claim` with no fragment. Click Continue: you land on the welcome document.
Then:

- `SELECT is_admin, signup_source, google_id FROM users;` gives one row: `true | signin_link | NULL`.
- `SELECT event, signup_source FROM auth_events;` gives one row: `signup | signin_link`.
- `SELECT value FROM app_settings WHERE key = 'instance_owner_user_id';` gives the owner id.
- Opening the startup-log link now shows the "already used" message.
- `/login` shows the claim-link instruction and no Google button; `/signup` is identical.
- `curl -si localhost:3911/auth/google` gives `302` to `/login?error=provider_disabled` and no `Set-Cookie`.

## 4. Re-entry and recovery

```bash
DB_NAME=collab_local_059 node bin/squire.js claim-link --name X --email y@z.com
# stderr says the instance has an owner and the flags were ignored; the link signs in Sam
DB_NAME=collab_local_059 node bin/squire.js login-link --email SAM@example.com   # case-insensitive
DB_NAME=collab_local_059 node bin/squire.js login-link --email nobody@example.com; echo $?   # 1, next action named
DB_NAME=collab_local_059 node bin/squire.js mode
DB_NAME=collab_local_059 SQUIRE_DATA_DIR=/tmp/squire-059 node bin/squire.js token create --name "Claude Code"
stat -c '%a' /tmp/squire-059/tokens/claude-code.token   # 600
```

The token appears in Settings, AI Agent Access, with the name "Claude Code"
and a 30-day expiry.

## 5. Boot refusals

```bash
SQUIRE_MODE=teams node server/index.js; echo $?        # 1, names local and team
SQUIRE_MODE=team GOOGLE_CLIENT_ID= GOOGLE_CLIENT_SECRET= ENABLE_DEV_ENDPOINTS= node server/index.js; echo $?   # 1, names the Google variables
```

## 6. Move local to team

Restart the step 3 server with `SQUIRE_MODE=team` and Google credentials. The
owner can still sign in with `squire claim-link`; their documents are intact;
`/login` shows "Sign in with Google". If the owner signs in with a Google
account whose email equals the owner's email, the page shows the
`account_exists` message (RBD-059-3) and no second account is created.

## 7. Image check (after 058's entrypoint is merged)

```bash
docker build -t squire-059 .
docker run --rm squire-059 sh -c 'command -v squire && squire --help'
```

Expected: `/usr/local/bin/squire` and the usage text.
