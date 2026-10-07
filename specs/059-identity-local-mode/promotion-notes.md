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
