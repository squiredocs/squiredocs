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
