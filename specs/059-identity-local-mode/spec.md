# Feature Specification: Identity and Local Mode

**Feature Branch**: `059-identity-local-mode`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "059-identity-local-mode: build step 2 of design/self-hosting-local-mode.md (ratified by Sam 2026-10-07, D1 to D11). A `user_identities` table keyed by issuer and subject with Google rows backfilled, a provider registry and `GET /auth/providers`, `SQUIRE_MODE=local|team`, sign-in links and the `/claim` page, the startup-log claim link (D11), the in-container `squire` CLI, and the sign-in and consent pages rendered from the instance's providers. The hosted service keeps today's behavior."

## Ground truth and scope

The design document `design/self-hosting-local-mode.md` is ground truth for this feature (Constitution VI). Where it is silent, the proposed amendment in `design/authentication-and-sharing.md` ("Amendment (2026-10-07, proposed): sign-in providers and team mode") is used as the strongest available guidance and the choice is recorded in `clarifications-needed.md` as RATIFIED-BY-DEFAULT. Nothing is decided silently.

**In scope (the design's build step 2):**

- Identity model: `user_identities` keyed by (issuer, subject); Google identities backfilled from `users.google_id`; `users.google_id` becomes nullable and is kept for existing rows; user resolution goes through identities; the shared post-sign-in path accepts an already-resolved user so every sign-in method shares it.
- Regression parity for the hosted service: the feature 029 faucet, the feature 031 auto-issue gate, the feature 034 sign-up capture and auth-event trail, and pending-invite conversion behave exactly as today.
- A provider registry and `GET /auth/providers`; the sign-in page and the consent page render from it.
- `SQUIRE_MODE=local|team`, local by default (D1), with the boot-time refusal in team mode when no provider is configured.
- Sign-in links: the `signin_links` table, the `/claim#<token>` page, `POST /auth/signin-link`, owner creation on an unclaimed instance, sign-in on a claimed instance, the startup-log link (D11), local mode's closed sign-up, and the share dialog note.
- The in-container `squire` CLI: `doctor [--json]`, `claim-link`, `login-link --email`, `mode`, `token create --name`.

**Out of scope:**

- `compose.yml`, the `./squire` host wrapper, the GHCR image, `AGENTS.md`, the README section, the documentation page, the `onboard.md` self-host branch, and the CI job that plays the agent (feature 060).
- Generic OIDC, email and password sign-in, `SIGNUP_MODE`, `ALLOWED_EMAIL_DOMAINS`, invite links, linking and unlinking sign-in methods from Settings, the verified-email invite rule, `INIT_ADMIN_EMAIL`, and reimplementing Google as an OIDC preset (feature 061).
- `APP_URL`, the cookie `Secure` rule, generated secrets, the entrypoint, migrations on boot, local image storage, generic SMTP, `SQUIRE_HOSTED`, and the welcome template URLs (feature 058). This feature depends on 058 for `APP_URL`; see Dependencies.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Claim a fresh local instance from a terminal link (Priority: P1)

A developer (or their agent) has just booted a fresh instance in local mode. Nobody has an account. They run `squire claim-link --name "Sam" --email "sam@example.com"` inside the app container, open the printed link in a browser, see their name and email prefilled on the claim page, click Continue, and are signed in as the instance owner with the welcome document open. From then on the instance has exactly one account, and it is an administrator.

**Why this priority**: This is the step the whole self-hosting path exists for. Without it nobody can sign in to a self-hosted instance, because local mode has no other sign-in method.

**Independent Test**: Boot the server with `SQUIRE_MODE=local` against an empty database, run the CLI, open the link, submit the claim page, and observe a session, a welcome document, an `is_admin = true` user row, exactly one `auth_events` row, and a used link row.

**Acceptance Scenarios**:

1. **Given** a local-mode instance with zero users, **When** `squire claim-link --name N --email E` runs, **Then** it prints exactly one line containing `${APP_URL}/claim#<token>` and nothing else on that line, and a `signin_links` row exists holding only the SHA-256 hash of the token, a 15-minute expiry, the claim target, and the prefilled name and email.
2. **Given** the printed link, **When** the developer opens it, **Then** the claim page shows name and email fields prefilled from the CLI arguments and a Continue action, and no request so far has carried the token in a URL path or query string.
3. **Given** the claim page with valid fields, **When** the developer submits, **Then** an account is created with that name and email and `is_admin = true`, the session cookies are set, the link is marked used, one `auth_events` row with `event = signup` is written, and the browser lands on the seeded welcome document.
4. **Given** a link that has already been used, has expired, or whose token does not match any stored hash, **When** it is submitted, **Then** sign-in is refused with a message that says to run `squire claim-link` again, and no account is created.
5. **Given** the claim page submitted with an empty email or an empty name, **When** the developer submits, **Then** the page explains the missing field and nothing is created.
6. **Given** two claim links outstanding (for example the startup-log link and a CLI link), **When** one is redeemed, **Then** the other can no longer create an owner.

---

### User Story 2 - The hosted service keeps working exactly as today (Priority: P1)

A person signs in to squiredocs.com with Google, as they do today. New accounts are created, existing accounts are found, pending invites convert, sign-up capture and the auth-event trail are recorded, the first-run consent collapse still fires for a brand-new account created inside an `/authorize` round trip, and the dev faucet keeps serving the test suites. The sign-in page and the consent page look and read the same as before.

**Why this priority**: The hosted service runs from the same code. The design's fourth goal is that it has no behavior change. This story is the regression contract that the identity rewrite must satisfy.

**Independent Test**: Run the existing auth, first-run, faucet, auto-issue, invite-conversion, and auth-capture suites against the rewritten resolution path, plus a backfill test over a database seeded with pre-059 Google rows, and a snapshot comparison of the sign-in and consent pages in team mode with Google only.

**Acceptance Scenarios**:

1. **Given** a pre-059 database with users carrying `google_id`, **When** the migration runs, **Then** every such user has exactly one identity row with issuer `https://accounts.google.com` and subject equal to the old `google_id`, `users.google_id` is still populated for those rows, and no user row is modified otherwise.
2. **Given** an existing Google user, **When** they sign in, **Then** they are resolved by (issuer, subject), not by email, their `last_login_*` capture refreshes, exactly one `auth_events` row with `event = login` is written, and their `signup_*` columns are untouched.
3. **Given** a Google subject never seen before in team mode, **When** it signs in with no `/authorize` return path, **Then** a user is created with `signup_source = browser`, the signup capture pair is written once, one `auth_events` row with `event = signup` is written, pending document and space invites addressed to that email convert in one transaction, and the welcome document is seeded.
4. **Given** a Google subject never seen before, **When** it signs in inside a valid `/authorize` return path whose redirect URI is a localhost loopback, **Then** the account is created with `signup_source = agent_oauth`, the authorization code is minted inline exactly as feature 031 does today, and no welcome document is seeded.
5. **Given** an existing account, **When** it signs in inside an `/authorize` return path, **Then** it sees the explicit consent card and nothing is minted inline (the feature 031 gate still keys only off "created in this very round trip").
6. **Given** `ENABLE_DEV_ENDPOINTS=1` outside production, **When** the fixed, fresh JSON, and fresh browser faucet modes run, **Then** each produces the same session, provenance, welcome-document, and return-path behavior as today, with the synthetic user keyed by a `dev` issuer identity rather than by `google_id`.
7. **Given** team mode with only Google configured, **When** the sign-in page and the unauthenticated consent page render, **Then** the visible copy and controls are the same as today ("Sign in with Google" or "Sign up with Google" by route, "Continue with Google" on consent, the "Welcome Back" and "Get Started" headlines, the sign-up and sign-in footer links).

---

### User Story 3 - Sign back in on a claimed instance (Priority: P2)

A week later the owner's session has expired. They ask their agent for a new link, or run `./squire claim-link` themselves (the wrapper is feature 060; the in-container command is this feature). The link signs them straight in. Alternatively, an administrator on a team-mode instance recovers access for any existing user with `squire login-link --email`. On a fresh local instance that nobody has claimed, the startup log also prints a claim link, so `docker compose logs app` is enough to get in (D11).

**Why this priority**: The design's session model keeps the existing 7-day refresh cookie, so re-entry by link is a routine path, and the startup-log link is a ratified decision (D11).

**Independent Test**: On a claimed instance, mint a claim link and a login link, redeem each, and verify the session belongs to the expected user. Boot an unclaimed local instance and verify a marked block in the log carries a redeemable claim link; boot a claimed one and a team-mode one and verify the log carries none.

**Acceptance Scenarios**:

1. **Given** a claimed instance, **When** `squire claim-link --name X --email Y` runs, **Then** it prints a link, states that `--name` and `--email` are ignored because the instance already has an owner, and the link signs in the owner.
2. **Given** that link, **When** it is opened, **Then** the claim page shows no fields, only "Sign in as <owner name> (<owner email>)" and a Continue button (RBD-059-20); **When** Continue is clicked, **Then** the owner is signed in and lands in the app, and the owner's name and email are unchanged.
3. **Given** an existing user with email E, **When** `squire login-link --email E` runs and the link is redeemed, **Then** that user is signed in with exactly one `auth_events` row with `event = login`; **When** no user has email E, **Then** the CLI exits non-zero and says there is no account with that email and, if the instance is unclaimed, that `squire claim-link` creates the owner.
4. **Given** local mode and zero users, **When** startup finishes, **Then** the log contains a clearly marked block with one `${APP_URL}/claim#<token>` link that carries no prefilled name or email, and the claim page opens with empty fields.
5. **Given** an instance with at least one user, or any team-mode instance, **When** it starts, **Then** no sign-in link is logged.
6. **Given** the startup-log link expired before anyone clicked it, **When** the person runs `squire claim-link` or restarts the app container, **Then** a fresh link is available.
7. **Given** any sign-in link, **When** 15 minutes have passed since it was minted, **Then** redeeming it is refused.

---

### User Story 4 - The sign-in and consent pages reflect the instance (Priority: P2)

A person reaching a self-hosted local instance's sign-in page is told how to get in: run the claim command and open the link. There is no Google button and no sign-up copy. An agent that reaches the consent page without a session gets the same instruction. On the hosted service nothing changes.

**Why this priority**: Without this, a local-mode user sees a Google button that cannot work, and the consent page tells them to sign in with Google.

**Independent Test**: Render both pages against `GET /auth/providers` responses for local mode and for team mode with Google, and compare.

**Acceptance Scenarios**:

1. **Given** any mode, **When** `GET /auth/providers` is called without a session, **Then** it returns the mode, whether the instance has an owner, whether new accounts can be created by signing in, and the list of enabled providers with an id, a display label, and the path that starts sign-in, and it returns no secret material.
2. **Given** local mode, **When** the sign-in page renders, **Then** it shows an instruction to run `squire claim-link` (full form: `docker compose exec app squire claim-link`) and open the printed link, shows no provider button, no "Sign up" or "Don't have an account?" copy, and `/signup` renders the same as `/login`.
3. **Given** local mode and no session, **When** the consent page renders, **Then** it names the agent and the grant as today, replaces the Google action with the sign-in-link instruction, and tells the person to return to the agent's authorization after signing in.
4. **Given** team mode with Google, **When** both pages render, **Then** they match today's copy and controls (User Story 2, scenario 7).
5. **Given** the hosted service's provider list, **When** the page needs the provider start path, **Then** it uses the path the registry returned rather than a hardcoded `/auth/google`.
6. **Given** local mode, **When** a browser requests `GET /auth/google`, **Then** the response is a redirect to the sign-in page with an error code that says this provider is not enabled, and no cookies are set.

---

### User Story 5 - Mode governs who can sign in (Priority: P2)

An operator sets `SQUIRE_MODE`. Local mode (the default) admits only the owner by sign-in link and closes sign-up. Team mode with Google configured is today's hosted behavior. Team mode with no provider refuses to boot and names the variables to set. Moving a local instance to team mode is a configuration change and a restart; the owner and their documents carry over.

**Why this priority**: The mode switch is what keeps a local instance closed and what makes the hosted deployment behave as today.

**Independent Test**: Boot with each mode and provider combination and assert the boot outcome, the provider list, and the sign-up outcome of a never-seen identity.

**Acceptance Scenarios**:

1. **Given** `SQUIRE_MODE` unset, **When** the server boots, **Then** it runs in local mode and logs the mode on one line.
2. **Given** `SQUIRE_MODE=team` and `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set, **When** the server boots, **Then** Google is the only provider and sign-in, sign-up, and the pages behave as today.
3. **Given** `SQUIRE_MODE=team` and no provider configured, **When** the server boots, **Then** it exits non-zero before listening with an error that names `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (and, once feature 061 lands, the other provider variables).
4. **Given** a value of `SQUIRE_MODE` other than `local` or `team`, **When** the server boots, **Then** it exits non-zero naming the two valid values.
5. **Given** local mode with Google credentials also set, **When** the server boots, **Then** Google is not offered, and the boot log says the provider is configured but inactive in local mode.
6. **Given** local mode with an owner, **When** any path other than owner claim would create an account, **Then** it is refused; there is no route by which a second account can be created.
7. **Given** local mode, **When** the owner shares a document (or invites to a space) with an email that has no account, **Then** the pending invite is recorded as today and the dialog shows a note that invites cannot be redeemed until the instance moves to team mode.
8. **Given** a local instance with an owner and documents, **When** the operator sets `SQUIRE_MODE=team` with Google configured and restarts, **Then** the owner can still sign in by link, their documents are intact, and Google sign-in is offered.

---

### User Story 6 - The squire CLI reports and recovers (Priority: P3)

An agent runs `squire doctor --json` after boot and checks `ok: true`. A person runs `squire doctor` to see what is on and off, `squire mode` to see the mode and what changing it needs, and `squire token create --name "Claude Code"` on a machine with no browser to get an `sk_sqd_` token written to a file with mode 0600. Every CLI error names the next action.

**Why this priority**: `doctor` is step 3 of the try-out path and the machine-checkable success condition; the rest are recovery and headless paths.

**Independent Test**: Run each command against a running instance in both modes and against an unreachable database, and check output, exit code, file mode, and error text.

**Acceptance Scenarios**:

1. **Given** a healthy instance, **When** `squire doctor --json` runs, **Then** it prints one JSON document with `ok: true` and fields for database reachability, migration state (pending count), Redis state, mode, `APP_URL`, whether the instance has an owner, and which optional features are on (email, image storage driver, semantic search, assistant keys), and exits 0.
2. **Given** the database is unreachable, migrations are pending, team mode has no provider, or `APP_URL` is neither localhost nor https, **When** `squire doctor` runs, **Then** `ok` is false, each failing check carries a message naming the next action, and the exit code is non-zero.
3. **Given** no embedding key, **When** `squire doctor` runs, **Then** it reports semantic search as off with the reason, and this alone does not make `ok` false.
4. **Given** any mode, **When** `squire mode` runs, **Then** it prints the current mode and what switching to the other mode requires (the variable to set, the provider variables for team mode, and a restart).
5. **Given** a local instance with an owner, **When** `squire token create --name "Claude Code"` runs, **Then** an `sk_sqd_` token for the owner is written to a file with mode 0600, the token value is not printed, the output states the file path and the exact command to copy it out of the container, and the token appears in the owner's Settings list with that name.
6. **Given** team mode, **When** `squire token create --name N` runs without `--email`, **Then** it exits non-zero and says which user to name with `--email`.
7. **Given** a CLI command that cannot connect to the database, **When** it runs, **Then** the error names the connection variables and says to check that the database container is healthy.

---

### Edge Cases

- A Google identity that is unknown but whose email belongs to an existing account: refused with a message to sign in with the existing method; no duplicate account, no silent linking (RBD-059-3). Today this path fails with a generic error on the email uniqueness constraint, so this is a clearer refusal, not a new failure.
- Two first sign-ins for the same new identity at the same instant: exactly one account results and both requests either succeed or one retries; no duplicate users or identities.
- A claim link minted before the instance was claimed and redeemed after: refused, because every outstanding claim-kind link is voided when the owner is created.
- A claim submitted with an email that already belongs to a user on an instance that reports zero users cannot happen; the unclaimed check and the insert run in one transaction.
- The claim page opened without a fragment, or with a malformed one: shows the instruction to mint a link, never a server error.
- `squire claim-link` on a claimed instance whose owner cannot be determined (the record is absent and there is not exactly one administrator): exits non-zero and says to use `squire login-link --email`.
- The startup-log link on a multi-replica deployment: each replica would mint its own; this only happens in local mode with no owner, and every link is independently valid, so no replica holds correctness-bearing state (Constitution VII).
- `/auth/providers` on the hosted service is public and cacheable; it exposes only the mode, owner presence, sign-up openness, and provider labels and paths.
- A sign-in link redeemed from a different browser than the one that will use the session: allowed; the link proves control of the machine, not of a browser.
- The dev faucet in local mode: still creates synthetic users, because it is mounted only behind `ENABLE_DEV_ENDPOINTS=1` outside production and is a test fixture, not a sign-in method (RBD-059-1).
- Rate limiting: `POST /auth/signin-link` and the peek endpoint sit under the existing per-IP `/auth` limiter; a 256-bit token cannot be guessed inside any budget.

## Requirements *(mandatory)*

### Functional Requirements

**Identity model**

- **FR-001**: The system MUST store sign-in identities in a `user_identities` table where each row is one (issuer, subject) pair that belongs to exactly one user, the pair is unique, and rows are deleted with their user.
- **FR-002**: The migration MUST backfill one identity row per existing user that has a `google_id`, with issuer `https://accounts.google.com` and subject equal to `google_id`, and MUST make `users.google_id` nullable while keeping its uniqueness and its existing values.
- **FR-003**: New Google sign-ins MUST resolve and create users through `user_identities` only; `users.google_id` MUST NOT be written for new rows and MUST NOT be read by any sign-in path (RBD-059-2).
- **FR-004**: Sign-in MUST look up the (issuer, subject) pair and never match on email. When the pair is unknown and an account with the same email already exists, the sign-in MUST be refused with a message that says to sign in with the existing method, and MUST create neither a user nor an identity (RBD-059-3).
- **FR-005**: A first sign-in for an unknown pair MUST create the user and the identity atomically; two concurrent first sign-ins for the same pair MUST yield one user.
- **FR-006**: The identity row MUST record the provider's email-verified claim when the provider sends one (Google's `email_verified`); backfilled rows record unknown. No behavior keys off this value in 059 (RBD-059-8).
- **FR-007**: A returning identity MUST refresh the user's email, name, and picture from the provider exactly as the current upsert does, so hosted behavior is unchanged (a pre-existing side effect is recorded in `promotion-notes.md`).

**Shared post-sign-in path and regression parity**

- **FR-008**: The shared post-sign-in path (`completePostAuth`) MUST accept an already-resolved user together with its `isNew` flag, the validated client origin, the raw return path, and the capture context, and MUST be the single place that issues session cookies, writes the auth-event row, converts pending invites, notifies, decides the welcome document, and handles the return path.
- **FR-009**: Every sign-in method (Google, sign-in link, dev faucet) MUST produce exactly one `auth_events` row per completed sign-in, with `event = signup` when the account was created in that sign-in and `login` otherwise; token refresh MUST write none.
- **FR-010**: The signup capture pair (`signup_ip`, `signup_user_agent`) and `signup_source` MUST be written once at account creation and never overwritten; `last_login_ip`, `last_login_user_agent`, and `last_login_at` MUST refresh on every completed sign-in.
- **FR-011**: The feature 031 inline auto-issue MUST fire only when the account was created in this very round trip, the cookie-bound return path is a fully valid `/authorize` request, and the redirect URI is a localhost loopback; it MUST never fire for a sign-in link, which carries no return path (D2).
- **FR-012**: Pending document invites and space invites addressed to the signed-in user's email MUST convert in one transaction on every completed sign-in, never downgrading an existing role, and a conversion failure MUST NOT fail the sign-in.
- **FR-013**: The dev faucet (`POST /auth/dev-login`) MUST keep its three modes and their contracts, keyed by identities under a `dev` issuer instead of `google_id`, and MUST remain mounted only behind `ENABLE_DEV_ENDPOINTS=1` outside production.
- **FR-014**: `signup_source` on `users` and on `auth_events` MUST accept a new channel value `signin_link`, used for accounts created by a claim link and for sign-ins by link (RBD-059-6).

**Provider registry and pages**

- **FR-015**: The system MUST have one provider registry that lists the sign-in providers the instance offers. In 059 it knows Google (enabled in team mode when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set) and the dev faucet (counted only when dev endpoints are enabled outside production). It MUST be shaped so feature 061 can add providers without touching the pages.
- **FR-016**: `GET /auth/providers` MUST be unauthenticated and return the mode, whether the instance has an owner, whether signing in can create an account, and for each enabled provider an id, a label, and the start path, with no secret material.
- **FR-017**: The sign-in page MUST render its headline, buttons, and footer from the provider list. In team mode with Google only the rendered copy and controls MUST be identical to today's. In local mode it MUST show the sign-in-link instruction and no provider button or sign-up copy, on both `/login` and `/signup`.
- **FR-018**: The consent page's unauthenticated state MUST render its sign-in action and its lead sentence from the provider list, identical to today's in team mode with Google only, and MUST show the sign-in-link instruction in local mode (RBD-059-9).
- **FR-019**: In local mode, provider start paths that are not enabled (`GET /auth/google`) MUST redirect to the sign-in page with an error code and set no cookies.

**Instance mode**

- **FR-020**: `SQUIRE_MODE` MUST accept `local` and `team`; unset MUST mean `local` (D1); any other value MUST stop the boot with an error naming the valid values.
- **FR-021**: In team mode with no enabled provider the server MUST exit non-zero before listening, with an error naming the variables to set.
- **FR-022**: In local mode the only sign-in method MUST be the sign-in link; account creation MUST be possible only through owner claim (plus the dev faucet when enabled, RBD-059-1).
- **FR-023**: The boot log MUST state the mode and, in local mode, name any configured provider that is inactive because of the mode.
- **FR-024**: The share dialog and the space invite dialog MUST show, in local mode, that a pending invite cannot be redeemed until the instance moves to team mode; the invite MUST still be recorded (RBD-059-10).
- **FR-025**: The hosted production overlay MUST set `SQUIRE_MODE=team` in the same change, and the development overlays and `.env.example` MUST set `team` so development sign-in keeps working (RBD-059-1, RBD-059-11).

**Sign-in links**

- **FR-026**: A sign-in link MUST be minted from 32 random bytes; only the SHA-256 hash is stored, together with the kind (owner claim or sign-in for a user id), the prefilled name and email for a claim, the source (CLI or startup), the creation time, a 15-minute expiry, and `used_at` (D5).
- **FR-027**: The printed link MUST be `${APP_URL}/claim#<token>` with the token in the fragment; the token MUST never appear in a path, a query string, a server log, or a `Referer`.
- **FR-028**: The claim page MUST read the token from the fragment, ask the server (without consuming the token) what kind of link it is and what is prefilled, render fields for a claim on an unclaimed instance and no fields otherwise, and submit the token to `POST /auth/signin-link` (RBD-059-5).
- **FR-029**: `POST /auth/signin-link` MUST accept a token exactly once: it checks the hash, the expiry, and `used_at`, marks the row used in the same statement that reads it, then runs the shared post-sign-in path. A used, expired, or unknown token MUST be refused with a message that says to mint a new link.
- **FR-030**: On an unclaimed instance (zero users), redeeming a claim-kind link MUST create the owner with the submitted name and email, `is_admin = true`, and `signup_source = signin_link`, record the owner, and void every other outstanding claim-kind link, all in one transaction (RBD-059-4).
- **FR-031**: Email MUST be required and syntactically checked at claim; it MUST NOT be verified or emailed in local mode (D6). Name MUST be required.
- **FR-032**: On a claimed instance, `squire claim-link` MUST mint a sign-in link for the owner, ignore `--name` and `--email`, and say so; the owner is the recorded owner, or the single administrator when no record exists; otherwise the command MUST refuse and name `squire login-link --email` (RBD-059-4).
- **FR-033**: There MUST be no HTTP endpoint and no MCP tool that mints a sign-in link; the only minters are the CLI and the startup log.
- **FR-034**: Redeeming a link MUST issue the normal session cookies so the session is the same as any other sign-in, and the server MUST respond as a form post (redirect to the post-sign-in destination) or, when the client asks for JSON, with the session and user summary (RBD-059-5).
- **FR-035**: The endpoints under `/auth` that handle sign-in links MUST be covered by the existing per-IP `/auth` rate limit.

**Startup-log link (D11)**

- **FR-036**: When startup finishes in local mode and the instance has zero users, the server MUST mint one claim link (source `startup`, no prefill) and log it in a clearly marked block; it MUST mint none when a user exists or in team mode.
- **FR-037**: A startup link is subject to the same expiry, single use, and voiding rules as a CLI link.

**The squire CLI**

- **FR-038**: The image MUST provide a `squire` command on the container's PATH, runnable as `docker compose exec app squire <command>`, that uses the same database configuration as the server and loads the same generated secrets before touching server modules that check them at load time.
- **FR-039**: `squire doctor [--json]` MUST report database reachability, migration state, Redis state, mode, `APP_URL`, owner presence, and which optional features are on (email, image storage driver, semantic search, assistant keys), MUST exit non-zero when the instance cannot serve requests (database unreachable, pending migrations, team mode without a provider, `APP_URL` neither localhost nor https), and `--json` MUST print one JSON document with `ok` as a boolean.
- **FR-040**: `squire claim-link [--name N] [--email E]` MUST behave per FR-026 to FR-032 and print the link bare on its own line.
- **FR-041**: `squire login-link --email E` MUST mint a sign-in link for an existing user by email (case-insensitive) in either mode and refuse with a next action when no such user exists.
- **FR-042**: `squire mode` MUST print the current mode and what changing it requires.
- **FR-043**: `squire token create --name N [--email E] [--scopes S] [--expires-in D] [--out PATH] [--stdout]` MUST mint an `sk_sqd_` token through the existing token module (same caps, hashing, and Settings listing), for the owner by default in local mode and for `--email` in team mode, with default scopes read and write and a default expiry of 30 days, write it to a file with mode 0600 (default under the data directory), print the path and the copy-out command, and never print the token unless `--stdout` is given (RBD-059-7).
- **FR-044**: Every CLI error MUST name the next action, and every command MUST exit 0 on success and non-zero on failure.

**Security**

- **FR-045**: Owner creation by claim MUST be impossible once any user exists, by construction in the same transaction, so no network peer can become an administrator of a claimed instance.
- **FR-046**: Nothing in this feature MAY change the numeric `trust proxy` setting or trust localhost by request address (the design explains why).
- **FR-047**: New endpoints (`GET /auth/providers`, the link peek, `POST /auth/signin-link`) MUST expose no secret and no user list; the peek response MUST contain only the link kind, the prefilled fields, the expiry, and whether it is still valid.

### Key Entities

- **User identity**: one way a person proves who they are to a provider: an issuer (for example `https://accounts.google.com` or `dev`), the provider's subject id, the user it belongs to, the provider's email-verified claim if any, and when it was created and last used. A user may have several; the pair is unique.
- **Sign-in link**: a single-use, 15-minute proof of control of the machine: the hash of a random token, the kind (owner claim or sign-in for one user), the prefilled name and email for a claim, the source (CLI or startup), expiry, and when it was used.
- **Instance owner**: the first account on an instance, created by a claim link, an administrator; recorded so later claim links know whom to sign in.
- **Provider**: an enabled way to sign in, with an id, a label, and a start path; the registry decides enablement from the mode and configuration.
- **Instance mode**: `local` or `team`; decides which providers are active and whether signing in can create accounts.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a fresh local instance, a person goes from running the claim command to a signed-in session on the welcome document in one click, and the whole path is covered by an automated test that drives the CLI and the page.
- **SC-002**: Every existing backend and frontend test that exercises sign-in, first-run, the faucet, auto-issue, invite conversion, and auth capture passes with no change in asserted behavior, except for assertions that named `google_id` or the Google profile shape, which are updated to the identity shape.
- **SC-003**: The sign-in page and the unauthenticated consent page in team mode with Google only render byte-identical visible text and the same controls as before this feature, verified by a snapshot test.
- **SC-004**: A sign-in link is refused after 15 minutes, after one use, and after the instance is claimed, in 100 percent of attempts, verified by tests.
- **SC-005**: A pre-059 database migrates with one identity row per Google user and zero orphaned users, verified by a migration test seeded with legacy rows.
- **SC-006**: `squire doctor --json` answers in under 5 seconds on a healthy instance and its `ok` value matches `/ready`'s verdict.
- **SC-007**: In local mode no request from the network can create an account or sign in without a link minted inside the container, verified by tests that try the Google start path, the faucet (when disabled), and the claim endpoint with guessed tokens.
- **SC-008**: Every CLI failure message contains a concrete next action, verified by a test over the enumerated failure cases.

## Assumptions

- Feature 058 lands first and defines `APP_URL` (default `http://localhost:${SQUIRE_PORT}`), the generated-secrets loader, and the data directory. Until it merges, the link builder falls back to `CLIENT_URL`, and the CLI's secret loading is a no-op; the plan records the integration points.
- The welcome document is seeded for the owner on first sign-in because a claim carries no return path and the shared post-sign-in path falls through to onboarding, as today.
- Google remains implemented with `google-auth-library` in 059; feature 061 may reimplement it as an OIDC preset (A2). The registry is designed so that swap does not touch the pages.
- The admin page continues to display `signup_source`; the new `signin_link` value gets a label there.
- Tests that insert users directly with a `google_id` value keep working because the column stays; they are not rewritten in this feature.
- Session cookies, refresh rotation, logout, and `token_version` are unchanged.
- The hosted service sets `SQUIRE_MODE=team` through the production overlay committed with this feature; the deploy itself is a Sam operation.

## Dependencies and verification against the code

Claims in the design were checked against the code on 2026-10-07. Line numbers are from `main` at that date.

| Design claim | Verified at |
| --- | --- |
| `users.google_id` is `NOT NULL UNIQUE` | `migrations/003_create_users_table.js:14-18` |
| `findOrCreateUser` upserts `ON CONFLICT (google_id)` and refreshes email, name, picture | `server/auth/users.js:83-88` |
| Invite conversion runs on every sign-in, in one transaction, documents and spaces | `server/auth/users.js:129-168`, `server/spaces.js:547-566` |
| One `auth_events` row per completed sign-in is written by `updateLastLogin` | `server/auth/users.js:262-293`, `server/auth/auth-events.js:66-86` |
| `completePostAuth` takes a Google-shaped profile and owns provenance, cookies, auto-issue, welcome doc | `server/auth/routes.js:322-429` |
| The 031 gate keys off `user.isNew` and a localhost redirect | `server/auth/routes.js:371-414` |
| The dev faucet creates users with `googleId` `dev-test-user` and `dev-test-<nonce>` | `server/auth/routes.js:626-631`, `673-678` |
| `getClientUrl` returns `CLIENT_URL` in production | `server/auth/routes.js:51-54` |
| Google profile shape is `{googleId, email, name, picture}`; `email_verified` is not read | `server/auth/google.js:84-89` |
| Access token carries `picture` and `isAdmin` from the user row | `server/auth/jwt.js:52-58` |
| `signup_source` is CHECK-constrained to `browser` and `agent_oauth` on both tables | `migrations/1799300000000_add-signup-source-to-users.js:25-28`, `migrations/1799400000000_add-auth-ip-capture.js:87-92` |
| The first admin is a hardcoded email in a migration | `migrations/1773952482000_add-admin-and-last-login.js:14` |
| `trust proxy` is a numeric hop count | `server/index.js:175` |
| `/auth` is behind a per-IP limiter | `server/index.js:382`, `server/rate-limit.js:27` |
| Startup completion hook (where D11 runs) | `server/index.js:1722-1771` (`lifecycle.markInitialized`) |
| The SPA fallback serves unknown routes, so `/claim` can be a client route | `server/index.js:1670`, `client/src/App.jsx:34-42` |
| Sign-in page hardcodes the Google button and sign-up copy | `client/src/components/LoginPage.jsx:64, 76-88, 91-108` |
| Consent page hardcodes "with your Google Account" and "Continue with Google" to `/auth/google` | `client/src/pages/AuthorizePage.jsx:152-153, 178-180, 322-328` |
| `login()` hardcodes `/auth/google` | `client/src/contexts/AuthContext.jsx:207-219` |
| Share dialog reports "Invitation sent" with no mode awareness | `client/src/components/ShareDialog.jsx:152-153` |
| `sk_sqd_` tokens are SHA-256 hashed, capped at 250 per user, created by `createToken` | `server/mcp/auth/api-tokens.js:15-25, 58, 73` |
| Requiring the MCP auth modules throws in production without `MCP_JWT_SECRET` (so the CLI must load secrets first) | `server/mcp/auth/jwt.js:14-16`, `server/auth/jwt.js:9-16` |
| The image has no `squire` command and starts with `node server/index.js` | `Dockerfile` (CMD), `package.json` has no `bin` |
| Production `NODE_ENV` is set by an overlay patch (where `SQUIRE_MODE=team` goes) | `k8s/overlays/aws-prod/patches/app-node-env.yaml:34`, applied by `script/deploy-aws.sh:24` |
| Development overlays set `NODE_ENV=development` and `ENABLE_DEV_ENDPOINTS=1` | `k8s/overlays/minikube/app-dev.yaml:41-49`, `devcontainer/k8s/app-dev.yaml:63`, `.env.example:3, 16-18` |
| Migrations must be greater than `1795000000000` and the latest file `1799820000000` | `script/migrate.js:28-45`, `migrations/` listing |

**Readers of `google_id` and the Google profile shape that this feature must update** (everything else that mentions `google_id` only inserts fixture rows and keeps working because the column stays):

- `server/auth/users.js:62-99` (resolution), `server/auth/routes.js:322, 626, 673` (profile consumers), `server/auth/google.js:84-89` (shape producer).
- `server/auth/__tests__/users.test.js:50, 60-100` (asserts `google_id` and upsert-by-`googleId`), `server/auth/__tests__/routes.test.js:43-49, 166`, `server/auth/__tests__/google.test.js`.
- `server/__tests__/auth-return-to.test.js:24-40, 82, 197`, `server/__tests__/integration/first-run.test.js:17-21, 58, 71, 83-128`, `first-run-auto-issue.test.js:29`, `first-run-delegation-parity.test.js`, `auto-approve.test.js:98`, `faucet-wipe.test.js`, `prod-reset.test.js` (Google adapter mocks and `google_id` lookups).
- `client/src/pages/__tests__/AuthorizePage.test.jsx:40-58` (asserts the Google copy; stays valid in team mode and gains a local-mode case).
- `test/first-run/oauth-chain-driver.mjs:115-140` (faucet legs; the sign-in-link leg is feature 060).
- `server/__tests__/helpers/db.js:182` (`createTestUser` inserts a random `google_id`; keeps working, may be simplified).

**Design gaps flagged** (recorded with defaults in `clarifications-needed.md`): mode default versus existing development environments (RBD-059-1); whether new Google rows write `google_id` (RBD-059-2); the email-collision rule, which lives only in the unratified amendment (RBD-059-3); the definition of "unclaimed" and who "the owner" is on a claimed instance (RBD-059-4); the claim page's need to inspect a link before submitting and the response shape of `POST /auth/signin-link` (RBD-059-5); the `signup_source` domain (RBD-059-6); `squire token create` details, which the CLI section omits (RBD-059-7); `email_verified` recording (RBD-059-8); the consent page in local mode with no session (RBD-059-9); the space invite dialog (RBD-059-10); the hosted overlay change (RBD-059-11); link housekeeping (RBD-059-12); the CLI's packaging and secret loading (RBD-059-13).
