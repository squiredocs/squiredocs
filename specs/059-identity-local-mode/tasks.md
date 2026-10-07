# Tasks: Identity and Local Mode

**Input**: Design documents from `specs/059-identity-local-mode/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md, clarifications-needed.md RBD-059-1 to RBD-059-24).

**Prerequisites**: Feature 058-self-host-config is merged to `main` first. 059 is implemented on top of it.

**Tests**: Required. Constitution II and the spec's success criteria (SC-001 to SC-008) call for tests on every behavioral change, and the regression contract (User Story 2) is only meaningful if pinned against production code.

**Organization**: Grouped by user story. Story order follows risk, not just priority: US2 (the regression contract) lands before US1 (the claim) because US1 is built on the rewritten post-sign-in path.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 to US6 from spec.md

## Conventions for every test task

- Backend: Jest under the per-worker database (`npm run test:server`; single file `npx jest <path> --forceExit`). Drive the real Express router with `supertest`; mock only `server/auth/google`, `server/email`, and (where the existing suites do) `server/onboarding`. Never write a local copy of a production function.
- Clean up by the ids the suite created (users, identities, links). Never truncate shared tables.
- Any suite that needs a zero-user instance (claim, startup link, `hasOwner`, local-mode lockdown, owner resolution in the CLI) or writes `app_settings.instance_owner_user_id` uses `createFreshInstanceDb()` (T016) and initializes the modules under test with that pool.
- Suites that need local mode set `process.env.SQUIRE_MODE = 'local'` and call `_resetInstanceConfigForTests()` from `server/instance-config.js`; restore in `afterEach`.
- Frontend: Vitest (`npm run test:client`).

---

## Phase 1: Setup

- [ ] T001 Confirm against 058's merged code the names its plan gives (`getInstanceConfig()` in `server/instance-config.js` for `APP_URL`, the data directory, email transport, and storage driver; `resolveSecrets({ env, dataDir })` in `server/boot/secrets.js`) and record any difference at the top of an "Implement phase" section in `specs/059-identity-local-mode/promotion-notes.md`. Every later task that says "058's configuration module" or "058's secrets resolver" means these.
- [ ] T002 Create the per-worktree test database base (`createdb collab_test_db_059`) and export `DATABASE_URL` for this worktree per `docs/dev.md`; run `npm run test:server` once on the unchanged tree and save the pass/fail summary in `promotion-notes.md` as the baseline.
- [ ] T003 [P] Record the SC-003 baseline BEFORE touching any page: create `client/src/components/__tests__/LoginPage.baseline.test.jsx` that renders `LoginPage` with `mode="login"` and `mode="signup"` and `FirstRunConsent` (from `client/src/pages/AuthorizePage.jsx`) with `agentName="Claude Code"` and both scope sets, and snapshots (a) the visible text (`container.textContent`, whitespace-normalized) and (b) the list of interactive controls (role, accessible name, `href`). Commit the generated snapshot file with the test. Later tasks must keep this test green with no snapshot update.

---

## Phase 2: Foundational (blocking prerequisites)

- [ ] T004 Create `migrations/1799830000000_add-user-identities-and-signin-links.js` per `data-model.md` and research R11: create `user_identities` and `signin_links` with all constraints and indexes; export `BACKFILL_SQL` (issuer `dev` for `google_id LIKE 'dev-test-%'`, else `https://accounts.google.com`; `ON CONFLICT DO NOTHING`; `created_at` from `users`) and run it; `ALTER TABLE users ALTER COLUMN google_id DROP NOT NULL`; replace the `signup_source` CHECK on `users` and on `auth_events` with `IN ('browser','agent_oauth','signin_link')`, locating the auto-named constraints through `pg_constraint` in a `DO` block; create the compatibility trigger `users_google_id_identity` (AFTER INSERT ON `users` FOR EACH ROW WHEN `NEW.google_id IS NOT NULL`: insert the identity with the same issuer rule as the backfill, `ON CONFLICT DO NOTHING`; RBD-059-24). Write `down` (drop the trigger and its function, map `signin_link` to `browser`, restore both CHECKs, `SET NOT NULL` on `google_id`, drop both tables). Header comment states why the timestamp is above `1799820000000` and the retired `1794000000000`.
- [ ] T005 Write `server/__tests__/migration-user-identities.test.js`: (a) schema assertions through `information_schema` and `pg_constraint`: `google_id` nullable and still unique, `(issuer, subject)` unique, FK cascade from `user_identities.user_id` and `signin_links.user_id`, both `signup_source` CHECKs accept `signin_link` and reject `nonsense`, `signin_links` kind/user_id CHECK; (b) backfill: insert legacy users with a numeric `google_id`, a `dev-test-abc` `google_id`, and a NULL `google_id`, delete the identities the compatibility trigger just created for them (so the rows look pre-059), run the exported `BACKFILL_SQL`, assert exactly one Google identity, one `dev` identity, none for the NULL row, `email_verified` NULL, `users` rows byte-identical before and after (SC-005), and that a second run inserts nothing; (c) trigger: a row inserted the old way (`INSERT INTO users (google_id, email, name)`) gets exactly one identity with the right issuer, and a row inserted with `google_id` NULL gets none.
- [ ] T006 [P] In `server/auth/auth-events.js` let `safeSignupSource` return `signin_link` for that value (still default `browser`); update the JSDoc domain. Add a case to `server/auth/__tests__/auth-events.test.js` that `record({ signupSource: 'signin_link' })` stores `signin_link`.
- [ ] T007 [P] Add `mode` to 058's `resolveInstanceConfig(env)` in `server/instance-config.js` per research R4: unset gives `local`, `local` and `team` accepted, anything else throws `ConfigError` with the message in `contracts/auth-providers.md`; consumers read `getInstanceConfig().mode`.
- [ ] T008 [P] Add mode cases to 058's instance-config test suite (the suite that covers `resolveInstanceConfig`): unset means `local`; `local` and `team` accepted case-sensitively; any other value throws naming both values.
- [ ] T009 [P] Create `server/auth/providers.js` per research R4 and R5: `checkBootProviders({ mode, providers })`, `assertBootable({ log, exit })` (logs the one mode line and inactive-provider lines per `contracts/auth-providers.md`; on error logs the FATAL line and calls `exit(1)`), `getProviders({ mode, env })` with the `google` and `dev` entries (`listed`, `countsForBoot`), `getConfiguredButInactive({ mode, env })`, and `getPublicProviderInfo(db)` returning `{ mode, hasOwner, signupOpen, providers: [{ id, label, startPath }] }` (owner probe failure yields `hasOwner: false` and a log line). Faucet enablement uses `devEndpointsEnabled()` from `server/auth/middleware.js`.
- [ ] T010 [P] Write `server/auth/__tests__/providers.test.js`: team with no boot-counting provider gives the message naming `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; team with the faucet only passes; `assertBootable` calls the injected `exit(1)` on error and logs exactly one mode line on success; team plus Google credentials lists Google only; team without credentials lists nothing; local lists nothing even with credentials and reports Google as configured-but-inactive; the faucet is never listed and counts for boot only when `devEndpointsEnabled()`; the public projection contains exactly `id`, `label`, `startPath` and no other key (FR-047).
- [ ] T011 [P] Create `server/auth/instance-owner.js` per research R7: `resolveOwner(db)`, `recordOwner(db, userId)`, `hasOwner(db)`, all with direct SQL on `app_settings` key `instance_owner_user_id` (never `server/api/app-settings.js`'s cache).
- [ ] T012 Write `server/auth/__tests__/instance-owner.test.js` (on a fresh instance database, T016): recorded owner wins; a recorded id whose user was deleted falls back; exactly one admin resolves with `via: 'single_admin'`; two admins and no record gives `ambiguous_admins`; zero users gives `no_users`. Each case resets users and the owner key inside that fresh database only.
- [ ] T013 In `server/__tests__/setup.js` (058 already added per-worker `SQUIRE_DATA_DIR` there) set `process.env.SQUIRE_MODE = process.env.SQUIRE_MODE || 'team'` next to the existing `ENABLE_DEV_ENDPOINTS` line, with a comment citing RBD-059-14.
- [ ] T014 [P] In `client/src/test/setup.js` add a default mock for `GET /auth/providers` returning the team-mode Google response (`{ mode: 'team', hasOwner: true, signupOpen: true, providers: [{ id: 'google', label: 'Google', startPath: '/auth/google' }] }`) through whatever HTTP layer `client/src/utils/api` uses, overridable per test.
- [ ] T015 [P] Change `verifyIdToken` in `server/auth/google.js` to return `{ issuer: 'https://accounts.google.com', subject: payload.sub, email, name, picture, emailVerified }` where `emailVerified` is `payload.email_verified` when it is a boolean, else undefined; keep the name and picture fallbacks. Update `server/auth/__tests__/google.test.js` to the new shape and add `email_verified` true, false, and absent cases.
- [ ] T016 Add `createFreshInstanceDb()` and `dropFreshInstanceDb(handle)` to `server/__tests__/helpers/db.js`: clone this run's migrated template (`getTemplateDatabaseName`) into `<worker database>_fresh` (drop `WITH (FORCE)` first, retry once if the template is momentarily in use), return a pool on it, and drop it in `afterAll`. Every suite that needs a zero-user instance or writes the fixed `app_settings` key `instance_owner_user_id` runs against this database, never against the shared worker database (Constitution II: suites must not assume they own the only database, and must not truncate shared tables). Add `server/__tests__/fresh-instance-db.test.js` proving two clones in sequence each start with zero users.

**Checkpoint**: migration, mode, registry, owner lookup, and test defaults exist. No route behavior has changed yet; the full backend suite is still green.

---

## Phase 3: User Story 2 - The hosted service keeps working exactly as today (Priority: P1)

**Goal**: user resolution goes through identities and every sign-in method shares one post-sign-in path, with no observable change on the hosted service.

**Independent test**: the existing auth, first-run, faucet, auto-issue, invite-conversion, and capture suites pass with unchanged assertions (except `google_id` and profile-shape lookups), plus the new identity regression suite.

### Implementation

- [ ] T017 [US2] In `server/auth/users.js` add `GOOGLE_ISSUER`, `DEV_ISSUER`, `AccountExistsError`, and `resolveIdentityUser(identity, ctx)` per research R2 and `contracts/identity-and-post-auth.md` (transaction, `pg_advisory_xact_lock(hashtextextended(...))`, identity lookup, refresh of `email`/`name`/`picture` and `last_used_at`/`email_verified` on return, case-insensitive email collision refusal, INSERT with `signup_source`/`signup_ip`/`signup_user_agent` and `google_id` NULL, identity insert). Signup source guard accepts `browser`, `agent_oauth`, `signin_link`. Add `createOwnerUser(client, { name, email, ctx })` and `findUserByEmail(db, email)`. Rewrite `findOrCreateUser` as the deprecated fixture wrapper (Google issuer, then `convertPendingInvites`), with a docblock citing RBD-059-18. Export the new names.
- [ ] T018 [US2] Create `server/auth/post-auth.js` per research R3 and `contracts/identity-and-post-auth.md`: move `isValidReturnTo`, `tryParseAuthorizeReturnTo`, and `completePostAuth` out of `server/auth/routes.js` unchanged in logic; add `signupSourceFor(rawReturnTo)` and `establishSession(res, user, { signupSource, ctx, notify })` with today's side-effect order (invites, notifications when `notify` and not synthetic, `updateLastLogin`, cookies). `completePostAuth` takes `{ user, signupSource, clientUrl, rawReturnTo, ctx }` and keeps the feature 031 gate byte-for-byte, including its comments. Neither function accepts `req`.
- [ ] T019 [US2] In `server/auth/routes.js` rewire `GET /google/callback`: `signupSourceFor(rawReturnTo)`, `resolveIdentityUser(profile, { signupSource, ...authContext(req) })`, then `completePostAuth`; catch `AccountExistsError` and redirect to `${clientUrl}/login?error=account_exists` with no cookies; keep `auth_failed` for other errors. Import from `post-auth.js`; keep `module.exports.isValidReturnTo` and `module.exports.tryParseAuthorizeReturnTo` as re-exports. Leave 058's cookie and client-URL lines as merged.
- [ ] T020 [US2] In `server/auth/routes.js` rewire `POST /dev-login`: all three modes resolve through `resolveIdentityUser({ issuer: DEV_ISSUER, subject: 'dev-test-user' | 'dev-test-<nonce>', ... })`; the fixed and fresh JSON modes call `establishSession(..., { notify: false })` and keep their response bodies exactly; browser mode calls `completePostAuth`. Mounting, gating, and the 400 nonce rule unchanged.

### Tests

- [ ] T021 [US2] Update `server/auth/__tests__/users.test.js`: replace assertions on `users.google_id` with assertions on the identity row; add tests for invariants I1 to I6 in `contracts/identity-and-post-auth.md`, including the concurrency case (two `resolveIdentityUser` calls for one new pair through two pool clients with `Promise.all`; exactly one user and one identity, one call `isNew: true`) and the collision case (`AccountExistsError`, zero new rows, case-variant email also refused); plus the fixture path RBD-059-24 protects: a user inserted the old way (`INSERT INTO users (google_id, email, name)`) is returned by `findOrCreateUser` with that `googleId` as the same user with `isNew: false`.
- [ ] T022 [US2] Extend the structural test in `server/auth/__tests__/auth-events.test.js` ("the refresh route calls neither user-store helper") so the refresh handler body also must not match `resolveIdentityUser|establishSession|completePostAuth`.
- [ ] T023 [US2] Write `server/__tests__/integration/identity-regression.test.js` (Google adapter mocked to return the new profile shape, real database, real `post-auth.js`). Cases: (1) new Google user without returnTo: one user with `signup_source = browser`, capture pair written, `google_id` NULL, one Google identity with `email_verified` stored, exactly one `auth_events` row (`signup`, `browser`), pending document and space invites for that email converted, welcome-doc redirect; (2) the same subject returns with a changed email claim: same user id, email/name/picture refreshed, `signup_*` unchanged, `last_login_*` refreshed, exactly one new `login` row; (3) a legacy row seeded with a numeric `google_id` plus its backfilled identity signs in as the same user; (4) unknown subject whose email exists: redirect `error=account_exists`, no `Set-Cookie` for session cookies, zero new users, identities, or `auth_events` rows; (5) new user with a valid `/authorize` returnTo and localhost redirect gets `signup_source = agent_oauth` and an inline code (031); (6) existing user with the same returnTo is redirected to the consent page and no code is minted; (7) faucet fixed, fresh JSON, and fresh browser modes create `dev` identities and keep their response shapes; a pre-059 faucet row (`google_id = 'dev-test-user'` backfilled to `dev`) is found again, not refused; (8) source-regex: no file under `server/` outside `__tests__` calls `findOrCreateUser(` except its definition in `server/auth/users.js`.
- [ ] T024 [P] [US2] Update the Google adapter mocks in `server/auth/__tests__/routes.test.js` and `server/__tests__/auth-return-to.test.js` to the new profile shape and replace any `google_id` lookups with identity or email lookups. No other assertion changes.
- [ ] T025 [P] [US2] Same update for `server/__tests__/integration/first-run.test.js`, `first-run-auto-issue.test.js`, and `first-run-delegation-parity.test.js` (the `GOOGLE_IDS` cleanup list becomes an identity-subject list deleted through `user_identities` joins, or a user-id list).
- [ ] T026 [P] [US2] Same update for `server/__tests__/integration/auto-approve.test.js`, `faucet-wipe.test.js`, and `prod-reset.test.js`.
- [ ] T027 [US2] Run the regression set listed in `quickstart.md` section 1 plus `server/__tests__/trust-proxy-invariant.test.js` and `server/__tests__/invite-conversion.test.js`; record in `promotion-notes.md` which files changed and confirm (by diff review) that only mocks, setup, and `google_id` lookups changed in them.

**Checkpoint**: hosted behavior is pinned; every later sign-in method reuses `post-auth.js`.

---

## Phase 4: User Story 1 - Claim a fresh local instance from a terminal link (Priority: P1) MVP

**Goal**: on a local instance with zero users, `squire claim-link` prints a link whose claim page creates the owner and signs them in.

**Independent test**: empty database, local mode; run the CLI function, open the link, submit; observe a session, an admin user with `signup_source = signin_link`, one `signup` event, a used link, and the welcome document.

### Implementation

- [ ] T028 [US1] Create `server/auth/signin-links.js` per research R6 and `contracts/signin-links.md`: `mintLink` (prunes, 32-byte base64url token, SHA-256 hex hash, 15-minute expiry), `buildLinkUrl` (058's `APP_URL`, fallback chain per the contract), `peekLink` (read-only; `{ valid: false }` with no detail for unknown, used, voided, expired, or a claim link on an instance that has users; `signin` prefill from the target user), `redeemLink` (validation before the transaction; conditional `UPDATE ... RETURNING`; `signin` target load; `claim`: `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`, zero-user check, `createOwnerUser`, `recordOwner`, void other unused claim links; typed `SigninLinkError` codes `link_invalid`, `instance_claimed`, `claim_invalid`). The module must not require `server/auth/jwt.js` or `server/mcp/auth/jwt.js`. Log only link ids.
- [ ] T029 [US1] Create `server/auth/signin-link-routes.js` with `POST /signin-link/peek` and `POST /signin-link` per `contracts/signin-links.md` (form vs JSON by `req.accepts`; success through `completePostAuth` with `signupSource: 'signin_link'` and `rawReturnTo: null`, or `establishSession` plus onboarding seed and the JSON body; refusals per the table, never setting cookies; `getClientUrl` reused from `routes.js` by exporting it). Mount it from `server/auth/routes.js` so it inherits the `/auth` per-IP limiter.
- [ ] T030 [US1] Create the CLI skeleton: `server/cli/index.js` (`parseArgs`, dispatch, usage, exit codes 0/1/2, stdout vs stderr rule), `server/cli/db.js` (pool from `script/setup-db-env.js`; connection failure mapped to the database message in `contracts/squire-cli.md`), `server/cli/messages.js` (every failure message, each with its next action), and `bin/squire.js` (shebang, `script/setup-db-env.js`, 058's `resolveSecrets({ env: process.env, dataDir: getInstanceConfig().dataDir, generate: false })`, then `main`). Add `"bin": { "squire": "bin/squire.js" }` to `package.json`.
- [ ] T031 [US1] Create `server/cli/claim-link.js` for the unclaimed case: syntax-check `--email` when given, mint a `claim` link with source `cli` and the prefill, print the URL alone on stdout and the explanation on stderr.
- [ ] T032 [P] [US1] Create `client/src/pages/ClaimPage.jsx` and `client/src/pages/ClaimPage.css` per `contracts/pages.md` (read and strip the fragment, peek, the five states, a real `<form method="post" action="/auth/signin-link">` with hidden `token`), and route `/claim` in `client/src/App.jsx` `parseRoute`.
- [ ] T033 [P] [US1] In `client/src/pages/AdminPage.jsx` render `signin_link` as "Sign-in link"; add the case to `client/src/pages/__tests__/AdminPage.test.jsx`.

### Tests

- [ ] T034 [US1] Write `server/auth/__tests__/signin-links.test.js`: stored row holds only the hash (the token string appears in no column), expiry is 15 minutes after creation, peek changes nothing (row identical before and after), redeem twice gives one success and one `link_invalid`, an expired row is refused (set `expires_at` in the past directly), validation failure does not set `used_at`, claim with zero users creates an admin with `signup_source = signin_link` and records the owner, claim when a user exists is refused with `instance_claimed` and creates nothing, redeeming one claim link voids the other outstanding claim link (SC-004, acceptance US1-6), mint prunes rows used or expired more than 24 hours ago and keeps newer ones, two concurrent claim redemptions with different links create exactly one user.
- [ ] T035 [US1] Write `server/__tests__/integration/signin-link.test.js` (local mode, real router mounted like `server/index.js` does, including the `/auth` limiter): form-mode success sets both session cookies and 302s to the welcome document (real onboarding, not mocked) with exactly one `auth_events` row (`signup`, `signin_link`); JSON-mode success returns `{ ok: true, user }` with the same cookies and one row; each refusal returns the contract's status or redirect and sets no cookie; `claim_invalid` leaves the link unspent; a request carrying a valid `oauth_return_to` cookie for an `/authorize` URL with a localhost redirect mints no authorization code (FR-011); the peek response for each state contains only the contract's keys (FR-047); the token never appears in any `Location` header; and a source-regex assertion that `mintLink(` is called only from files under `server/cli/` and from `maybeLogStartupClaimLink` in `server/auth/signin-links.js`, with no route file calling it (FR-033).
- [ ] T036 [US1] Write `server/__tests__/integration/claim-e2e.test.js` for SC-001: empty database, local mode; call `server/cli/claim-link.js` with captured stdout, parse the single URL line, take the fragment, POST the peek and assert prefill, POST the form, follow to the welcome document, and call `GET /auth/me` with the returned cookies to confirm the session and `isAdmin: true`.
- [ ] T037 [P] [US1] Write `server/cli/__tests__/claim-link.test.js` for the unclaimed case: stdout is exactly one line matching `^<APP_URL>/claim#[A-Za-z0-9_-]{43}$`, explanation on stderr, bad `--email` exits 2 with the reason, the row's prefill matches the flags.
- [ ] T038 [P] [US1] Write `client/src/pages/__tests__/ClaimPage.test.jsx`: the fragment is removed from the URL after load; no request URL contains the token (assert on the mocked HTTP calls); the claim state renders prefilled editable fields; the sign-in state renders "Sign in as <name> (<email>)" and no fields; invalid states render the message and no form; the form posts to `/auth/signin-link` with the hidden token; empty name or malformed email blocks submission client-side.

**Checkpoint**: MVP. A local instance can be claimed end to end.

---

## Phase 5: User Story 3 - Sign back in on a claimed instance (Priority: P2)

**Goal**: links sign in the owner or any named user on a claimed instance; the startup log prints a claim link only on an unclaimed local instance.

**Independent test**: on a claimed instance, mint and redeem a claim link and a login link; boot unclaimed, claimed, and team instances and check the log.

- [ ] T039 [US3] Extend `server/cli/claim-link.js` for a claimed instance: `resolveOwner`; owner found mints a `signin` link for the owner and prints the "already has an owner ... ignored" stderr line (the "ignored" clause only when a flag was given); owner unresolvable exits 1 with the `login-link --email` next action.
- [ ] T040 [P] [US3] Create `server/cli/login-link.js`: case-insensitive `findUserByEmail`; found mints a `signin` link; not found exits 1 naming the email and, with zero users, the `claim-link` next action.
- [ ] T041 [US3] Add `maybeLogStartupClaimLink({ pool, mode, log })` to `server/auth/signin-links.js` (local mode and zero users only; source `startup`; no prefill; the exact block in `contracts/signin-links.md`; errors logged and swallowed) and call it in `server/index.js` inside the `app.listen` callback immediately before `lifecycle.markInitialized()`.
- [ ] T042 [US3] Add claimed-instance cases to `server/cli/__tests__/claim-link.test.js`: the link signs in the owner without changing their name or email; the flags-ignored message; ambiguous admins exit 1 naming `squire login-link --email`.
- [ ] T043 [P] [US3] Write `server/cli/__tests__/login-link.test.js`: mixed-case email finds the user; redemption yields exactly one `login` row with `signin_link`; unknown email exits 1 with the right next action in both the zero-user and the claimed case; works with `SQUIRE_MODE=team`.
- [ ] T044 [US3] Write `server/auth/__tests__/startup-claim-link.test.js`: local plus zero users logs the block with exactly one URL line, and that link is redeemable as a claim with empty prefill; local with a user logs nothing; team mode logs nothing; a database error is swallowed; plus a source-regex assertion on `server/index.js` that `maybeLogStartupClaimLink` appears inside the listen callback before `lifecycle.markInitialized()`.

---

## Phase 6: User Story 4 - The sign-in and consent pages reflect the instance (Priority: P2)

**Goal**: pages render from `GET /auth/providers`; local mode shows the claim-link instruction; team mode with Google is unchanged.

**Independent test**: render both pages against local and team responses; the SC-003 baseline stays green.

- [ ] T045 [US4] Add `GET /providers` to `server/auth/signin-link-routes.js` per `contracts/auth-providers.md` (`getPublicProviderInfo`, `Cache-Control: public, max-age=60`).
- [ ] T046 [US4] In `server/auth/routes.js` add the local-mode gate as the first statement of `GET /google` and `GET /google/callback`: `getInstanceConfig().mode === 'local'` redirects to `${getClientUrl(req)}/login?error=provider_disabled` with no cookies set or cleared and no adapter call.
- [ ] T047 [US4] Write `server/__tests__/integration/auth-providers.test.js`: response shape for local and for team with Google (keys exactly as the contract; no secret values from the environment appear anywhere in the body); `hasOwner` false then true after a claim; local-mode `GET /auth/google` and `GET /auth/google/callback?code=x&state=y` return 302 to `error=provider_disabled` with no `Set-Cookie` header and no call to the mocked adapter; team mode unchanged.
- [ ] T048 [P] [US4] Create `client/src/hooks/useAuthProviders.js` per `contracts/pages.md` (shared promise, `loading`/`ready`/`error`, Google fallback on error) and `client/src/hooks/__tests__/useAuthProviders.test.js`.
- [ ] T049 [P] [US4] In `client/src/contexts/AuthContext.jsx` change `login(returnTo)` to `login(returnTo, startPath = '/auth/google')`, building the URL from `startPath`; existing callers unchanged.
- [ ] T050 [US4] Update `client/src/components/LoginPage.jsx` per `contracts/pages.md`: headline immediately; provider buttons (Google keeps its icon and exact text) and footer after the fetch settles; local-mode instruction block on both routes with no footer; new error-code messages. Keep 058's legal-link condition as merged.
- [ ] T051 [US4] Update `FirstRunConsent` and its caller in `client/src/pages/AuthorizePage.jsx`: lead sentence, grant tail, and action from the provider (team: unchanged text, `href = startPath + '?returnTo=' + current /authorize URL`); local-mode variant per `contracts/pages.md`; add a local-mode card to `AuthorizePreview`.
- [ ] T052 [US4] Client tests: `client/src/components/__tests__/LoginPage.test.jsx` (local mode on `/login` and `/signup`: instruction present, no button, no "Sign up" or "Don't have an account?" text; error messages for the new codes; fetch failure renders the Google version), additions to `client/src/pages/__tests__/AuthorizePage.test.jsx` (local mode: no "Google" anywhere in the rendered text, instruction present, agent name and grant present; team mode `href` uses the registry's start path), and confirm `LoginPage.baseline.test.jsx` from T003 passes unchanged against the new components with the team-mode mock (SC-003).

---

## Phase 7: User Story 5 - Mode governs who can sign in (Priority: P2)

**Goal**: the mode is validated at boot, local mode admits no network-created accounts, invites say they cannot be redeemed, and every deployment sets its mode explicitly.

**Independent test**: boot outcomes per mode and provider; network attempts to create an account in local mode all fail.

- [ ] T053 [US5] In `server/index.js` call `assertBootable({ log: console, exit: process.exit })` from `server/auth/providers.js` after the `NODE_ENV` warning block and before the first `app.listen`; it logs the mode line and the inactive-provider line (FR-023).
- [ ] T054 [US5] Add to `server/auth/__tests__/providers.test.js` a source-regex assertion that `server/index.js` calls `assertBootable(` before `app.listen(`.
- [ ] T055 [US5] Write `server/__tests__/integration/local-mode-lockdown.test.js` (SC-007): local mode with an owner; `GET /auth/google`, the callback with a mocked valid profile for a new subject, `POST /auth/dev-login` with `ENABLE_DEV_ENDPOINTS` unset (router loaded with `jest.isolateModules`), and `POST /auth/signin-link` with 20 random 43-character tokens and with a claim body each create no user and set no session cookie; then switch to team mode with Google (US5-8): the owner still signs in with a `signin` link, their document rows are intact, `GET /auth/providers` lists Google, and a Google sign-in using the owner's email gets `account_exists`.
- [ ] T056 [P] [US5] In `client/src/components/ShareDialog.jsx` show the local-mode invite note from `contracts/pages.md` when the share result is an invite and the provider info says local; add the case and the unchanged team text to a new `client/src/components/__tests__/ShareDialog.localMode.test.jsx`.
- [ ] T057 [P] [US5] In `client/src/pages/SpaceSettingsPage.jsx` show the same note after a pending space invite in local mode; add cases to `client/src/pages/__tests__/SpaceSettingsPage.test.jsx`.
- [ ] T058 [P] [US5] Set `SQUIRE_MODE=team` in `k8s/base/app-deployment.yaml` (RBD-059-15), `k8s/overlays/aws-prod/patches/app-node-env.yaml` (RBD-059-11, next to `NODE_ENV`), `k8s/overlays/minikube/app-dev.yaml` and `devcontainer/k8s/app-dev.yaml` (RBD-059-1), and `.env.example` (with a comment explaining local versus team).
- [ ] T059 [US5] Write `server/__tests__/deploy-mode-config.test.js`: each of the five files from T058 sets `SQUIRE_MODE` to `team` (YAML parsed with the repo's existing YAML dependency if present, else a strict regex on the env entry), so a future edit cannot silently drop the hosted mode.

---

## Phase 8: User Story 6 - The squire CLI reports and recovers (Priority: P3)

**Goal**: `doctor`, `mode`, and `token create` behave per `contracts/squire-cli.md`, every failure names the next action, and the image ships the command.

**Independent test**: run each command against healthy and broken setups and check output, exit code, file mode, and messages.

- [ ] T060 [US6] Create `server/cli/doctor.js` per `contracts/squire-cli.md` and RBD-059-23 (database, pending migrations ignoring the retired 008 name, `/ready` probe, mode and providers, `APP_URL` rule, owner, info block from 058's configuration module, `server/api/ai-providers.js` server-key variables, and `GOOGLE_GENERATIVE_AI_API_KEY`); the database, Redis, and `/ready` probes run concurrently with 2 s timeouts so the command finishes within 5 s even when all three hang; a `ConfigError` from `getInstanceConfig()` is reported as a failing check with its message rather than a crash.
- [ ] T061 [P] [US6] Create `server/cli/mode.js` (text for both modes per the contract).
- [ ] T062 [P] [US6] Create `server/cli/token-create.js` per `contracts/squire-cli.md` and RBD-059-7/RBD-059-22 (target user rules, scopes, `--expires-in` grammar, exclusive 0600 file under `<data dir>/tokens` with a 0700 directory, mint only after the file is open and remove it on failure, `--stdout` with the do-not-echo warning reused from `server/mcp/tools/create-access-token.js`).
- [ ] T063 [US6] Write `server/cli/__tests__/doctor.test.js`: healthy (stub `/ready` server on an ephemeral port) gives `ok: true` and exit 0; unreachable database (bad port), pending migrations (insert a fake future migration file name into a temp migrations dir or stub the directory reader), team with no provider, `APP_URL=http://192.168.1.5:3910`, and `/ready` not listening each give `ok: false`, a `message` with a next action, and exit 1; no embedding key is reported off and leaves `ok` true; `--json` output parses as one JSON document; total time under 5 s with an unreachable database.
- [ ] T064 [P] [US6] Write `server/cli/__tests__/mode.test.js` and `server/cli/__tests__/token-create.test.js`: file mode 0600 and directory 0700, token absent from stdout and stderr, stderr names the path and the `docker compose cp` command, the token appears in `listTokens` for the owner with the given name and an expiry 30 days out (within a minute), team mode without `--email` exits 2, an existing file is refused and no token is minted, `--stdout` prints only the token on stdout, bad durations and scopes exit 2.
- [ ] T065 [US6] Write `server/cli/__tests__/messages.test.js` (SC-008): one table-driven test that triggers every failure in `server/cli/messages.js` through the command functions and asserts each printed message contains its next-action command or setting name.
- [ ] T066 [US6] Write `server/cli/__tests__/safe-require.test.js`: with `NODE_ENV=production` and none of the four secrets set, `require('../index')` (inside `jest.isolateModules`) does not throw, and the loaded module set (from `require.cache`) excludes `server/auth/jwt.js`, `server/mcp/auth/jwt.js`, `server/auth/routes.js`, and `server/index.js`.
- [ ] T067 [US6] Write `server/cli/__tests__/bin-shim.test.js`: spawn `node bin/squire.js` with no arguments (exit 2, usage on stderr), `--help` (exit 0), and `doctor --json` with `DB_PORT` pointing at a closed port (exit 1, JSON with `ok: false`).
- [ ] T068 [US6] In `Dockerfile` add `COPY --chown=appuser:appgroup bin/ ./bin/` next to the other COPY lines and, before `USER appuser`, `RUN chmod 0755 /app/bin/squire.js && ln -s /app/bin/squire.js /usr/local/bin/squire`. Leave 058's entrypoint, `NODE_ENV`, `/data`, and HEALTHCHECK lines as merged.

---

## Phase 9: Polish and cross-cutting

- [ ] T069 [P] Update `README.md` per the plan's "Documentation owed" list (identity model, modes, `GET /auth/providers`, sign-in links and `/claim`, the startup-log link, the CLI, migration `1799830000000`, `signin_link`, the hosted overlay's `SQUIRE_MODE=team`).
- [ ] T070 [P] Update `docs/dev.md`: development runs in team mode (overlays and Jest default), the faucet's `dev` issuer, running `node bin/squire.js` in the pod, trying local mode on a scratch database (quickstart section 3).
- [ ] T071 Append the implement-phase section to `specs/059-identity-local-mode/promotion-notes.md`: deploy preconditions (SQUIRE_MODE check, case-variant email count, migrate Job), the design amendments owed in Squire (from the spec phase list plus RBD-059-16 and RBD-059-20), and any relaxation accepted during implementation.
- [ ] T072 Run `npm run test:server` and `npm run test:client` in full; fix any failure in this feature's code (never by changing an existing regression assertion).
- [ ] T073 Walk `quickstart.md` sections 2 to 6 in the dev pod and section 7 with a local image build; record results in `promotion-notes.md`.

---

## Dependencies and execution order

### Phase dependencies

- Phase 1 (Setup) requires 058 merged. T003 must finish before T050, T051.
- Phase 2 (Foundational) blocks everything after it. T004 before T005; T011 and T016 before T012 (it writes the owner key, so it runs on a fresh instance database); T013 before any backend suite that relies on team mode; T016 before every suite named in the fresh-database convention above.
- Phase 3 (US2) blocks Phases 4 to 8: every new sign-in method uses `post-auth.js` and `resolveIdentityUser`.
- Phase 4 (US1) depends on Phase 3. T028 before T029, T031, T034; T030 before T031, T037; T029 before T035, T036.
- Phase 5 (US3) depends on Phase 4 (links and CLI skeleton).
- Phase 6 (US4) depends on Phase 2 (registry) and Phase 4 (T029 file exists for T045); it can run in parallel with Phase 5.
- Phase 7 (US5) depends on Phase 6 (T046 gate) for T055; T056 to T059 can start after Phase 2.
- Phase 8 (US6) depends on Phase 4 (CLI skeleton); T060 needs 058's configuration names from T001.
- Phase 9 last.

### Within each story

Implementation tasks precede their tests only where the test needs the module to exist; write the tests in the same session and run them before moving on.

### Parallel opportunities

- Phase 2: T006, T007, T009, T011, T014, T015 in parallel (separate files); T008, T010 after their modules.
- Phase 3: T024, T025, T026 in parallel after T019 and T020.
- Phase 4: T032, T033 (client) in parallel with T028 to T031 (server); T037, T038 in parallel.
- Phases 5 and 6 can be worked in parallel by two agents after Phase 4.
- Phase 7: T056, T057, T058 in parallel.
- Phase 8: T061, T062, T064 in parallel after T030.

### Parallel example: Foundational

```text
T006 auth-events.js domain        T007 mode in instance-config.js
T009 providers.js                 T011 instance-owner.js
T014 client test setup            T015 google.js profile shape
```

## Implementation strategy

1. **Regression first**: Phases 1 to 3 land and the full backend suite is green before any new sign-in method exists. If Phase 3 cannot be made green with unchanged assertions, stop and report; do not proceed to US1.
2. **MVP**: Phase 4 (claim end to end). At this checkpoint a local instance can be claimed through the CLI function and the page.
3. **Increment**: Phases 5 and 6 (re-entry, startup link, provider-driven pages), then Phase 7 (boot check, lockdown, overlays), then Phase 8 (doctor, mode, token create, image).
4. **Close**: Phase 9 docs and the quickstart walk, in the same change set as the behavior (Constitution I).

## Requirement coverage map

| Requirement | Tasks |
| --- | --- |
| FR-001, FR-002 | T004, T005 |
| FR-003, FR-004, FR-005, FR-006, FR-007 | T015, T017, T019, T021, T023 |
| FR-008, FR-009, FR-010, FR-012 | T018, T019, T020, T022, T023, T035 |
| FR-011 | T018, T023, T035 |
| FR-013 | T020, T023, T026 |
| FR-014 | T004, T006, T017, T028, T033 |
| FR-015, FR-016, FR-047 | T009, T010, T045, T047, T035 |
| FR-017, FR-018 | T003, T048 to T052 |
| FR-019 | T046, T047 |
| FR-020, FR-021, FR-023 | T007, T008, T009, T010, T053, T054 |
| FR-022, FR-045 | T028, T034, T055 |
| FR-024 | T056, T057 |
| FR-025 | T013, T058, T059 |
| FR-026 to FR-031, FR-034 | T028, T029, T032, T034, T035, T038 |
| FR-032 | T039, T042 |
| FR-033 | T035 |
| FR-035 | T029, T035 |
| FR-036, FR-037 | T041, T044 |
| FR-038 | T030, T066, T067, T068 |
| FR-039 | T060, T063 |
| FR-040 | T031, T037, T039, T042 |
| FR-041 | T040, T043 |
| FR-042 | T061, T064 |
| FR-043 | T062, T064 |
| FR-044 | T030, T065 |
| FR-046 | T027 (trust-proxy-invariant suite stays green; no task edits `trust proxy`) |
| SC-001 | T036 |
| SC-002 | T024 to T027, T072 |
| SC-003 | T003, T052 |
| SC-004 | T034 |
| SC-005 | T005 |
| SC-006 | T060, T063 |
| SC-007 | T055 |
| SC-008 | T065 |
