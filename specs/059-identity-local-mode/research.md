# Research: Identity and Local Mode (059)

Phase 0 output for `plan.md`. Each entry records a decision, why, and what else
was considered. Product decisions that the design and spec leave open are in
`clarifications-needed.md` (RBD-059-1 to RBD-059-13 from the spec phase,
RBD-059-14 onward from this phase). Code facts were checked against `main` on
2026-10-07.

---

## R1. Where user resolution lives and what its signature is

**Decision**: A new function `resolveIdentityUser(identity, ctx)` in
`server/auth/users.js` takes `{ issuer, subject, email, name, picture,
emailVerified }` and `{ signupSource, ip, userAgent }` and returns the user row
with `isNew`. It does not convert invites, notify, or write the auth event;
those move to the shared post-sign-in path (R3). `findOrCreateUser(profile,
ctx)` stays, with its current Google-profile signature, as a deprecated wrapper:
it calls `resolveIdentityUser` with the Google issuer and then
`convertPendingInvites`, exactly matching its current contract (RBD-059-18).

**Rationale**: Fourteen backend suites call `findOrCreateUser` as a fixture
helper (`invite-conversion`, `share-attribution`, `spaces-*`, `admin-*`,
`support`, `auth-events`, MCP share tools). Keeping the wrapper keeps those
suites byte-for-byte unchanged, which is the cheapest regression evidence
available. A source-regex test pins that no production route calls the wrapper,
so it cannot become a second sign-in path.

**Alternatives considered**: Rewriting all fixture callers (large diff with no
behavioral value and real risk of weakening an assertion); keeping invite
conversion inside resolution (then the sign-in link path would need a second
conversion call and FR-008's single place would be false).

## R2. Atomic first sign-in and concurrent first sign-ins (FR-005)

**Decision**: `resolveIdentityUser` runs in one transaction:

1. `SELECT pg_advisory_xact_lock(hashtextextended('identity:' || issuer || ':' || subject, 0))`.
2. Look up `user_identities` by `(issuer, subject)`. If found: update the user's
   `email`, `name`, `picture` (FR-007, same three columns the current `ON
   CONFLICT DO UPDATE` sets), set the identity's `last_used_at` and
   `email_verified` (when the provider sent one), return `isNew = false`.
3. If not found: check `SELECT 1 FROM users WHERE lower(email) = lower($email)`.
   If a row exists, roll back and throw `AccountExistsError` (FR-004,
   RBD-059-3, RBD-059-17).
4. Otherwise insert the user (with `signup_source`, `signup_ip`,
   `signup_user_agent` in the INSERT only, `google_id` NULL) and the identity,
   return `isNew = true`.

The unique `(issuer, subject)` index remains the final backstop.

**Rationale**: The advisory lock serializes exactly the racing pair (same
identity) and nothing else, lives in Postgres (Constitution VII: no
process-local coordination), and makes "one user" true without retry loops.
The current code gets atomicity from `ON CONFLICT (google_id)`; with two tables
an upsert alone cannot guarantee that the user insert and identity insert agree.

**Alternatives considered**: `INSERT ... ON CONFLICT DO NOTHING` on the identity
followed by deleting an orphan user on conflict (leaves a window where an orphan
user row exists and could collide on email); `SERIALIZABLE` isolation with retry
(heavier, and the retry loop would have to replay capture context).

## R3. The shared post-sign-in path (FR-008 to FR-012)

**Decision**: Move the post-sign-in logic out of `server/auth/routes.js` into a
new module `server/auth/post-auth.js` with three exports:

- `signupSourceFor(rawReturnTo)`: `'agent_oauth'` when `isValidReturnTo`, else
  `'browser'`. Callers compute this before resolving the user so the value is
  stamped on INSERT (feature 029 FR-012).
- `establishSession(res, user, { signupSource, ctx, notify })`: converts
  pending invites (one transaction, never throws), sends the new-user and
  login notifications when `notify` is true and the email is not synthetic,
  calls `updateLastLogin` with `isNew` (the one `auth_events` row), and sets
  the access and refresh cookies.
- `completePostAuth(res, { user, signupSource, clientUrl, rawReturnTo, ctx })`:
  `establishSession` with `notify: true`, the feature 031 auto-issue gate (unchanged, still keyed on `user.isNew === true`
  plus `tryParseAuthorizeReturnTo` plus `isLocalhostUri`), the returnTo
  redirect, and the onboarding redirect.

`isValidReturnTo` and `tryParseAuthorizeReturnTo` move with it; `routes.js`
re-exports both so existing imports keep working. The order of side effects is
kept exactly as today: invite conversion (today inside `findOrCreateUser`),
then notification, then `updateLastLogin`, then cookies.

Callers:

| Caller | Resolution | Then |
| --- | --- | --- |
| `GET /auth/google/callback` | `resolveIdentityUser` (issuer Google) | `completePostAuth` |
| Faucet fixed JSON | `resolveIdentityUser` (issuer `dev`, subject `dev-test-user`) | `establishSession` (`notify: false`), onboarding seed, JSON (as today) |
| Faucet fresh JSON | `resolveIdentityUser` (issuer `dev`, subject `dev-test-<nonce>`) | `establishSession` (`notify: false`), JSON |
| Faucet fresh browser | same | `completePostAuth` |
| `POST /auth/signin-link` (form) | `signinLinks.redeem` | `completePostAuth` with `rawReturnTo = null` |
| `POST /auth/signin-link` (JSON) | `signinLinks.redeem` | `establishSession` (`notify: true`), onboarding seed, JSON |

**Behavior change inside the faucet JSON modes, deliberately none**: today they
convert invites (inside `findOrCreateUser`) and do not notify. Under the plan
they convert invites (inside `establishSession`) and do not notify. Same.

**Rationale**: A separate module removes the circular dependency the sign-in
link routes would otherwise have on `routes.js`, and keeps the U2/INV-3
invariant visible: `completePostAuth` and `establishSession` never receive
`req`. The structural test in `auth-events.test.js` that the refresh route calls
no user-store helper is extended to the new helper names.

**Alternatives considered**: A `resolveUser` callback passed into
`completePostAuth` (keeps the profile-shaped API the design asks to remove);
leaving the code in `routes.js` (forces sign-in link routes into the same file,
growing the 058 merge surface).

## R4. Instance mode resolution and the boot check (FR-020 to FR-023)

**Decision**: The mode is a field of 058's instance configuration:
`resolveInstanceConfig(env)` in `server/instance-config.js` gains `mode`
(`local` when `SQUIRE_MODE` is unset, `team`, or a `ConfigError` whose message
names `local` and `team`), read everywhere as `getInstanceConfig().mode`, and
tests reset it with `_resetInstanceConfigForTests()`. This follows RBD-058-16
(one configuration module) and 058's research R14 ("059 owns `SQUIRE_MODE`
and adds it to the same module"). The provider check lives with the registry:
`server/auth/providers.js` exports a pure `checkBootProviders({ mode,
providers })` (an error message naming `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` when team mode has no boot-counting provider) and
`assertBootable({ log, exit })`. `server/index.js` calls
`assertBootable()` near the top of the file, before any `app.listen`,
which logs the mode on one line, logs inactive providers in local mode
(FR-023), and on error prints the message and calls `process.exit(1)`.

**Rationale**: Pure functions are unit-testable without booting the server; the
wiring is pinned with a source-regex test (the repo's convention from feature
043: "pin the wiring so moving the code fails the build"). The memoized
accessor gives the "resolved once" property 058 asks for (RBD-058-16) without
making tests restart the module registry.

**Route-level effect of mode**: only local mode changes route behavior. In team
mode every route behaves as today, including when Google credentials are absent
(the callback path is reachable and the Google adapter decides, exactly as
now). This is what lets existing suites that mock the Google adapter without
setting credentials keep passing (RBD-059-14).

Because 058's entrypoint resolves the configuration before loading the
server, an invalid `SQUIRE_MODE` fails the image boot there with 058's
`[Boot]` prefix; in development (`server/index.js` started directly) the first
`getInstanceConfig()` call fails the same way. The provider check needs the
registry and runs in `server/index.js`.

**Alternatives considered**: Reading `process.env.SQUIRE_MODE` at each call
site (the scattered-env pattern behind the `NODE_ENV` incident); a separate
`server/auth/instance-mode.js` (a second configuration module, contradicting
RBD-058-16).

## R5. Provider registry (FR-015 to FR-019)

**Decision**: `server/auth/providers.js` exports `getProviders({ mode, env })`
returning entries `{ id, label, startPath, listed, countsForBoot }`:

- `google`: enabled when `mode === 'team'` and both Google variables are set.
  `label: 'Google'`, `startPath: '/auth/google'`, `listed: true`,
  `countsForBoot: true`.
- `dev`: enabled when `devEndpointsEnabled()` (existing helper in
  `server/auth/middleware.js`), any mode. `listed: false`,
  `countsForBoot: true` (RBD-059-1, RBD-059-19).

Plus `getConfiguredButInactive({ mode, env })` for the boot log, and
`getPublicProviderInfo(pool)` for `GET /auth/providers`, which adds `hasOwner`
and `signupOpen` (`mode === 'team'`) and strips `listed`/`countsForBoot`.

**Rationale**: Feature 061 adds OIDC and password entries to the same list
without touching the pages. The faucet must count for the boot check (a dev
server without Google credentials must boot in team mode) but must never render
a button, or the team-mode snapshot (SC-003) breaks in development.

## R6. Sign-in link storage and redemption (FR-026 to FR-037)

**Decision**: `server/auth/signin-links.js` (no dependency on `jwt.js`, so the
CLI can require it) exports `mintLink`, `peekLink`, `redeemLink`,
`buildLinkUrl`, and `pruneLinks`. Details:

- Token: `crypto.randomBytes(32).toString('base64url')` (43 characters, URL
  fragment safe). Stored as `sha256(token)` hex. Lookup is by hash equality;
  no plaintext comparison happens, so no timing channel.
- Kinds: `claim` (no user id; only minted when the instance has zero users)
  and `signin` (carries `user_id`). `squire claim-link` on a claimed instance
  mints a `signin` link for the resolved owner (RBD-059-4), so "claim link"
  in the CLI's vocabulary maps to two stored kinds.
- Mint prunes rows expired or used more than 24 hours ago (RBD-059-12).
- Peek: read-only `SELECT` by hash; returns `{ valid, kind, expiresAt, prefill }` (an invalid link returns only
  `{ valid: false }`) where `prefill` is the stored name and email for a claim, or the
  target user's name and email for a `signin` link (RBD-059-20). Never updates
  the row.
- Redeem (one transaction):
  1. `UPDATE signin_links SET used_at = now() WHERE token_hash = $1 AND used_at
     IS NULL AND expires_at > now() RETURNING *`. Zero rows means refused
     (`link_invalid`), with no further work. This is the "marks used in the same
     statement that reads it" requirement.
  2. `signin` kind: load the user; if it no longer exists, roll back and refuse.
  3. `claim` kind: `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`, then
     `SELECT count(*) FROM users`. Non-zero: roll back and refuse
     (`instance_claimed`). Zero: insert the owner (`is_admin = true`,
     `signup_source = 'signin_link'`, capture pair), record
     `instance_owner_user_id` in `app_settings`, and set `used_at = now()` on
     every other unused claim-kind link (FR-030).
  4. Commit; return `{ user, isNew }`.
- Name and email are validated before the transaction (FR-031), so a typo
  never spends the link.

**Rationale**: The table lock blocks concurrent user inserts only for the
duration of a rare transaction and makes FR-045 hold by construction even in
team mode, where a Google first sign-in could otherwise race a claim. Voiding
by `used_at` needs no extra column, and the refusal message ("run `squire
claim-link` again") is right in both cases.

**Alternatives considered**: An advisory lock on a fixed key (Google sign-ups
do not take it, so it would not exclude them); a `voided_at` column (adds a
state with no different user-facing outcome).

## R7. Instance owner record (RBD-059-4)

**Decision**: `server/auth/instance-owner.js` exports `resolveOwner(db)`,
`recordOwner(db, userId)`, and `hasOwner(db)`. It reads and writes
`app_settings` key `instance_owner_user_id` with direct SQL on the caller's
client, never through `server/api/app-settings.js`'s in-process cache.
`resolveOwner` returns the recorded user when that row still exists, else the
single `is_admin = true` user when exactly one exists, else `null` with a
reason (`no_users`, `ambiguous_admins`).

**Rationale**: The app-settings cache is per-process and write-through only on
the writing pod (its own docblock calls this out for the 021 kill-switch).
Owner identity decides whom a link signs in, so it must come from Postgres on
every read (Constitution VII).

## R8. Startup-log link (D11, FR-036)

**Decision**: In the `app.listen` callback in `server/index.js`, just before
`lifecycle.markInitialized()`, call `signinLinks.maybeLogStartupClaimLink({
pool, mode, log })`. It returns without effect unless `mode === 'local'` and
the users table is empty; otherwise it mints a `claim` link with `source =
'startup'` and no prefill, and writes a fixed block:

```
==================== Squire Docs: claim this instance ====================
Open this link within 15 minutes to create the owner account:
<APP_URL>/claim#<token>
Expired? Run: docker compose exec app squire claim-link
==========================================================================
```

Failures are logged and swallowed; the boot never fails because of the link.

**Rationale**: Placing it before `markInitialized` means `docker compose up
--wait` returns only after the link is in the log. Each replica mints its own
independently valid link (spec edge case), so no correctness rides on one pod.

## R9. The `squire` CLI (FR-038 to FR-044)

**Decision**: Command logic lives in `server/cli/` as plain functions that take
`{ pool, env, out, err }` and return an exit code:
`doctor.js`, `claim-link.js`, `login-link.js`, `mode.js`, `token-create.js`,
plus `index.js` (argument parsing with `node:util` `parseArgs`, dispatch,
usage text) and `db.js` (pool from `script/setup-db-env.js`, a connection
error mapped to the FR-044 next-action message). `bin/squire.js` is a shim:
`#!/usr/bin/env node`, `require('../script/setup-db-env')`, then 058's
`resolveSecrets({ env: process.env, dataDir: getInstanceConfig().dataDir, generate: false })`
(read-only: the CLI never creates secrets, 058 research R13)
from `server/boot/secrets.js` (both modules are free of load-time secret
checks), then `require('../server/cli').main(process.argv.slice(2))`.

- `package.json` gains `"bin": { "squire": "bin/squire.js" }`.
- The Dockerfile gains `COPY --chown=appuser:appgroup bin/ ./bin/` and, before
  `USER appuser`, `RUN chmod 0755 /app/bin/squire.js && ln -s
  /app/bin/squire.js /usr/local/bin/squire`.
- Required modules are limited to ones with no load-time secret checks:
  `users.js`, `signin-links.js`, `instance-owner.js`, `server/instance-config.js`,
  `providers.js`, `server/mcp/auth/api-tokens.js`. The CLI never requires
  `server/auth/jwt.js`, `server/mcp/auth/jwt.js`, `server/auth/routes.js`, or
  `server/index.js`. A test pins this list (it requires the CLI with
  `NODE_ENV=production` and no secrets set and expects no throw).
- Output convention: the link is printed bare on its own line to stdout;
  explanations go to stderr, so `squire claim-link | tail -1` and agent
  relaying both get exactly the link.

**`doctor` checks** (RBD-059-23): database connection (`SELECT 1`, 2 s
timeout); pending migrations (files in `migrations/` minus rows in
`pgmigrations`, ignoring the retired 008 phantom name); Redis (`PING` when
`REDIS_HOST` is set, else "off"; never fails `ok`); mode and boot-provider
check; `APP_URL` is `http://localhost`, a loopback address, or `https`; owner
presence via `resolveOwner`; the running server's `/ready` on
`http://127.0.0.1:${PORT || 3001}/ready` (2 s timeout), so `ok` agrees with
`/ready` by construction (SC-006). Optional features (email, storage driver,
semantic search, assistant keys) are reported and never fail `ok`. Email and
storage driver come from 058's configuration module; semantic search from
`GOOGLE_GENERATIVE_AI_API_KEY`; assistant keys from the server-wide provider
variables listed in `server/api/ai-providers.js`.

**`token create`** (RBD-059-7, RBD-059-22): mints through `createToken` with
`expiresAt = now + duration`; refuses to overwrite an existing file; creates
`<data dir>/tokens` with mode 0700 and the file with `fs.openSync(path, 'wx',
0o600)`; prints the path and `docker compose cp app:<path> ~/.squire/token`.
`--stdout` prints the token after the do-not-echo warning used by
`server/mcp/tools/create-access-token.js`.

**Rationale**: Functions with injected I/O are testable in Jest against the
per-worker database without spawning processes; one spawn test covers the shim
and exit codes.

## R10. Client: providers, sign-in page, consent page, claim page

**Decision**:

- `client/src/hooks/useAuthProviders.js` fetches `GET /auth/providers` once per
  page load (module-level promise) and returns `{ status, info }` (RBD-059-21).
- `LoginPage.jsx`: headline renders immediately (it depends only on the route).
  The action area and footer render after the fetch. Team mode with Google
  renders today's exact button, text, and footer. Local mode renders the
  instruction block (no button, no sign-up copy) on both `/login` and
  `/signup`. On fetch failure it falls back to the team-mode Google rendering,
  because that is today's page and the hosted service must never show a blank
  sign-in page.
- `AuthContext.login(returnTo, startPath)` builds the URL from the provider's
  start path (default `/auth/google` when not given, which keeps every existing
  caller working).
- `AuthorizePage.jsx`'s `FirstRunConsent` takes a `provider` prop (label and
  start path) or a `localMode` flag. Team mode with Google renders today's lead
  sentence and "Continue with Google". Local mode replaces the lead and the
  action with the instruction and a "come back to your agent" line (RBD-059-9).
  `/authorize-preview` gains a local-mode card.
- `client/src/pages/ClaimPage.jsx`, routed at `/claim` in `App.jsx`: reads
  `location.hash`, immediately strips it with `history.replaceState` so the
  token does not linger in history, peeks, and renders one of: claim form
  (prefilled name and email, Continue), sign-in confirmation ("Sign in as
  <name> (<email>)", Continue), or the "this link has expired or was already
  used; run `squire claim-link` again" state. Continue submits a real HTML
  form (`method="post" action="/auth/signin-link"`) with hidden `token`, so the
  server's redirect drives navigation exactly like the Google callback.
- Error codes added to `LoginPage`'s message map: `provider_disabled`,
  `account_exists`, `link_invalid`, `instance_claimed`, `claim_invalid`.
- The share dialog and the space settings invite form show the local-mode note
  when `info.mode === 'local'` (RBD-059-10).
- Admin page labels `signin_link` as "Sign-in link".

**SC-003 baseline**: before touching `LoginPage.jsx` or `AuthorizePage.jsx`, a
Vitest test records the rendered visible text and control list of `/login`,
`/signup`, and the unauthenticated consent page as committed snapshots. The
same test then runs against the provider-driven version with a mocked
team-mode Google response and must match unchanged.

**Rationale**: 058 injects static instance configuration into the app shell
(`client/src/instance.js`, including a Vite plugin for development), but the
provider info includes owner presence, a database read, which does not belong
in serving `index.html`. A fetch keeps the shell static and works in every
environment. Falling back to the Google rendering on fetch failure keeps the
hosted page identical even if the endpoint is briefly unavailable.

## R11. Migration (FR-001, FR-002, FR-014)

**Decision**: One migration, `migrations/1799830000000_add-user-identities-and-signin-links.js`
(greater than the current latest `1799820000000_create-document-access-view.js`
and the retired `1794000000000` phantom that `script/migrate.js` cleans up). It:

1. Creates `user_identities` and `signin_links` (see `data-model.md`).
2. Backfills identities:
   `INSERT INTO user_identities (user_id, issuer, subject, created_at)
    SELECT id, CASE WHEN google_id LIKE 'dev-test-%' THEN 'dev' ELSE
    'https://accounts.google.com' END, google_id, created_at FROM users WHERE
    google_id IS NOT NULL ON CONFLICT (issuer, subject) DO NOTHING`
   (RBD-059-16). `email_verified` stays NULL.
3. `ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL` (unique constraint
   and `idx_users_google_id` kept).
4. Replaces both `signup_source` CHECK constraints with ones that also accept
   `signin_link`. Constraint names are looked up from `pg_constraint` by table
   and column in a `DO` block, since the originals were auto-named by inline
   `check:` options.

5. Creates the compatibility trigger `users_google_id_identity` (RBD-059-24):
   after each `users` INSERT whose `google_id` is set, insert the matching
   identity with the backfill's issuer rule, `ON CONFLICT DO NOTHING`.

Why the trigger: the hosted deploy runs the migrate Job first, then rolls the
pods. During the roll, pre-059 pods still create Google users with
`google_id` and no identity. Without the trigger, such a user's next sign-in on
a 059 pod would be an unknown identity with an existing email, refused as
`account_exists`, a lockout. Healing in the sign-in path would mean reading
`google_id` there, which FR-003 forbids. The trigger also gives the roughly 60
test files and the dev scripts that insert `google_id` directly the same
identities a real Google sign-up would get, so the fixture wrapper finds them.
The reverse window (a 059-created user, `google_id` NULL, signing in on a
pre-059 pod during the same roll) fails on the email constraint with
`auth_failed` and succeeds on retry once the roll completes; recorded in
`promotion-notes.md`.

`down` drops the trigger, then reverses 4 (mapping any `signin_link` values to `browser` first), 3
(fails loudly if any user has a NULL `google_id`, which is correct: such users
cannot be represented in the old schema), and drops both tables.

The backfill SQL is exported from the migration module as `BACKFILL_SQL` so the
migration test can run the exact statement against seeded legacy rows in the
per-worker database (there is no existing harness for running a single
migration's `up` in isolation; the test also asserts the post-migration schema
through `information_schema` and `pg_constraint`).

**Data volume**: the hosted service has thousands of users at most; the
backfill is one `INSERT ... SELECT` and the column change is a metadata-only
`DROP NOT NULL`. No batching needed.

## R12. Mode in the test environment (RBD-059-14)

**Decision**: `server/__tests__/setup.js` (already the `setupFilesAfterEnv`
file) sets `process.env.SQUIRE_MODE = process.env.SQUIRE_MODE || 'team'`
before any test module is required. Suites that test local mode set
`SQUIRE_MODE=local` and call `_resetInstanceConfigForTests()` in `beforeEach`.
The client test setup mocks `GET /auth/providers` with the team-mode Google
response by default.

**Rationale**: The existing suites encode the hosted service's behavior, which
is team mode. Without this default they would all run in local mode after D1
and fail on "provider disabled". The dev overlays make the same choice
(RBD-059-1).

## R13. Rate-limit budget

`GET /auth/providers`, the peek, and the redemption all sit under the existing
`/auth` per-IP limiter (30 per minute by default). A claim costs three requests
(providers is not even fetched by the claim page; peek, redeem, then `/auth/me`
on landing). The hosted sign-in page adds one `/auth/providers` request per
view. Both are well inside the budget. No limiter change.

## R14. Logging hygiene for tokens

The token travels only in the fragment, the peek body, and the redeem body. The
server has no request-body logging on `/auth` (checked: no body logger is
mounted in `server/index.js`). The startup-log block is the only place a token
is printed by the server, by design (D11). Error paths log the link row id,
never the token or its hash.

## R15. Testing "zero users" under per-worker isolation

**Decision**: Add `createFreshInstanceDb()` and `dropFreshInstanceDb()` to
`server/__tests__/helpers/db.js`. The helper clones the run's migrated template
database (the same one `globalSetup.js` copies into `<base>_wN`) into
`<base>_wN_fresh`, returns a pool on it, and drops it after the suite. Suites
that exercise owner creation, the startup-log link, `hasOwner`, local-mode
lockdown, or CLI owner resolution initialize `users`, `signin-links`, and the
other modules under test with that pool.

**Rationale**: Owner creation is defined by an empty `users` table (RBD-059-4)
and is enforced inside production code by a table lock and a count. The
shared worker database accumulates users from earlier suites on the same
worker, and the repo's conventions forbid truncating shared tables
(Constitution II). A per-suite clone tests the real predicate with no test-only
seam in production code.

**Alternatives considered**: Injecting a "users exist" predicate (tests a seam,
not the production check); deleting all users in the worker database (violates
the isolation convention and breaks later suites on the worker); provisioning
a second per-worker database in `globalSetup.js` (touches shared infrastructure
from feature 052 for a need only this feature has).
