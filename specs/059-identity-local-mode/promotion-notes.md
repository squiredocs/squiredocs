# Promotion notes: 059-identity-local-mode

Records relaxations consciously accepted during this feature's pipeline, deploy
preconditions, and pre-existing defects found but deliberately not fixed. Later
phases append here.

## Spec phase (2026-10-07)

- **No relaxations introduced by the spec.** It encodes the ratified design
  (`design/self-hosting-local-mode.md`, D1 to D11) plus the RATIFIED-BY-DEFAULT
  decisions in `clarifications-needed.md` (RBD-059-1 to RBD-059-13).

- **Deploy precondition (RBD-059-11).** The hosted service must run with
  `SQUIRE_MODE=team`. The production overlay patch carries it in this feature's
  change set, and `script/deploy-aws.sh` applies that overlay, so a normal deploy
  picks it up. If the image is ever run outside that overlay with the variable
  unset, Google sign-in is off and the sign-in page shows the local-mode
  instruction. The boot log and `squire doctor` print the mode.

- **Dependency on 058.** `APP_URL`, the generated-secrets loader, and the data
  directory come from feature 058. The link builder falls back to `CLIENT_URL`
  and the CLI's secret loading is a no-op until 058 merges. The Dockerfile is
  touched by both features (058: entrypoint, `NODE_ENV`, `/data`; 059: the
  `squire` symlink). The merge queue should land 058 first.

- **Design-doc amendments owed in Squire** (never hand-edit the exports; amend
  the source doc, then `node design/sync.mjs`):
  1. `design/self-hosting-local-mode.md`, "The squire CLI": add
     `squire token create` to the command list with the RBD-059-7 defaults.
  2. `design/self-hosting-local-mode.md`, "Sign-in links": record the peek
     call and the form-post/JSON response contract (RBD-059-5), the "zero
     users" definition of unclaimed and the recorded owner (RBD-059-4), and the
     voiding of outstanding claim links on claim (RBD-059-12).
  3. `design/self-hosting-local-mode.md`, "Instance modes": note that the
     development overlays set team mode and that the dev faucet bypasses local
     mode's closed sign-up (RBD-059-1).
  4. `design/authentication-and-sharing.md`: once A1 is ratified, the
     "Identity" section should describe `user_identities` as built (059 ships
     the table and the no-linking rule ahead of 061); if A1 is overturned,
     RBD-059-3 changes with it.

- **Documentation owed by the implement phase** (this spec agent may not edit
  these files): `README.md` (identity model, `SQUIRE_MODE`, `GET
  /auth/providers`, sign-in links, the `squire` CLI, the new migration, the
  `signin_link` provenance value) and `docs/dev.md` (`SQUIRE_MODE=team` for
  development; the faucet's `dev` issuer).

- **Pre-existing defects found while speccing, deliberately NOT fixed by this
  feature** (each would widen scope; none blocks 059):
  1. Every Google sign-in overwrites `users.name` and `users.picture` from the
     provider (`server/auth/users.js:85-86`), which clobbers a display name set
     through `PATCH /auth/me` (`server/auth/routes.js:528-541`). FR-007 keeps
     this behavior for hosted parity. Candidate fix: refresh `picture` only, or
     only when the stored name still equals the previous provider name.
  2. A returning identity whose provider email changed to one already owned by
     another user fails on the email uniqueness constraint with a generic
     `auth_failed` (today and after 059). A clearer refusal is a one-line
     follow-on.
  3. `migrations/1773952482000_add-admin-and-last-login.js:14` still promotes
     one hardcoded email. The amendment keeps it for the hosted service's
     history; it is a no-op on a fresh database.

- **Tests that keep inserting `google_id` directly** (about 60 files) are left
  as they are; the column stays nullable and unique. The identity model does
  not need them to change.

## Plan phase (2026-10-07)

- **No relaxations introduced by the plan.** New defaults are RBD-059-14 to
  RBD-059-24 in `clarifications-needed.md`.

- **Migration.** One file, `migrations/1799830000000_add-user-identities-and-signin-links.js`,
  above the latest `1799820000000` and the retired `1794000000000` phantom. Any
  later migration in the 058/059/060 campaign must be above `1799830000000`.

- **Merge order: 058 first, then 059.** Shared files and their conflict risk are
  tabled in `plan.md` ("Overlaps with 058"). The two medium-risk files are
  `server/auth/routes.js` (both edit the `/google` handler; 059's local-mode gate
  goes first in the handler, above 058's cookie lines) and
  `client/src/components/LoginPage.jsx` (058's legal-link condition must survive
  059's provider rendering). 059 makes no change to `server/auth/jwt.js`.

- **Deploy preconditions added by the plan.**
  1. `SQUIRE_MODE=team` is now carried by both `k8s/base/app-deployment.yaml`
     (RBD-059-15) and the aws-prod patch (RBD-059-11); a test pins both
     (`server/__tests__/deploy-mode-config.test.js`). Verify the boot log line
     `[Auth] Instance mode: team (providers: google)` after rollout.
  2. Count case-variant duplicate emails in production before rollout
     (RBD-059-17): `SELECT lower(email), count(*) FROM users GROUP BY 1 HAVING count(*) > 1`.

  3. Rolling-deploy window (RBD-059-24): a user created by a 059 pod who
     signs in again on a not-yet-replaced pre-059 pod during the same rollout
     gets `auth_failed` once (old code upserts on `google_id`, which is NULL
     for them, and hits the email constraint). It succeeds after the rollout.
     The opposite direction is closed by the migration's compatibility trigger.

- **Design-doc amendments owed in Squire, additions to the spec-phase list.**
  5. `design/self-hosting-local-mode.md`, "Owner and redemption details": the
     backfill maps faucet `dev-test-` subjects to the `dev` issuer (RBD-059-16),
     and a sign-in link to an existing user shows "Sign in as <name>" with a
     Continue click instead of redeeming on open (RBD-059-20).
  6. Same doc, "The squire CLI": `doctor` probes the server's `/ready` and
     treats owner presence and Redis as informational (RBD-059-23).
  7. Same doc, "Build sequence" paragraph on `google_id`: the migration adds a
     compatibility trigger that creates identities for rows written with
     `google_id` (RBD-059-24); the later cleanup drops it with the column.

- **Spec wording to reconcile at the next spec touch (not blocking).** US3
  scenario 2 says the claimed-instance page shows "only 'Signed in as
  <owner>' after redemption"; RBD-059-20 renders "Sign in as <owner>" with a
  Continue button and the post-redirect page shows the signed-in account.

## Orchestrator note (2026-10-07, from 059 analyze)

- Feature 060 must NOT ship the repository's `.env.example` as the self-host release asset: it sets `SQUIRE_MODE=team` for development (RBD-059-1), and a self-hosted install booting in team mode with no provider refuses to start. 060 needs its own self-host `.env.example` with local mode as the default.

## Implement phase (2026-10-07)

### 058 names confirmed against merged code (T001)

Implemented on `main` at 24d394fe (058 merged plus its review fixes). The
plan's names hold: `getInstanceConfig()` / `resolveInstanceConfig(env)` /
`_resetInstanceConfigForTests()` in `server/instance-config.js` (fields
`appUrl`, `dataDir`, `smtp`, `storageDriver`, `cookieSecure`), and
`resolveSecrets({ env, dataDir, generate, log })` in `server/boot/secrets.js`.
Differences: 058's review fixes removed `hostedInvalidValue` and made a
malformed `SQUIRE_HOSTED` a boot-time `ConfigError`; `SQUIRE_MODE` follows the
same rule (a bad value throws, never warns). The structured-logging console
shim (feature 014) is installed in every deployment, which changed how the
startup block is written (RBD-059-26).

### Baseline and final counts (T002, T072)

- Baseline on `main` before any change: server 292 suites, 5420 passed, 1
  skipped; client 80 suites, 988 passed.
- After 059: server 312 suites, 5595 passed, 1 skipped; client 85 suites,
  1020 passed; `npm run test:first-run` 31 of 31; `npm run build` clean.

### Regression set (T027)

Existing pins that pass before and after with no assertion change: 
`first-run-auto-issue.test.js`, `first-run-delegation-parity.test.js`,
`auto-approve.test.js`, `faucet-wipe.test.js`, `prod-reset.test.js`,
`invite-conversion.test.js`, `admin-auth-capture.test.js`,
`trust-proxy-invariant.test.js`, `server/auth/__tests__/routes.test.js`,
`client/src/pages/__tests__/AuthorizePage.test.jsx` (cases added only).

Changed, by diff review limited to the allowed kinds:
- `server/__tests__/integration/first-run.test.js`: the Google adapter mock
  returns the identity shape; `google_id` lookups and cleanup go through
  `user_identities.subject`.
- `server/__tests__/auth-return-to.test.js`: same two kinds of change.
- `server/auth/__tests__/users.test.js`: one assertion on `users.google_id`
  replaced by the identity row; new invariant cases appended.
- `server/auth/__tests__/auth-events.test.js`: the structural refresh test is
  extended (T022) and one `signin_link` case added; nothing removed.
- `server/__tests__/instance-config.test.js`, `google.test.js`: cases added.

### Relaxations accepted

- **Rolling-deploy transient (kept from RBD-059-24).** A user created by a 059
  pod who signs in on a not-yet-replaced pre-059 pod during the same rollout
  gets `auth_failed` once; it succeeds after the rollout.
- **`identity-regression.test.js` is after-only.** It asserts identity rows,
  which cannot exist before the migration. Its "before" counterpart is the set
  of unchanged pins above, which passed on the baseline and pass now.
- **The faucet's local-mode lockdown check flips `ENABLE_DEV_ENDPOINTS` per
  request** instead of reloading the router with `jest.isolateModules` (T055):
  the gate is evaluated per request (`devEndpointsEnabled`), so the result is
  the same.
- **Quickstart section 7 (image build) and the browser parts of sections 2, 3,
  and 6 were not run**: there is no Docker daemon in the pod and no browser
  session with Google. The Dockerfile change is two lines; the server, CLI, and
  HTTP flow were walked by hand (below).
- **The startup block bypasses the JSON log shim** (RBD-059-26). Log pipelines
  that expect JSON on every line would see five plain lines, but only from a
  local instance with no users; the hosted service never prints them.

### Quickstart walk (T073)

Walked sections 3 to 6 in the dev pod on a scratch database
(`collab_local_059`, dropped afterward) with a local-mode server on port 3911:
- Boot log: `[Auth] Instance mode: local (...)`, the Google
  configured-but-inactive line (the pod has Google credentials), and the claim
  block with one `http://localhost:3911/claim#<token>` line.
- `doctor --json`: `ok: true`, `owner.hasOwner: false`.
- `claim-link --name Sam --email sam@example.com`, peek (prefill returned),
  form redemption: 302 to `/d/<id>?welcome=1`, both cookies, non-Secure on
  `http://localhost`. Database: one user `t | signin_link | NULL`, one event
  `signup | signin_link`, owner recorded. The startup link then peeks
  `valid: false`. `GET /auth/google` is a 302 to `provider_disabled` with no
  `Set-Cookie`.
- Section 4: the flags-ignored message, case-insensitive `login-link`, exit 1
  and the next action for an unknown email, `mode`, and `token create` writing
  a 0600 file in a 0700 directory with a 30-day, read-and-write token.
- Section 5: `SQUIRE_MODE=teams` exits 1 naming both values; team mode with no
  provider and no faucet exits 1 with the FATAL line.
- Section 6: the same database in team mode logs `providers: google`, lists
  Google in `/auth/providers` with `hasOwner: true`, and the owner signs in by
  link (JSON mode) as an administrator.
- Not walked: the Google sign-in parts (no browser), and section 7.

### Deploy preconditions (in addition to the plan's)

1. Verify after rollout: the boot log shows `[Auth] Instance mode: team
   (providers: google)`. `kubectl kustomize k8s/overlays/aws-prod` renders one
   `SQUIRE_MODE=team` entry on the app container.
2. Run the case-variant email count (RBD-059-17) before rollout.
3. The migration runs in the migrate Job; it is one transaction and the
   backfill is one `INSERT ... SELECT`.
4. The minikube base pod and the dev pod pick up `SQUIRE_MODE=team` on their
   next apply or sandbox `up`; until then they run local mode (Google off).
   Never restart from inside the pod.

### Design amendments owed in Squire (additions to the earlier lists)

8. `design/self-hosting-local-mode.md`, D11: the startup block is printed
   before the server reports ready, as plain lines outside the JSON log
   (RBD-059-26).
9. Same doc, "The squire CLI": `doctor --json` carries a `failed` list
   (RBD-059-27).
10. Same doc, "Owner and redemption details": a claim takes the users lock
    before spending its link; a losing concurrent claim sees `link_invalid`
    (RBD-059-28).
(Items 5 to 7 from the plan phase, including RBD-059-16 and RBD-059-20, are
still owed.)

### Documentation owed (T069, T070; RBD-059-33)

`README.md`:
- Identity model: `user_identities` (issuer, subject), Google backfilled from
  `users.google_id` (now nullable, legacy, never written by new rows), the
  compatibility trigger, no linking by email (`account_exists`).
- `SQUIRE_MODE` (`local` default, `team`), the boot check and log lines, and
  the hosted overlay and base deployment setting `SQUIRE_MODE=team`.
- `GET /auth/providers`, `POST /auth/signin-link/peek`, `POST
  /auth/signin-link`, the `/claim` page, the startup claim block.
- The `squire` CLI: `doctor [--json]`, `claim-link`, `login-link`, `mode`,
  `token create`; `bin/squire.js`, on PATH in the image.
- Migration `1799830000000`; `signin_link` as a `signup_source` value.
- New modules: `server/auth/post-auth.js`, `providers.js`,
  `instance-owner.js`, `signin-links.js`, `signin-link-routes.js`,
  `dev-endpoints.js`, `server/cli/`.

`docs/dev.md`:
- Development runs in team mode (`SQUIRE_MODE=team` in both dev manifests and
  `.env.example`; Jest's setup defaults to it); the faucet's users are `dev`
  issuer identities.
- Run the CLI in the pod: `node bin/squire.js <command>`.
- Trying local mode: quickstart section 3 (scratch database, `SQUIRE_MODE=local`,
  a second port).
- Test helpers: `createFreshInstanceDb()` for zero-user suites and
  `server/__tests__/helpers/local-instance.js`.
