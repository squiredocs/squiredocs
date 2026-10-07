# Clarifications Ledger: 058-self-host-config

Per Constitution VI, unanswered product decisions get the best default,
recorded here. Work never blocks on the maintainer, and nothing is decided
silently. All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-10-07)** unless later overturned.

Design ground truth: `design/self-hosting-local-mode.md` (ratified 2026-10-07).
Entries marked "refines design text" change nothing the design decides but
pick a mechanism or default the design leaves open or that the code shows
would regress production. Entries marked "found-in-spec" cover hosted-only
behavior or hardcoded hosts the design's lists missed.

---

## RBD-058-1 - APP_URL default chain

**Question**: The design says `APP_URL` defaults to
`http://localhost:${SQUIRE_PORT}`. `SQUIRE_PORT` is the compose-level host
port and the container does not see it unless the compose file passes it.
The hosted overlay today sets `CLIENT_URL` but no `APP_URL`. What is the
default when `APP_URL` is unset?

**Why it matters**: The cookie `Secure` flag now follows `APP_URL`'s scheme.
If the hosted deploy forgets `APP_URL`, a localhost default would silently
turn `Secure` off on squiredocs.com. And a self-host whose compose file does
not pass the port would advertise the wrong origin.

**Default chosen**: `APP_URL` resolves as: explicit `APP_URL`; else
`CLIENT_URL` when set; else `http://localhost:<SQUIRE_PORT, else PORT, else
3001>`. The value is normalized to an origin. The hosted overlay still sets
`APP_URL` explicitly (FR-036) so the chain is never load-bearing in
production. Feature 060's compose file passes `SQUIRE_PORT` into the
container or sets `APP_URL` directly.

**Rationale**: `CLIENT_URL` is already the configured public origin on every
existing deploy, so inheriting it cannot change their behavior. The localhost
fallback matches the design's intent for the bare container case. Refines
design text; suggested amendment: "compose passes `SQUIRE_PORT` through".

---

## RBD-058-2 - STORAGE_DRIVER default auto-detects a configured bucket

**Question**: The design says `STORAGE_DRIVER=local` is the default. The
hosted pods have no persistent `/data` and configure S3 through a secret.
Should an unset `STORAGE_DRIVER` mean `local` unconditionally?

**Why it matters**: An unconditional `local` default would move the hosted
service's image writes onto an ephemeral pod filesystem the moment the new
image deploys without the overlay change, losing every new image at the next
pod restart.

**Default chosen**: Unset resolves to `s3` when `S3_IMAGE_BUCKET` is set,
otherwise `local`. The hosted overlay sets `STORAGE_DRIVER=s3` explicitly
anyway (FR-036). An unknown value fails boot.

**Rationale**: A bare container has no bucket and gets `local`, which is what
the design wants. A deploy that already configured S3 keeps S3 even if the
overlay change is missed. Refines design text; suggested amendment: "local
by default when no bucket is configured".

---

## RBD-058-3 - What "signup AI credits off" means

**Question**: The design lists "signup AI credits" as hosted-only. The grant
is the `users.ai_credit_cents` column default (1000 cents), and the quota
check enforces it against shared-key usage. With the flag off, do new users
get zero credit (blocking the shared key) or is the allowance simply not
enforced?

**Why it matters**: The design says server-wide keys "come from the same
environment variables production uses" and that AI features degrade only
when no key is present. A self-hoster who sets `ANTHROPIC_API_KEY` would be
told "usage limit reached" after zero cents of credit, and would have to
grant themselves credit from the Admin page. That contradicts the zero-setup
goal.

**Default chosen**: When not hosted, shared-key usage is recorded but not
capped: the quota check reports allowed, the credit-limit admin email never
fires, and `/api/usage` marks the allowance as not applicable so the
Settings meter hides. The column default is untouched (no migration). Admin
page credit editing stays visible; it has no effect when not hosted and the
plan may label it.

**Rationale**: The operator owns the key and its bill; metering their own key
against a beta allowance is the hosted service's business rule, not a
product rule. This is the interpretation most likely to match "no external
accounts or keys are required to try it" without blocking the operator who
adds one. Sam may prefer the opposite (zero credit, admin grants); it is a
one-line change in the quota check either way.

---

## RBD-058-4 - How the client learns the hosted flag, and where the analytics tag lives

**Question**: The sign-in page, Settings, and Admin page need to know whether
the instance is hosted; the sign-in page renders before any authenticated
request, and `GET /api/client-config` requires auth. The analytics tag is
inline in `client/index.html`, so gating only the CSP leaves a blocked
script on every self-hosted page load. What mechanism?

**Why it matters**: A flicker (render hosted controls, then hide) or a
pre-auth race would make the gate unreliable, and a blocked analytics script
produces console errors and a failed request on every page view.

**Default chosen**: The server serves the application shell with a small
instance-configuration script injected (hosted flag only; no secrets) and
injects the analytics tag only when hosted. The analytics snippet is removed
from the static `index.html`. The static marketing pages keep their inline
tags because they are hosted-only in their entirety. `GET /api/client-config`
is unchanged.

**Rationale**: One mechanism solves both problems with no extra request and
no race, and the server already reads the shell from disk to serve it. The
client's existing `typeof gtag === 'function'` guards keep working. The plan
decides the exact injection point and caching.

---

## RBD-058-5 - Hosted-only pages return 404; the app shell owns `/`

**Question**: With the flag off, what do the hosted-only paths return, and
does the documentation site stay?

**Why it matters**: A self-hosted instance must not expose pricing, legal
text, or a blog written for squiredocs.com, but it must keep whatever the
product itself needs.

**Default chosen**: `/pricing`, `/about`, `/security`, `/blog`, `/blog/*`,
`/privacy`, `/terms` return 404 (plain, same as an unknown documentation
slug). `/` serves the application shell; the client's existing landing route
already sends a signed-out visitor to sign-in and a signed-in user to their
documents (feature 059 then changes what sign-in shows). `/documentation`
and `/agents.md` stay because they document the product, not the service.

**Rationale**: The design says "with it unset, `/` goes to the app's sign-in
or document list", which the shell already does. `/about` and `/security`
are static marketing pages the design's list omitted (found-in-spec). The
documentation site is referenced by the welcome document and by 060's
self-hosting page.

---

## RBD-058-6 - `/agents.md` is served with the instance origin (found-in-spec)

**Question**: `client/public/agents.md` hardcodes `https://squiredocs.com`
six times (connect one-liner, JSON config, OAuth endpoints, curl example),
and the welcome document links to it. The design's "text that names the
server" list does not include it. Rewrite at serve time, template at build
time, or leave it?

**Why it matters**: The try-out path ends with the agent reading the welcome
document, which points at `${APP_URL}/agents.md`. If that page tells the
agent to connect to squiredocs.com, the design's stated failure ("tells a
local agent to sync the developer's file to the hosted service") recurs one
link later.

**Default chosen**: The server serves `/agents.md` with the hosted origin
replaced by the request origin (falling back to `APP_URL`) when not hosted;
when hosted it is served verbatim. The repository file keeps the hosted
URLs so `server/__tests__/agents-md-claims.test.js` is untouched.

**Rationale**: Serve-time substitution is the smallest change that keeps a
single source file and the drift guard. The documentation pages under
`documentation/` (10 occurrences across three pages) are left to feature
060's documentation work and are flagged in the spec.

---

## RBD-058-7 - Chat attachments get a raw route too (found-in-spec)

**Question**: Chat attachments store and resolve bytes through the same S3
module (`server/api/chat-attachments.js`) with an ownership rule encoded in
the key. The design covers only document images. What happens to attachments
on the local driver?

**Why it matters**: Without a raw route, attaching an image in the assistant
on a self-hosted instance would return a URL nothing serves.

**Default chosen**: The storage interface (FR-015) is shared, and the
attachment resolve route returns the relative URL of a new raw route that
enforces the same ownership check before streaming bytes. Same cache header
as document images.

**Rationale**: Mirrors the design's chosen shape for document images (keep
the `{ url }` contract, add a raw route with the same access check) rather
than inventing a signed-URL scheme.

---

## RBD-058-8 - SMTP transport defaults and the SES default host

**Question**: The design names the generic variables and says the SES names
stay as aliases, but says nothing about port semantics, TLS mode, or the
existing SES default host (`email-smtp.us-west-2.amazonaws.com`), which the
hosted deploy relies on because it sets no host at all.

**Why it matters**: Production sets only `SES_SMTP_USER`, `SES_SMTP_PASS`,
and `SES_FROM_EMAIL`. If the SES default host disappears, production email
breaks on deploy. A fixed port 465 with implicit TLS does not fit most
self-hosted relays.

**Default chosen**: `SMTP_PORT` defaults to 465; port 465 uses implicit TLS,
any other port uses STARTTLS; `SMTP_SECURE=true|false` overrides. Generic
names win over aliases. The SES default host applies only when the host is
unset and the configuration arrived through the SES aliases. No sender set
logs one boot line and skips silently afterward.

**Rationale**: Byte-identical transport for the hosted deploy with zero new
variables; standard port semantics for everyone else.

---

## RBD-058-9 - Data directory override and secrets file handling

**Question**: The design fixes `/data`. Tests and non-container runs cannot
write there. How is the location chosen, and what happens on a corrupt file?

**Why it matters**: The entrypoint and the local driver need unit and
integration tests that do not touch `/data`; a corrupt secrets file must not
be regenerated because a new encryption key makes every stored BYOK key
unreadable.

**Default chosen**: `SQUIRE_DATA_DIR` (default `/data`) is the root for
`secrets.json` and `images/`. The file is written atomically (temp file plus
rename) with mode 0600, only when at least one value was generated, and only
the missing values are added. An unparseable file stops boot naming the
file. The environment always wins and is never written to the file.

**Rationale**: One override keeps the design's path as the container default
while making the code testable. Refusing to regenerate protects the stored
keys the design itself warns about ("losing the volume loses the encryption
key").

---

## RBD-058-10 - Migration lock and connection retry behavior

**Question**: The design requires an advisory lock so concurrent replicas run
migrations once. What key, does a waiter block or fail, and what if Postgres
is not up yet?

**Why it matters**: The compose file waits on Postgres health, but Kubernetes
and bare `docker run` do not, and a crash loop on first boot is the worst
first impression for the try-out path.

**Default chosen**: A fixed application-level advisory lock key (a named
constant). The waiter blocks on the lock with no timeout (the orchestrator's
own wait bounds it). The initial connection retries with backoff for up to
60 seconds, then exits non-zero. A migration error exits non-zero without
starting the server.

**Rationale**: Blocking is correct because the holder is doing the work the
waiter would otherwise do; failing fast on an unreachable database lets the
orchestrator restart with a clear log instead of booting a server that
cannot serve.

---

## RBD-058-11 - Which admin emails are hosted-only

**Question**: The design names "admin sign-up and login notification emails"
as hosted-only. `server/email.js` also sends credit-limit, support-request,
share, space, exception, and beta welcome emails.

**Why it matters**: Gating too much removes product features from
self-hosters; gating too little makes a self-hosted instance behave like a
beta service.

**Default chosen**: Hosted-only: new-user and login notifications, the beta
welcome email (its endpoint 404s), and the credit-limit notification (which
cannot fire when credits are not enforced, RBD-058-3). Unchanged:
support-request and exception emails (operator opt-in via `ADMIN_EMAIL`),
share and space emails (product features).

**Rationale**: Follows the design's list exactly and classifies the rest by
whether the operator chose them.

---

## RBD-058-12 - Additional hosted-only items (found-in-spec)

**Question**: The code review found hosted-only behavior the design does not
list: the `/about` and `/security` static pages, the old-domain 301 redirect
(herodocs.xyz, heradocs.com), the OpenRouter `HTTP-Referer` header, the
Settings page's public-beta usage note with `contact@squiredocs.com`, the
usage meter, the Admin page's welcome-email and self-test controls, and the
sign-in page's privacy and terms links. Gate them?

**Why it matters**: Each one either advertises the hosted service or points
a self-hoster at it.

**Default chosen**: All gated or re-pointed: pages 404 (RBD-058-5), redirect
not mounted, referer header uses `APP_URL`, beta note and meter hidden,
Admin controls hidden with their endpoints 404, legal links hidden. The
sign-in page is otherwise unchanged; feature 059 re-renders it from
providers.

**Rationale**: Consistent with D8 (hosted code stays in the repository behind
the flag) and the design's own principle for server-naming text.

---

## RBD-058-13 - Plain http on a non-localhost APP_URL

**Question**: The design says serving plain HTTP on any address other than
localhost is not supported and that `squire doctor` (059) reports it. What
does the server itself do in 058?

**Why it matters**: The cookie flag follows the scheme, so an `http://` host
address gives non-Secure cookies on a network-reachable instance; the CSP's
`upgrade-insecure-requests` already breaks such a setup in the browser.

**Default chosen**: Follow the scheme as designed and log one boot-time
warning in production when the scheme is http and the host is not
localhost or loopback. No refusal.

**Rationale**: Refusing would break development-like setups the design does
not forbid, and 059's doctor is the designed reporting surface.

---

## RBD-058-14 - Raw route URL form and caching

**Question**: The design says the resolve route returns "the URL of a new
route". Absolute or relative, and with what cache policy?

**Why it matters**: An absolute URL built from `APP_URL` breaks when the
browser reached the instance through a different origin (a proxy or a LAN
address during development); S3 presigned URLs are valid for an hour today.

**Default chosen**: Relative path (`/api/docs/:docId/images/:imageId/raw`),
`Cache-Control: private, max-age=3600`, content type from the stored row.
The resolve response keeps `Cache-Control: no-store`.

**Rationale**: Same-origin relative URLs need no configuration and send the
session cookie automatically; one hour matches the presigned TTL.

---

## RBD-058-15 - NODE_ENV in the Dockerfile reaches the minikube base pod

**Question**: Setting `NODE_ENV=production` in the image also changes the
minikube `collab-app` base pod, which today runs with it unset (the overlay
note says base carries no `NODE_ENV`). Is that acceptable?

**Why it matters**: In production mode the pod refuses weak or missing
secrets. If `k8s/auth.env` holds placeholder values, the minikube pod will
crash-loop after the rebuild.

**Default chosen**: Accept the change (it removes the warning the design
cites), and record a verification item: before rebuilding, confirm the
minikube secrets are strong, non-default values; set
`MIGRATE_ON_BOOT=false` in the minikube overlay if the double migration
(boot plus Job) is unwanted. The `app-dev` pod keeps `NODE_ENV=development`
through its own env.

**Rationale**: The image must be production-safe by default; the dev cluster
should look like production anyway.

---

## RBD-058-16 - One configuration module; PUBLIC_ORIGIN follows APP_URL

**Question**: Where are `APP_URL`, the hosted flag, the driver, and the data
directory resolved, and does `server/url.js`'s `PUBLIC_ORIGIN` (default
`https://squiredocs.com`) change?

**Why it matters**: `process.env` reads scattered across modules are how the
`NODE_ENV` unset incident happened; `PUBLIC_ORIGIN` is only consulted when
the request host matches a hosted alias, so it is harmless on a self-host,
but two notions of "the public origin" invite drift.

**Default chosen**: One module resolves instance configuration once at load
and exports it; every consumer imports from it. `PUBLIC_ORIGIN` defaults to
`APP_URL` when unset; the alias mapping and the request-origin fallback in
`server/url.js` are otherwise unchanged. The welcome template (seeded outside
a request) uses `APP_URL`; MCP tools use the request origin and fall back to
`APP_URL`.

**Rationale**: Matches the design's "built from the request's origin or
`APP_URL`" wording and makes the hosted alias mapping agree with the
configured origin without a new variable.

---

## RBD-058-17 - Which secrets are generated

**Question**: The design names four generated secrets. The Kubernetes
manifests also pass `MCP_REFRESH_SECRET` and `MCP_AUTH_CODE_SECRET`, and the
README mentions `JWT_SECRET`. Generate those too?

**Why it matters**: Generating unused values adds noise to the secrets file;
missing a used one crashes the boot the feature exists to make work.

**Default chosen**: Exactly the four in the design. `MCP_REFRESH_SECRET`,
`MCP_AUTH_CODE_SECRET`, and `JWT_SECRET` are not read by any server code
(verified with `git grep` on 2026-10-07; they appear only in
`script/generate-mcp-secrets.sh`, the manifests, and the README) and are
not generated. The README's variable list is corrected in the
implementation phase (Constitution I).

**Rationale**: The design's list is complete for the code as it stands.

---

# Plan-phase entries (2026-10-07)

Added by the 058 plan agent. All **RATIFIED-BY-DEFAULT (Sam
pre-authorized, 2026-10-07)**. Technical reasoning is in `research.md`.

---

## RBD-058-18 - APP_URL chain follows the amended design (drops SQUIRE_PORT)

**Question**: RBD-058-1 and FR-009 default `APP_URL` to
`http://localhost:<SQUIRE_PORT, else PORT, else 3001>`. The design, amended
the same day, says "defaults to `CLIENT_URL` if set, else
`http://localhost:<PORT>`" and has `compose.yml` pass `APP_URL` explicitly.
Which wins?

**Default chosen**: The design (Constitution VI). Chain: `APP_URL`, else
`CLIENT_URL`, else `http://localhost:<PORT or 3001>`. `SQUIRE_PORT` is not read
inside the container.

**Rationale**: The design's later text supersedes the spec's; `SQUIRE_PORT` is a
host-side compose variable and reading it inside the container would only ever
pick up a value set by mistake. Spec FR-009 and RBD-058-1 need a sync edit.

---

## RBD-058-19 - Storage facade replaces `server/s3-images.js`

**Question**: Keep `server/s3-images.js` as the facade name, or introduce a new
module?

**Default chosen**: New facade `server/image-storage/index.js` with
`s3-driver.js` (today's module moved) and `local-driver.js`. The old file is
deleted, all eight consumers and the 13 `jest.mock` paths move in one task, and
`server/__tests__/setup.js` points `SQUIRE_DATA_DIR` at a per-worker temp
directory so a missed mock can never write to `/data` or to another worker's
files.

**Rationale**: The facade carries every self-hoster's images; a name that says
S3 would mislead every future reader. Deleting the old path makes a missed
require fail loudly.

---

## RBD-058-20 - Raw routes accept the session cookie

**Question**: `requireAuth` reads only the `Authorization` header, but an
`<img src>` sends cookies only. How does the raw route authenticate a browser?

**Default chosen**: New `requireAuthOrCookie`: the header path is identical to
`requireAuth`; without a header it verifies the `accessToken` cookie through
`permissions.extractUser`, as the WebSocket upgrade already does. Used only on
the two raw routes.

**Rationale**: The cookie already exists, is `httpOnly`, `SameSite=Strict` in
production, and is accepted by the WebSocket path. Query-string tokens would
leak into logs and `Referer`; a signed-URL scheme is new machinery the design
did not ask for.

---

## RBD-058-21 - `readObject` and content type for the local driver

**Question**: Chat attachments have no database row holding their content type,
and `getObject` returns bytes only. How does the attachment raw route know what
to send?

**Default chosen**: Both drivers gain `readObject(key) -> { body, contentType }`
and a `kind` property. The local driver stores the content type in
`images/meta/<key>.json`. Raw routes stream only allow-listed image types and
set `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; sandbox`.

**Rationale**: Smallest addition that keeps the interface driver-neutral; the
headers keep a same-origin byte route from ever executing stored content
(Constitution V).

---

## RBD-058-22 - Welcome document beta-credit sentence is hosted-only (found-in-plan)

**Question**: The welcome template's "About Squire Docs" paragraph says it "is
currently in free public beta, including a $10 AI credit allotment for new
users". FR-034 gates only the support paragraph.

**Default chosen**: That sentence is included only when hosted; the rest of the
paragraph stays.

**Rationale**: A self-hosted instance has no beta and, per RBD-058-3, no credit
allotment. Same principle as RBD-058-12.

---

## RBD-058-23 - Admin sign-up and login emails are gated inside `server/email.js`

**Question**: Gate at the call site in `completePostAuth` or in the email
functions?

**Default chosen**: `notifyNewUser` and `notifyLogin` return early when not
hosted. `server/auth/routes.js` is not touched for this.

**Rationale**: Feature 059 rewrites `completePostAuth`; keeping 058 out of it
avoids a merge conflict and keeps the gate next to the other email rules.

---

## RBD-058-24 - Boot migration lock key and scope

**Question**: Which advisory lock key, and what does it cover?

**Default chosen**: A named constant distinct from node-pg-migrate's internal
key `7241865325823964`, held on the entrypoint's own connection around the
whole `script/migrate.js` child process, including its `pgmigrations` dedupe
pre-step.

**Rationale**: node-pg-migrate takes its own lock on a separate connection in
the child; the same key would make the child wait forever on its parent. The
dedupe pre-step runs outside node-pg-migrate's lock today, so wrapping the
whole script is what makes concurrent boots safe.

---

## RBD-058-25 - Entrypoint environment hygiene

**Question**: Should the entrypoint load `.env`, and may it set
`DATABASE_URL` for the server?

**Default chosen**: The entrypoint calls `dotenv` first, so a `.env` value
beats the secrets file. It never writes `DATABASE_URL` into the server's
environment; it builds its own connection for the lock and lets the migrate
child build its URL as the Kubernetes Job does.

**Rationale**: dotenv does not override existing variables, so loading it after
the secrets file would invert the "environment wins" rule for `.env` users.
`script/setup-db-env.js` does not URL-encode the password; exporting its URL to
the server could break a password the server's object config handles today.

---

## RBD-058-26 - No generated encryption key during a keyring rotation

**Question**: Should the entrypoint generate `API_KEY_ENCRYPTION_KEY` when
`API_KEY_ENCRYPTION_KEYS` (the rotation keyring) is set?

**Default chosen**: No. With `API_KEY_ENCRYPTION_KEYS` set, the entrypoint
neither reads nor generates `API_KEY_ENCRYPTION_KEY`; `server/crypto.js`'s own
checks decide.

**Rationale**: An operator rotating keys has chosen them explicitly. A
generated legacy key would turn a clear "key must be set" error into a silent
wrong-key decrypt failure for untagged values.

---

## RBD-058-27 - Static-file variants of hosted pages and the raw shell

**Question**: `express.static` serves `/landing.html`, `/pricing.html`,
`/about.html`, `/security.html`, the root blog assets, and `/index.html`
directly. Do those stay reachable when not hosted?

**Default chosen**: Not hosted: those paths return 404. In every mode
`express.static` runs with `index: false`, and `/index.html` is routed to the
injected shell, so no path serves the un-injected file.

**Rationale**: Otherwise the hosted pages leak through their file names, and
`/index.html` would bypass the instance-config injection.

---

## RBD-058-28 - Development keeps mirroring the hosted service

**Question**: With `SQUIRE_HOSTED` off by default, the Vite dev server and the
app-dev pod would stop showing the landing page and analytics. Is that wanted?

**Default chosen**: The Vite config injects the shell through the same server
helper and gates its marketing-page plugin on `SQUIRE_HOSTED`. The app-dev pod
(`k8s/overlays/minikube/app-dev.yaml` and `devcontainer/k8s/app-dev.yaml`)
and the minikube `collab-app` set `SQUIRE_HOSTED=true` (the latter also
`MIGRATE_ON_BOOT=false`). The test setup unsets `SQUIRE_HOSTED`, so suites are
deterministic whatever the pod sets.

**Rationale**: The dev cluster exists to look like production; flipping one
variable exercises the self-host path.

---

## RBD-058-29 - Hosted-only routes are skipped per request

**Question**: FR-028 requires the gated endpoints to be indistinguishable from
unknown routes. Register them conditionally at load, or gate per request?

**Default chosen**: A `hostedOnly` middleware placed first on each gated route
calls `next('route')` when not hosted, so Express falls through exactly as for
an unregistered path.

**Rationale**: Same external behavior as conditional registration, and tests
can toggle the flag without reloading the router modules.

---

## RBD-058-30 - Development default for CLIENT_URL

**Question**: Today `CLIENT_URL` falls back to `http://localhost:5173`. With
the new chain and neither `APP_URL` nor `CLIENT_URL` set, it becomes
`http://localhost:3001`. Keep the Vite port as a special case?

**Default chosen**: No special case. `.env.example` keeps
`CLIENT_URL=http://localhost:5173` for development, the CORS allow-list keeps
both localhost origins, and development `getClientUrl` still prefers the
request's `Origin` or `Referer`.

**Rationale**: A production-safe default matters more than a dev convenience
that `.env` already provides.

---

## RBD-058-31 - Generated secrets and local images with more than one replica

**Question**: Constitution VII forbids single-replica preconditions. Generated
secrets and local image bytes live on the data volume. What happens with two
replicas?

**Default chosen**: Replicas are correct when they share `SQUIRE_DATA_DIR` (one
volume) or when secrets come from the environment and images from
`STORAGE_DRIVER=s3`, which is the hosted service's configuration. First-boot
secret creation publishes the file with an exclusive link, so two replicas
racing on a shared empty volume adopt one set of values. Per-replica private
volumes are a misconfiguration; README says so. The design's non-goal (no
documented multi-replica self-host) stands.

**Rationale**: Keeps correctness in shared infrastructure (the volume or S3),
never in one process, and closes the only race the shared-volume case had.

---

## RBD-058-32 - The entrypoint starts telemetry before anything else (found-in-plan)

**Question**: `server/index.js` starts OpenTelemetry as its first statement
because the require hooks only instrument modules loaded afterward. The
entrypoint now runs before it and loads `pg` for the migration lock. Does that
silently drop Postgres tracing?

**Default chosen**: The entrypoint calls `server/telemetry.js` `start()` right
after loading `.env`; `start()` is idempotent, so the existing call in
`server/index.js` becomes a no-op. `server/boot/migrate-lock.js` requires `pg`
inside the function, so a hosted boot with `MIGRATE_ON_BOOT=false` never loads
it early anyway.

**Rationale**: Keeps feature 014's "telemetry first" invariant true for every
boot path; the hosted service's traces and structured boot logs are unchanged.

---

# Implementation-phase entries (RBD-058-33 onward)

All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-10-07)**.
Recorded by the 058 implementer; each is a deviation from or refinement of
plan.md/tasks.md found while building.

---

## RBD-058-33 - Test setup also drops S3_IMAGE_BUCKET and SES_* (found-in-implementation)

**Question**: T001 deletes `STORAGE_DRIVER` and `SMTP_*` from the test
environment. The app-dev pod also carries real `S3_IMAGE_BUCKET`, AWS keys, and
`SES_*` credentials. With the bucket set, `STORAGE_DRIVER` auto-detects `s3`,
so an unmocked suite would write to a real bucket; with `SES_*` set, email is
configured through the aliases.

**Default chosen**: `server/__tests__/setup.js` also deletes `S3_IMAGE_BUCKET`,
`SES_SMTP_HOST`, `SES_SMTP_USER`, `SES_SMTP_PASS`, `SES_FROM_EMAIL`. A suite
that wants either sets it explicitly. AWS keys and `ADMIN_EMAIL` are left
alone (nothing selects a driver or a transport from them alone).

**Rationale**: Makes the plan's stated risk mitigation ("the app-dev pod's S3
vars ignored unless a suite opts in") actually true.

## RBD-058-34 - Per-worker data dir cleanup uses afterAll, not process.on('exit')

**Default chosen**: setup.js registers `afterAll(() => rmSync(...))`. Jest hands
each test file a fresh process proxy, so an exit listener per file would pile
up (MaxListeners) in a worker; files in a worker run serially and the next
file's setup recreates the directory.

## RBD-058-35 - No recursive mkdir in boot and the local driver (found-in-implementation)

**Finding**: `fs.mkdirSync(dir, { recursive: true })` spins forever at 100% CPU
for a path under `/proc` (Node 22), so a misconfigured `SQUIRE_DATA_DIR` would
hang boot instead of failing.

**Default chosen**: `server/fs-ensure-dir.js` creates parents one level at a
time; `server/boot/secrets.js` and the local driver use it. A bad data dir
fails with the named-directory message.

## RBD-058-36 - Boot migration runner puts node_modules/.bin on PATH

**Finding**: `script/migrate.js` runs `execSync('node-pg-migrate up')`, which
works under `npm run migrate` (npm adds `node_modules/.bin` to PATH) but not
when the entrypoint spawns `node script/migrate.js` directly in the image.

**Default chosen**: `defaultRunMigrate` prepends `<repo>/node_modules/.bin` to
the child's PATH. `script/migrate.js` is unchanged, so the Kubernetes Job is
unaffected. Verified by running `node script/entrypoint.js` against an empty
per-agent database (52 migrations applied).

## RBD-058-37 - Boot migration lock key value

**Default chosen**: `MIGRATE_LOCK_KEY = 3728990676630059578`, the first 8
bytes of sha256("squire-docs:boot-migrate") as a signed int64; a test asserts it
differs from node-pg-migrate's `7241865325823964`.

## RBD-058-38 - Raw-route cookie path accepts what the WebSocket cookie path accepts

**Default chosen**: `requireAuthOrCookie` verifies the `accessToken` cookie
with `permissions.extractUser({ queryToken })`, exactly as the WebSocket
upgrade does (research R8). That call also accepts agent JWTs and API tokens;
the cookie only ever carries a user session JWT in practice, and scoped
principals still face the `documents:read` check. A present but bad
Authorization header is a 401 and never falls back to the cookie. The chat
attachments router imports the middleware from `server/auth/middleware.js`
rather than the `server/auth` barrel, so suites that stub the barrel's
`requireAuth` keep loading. The chat raw route checks the reference before the
storage check (400 before 503).

## RBD-058-39 - Two small test seams instead of route mirrors

**Default chosen**: document deletion's byte cleanup moved into
`documentImages.deleteImageBytesForDoc(docId)` (called by `server/index.js`), and
`collectBundleAssets` is exported from `server/api/docs-export.js`, so the
local-driver coverage for deletion and bundle export (T034) exercises the
production functions. T034's cases live in one new suite,
`server/__tests__/image-storage-local-paths.test.js`, and T033's local cases in
`server/__tests__/chat-attachments-local.test.js`, because the existing suites
mock the storage module file-wide.

## RBD-058-40 - Empty-database and concurrent-boot migration covered by an automated test

**Default chosen**: `server/__tests__/migrate-lock.test.js` creates a scratch
database named `<worker db>_boot` (derived from the per-run base, so private to
the run and worker), runs two concurrent `runMigrationsWithLock` calls with the
real `script/migrate.js` runner, asserts the runs never overlap and every
migration row exists exactly once, then drops it. About 4 s. Quickstart steps
for the image remain owed (Docker).

## RBD-058-41 - Documentation pages still embed the Google tag (found-in-implementation)

**Finding**: `client/scripts/render-documentation.mjs` puts the Google tag in
every `/documentation` page, which a self-hosted instance serves. The
self-hosted CSP blocks the script, so nothing is sent, but the browser logs a
CSP violation.

**Default chosen**: Left for feature 060's documentation work, alongside the
squiredocs.com mentions in those pages (RBD-058-6). Listed in promotion notes.

## RBD-058-42 - Vite dev gating and hosted /index.html

**Default chosen**: `client/vite.config.js` gates the blog plugin as well as
the marketing-pages plugin on `SQUIRE_HOSTED`, and the shell plugin is
`apply: 'serve'` so the built `dist/index.html` is never pre-injected. In dev
with the flag off, `/pricing` falls through to the SPA shell (Vite has no 404
step); production returns 404. On the hosted service `/index.html` now serves
the injected shell (before, express.static served the raw file, which carried
the tag inline); the bytes differ only in the added instance script.

## RBD-058-43 - Settings hides the whole AI Usage block when the allowance does not apply

**Default chosen**: When not hosted or `usage.notApplicable`, the Settings "AI
Usage" subsection (meter, beta note, and the BYOK "tracked but not limited"
line inside it) is not rendered. `checkQuota` for an unknown user id still
returns `allowed: false` on either instance type.


---

**Amendment to RBD-058-26 (2026-10-07, post-merge review M1).** When `API_KEY_ENCRYPTION_KEYS` is set, the entrypoint still never GENERATES a legacy `API_KEY_ENCRYPTION_KEY`, but it now ADOPTS one already in `secrets.json`. The original rationale ("the operator chose keys explicitly") did not hold for a key the entrypoint generated and the operator never saw: dropping it made every pre-rotation BYOK value undecryptable.
