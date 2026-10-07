# Implementation Plan: Identity and Local Mode

**Branch**: `059-identity-local-mode` (planned on `main` in the `main-os` worktree; no branch created) | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/059-identity-local-mode/spec.md`, ledger `clarifications-needed.md` (RBD-059-1 to RBD-059-13 from the spec phase, RBD-059-14 to RBD-059-24 from this phase), design ground truth `design/self-hosting-local-mode.md` (ratified D1 to D12, amended 2026-10-07 with the owner and redemption details and `squire token create`).

## Summary

Build step 2 of the self-hosting design. Users are resolved through a new
`user_identities` table keyed by (issuer, subject), with Google rows
backfilled and `users.google_id` made nullable. The post-sign-in logic moves
into one module that every sign-in method shares, so the hosted service's
Google sign-in, the feature 029 faucet, the feature 031 auto-issue gate, the
feature 034 capture and auth-event trail, and pending-invite conversion keep
today's behavior by construction and are pinned by tests against production
code. `SQUIRE_MODE=local|team` (local by default) decides which providers are
active; a provider registry feeds `GET /auth/providers`, and the sign-in and
consent pages render from it. Local mode signs in only through single-use,
15-minute links minted inside the container (the `squire` CLI or the startup
log), redeemed on a new `/claim` page. The hosted overlay and the development
overlays set `SQUIRE_MODE=team` in the same change.

059 is implemented after feature 058 and on top of it. It consumes 058's
`APP_URL`, secrets resolver, data directory, and Secure-cookie rule, and does
not re-plan them.

## Technical Context

**Language/Version**: Node.js 22 (CommonJS) backend; React 18 + Vite frontend.

**Primary Dependencies**: Express, `pg`, node-pg-migrate, `google-auth-library` (unchanged), `cookie-parser`, `node:crypto`, `node:util` `parseArgs` (CLI). No new npm dependency.

**Storage**: PostgreSQL. One migration, `migrations/1799830000000_add-user-identities-and-signin-links.js` (new tables `user_identities`, `signin_links`; `users.google_id` DROP NOT NULL; `signup_source` CHECK widened on `users` and `auth_events`; a compatibility trigger that gives rows written with `google_id` an identity, RBD-059-24). One new `app_settings` key, `instance_owner_user_id`. See `data-model.md`.

**Testing**: Jest backend (`npm run test:server`, parallel per-worker databases, `server/__tests__/setup.js` gains a `SQUIRE_MODE=team` default per RBD-059-14); Vitest frontend (`npm run test:client`); one spawn test for the CLI shim. Regression pins listed in "Regression protection" below.

**Target Platform**: Linux container (`node:22-alpine`), the minikube app-dev pod, the hosted k3s cluster.

**Project Type**: Web application (Express backend + React SPA) plus an in-container CLI.

**Performance Goals**: `squire doctor --json` under 5 s on a healthy instance (SC-006); sign-in latency unchanged in practice (one extra indexed lookup plus a transaction-scoped advisory lock on first sign-in only).

**Constraints**: Hosted behavior unchanged in team mode with Google (SC-002, SC-003); tokens never in paths, queries, logs, or Referer (FR-027); owner creation impossible once any user exists (FR-045); no change to `trust proxy` (FR-046); every replica stateless with respect to links and owner (Constitution VII).

**Scale/Scope**: About 25 source files touched or created, 1 migration, about 12 new test files, about 20 existing test files touched (mostly setup or `google_id` lookups).

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 design. No violations.*

| Principle | How 059 complies |
| --- | --- |
| I. Documentation Reflects Reality | README.md and docs/dev.md updates are tasks in this feature's change set (listed under "Documentation owed"). This plan agent may not edit them; the implement phase must, in the same commit as the behavior. |
| II. Test-Backed Changes | Every FR maps to a test task. Regression parity is pinned against production code (no mirrors). Suites follow per-worker isolation; suites that insert users clean up by their own ids; the migration test uses its own rows. "Unclaimed" means zero users, which a shared per-worker database can never guarantee, so suites that need a zero-user instance or write the fixed `app_settings` key `instance_owner_user_id` run on a fresh clone of the migrated template (`createFreshInstanceDb()` in `server/__tests__/helpers/db.js`, research R15), never by truncating shared tables. |
| III. Trunk-Based Solo Workflow | Planned on `main` in a worktree per the pipeline; merge after 058. |
| IV. CRDT / attribution integrity | Not touched: no document, Yjs, or attribution code changes. |
| V. Secure by Default | `sk_sqd_` tokens from `token create` are scoped (read and write default, narrowable) and expiring (30 days default, 365 max). New endpoints: `GET /auth/providers` is intentionally public and returns no secret or user data; the peek and redeem endpoints are authenticated by the token itself and rate limited; no endpoint mints links (FR-033). Trust boundary of the new ingestion surface (the claim form): untrusted name and email, validated length and shape, no HTML rendering. |
| VI. Design Docs Are Ground Truth | Built from `design/self-hosting-local-mode.md`. New gaps recorded as RBD-059-14 to RBD-059-24. Design amendments owed are listed in `promotion-notes.md`. The unratified team-mode amendment is used only where the spec already chose it (RBD-059-3). |
| VII. Horizontally Scalable App Pods | Owner identity read from Postgres on every use (not the per-process app-settings cache); link state in Postgres; concurrency via Postgres advisory and table locks; startup links minted per replica and independently valid; mode is configuration, identical across replicas. |
| Tech constraints | Schema change through node-pg-migrate only; no AI-provider change (doctor only reads `server/api/ai-providers.js` metadata); no new serialization dependency. |

Post-design re-check: the design adds `server/auth/post-auth.js` (a move, not a
new layer) and `server/cli/` (needed so the CLI is testable without spawning).
Neither is a constitution concern. Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/059-identity-local-mode/
├── spec.md
├── clarifications-needed.md     # RBD-059-1..24
├── promotion-notes.md
├── plan.md                      # this file
├── research.md                  # R1..R15
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── auth-providers.md
│   ├── signin-links.md
│   ├── squire-cli.md
│   ├── identity-and-post-auth.md
│   └── pages.md
└── tasks.md
```

### Source Code (repository root)

```text
migrations/
└── 1799830000000_add-user-identities-and-signin-links.js     NEW

server/auth/
├── users.js               CHANGED  resolveIdentityUser, createOwnerUser, findUserByEmail, AccountExistsError; findOrCreateUser becomes a fixture wrapper
├── post-auth.js           NEW      isValidReturnTo, tryParseAuthorizeReturnTo, signupSourceFor, establishSession, completePostAuth (moved from routes.js)
├── routes.js              CHANGED  Google callback and faucet call resolveIdentityUser + post-auth; local-mode gate on /google and /google/callback; account_exists redirect; mounts providers and signin-link routes; re-exports moved helpers
├── google.js              CHANGED  verifyIdToken returns { issuer, subject, email, name, picture, emailVerified }
├── auth-events.js         CHANGED  safeSignupSource accepts signin_link
├── providers.js           NEW      registry, getPublicProviderInfo, inactive-provider report, checkBootProviders, assertBootable
├── instance-owner.js      NEW      resolveOwner, recordOwner, hasOwner
├── signin-links.js        NEW      mintLink, peekLink, redeemLink, buildLinkUrl, maybeLogStartupClaimLink
└── signin-link-routes.js  NEW      GET /providers, POST /signin-link/peek, POST /signin-link

server/cli/                NEW      index.js, db.js, messages.js, doctor.js, claim-link.js, login-link.js, mode.js, token-create.js
bin/squire.js              NEW      shim: 058 secrets resolver, setup-db-env, server/cli main
server/instance-config.js  CHANGED  (058's module) adds `mode` from SQUIRE_MODE; invalid value is a ConfigError naming local and team
server/index.js            CHANGED  assertBootable before listen; startup claim link before markInitialized
server/api/admin.js        unchanged (already returns signup_source)

client/src/
├── hooks/useAuthProviders.js            NEW
├── components/LoginPage.jsx             CHANGED  render from providers; local-mode instruction; new error codes
├── contexts/AuthContext.jsx             CHANGED  login(returnTo, startPath)
├── pages/AuthorizePage.jsx              CHANGED  FirstRunConsent from providers; local-mode variant; preview card
├── pages/ClaimPage.jsx (+ ClaimPage.css) NEW
├── App.jsx                              CHANGED  /claim route
├── components/ShareDialog.jsx           CHANGED  local-mode invite note
├── pages/SpaceSettingsPage.jsx          CHANGED  local-mode invite note
└── pages/AdminPage.jsx                  CHANGED  "Sign-in link" label

Dockerfile                               CHANGED  COPY bin/; chmod + symlink /usr/local/bin/squire before USER
package.json                             CHANGED  "bin": { "squire": "bin/squire.js" }
k8s/base/app-deployment.yaml             CHANGED  SQUIRE_MODE=team (RBD-059-15)
k8s/overlays/aws-prod/patches/app-node-env.yaml   CHANGED  SQUIRE_MODE=team (RBD-059-11)
k8s/overlays/minikube/app-dev.yaml       CHANGED  SQUIRE_MODE=team (RBD-059-1)
devcontainer/k8s/app-dev.yaml            CHANGED  SQUIRE_MODE=team (RBD-059-1)
.env.example                             CHANGED  SQUIRE_MODE=team with a comment

server/__tests__/setup.js                CHANGED  SQUIRE_MODE defaults to team (RBD-059-14)
client/src test setup                    CHANGED  default /auth/providers mock (team, Google)
```

**Structure Decision**: Existing web-application layout. New auth modules sit
beside the ones they extend in `server/auth/`; CLI logic is under `server/cli/`
so it ships with the existing `COPY server/` and is testable in Jest; only the
shim lives in `bin/`.

## Phases (implementation order)

1. **Foundation (blocking)**: migration and its test; `mode` in 058's `server/instance-config.js`;
   `providers.js`; `instance-owner.js`; Jest and Vitest mode defaults;
   `auth-events.js` domain; SC-003 baseline snapshots recorded against the
   unchanged pages.
2. **US2 regression contract (P1)**: `resolveIdentityUser`, `post-auth.js`,
   rewired Google callback and faucet, `google.js` profile shape,
   `findOrCreateUser` wrapper; the identity regression suite; updates to suites
   that read `google_id` or the Google profile shape. This is the
   highest-risk phase and lands before any new sign-in method.
3. **US1 claim (P1)**: `signin-links.js`, the peek and redeem routes,
   `ClaimPage.jsx`, `/claim` route, `squire claim-link`, the CLI skeleton and
   shim, the end-to-end claim test (SC-001).
4. **US3 re-entry (P2)**: `login-link`, claimed-instance `claim-link`, the
   startup-log link (D11), expiry and voiding tests (SC-004).
5. **US4 pages (P2)**: `GET /auth/providers`, `useAuthProviders`, the sign-in
   page, the consent page, the local-mode gate on Google start paths, SC-003
   comparison.
6. **US5 mode (P2)**: boot check and log lines in `server/index.js`, local-mode
   lockdown tests (SC-007), invite notes, overlays and `.env.example`.
7. **US6 CLI (P3)**: `doctor`, `mode`, `token create`, the failure-message
   table (SC-008), the Dockerfile and `package.json` changes.
8. **Polish**: README.md, docs/dev.md, promotion notes, full suites, the
   quickstart walk.

## Regression protection (the core risk)

Each row is pinned by a test that drives production code (the real Express
router, real database, Google adapter mocked at `server/auth/google`, as the
existing suites do).

| Behavior | Existing pin (must stay green, assertions unchanged) | New pin |
| --- | --- | --- |
| Google new user, browser: one user, `signup_source = browser`, capture written once, one `signup` event, welcome doc seeded | `first-run.test.js`, `auth-events.test.js`, `admin-auth-capture.test.js` | `identity-regression.test.js` asserts the identity row (Google issuer, `email_verified` stored), `google_id` NULL, exactly one `auth_events` row |
| Google returning user: resolved by (issuer, subject) even after an email change at Google; `last_login_*` refreshed; `signup_*` untouched; one `login` event | `auth-events.test.js` (via wrapper) | `identity-regression.test.js` signs in twice through the callback with a changed email claim and asserts the same user id |
| Backfilled legacy user signs in through the new path | none | `identity-regression.test.js` seeds a pre-059 style row plus backfilled identity and drives the callback |
| 031 auto-issue only for `isNew` + valid `/authorize` + localhost | `first-run-auto-issue.test.js`, `first-run-delegation-parity.test.js`, `auth-return-to.test.js` | sign-in-link test: a valid `oauth_return_to` cookie never yields a code on `POST /auth/signin-link` |
| Existing account inside `/authorize` sees consent | `first-run-auto-issue.test.js` | unchanged |
| Faucet three modes, synthetic wipe, auto-approve, prod reset | `faucet-wipe.test.js`, `auto-approve.test.js`, `prod-reset.test.js`, `first-run.test.js` | `identity-regression.test.js` asserts `dev` issuer identities and that a pre-059 dev row (backfilled to `dev`) is found again |
| Pending document and space invites convert in one transaction on every sign-in, never downgrade, never fail sign-in | `invite-conversion.test.js` (via wrapper) | `identity-regression.test.js` converts through the Google callback and through a sign-in link |
| Exactly one `auth_events` row per completed sign-in; none on refresh | `auth-events.test.js` (structural refresh test extended to the new helper names) | per-method count assertions in identity, sign-in-link, and faucet tests |
| No production route calls `findOrCreateUser` | none | source-regex test in `identity-regression.test.js` |
| Sign-in and consent page copy unchanged in team mode | `AuthorizePage.test.jsx` | baseline snapshots recorded before the change (SC-003) |
| Account with same email, new identity | none (today: generic `auth_failed`) | `account_exists` redirect, zero new rows |

## Overlaps with 058 and merge order

Merge order: **058 first, then 059 rebased onto it.** 059's tasks assume 058's
modules exist; where 059 needs a 058 name (the configuration module that
exports `APP_URL` and the data directory, and the secrets resolver), the
implement agent takes it from 058's merged code. Shared files:

| File | 058 changes | 059 changes | Conflict risk |
| --- | --- | --- | --- |
| `server/auth/routes.js` | `DEFAULT_CLIENT_URL` from `APP_URL`; `secure` on the three OAuth cookies from `APP_URL` | moves `completePostAuth` and helpers to `post-auth.js`; rewires callback and faucet; local-mode gate at the top of `/google` and `/google/callback`; mounts new routes | Medium: both edit the `/google` handler. 059's gate is the first statement in the handler, above 058's cookie lines. |
| `server/auth/jwt.js` | `secure` from `APP_URL` | none (059 does not edit it; `post-auth.js` imports its cookie helpers) | None |
| `server/auth/google.js` | `GOOGLE_REDIRECT_URI` default from `APP_URL` | `verifyIdToken` return shape | Low: different functions |
| `Dockerfile` | `NODE_ENV=production`, entrypoint CMD, `/data`, HEALTHCHECK `/ready` | `COPY bin/`, chmod and symlink before `USER appuser` | Low: separate lines |
| `k8s/overlays/aws-prod/patches/app-node-env.yaml` | comment only (058 puts its values in a new `patches/app-self-host-config.yaml`) | adds `SQUIRE_MODE=team` | Low |
| `k8s/overlays/minikube/app-dev.yaml`, `devcontainer/k8s/app-dev.yaml` | minikube app-dev gains `SQUIRE_HOSTED=true`; 058 also adds `k8s/overlays/minikube/patches/app-self-host-config.yaml` for the base pod | `SQUIRE_MODE=team` (and on the base Deployment, RBD-059-15) | Low: adjacent env entries |
| `.env.example` | documents new variables | adds `SQUIRE_MODE` | Low |
| `server/index.js` | hosted gating, configuration, CSP, warnings | `assertBootable` near the top; startup link before `markInitialized` | Low: different regions |
| `client/src/components/LoginPage.jsx` | hides legal links when not hosted | provider-driven action area and footer | Medium: same component; 059 keeps 058's legal-link condition intact |
| `package.json` | maybe none | `bin` entry | Low |
| `server/__tests__/setup.js` | per-worker `SQUIRE_DATA_DIR`, `SQUIRE_HOSTED` forced unset | `SQUIRE_MODE` defaults to `team` | Low: adjacent lines |
| `client/src/App.jsx` | reads `client/src/instance.js` for hosted pages | `/claim` route | Low |
| `client/src/pages/AdminPage.jsx` | hides welcome-email and self-test controls when not hosted | `signin_link` label | Low |
| `server/email.js` | hosted gate inside `notifyNewUser` and `notifyLogin` | none (059 keeps calling both; the gate decides) | None |
| `server/instance-config.js` | new module (APP_URL, hosted flag, data dir, storage, SMTP) | adds `mode` (058 research R14 assigns `SQUIRE_MODE` to 059 in this module) | Low: additive field |
| `server/auth/middleware.js` | adds `requireAuthOrCookie` | none (reads `devEndpointsEnabled` only) | None |
| README.md, docs/dev.md | 058's variables | 059's identity, mode, CLI | Low: different sections |

059 uses from 058 (names from 058's plan and `contracts/storage-and-boot.md`;
T001 confirms them against the merged code): `getInstanceConfig()` in
`server/instance-config.js` for `APP_URL` (link URLs, doctor), the data
directory (`token create` default path), and the email and storage-driver
resolution (doctor's `info`); `resolveSecrets({ env, dataDir })` in
`server/boot/secrets.js` (CLI shim); and the Secure-cookie rule (claim
redemption cookies on `http://localhost` must not be Secure; 059 adds no cookie
code of its own and inherits the rule through `jwt.js`). If 059 is ever
implemented before 058 merges, the fallbacks in RBD-059-13 apply, and the
claim page on Safari over `http://localhost` would fail until 058 lands.

## Documentation owed (implement phase, same commit as behavior)

- `README.md`: identity model (`user_identities`, `google_id` legacy), `SQUIRE_MODE` and the two modes, `GET /auth/providers`, sign-in links and `/claim`, the startup-log link, the `squire` CLI commands, migration `1799830000000`, the `signin_link` provenance value, the hosted overlay's `SQUIRE_MODE=team`.
- `docs/dev.md`: development runs in team mode (`SQUIRE_MODE=team` in the overlays; Jest defaults to it), the faucet's `dev` issuer, running the CLI in the pod (`node bin/squire.js ...`), how to try local mode on a scratch database (quickstart step 3).
- `.env.example`: `SQUIRE_MODE`.
- Design amendments in Squire (not hand-edited exports): listed in `promotion-notes.md`.

## Deploy preconditions

- `SQUIRE_MODE=team` must be present in the hosted pod's environment. The aws-prod patch and the base deployment both carry it (RBD-059-11, RBD-059-15); verify with `kubectl get deploy collab-app -o yaml | grep -A1 SQUIRE_MODE` before rollout and the boot log line after.
- Before deploying, count case-variant duplicate emails in production (`SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1`). Existing duplicates keep working (identities resolve them), but the number should be known since RBD-059-17 stops new ones.
- The migration runs in the existing migrate Job (058 keeps `MIGRATE_ON_BOOT=false` in production). Its compatibility trigger covers users created by old pods during the roll (RBD-059-24); the reverse transient is in `promotion-notes.md`.

## Complexity Tracking

No constitution violations. Nothing to justify.
