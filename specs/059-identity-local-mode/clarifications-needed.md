# Clarifications Ledger: 059-identity-local-mode

Per Constitution VI, unanswered product decisions get the best default,
recorded here. Work never blocks on the maintainer, and nothing is decided
silently. All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-10-07)** unless later overturned.

Ground truth: `design/self-hosting-local-mode.md` (ratified, D1 to D11). Where
it is silent, the proposed amendment in `design/authentication-and-sharing.md`
(2026-10-07, not yet ratified: A1 to A5) is used as the strongest guidance and
the dependency on its ratification is noted.

---

## RBD-059-1 - Mode default versus the existing development and test environments

**Question**: D1 makes local mode the default when `SQUIRE_MODE` is unset. The
minikube and devcontainer overlays and `.env.example` set no mode, so after
this feature they would boot in local mode, which disables Google sign-in and
closes sign-up. The backend suites also exercise the faucet and the Google
callback without setting a mode. What happens to those environments, and does
the dev faucet count as a provider or respect local mode's closed sign-up?

**Why it matters**: A silent flip of the development pod to local mode would
remove the Google button from the dev sign-in page and make the first-run
test suites fail on "sign-up closed". Counting the faucet as a provider
decides whether a development server without Google credentials can boot in
team mode at all.

**Default chosen**: `SQUIRE_MODE` unset means `local`, exactly as D1 says. The
development overlays (`k8s/overlays/minikube/app-dev.yaml`,
`devcontainer/k8s/app-dev.yaml`) and `.env.example` set `SQUIRE_MODE=team`
in this feature. The dev faucet is a test fixture, not a sign-in method: it
stays mounted only behind `ENABLE_DEV_ENDPOINTS=1` outside production, it
works in both modes, it may create synthetic users in local mode, and it
counts as a configured provider for the team-mode boot check only when it is
mounted. The test suites that boot the auth router directly are unaffected
by the boot check; suites that assert mode behavior set the mode explicitly.

**Rationale**: D1 is ratified and the design's fresh-install story depends on
it. Making the default depend on which credentials happen to be set would be
an ad hoc third mode. The faucet is already a session-forgery primitive
behind a positive opt-in that the image never sets, so letting it bypass
local mode's closed sign-up adds no exposure. `docs/dev.md` must mention
`SQUIRE_MODE=team` for development; that edit is owed by the implement
phase (this spec agent may not edit it).

---

## RBD-059-2 - New Google rows do not write `users.google_id`

**Question**: The design keeps `google_id` "for the hosted service's existing
rows until a later cleanup" but does not say whether new Google sign-ins keep
writing it alongside the identity row.

**Why it matters**: Dual-writing keeps two sources of truth and the later
cleanup harder; not writing it means tests and tools that look users up by
`google_id` after a Google sign-in must change now.

**Default chosen**: Identities are the only lookup. New rows leave
`google_id` NULL; the backfill copies existing values into
`user_identities`; the column stays nullable and unique; no sign-in path
reads it. Tests that look up by `google_id` after driving the Google callback
switch to looking up by identity or email.

**Rationale**: The only readers of `google_id` outside tests are the upsert
this feature replaces (`server/auth/users.js:83-88`). One source of truth is
what makes the later cleanup a column drop with no code change.

---

## RBD-059-3 - Unknown identity with an existing email is refused, never linked

**Question**: What happens when a Google subject never seen before signs in
and an account with the same email already exists (for 059 this can happen
on the hosted service, and on a local instance moved to team mode whose owner
was created by a claim link with their Google email)?

**Why it matters**: Auto-linking by email is the Grafana CVE-2023-3128
pattern the amendment names. Refusing means the owner of a local instance
cannot use Google until feature 061 ships linking from Settings.

**Default chosen**: Refuse, exactly as the amendment's A1 proposes: no
duplicate account, no link, a sign-in page error that says to sign in with
the existing method and that linking a new method from Settings arrives with
team mode (feature 061). The error code is `account_exists`.

**Rationale**: Today this path already fails, on the email uniqueness
constraint with a generic `auth_failed`, so the refusal is a clearer message
rather than a new failure, and the hosted service's behavior does not get
weaker. A1 is proposed, not ratified; if Sam overturns A1 the default here
changes with it. Nothing in 059 should pre-empt that decision by linking.

---

## RBD-059-4 - "Unclaimed" means zero users; "the owner" is recorded at claim

**Question**: The self-hosting doc says a claim link "creates the owner" on an
unclaimed instance and "signs in the owner" on a claimed one, and `doctor`
reports "whether the instance has an owner". The amendment says `claim-link`
creates the owner "on an instance with no users, in either mode". Which
definition applies, and who is "the owner" on a database that predates this
feature or has several administrators (the hosted service, a development
database whose first user came from the faucet)?

**Why it matters**: The definition is the security boundary of owner
creation (FR-045), and the owner lookup decides whom `claim-link` signs in.

**Default chosen**: Unclaimed means the `users` table is empty, checked
inside the same transaction that creates the owner. The owner's user id is
recorded in `app_settings` under `instance_owner_user_id` when the claim
succeeds. On a claimed instance, `claim-link` signs in the recorded owner;
when no record exists it falls back to the single user with `is_admin =
true` if exactly one exists; otherwise it refuses and names
`squire login-link --email`. `doctor` reports `owner: true` when either
resolution succeeds.

**Rationale**: "Zero users" is the only definition that makes owner creation
impossible to race or re-trigger, and it is the amendment's wording. The
recorded owner survives later administrators being added in team mode. The
single-admin fallback covers the hosted service's history and a local
instance whose database was created by hand, without ever guessing between
several administrators.

---

## RBD-059-5 - Link inspection before submit, and the redeem response shape

**Question**: The design says the claim page "reads [the token] in the
browser and posts it to `POST /auth/signin-link`" and shows prefilled fields
on an unclaimed instance and "Signed in as <owner>" on a claimed one. The
page cannot know which to render, or what to prefill, without asking the
server, and the design defines only the consuming endpoint. It also says the
endpoint "runs the normal post-sign-in path (`completePostAuth`)", which
answers with a redirect today.

**Why it matters**: Without an inspection step the page would have to
consume the token to find out what it is, which breaks "shows the prefilled
name and email, they click Continue". The response shape decides whether a
browser form, a fetch call, and the feature 060 CI driver can all use the
endpoint.

**Default chosen**: A peek call (`POST /auth/signin-link/peek`, body
`{token}`) returns the link kind, the prefilled name and email, the expiry,
and whether it is still valid, and consumes nothing. Redemption is a
full-page form post to `POST /auth/signin-link` carrying the token and, for
a claim, the name and email, so the server's redirect lands the browser on
the welcome document or document list exactly as the Google callback does.
When the request asks for JSON (`Accept: application/json`), the endpoint
sets the same cookies and returns `{ok, user}` instead of redirecting, which
is the leg the 060 CI driver uses. Both endpoints sit under the existing
per-IP `/auth` limiter and the peek never counts as a use.

**Rationale**: Mirrors the faucet's browser mode, which already routes a
full-page POST through the shared path (`server/auth/routes.js:682-684`), so
cookie handling, return-path handling, and the welcome-document decision are
reused rather than duplicated. A peek does not weaken the token: it is 256
bits of entropy and the peek reveals only what the page is about to show.

---

## RBD-059-6 - `signup_source` gains the value `signin_link`

**Question**: `signup_source` on `users` and `auth_events` is CHECK-constrained
to `browser` and `agent_oauth` (feature 029 and 034). A sign-in link is a new
channel. Record it as `browser`, or add a value?

**Why it matters**: Feature 034's trail semantics say the column records the
channel of the event. Recording a link sign-in as `browser` would be a lie in
the abuse-signal trail; adding a value touches two CHECK constraints and the
admin page's label mapping.

**Default chosen**: Add `signin_link` to both CHECK domains in this feature's
migration. Owner creation stamps `users.signup_source = signin_link`; every
link redemption writes an `auth_events` row with `signup_source =
signin_link`. The admin adoption view gets a label for it.

**Rationale**: Honest channels are the point of the trail. The change is one
constraint rewrite per table in a migration this feature already adds.

---

## RBD-059-7 - `squire token create` defaults

**Question**: The design mentions `squire token create --name <agent>` only in
"Connecting the agent" ("writes an `sk_sqd_` token to a file with mode
0600"); the CLI section does not list it. Which user, which scopes, what
expiry, which file, and how does the token reach the host without passing
through a transcript?

**Why it matters**: The constitution requires API tokens to be scoped and
expiring; the channel rule says a token is bytes that never pass through the
conversation; and the file lives inside the container.

**Default chosen**: In local mode the token belongs to the owner; in team
mode `--email` is required. Scopes default to `documents:read` and
`documents:write`; `--scopes` narrows. Expiry defaults to 30 days;
`--expires-in` accepts a duration (for example `7d`, `24h`). The token is
minted through the existing `createToken` (same per-user cap, hashing, and
Settings listing; `minted_by` empty, so it reads as interactive). The file
defaults to `<data dir>/tokens/<slug-of-name>.token`, mode 0600, owned by
the app user; the command prints the path and the exact `docker compose cp
app:<path> ~/.squire/token` command, never the token. `--stdout` is the
explicit opt-in to print it, prefixed with the do-not-echo warning the MCP
mint tool already uses. `--out` overrides the path.

**Rationale**: Matches the headless fallback in `onboard.md` (`~/.squire/token`,
0600) and the agent-surface doc's channel rule. A 30-day expiry is long
enough for a headless agent and short enough to satisfy "expiring"; the
Settings UI already lets the owner revoke it.

---

## RBD-059-8 - `email_verified` is recorded on the identity, with no behavior yet

**Question**: The amendment says the OIDC `email_verified` claim "is
recorded" and the verified-email invite rule ships with feature 061. Should
059 record the claim now, and what do backfilled Google rows get?

**Why it matters**: Recording it now means 061 has data for every identity
created after 059; backfilling a value for legacy rows would fabricate a
fact.

**Default chosen**: `user_identities.email_verified` is a nullable boolean.
The Google provider records the ID token's `email_verified` claim on create
and refreshes it on each sign-in. Backfilled rows get NULL (unknown). No
behavior in 059 reads the column; invite conversion stays as today.

**Rationale**: Cheap now, impossible to backfill later (the same argument as
feature 029's provenance column). NULL for legacy rows is honest; 061
decides how to treat unknown.

---

## RBD-059-9 - The consent page in local mode with no session

**Question**: The design says the consent page is "rendered from the
instance's providers" and that in the try-out path the owner already has a
session when the agent's authorization opens. It does not say what the
unauthenticated consent page shows in local mode, or whether a sign-in link
can carry the `/authorize` return path.

**Why it matters**: An agent can open `/authorize` before its user has
claimed the instance. D2 keeps the claim link and the consent card separate.

**Default chosen**: In local mode the unauthenticated consent page keeps the
agent name, the grant, and the revocation line, replaces the provider action
with the sign-in-link instruction (`docker compose exec app squire
claim-link`, open the link), and says to return to the agent's authorization
afterwards (Claude Code re-opens it on the next tool call or `/mcp`). A
sign-in link carries no return path and never auto-issues (D2, FR-011).

**Rationale**: D2 is explicit that the two clicks stay separate until the
basic path ships. Carrying the `/authorize` parameters through a claim would
extend a security-reviewed gate, which D2 defers.

---

## RBD-059-10 - The space invite dialog gets the same local-mode note

**Question**: The design names only "the share dialog" for the note that
invites cannot be redeemed in local mode. Space invites go through a
different dialog and convert through the same path.

**Why it matters**: A space owner in local mode would otherwise see an
invite recorded with no hint that nobody can redeem it.

**Default chosen**: Both the document share dialog and the space settings
invite form show the note in local mode, driven by the mode from
`GET /auth/providers`. Invites are still recorded.

**Rationale**: Same mechanism, same user expectation; the design predates
feature 053's space invites.

---

## RBD-059-11 - The hosted overlay sets `SQUIRE_MODE=team` in this feature

**Question**: The design says "the hosted deployment sets team" but names no
file. If the image ships with local as the default and the production
overlay is not updated, the next deploy would disable Google sign-in on
squiredocs.com.

**Why it matters**: This is a deploy-gating outage risk.

**Default chosen**: `k8s/overlays/aws-prod/patches/app-node-env.yaml` gains
`SQUIRE_MODE=team` next to `NODE_ENV=production` in this feature's change
set, so `script/deploy-aws.sh` (which applies that overlay) carries it
automatically. The promotion notes record it as a deploy precondition, and
`squire doctor` and the boot log both print the mode so a wrong deploy is
visible immediately.

**Rationale**: "Verify claims against the actual flow": the deploy script
applies `k8s/overlays/aws-prod` (`script/deploy-aws.sh:24`), so the overlay is
the one place that makes the hosted mode automatic.

---

## RBD-059-12 - Sign-in link housekeeping

**Question**: The design does not say when used or expired `signin_links`
rows go away, or whether minting a new link affects older ones.

**Why it matters**: Unbounded growth is trivial here (links are minted by
hand), but a clear rule avoids a second retention job.

**Default chosen**: Minting a link deletes rows that expired or were used
more than 24 hours earlier. Minting never voids other outstanding links; the
only voiding event is a successful owner claim, which voids every other
claim-kind link (FR-030). Startup links are minted once per boot per
process; on a multi-replica deployment each link is independently valid.

**Rationale**: Piggybacking on the mint keeps the table small with no timer.
Voiding on claim is the one case where an outstanding link would otherwise
change meaning.

---

## RBD-059-13 - CLI packaging and secret loading

**Question**: The design says "the image ships a `squire` command" that "uses
the same database connection as the server" but does not say where it lives
or how it coexists with the production load-time secret checks in
`server/auth/jwt.js` and `server/mcp/auth/jwt.js`.

**Why it matters**: Requiring the token module from a CLI process that has
not loaded the 058 generated secrets throws in production. The Dockerfile is
also touched by 058 (entrypoint, `NODE_ENV`, `/data`), so the two features
must not fight over it.

**Default chosen**: The CLI is `bin/squire.js` in the repository, registered
as the `squire` bin in `package.json`, and symlinked onto the container PATH
by a one-line Dockerfile addition. It builds its database configuration with
`script/setup-db-env.js`, calls 058's secrets loader before requiring any
server module (a no-op when 058 is absent or the variables are already set),
and reads `APP_URL` with a fallback to `CLIENT_URL` until 058 merges.

**Rationale**: Reuses the pieces that already exist and keeps the Dockerfile
change small enough to merge cleanly after 058.
