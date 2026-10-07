# Feature Specification: Self-Host Configuration Foundation

**Feature Branch**: `058-self-host-config` (spec directory; work is orchestrated on the current branch and no feature branch is created by the spec phase)

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "058-self-host-config: self-host configuration foundation"

**Design ground truth**: `design/self-hosting-local-mode.md` (ratified by Sam 2026-10-07, decisions D1 to D11), build sequence step 1: "Self-host configuration foundation. `APP_URL`, cookie flag, generated secrets, migrations on boot, local image storage, generic SMTP, `SQUIRE_HOSTED`, welcome template URLs. No user-visible change on the hosted service." Read together with the "Zero-configuration boot" section, the "Changes to existing behavior" table, and the "Security considerations" section. Companion context: `design/infrastructure-and-environments.md` (runtime shape, deploy path) and `design/authentication-and-sharing.md` (cookie and session rules).

**Decisions ledger**: `specs/058-self-host-config/clarifications-needed.md` (RBD-058-1 to RBD-058-32). Every default chosen where the design is silent is recorded there, never in this file alone.

## Problem Statement

The Squire Docs image cannot boot without a hand-built environment. Every one of the following was verified against the code on 2026-10-07:

| Today | Where | Consequence for a self-hoster |
| --- | --- | --- |
| `NODE_ENV` is not set in the image; only the production Kubernetes overlay sets it | `Dockerfile` CMD (`node server/index.js`), `k8s/overlays/aws-prod/patches/app-node-env.yaml` | Running the image bare prints the `[SECURITY] NODE_ENV is UNSET` warning (`server/index.js:25-37`) and runs with every hardening guard off |
| Production refuses to boot without four strong secrets in the environment | `server/auth/jwt.js:10-17`, `server/mcp/auth/jwt.js:14-17`, `server/crypto.js:50-92` | A fresh container with `NODE_ENV=production` crashes at require time |
| Migrations run only from a Kubernetes Job | `k8s/base/db-migrate-job.yaml`, `script/migrate.js`, `script/deploy-aws.sh:153-216` | A compose user has no way to create the schema |
| The health check hits `/health`, which is pure liveness | `Dockerfile` HEALTHCHECK, `server/index.js:616-618`; `/ready` exists at `:627` and `server/ready.js` | `docker compose up --wait` returns before the app can serve requests |
| Post-sign-in redirects go to `CLIENT_URL`, which defaults to the Vite dev port | `server/auth/routes.js:45-53` (`DEFAULT_CLIENT_URL = CLIENT_URL or http://localhost:5173`), `server/index.js:223` | Sign-in on a self-hosted instance lands on the wrong origin unless `CLIENT_URL` is set by hand |
| The Google callback defaults to port 3001 on localhost | `server/auth/google.js:10` | Correct for the container port but not for the published host port |
| Five cookies set `Secure` when `NODE_ENV=production` | access and refresh cookies `server/auth/jwt.js:32-44,126-140`; `oauth_redirect`, `oauth_return_to`, `oauth_state` at `server/auth/routes.js:127-154` | Safari does not store `Secure` cookies on `http://localhost`, so production-mode sign-in breaks on a local instance |
| Image bytes go only to S3; uploads and resolves return 503 without it | `server/s3-images.js:38-40`, `server/index.js:923-989`, `server/api/chat-attachments.js:64-66,128-130` | Images do not work without an S3 bucket and IAM credentials |
| Email is configured by SES-specific names with a fixed port 465 and a fixed default host | `server/email.js:12-29` | A self-hoster with an ordinary SMTP server has to pretend it is SES |
| Marketing, pricing, about, security, blog, privacy, and terms pages, the Google Analytics and Ads CSP sources, the analytics tag in the app shell, signup AI credits, admin sign-up and login emails, the beta welcome email, and the production self-test reset endpoint are always on | `server/index.js:195-209,213-219,1612-1646`; `client/index.html:4-12`; `client/src/App.jsx:57-63,118-125`; `migrations/1784000000000_raise-default-ai-credit.js`; `server/auth/routes.js:330-335,822-830`; `server/api/admin.js:378-405`; `client/src/pages/AdminPage.jsx:111-161,292-303,459-480` | A self-hosted instance advertises and tracks for squiredocs.com |
| Text that names the server hardcodes `https://squiredocs.com` | `server/mcp/tools/tool-documentation/export-api.js:88,91,129,139,175,189,232`; `server/mcp/tools/create-access-token.js:195,219`; `server/mcp/tools/import-markdown-file.js:194`; `client/src/pages/SettingsPage.jsx:298,302`; `server/onboarding/welcome-template.js:80,96,106,110,125,127`; `client/public/agents.md` (6 occurrences) | The try-out path's last step tells a local agent to sync the developer's file to the hosted service |

This feature removes every item in that table so the image boots with no environment variables set, while the hosted service at squiredocs.com keeps running from the same image with no behavior change. It is the foundation that features 059 (identity and local mode), 060 (distribution), and 061 (team mode) build on. It adds no instance mode, no sign-in link, no CLI, no compose file, and no schema change.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The image boots with nothing configured (Priority: P1)

An operator starts the published image against a reachable Postgres (and optionally Redis) with no other environment variables. The container generates and persists the secrets it needs, creates the schema, and reports healthy only once it can serve requests. A restart reuses the same secrets, so existing sessions and stored keys keep working.

**Why this priority**: Everything else in the self-host design (the compose file in 060, the claim link in 059) assumes the image can come up on its own. Without this, "docker compose up" cannot succeed.

**Independent Test**: Run the image with only database connection variables set. Verify the container reaches a healthy state, the schema is at the latest migration, a `secrets.json` with mode 0600 exists under the data directory, and a second start with the same volume reuses the same values. Then run the image with the four secrets set in the environment and verify the file is neither read nor written.

**Acceptance Scenarios**:

1. **Given** a fresh data volume and no secret variables, **When** the container starts, **Then** it generates `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `MCP_JWT_SECRET`, and `API_KEY_ENCRYPTION_KEY`, writes them to the secrets file with mode 0600, and the server boots in production mode with no `[SECURITY] NODE_ENV` warning and no weak-secret failure.
2. **Given** a data volume that already holds a secrets file, **When** the container restarts, **Then** the server uses the stored values and a session cookie issued before the restart is still valid after it.
3. **Given** a secret set in the environment and a different value for the same secret in the file, **When** the container starts, **Then** the environment value is used and the file is left unchanged.
4. **Given** an empty database and the migrate-on-boot default, **When** the container starts, **Then** the schema is created before the server accepts requests, and a second container started against the same database at the same time does not run migrations concurrently.
5. **Given** migrate-on-boot disabled, **When** the container starts, **Then** no migration runs and the server boots as today.
6. **Given** the container is starting, **When** an orchestrator polls the image health check, **Then** it reports unhealthy until startup finishes and Postgres answers, and healthy after.
7. **Given** the data directory is not writable by the application user, **When** the container needs to write the secrets file, **Then** it exits non-zero with a message that names the directory and the fix, instead of booting with weak or missing secrets.

---

### User Story 2 - The hosted service keeps running unchanged (Priority: P1)

The deploy of squiredocs.com picks up the new image and nothing a user or operator can observe changes: the same pages, cookies, emails, analytics, image storage, and migration flow.

**Why this priority**: The design's fourth goal and the step-1 mandate ("No user-visible change on the hosted service"). A regression here is a production incident on the only running instance.

**Independent Test**: Build the production overlay with the new environment values, deploy to the hosted cluster, and walk the production checklist in this spec: marketing pages serve, `Secure` cookies are issued, the migrate Job still gates the rollout, images resolve to S3, the welcome and notification emails still send, and the Admin page still shows the welcome-email and self-test controls.

**Acceptance Scenarios**:

1. **Given** the production overlay sets the hosted flag, the public URL, S3 storage, and migrate-on-boot off, **When** a pod starts, **Then** it does not run migrations, uses the environment secrets, and serves exactly the routes it serves today.
2. **Given** the public URL is `https://squiredocs.com`, **When** a user signs in, **Then** all five cookies carry `Secure` and `SameSite` as today, and the post-sign-in redirect lands on `https://squiredocs.com`.
3. **Given** the SES variables are still supplied under their existing names, **When** the server sends any email, **Then** it uses the same host, port, credentials, and sender as today.
4. **Given** the existing S3 secret, **When** a document image is uploaded or resolved, **Then** bytes go to and come from the S3 bucket and the CSP still allows the bucket origin.
5. **Given** an unauthenticated visitor, **When** they open `/`, `/pricing`, `/about`, `/security`, `/blog`, `/privacy`, or `/terms`, **Then** each serves the same page as today with the analytics tag present.

---

### User Story 3 - Sign-in works on a plain-http local instance in every browser (Priority: P2)

A developer runs the instance on `http://localhost:<port>` and signs in. The session cookies are stored by Safari as well as Chrome and Firefox, and the post-sign-in redirect lands on the local instance without any URL variables set.

**Why this priority**: Feature 059's claim link signs the owner in through the same cookie path. If `Secure` cookies are issued on plain http, the try-out path fails silently for Safari users.

**Independent Test**: Start the server with `NODE_ENV=production` and an `http://localhost` public URL. Trigger the sign-in start and callback paths (with a stubbed provider, or the dev faucet in a development environment) and inspect every `Set-Cookie` header: `Secure` absent, `SameSite` unchanged from today. Repeat with an `https://` public URL and verify `Secure` present. Verify that with no `CLIENT_URL` and no `GOOGLE_REDIRECT_URI` set, the redirect target and the callback URL derive from the public URL.

**Acceptance Scenarios**:

1. **Given** `APP_URL=http://localhost:3910`, **When** the server issues the access, refresh, `oauth_redirect`, `oauth_return_to`, or `oauth_state` cookie, **Then** none carries `Secure`, and `SameSite` is the same value today's production mode sets.
2. **Given** `APP_URL=https://docs.example.com`, **When** any of those cookies is issued, **Then** it carries `Secure`.
3. **Given** `APP_URL` set and `CLIENT_URL` unset, **When** a sign-in completes, **Then** the browser is redirected to a path under `APP_URL`.
4. **Given** `APP_URL` set and `GOOGLE_REDIRECT_URI` unset, **When** the Google sign-in starts, **Then** the callback URL sent to the provider is `APP_URL` plus the callback path.
5. **Given** `CLIENT_URL` or `GOOGLE_REDIRECT_URI` set explicitly, **When** the server builds a redirect or callback, **Then** the explicit value wins over the `APP_URL` default.
6. **Given** `NODE_ENV=production` and an `http://` public URL whose host is not localhost, **When** the server boots, **Then** it logs a warning that the configuration is unsupported (the design's "serving plain HTTP on any other address is not supported"), and still boots.

---

### User Story 4 - Images work without S3 (Priority: P2)

A self-hoster pastes an image into a document and attaches an image in the assistant chat. Both are stored on the instance's data volume, served back to the browser through the application with the same access rules as the S3 path, and survive a container restart.

**Why this priority**: Images are part of the core editing loop. The design makes local storage the default so a try-out needs no bucket. It is P2 only because the boot path (US1) must exist first.

**Independent Test**: With local storage selected, upload a document image through the existing upload route, resolve it, fetch the returned URL as the uploader and as a viewer (200 with the right content type and bytes), and as a user without access (403). Restart the container and fetch again. Export the document as a bundle and confirm the image bytes are included. Repeat for a chat attachment with its ownership rule.

**Acceptance Scenarios**:

1. **Given** no storage driver configured and no S3 bucket configured, **When** the server boots, **Then** local storage is active and image upload is enabled.
2. **Given** local storage, **When** a user with edit access uploads an image, **Then** the bytes are written under the data directory and the response is the same shape as today (an app image URL).
3. **Given** local storage, **When** a user with view access resolves an image, **Then** the response is `{ url }` where the URL points at the new raw route, and fetching that URL returns the bytes with the stored content type.
4. **Given** local storage, **When** a user without access fetches the raw route, **Then** the response is 403, and an unknown image id returns 404.
5. **Given** local storage, **When** a document is deleted, copied, exported as a bundle, rehosted from a markdown import, or viewed by the assistant's image tool, **Then** every path that reads or writes image bytes today works the same way.
6. **Given** S3 selected with an `S3_ENDPOINT` set, **When** the server stores or signs an object, **Then** it talks to that endpoint (an S3-compatible service such as MinIO) instead of AWS.
7. **Given** S3 selected with no bucket configured, **When** an image is uploaded, **Then** the response is the same 503 as today.

---

### User Story 5 - A self-hosted instance never presents the hosted service (Priority: P3)

Someone running their own instance sees no squiredocs.com marketing pages, legal pages, trackers, beta notices, or sign-up notifications, and every URL the product shows them (in Settings, in MCP tool output, in the welcome document, in the agent connect guide) names their own instance.

**Why this priority**: It is what makes the try-out path's last step correct and what keeps a self-hosted instance from leaking usage to the hosted service's analytics. It is P3 because nothing here blocks booting or signing in.

**Independent Test**: Boot with the hosted flag unset. Request each hosted-only path and verify 404. Load the app shell and verify no analytics script or Google CSP sources. Sign in, open Settings, and verify the MCP URL is the instance's origin. Call `get_tool_documentation({ tool: "rest_api" })`, `create_access_token`, and `import_markdown_file` through MCP on the instance and verify no `squiredocs.com` in the output. Seed a welcome document and verify its URLs and the absence of support links. Fetch `/agents.md` and verify the instance origin. Then boot with the hosted flag set and verify each item is back.

**Acceptance Scenarios**:

1. **Given** the hosted flag unset, **When** anyone requests `/pricing`, `/about`, `/security`, `/blog`, any `/blog/*`, `/privacy`, or `/terms`, **Then** the response is 404, and `/` serves the application shell, which sends a signed-out visitor to sign-in and a signed-in user to their documents.
2. **Given** the hosted flag unset, **When** the application shell is served, **Then** it contains no analytics or ads script and the Content Security Policy has no Google Analytics, Tag Manager, or Ads sources; the documentation site under `/documentation` still serves.
3. **Given** the hosted flag unset, **When** a new user signs in for the first time, **Then** no admin sign-up or login notification email is sent, and shared-key assistant use is not limited by the signup credit allowance (RBD-058-3).
4. **Given** the hosted flag unset, **When** an admin calls the welcome-email endpoint or the production self-test reset endpoint, **Then** the response is 404 and the Admin page does not show those controls.
5. **Given** the hosted flag unset, **When** a user opens Settings, **Then** the MCP URL shown and copied is the instance's own origin plus `/mcp`, and the public-beta usage note with the squiredocs.com contact address is not shown.
6. **Given** the hosted flag unset, **When** the welcome document is seeded, **Then** every connection command and link is built from the public URL, and the support links (email support, Get Support) are absent.
7. **Given** any instance, **When** an agent calls `get_tool_documentation({ tool: "rest_api" })`, `create_access_token`, or `import_markdown_file`, **Then** every URL in the result is built from the request's origin, falling back to the public URL, never from a hardcoded host.
8. **Given** the hosted flag set, **When** each item above is exercised, **Then** behavior is identical to today.

---

### User Story 6 - Email through any SMTP server (Priority: P3)

A self-hoster points the instance at their own SMTP server using generic variable names. The hosted service keeps its existing SES variables untouched.

**Why this priority**: Email is optional in local mode (D6), so this is the least urgent story, but team-mode invites (061) and share notifications need it.

**Independent Test**: Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` against a local SMTP sink, trigger a share notification, and verify delivery. Configure only the `SES_*` names and verify the same transport settings result. Configure nothing and verify one boot-time log line and silent skipping.

**Acceptance Scenarios**:

1. **Given** the generic variables set, **When** the server sends email, **Then** it connects to that host and port with those credentials and sender.
2. **Given** only the SES names set (as the hosted service does), **When** the server sends email, **Then** host, port, credentials, and sender resolve exactly as today, including the SES default host when no host is given.
3. **Given** both a generic name and its SES alias set, **When** the server resolves the setting, **Then** the generic name wins.
4. **Given** no sender configured, **When** the server boots, **Then** it logs once that email is off, and every later send is skipped without logging per message at warning level.

---

### Edge Cases

- The secrets file exists but is unreadable, truncated, or not valid JSON: the entrypoint exits non-zero with a message naming the file; it never silently regenerates (regeneration would invalidate every stored BYOK key).
- The secrets file is missing one of the four values (for example, written by an older image): only the missing value is generated and appended; the others are preserved.
- Two replicas start together with migrate-on-boot enabled: one holds the advisory lock and migrates; the other waits, then finds nothing to do.
- Postgres is not yet accepting connections when the entrypoint starts: it retries for a bounded period and then exits non-zero so the orchestrator restarts the container (RBD-058-10).
- Migrations fail: the entrypoint exits non-zero and the server never starts, matching today's Job gate.
- `APP_URL` has a trailing slash or a path: it is normalized to an origin; a value that is not an absolute http or https URL fails boot with a message naming the variable.
- `APP_URL` is https but the instance is reached over http through a misconfigured proxy: cookies carry `Secure` and sign-in fails, which is the correct outcome; the warning in US3 scenario 6 covers the reverse case.
- The hosted flag is set but `APP_URL` is unset: the compatibility chain (RBD-058-1) derives the public URL from `CLIENT_URL`, so the hosted deploy cannot lose `Secure` cookies by omission.
- Local storage is selected but the images directory cannot be created: upload returns 503 with a clear message, resolve of an existing row returns 503 with a logged error (as today), and the server still boots.
- A stored image key contains path separators or `..`: the local driver treats keys as opaque and maps them to a path strictly under the images directory, rejecting any key that would escape it.
- The driver is switched from local to S3 (or back) with existing rows: rows written by the other driver resolve to a 404 from that driver; no migration of bytes is attempted in this feature.
- `STORAGE_DRIVER` has an unknown value: boot fails with a message listing the accepted values.
- A hosted-only route is requested with a trailing slash or different case: it is treated like today's routing; only the listed routes change.
- `SQUIRE_HOSTED` is set to a value other than `true` (for example `1`, `yes`, `TRUE`): accepted values are exactly `true` and `false` (case-insensitive); anything else is treated as unset and logged once.

## Requirements *(mandatory)*

### Functional Requirements

**Boot sequence and secrets**

- **FR-001**: The image MUST set `NODE_ENV=production` so that a bare run has the production cookie, weak-secret, development-endpoint, and error-verbosity guards on and prints no `NODE_ENV` warning.
- **FR-002**: The image's command MUST be an entrypoint script that, in order: resolves secrets into the process environment, runs migrations when enabled, then loads the server. The server MUST NOT be loaded before secrets are in the environment, because its auth and crypto modules check them at require time.
- **FR-003**: For each of `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `MCP_JWT_SECRET`, and `API_KEY_ENCRYPTION_KEY`, the entrypoint MUST use the environment value when set; otherwise read it from the secrets file; otherwise generate a cryptographically random value of the strength the existing guards require (the encryption key as 64 hex characters) and write it to the file. The environment always wins over the file, and the file is only written when at least one value was generated.
- **FR-004**: The secrets file MUST live at `<data dir>/secrets.json` (data dir default `/data`, override `SQUIRE_DATA_DIR`, RBD-058-9), be created with mode 0600, and be written atomically so a crash mid-write cannot leave a truncated file. A file that exists but cannot be parsed MUST stop boot with an error naming the file; it MUST NOT be regenerated.
- **FR-005**: The image MUST create the data directory and give ownership to the application user so a named volume mounted there is writable on first boot. A write failure MUST stop boot with a message that names the directory and the ownership fix.
- **FR-006**: With `MIGRATE_ON_BOOT=true` (the image default) the entrypoint MUST run the existing migration script while holding a Postgres advisory lock with a fixed key, so concurrent replicas run it once; with `false` it MUST skip migrations entirely. It MUST wait for the lock rather than fail, and MUST retry the initial database connection for a bounded period before exiting non-zero (RBD-058-10). A migration failure MUST exit non-zero and MUST NOT start the server.
- **FR-007**: The image health check MUST call `/ready` instead of `/health`, so that the container is healthy only after startup finished and Postgres answers. Kubernetes probe configuration is unchanged by this feature (the production overlay already uses `/ready` for readiness and `/health` for liveness).
- **FR-008**: The existing secret guards (`server/auth/jwt.js`, `server/mcp/auth/jwt.js`, `server/crypto.js`) MUST stay as they are; the feature satisfies them rather than relaxing them. `MCP_REFRESH_SECRET` and `MCP_AUTH_CODE_SECRET` are not read by any server code (verified) and are not generated (RBD-058-17).

**Public URL and cookies**

- **FR-009**: `APP_URL` MUST be the configured public origin. When unset, it MUST default to `CLIENT_URL` if that is set, otherwise to `http://localhost:<PORT or 3001>` (RBD-058-1, amended by RBD-058-18: `SQUIRE_PORT` is not read; compose passes `APP_URL` explicitly per the design). The value MUST be normalized to an origin (scheme, host, port; no path, no trailing slash), and an invalid value MUST fail boot naming the variable.
- **FR-010**: `CLIENT_URL` MUST default to `APP_URL` when unset, and `GOOGLE_REDIRECT_URI` MUST default to `APP_URL` plus the existing Google callback path when unset. Explicit values keep winning. The CORS allow-list and the production redirect validation MUST use the resolved `CLIENT_URL` exactly as today.
- **FR-011**: The `Secure` attribute on the access cookie, the refresh cookie, the cookie-clearing options, and the `oauth_redirect`, `oauth_return_to`, and `oauth_state` cookies MUST be set when `APP_URL`'s scheme is `https` and unset when it is `http`, independent of `NODE_ENV`. `SameSite` MUST keep its current rule (`strict` in production, `lax` otherwise, and `lax` for the three transient OAuth cookies).
- **FR-012**: In production with an `http` `APP_URL` whose host is not `localhost` or a loopback address, the server MUST log one boot-time warning that this configuration is unsupported and that a TLS-terminating proxy with an `https` `APP_URL` is required. It MUST still boot (RBD-058-13).
- **FR-013**: The request-origin base URL helper (`server/url.js`) keeps its behavior; `PUBLIC_ORIGIN` MUST default to `APP_URL` when unset so the hosted alias mapping and the self-host origin agree (RBD-058-16).

**Image storage**

- **FR-014**: `STORAGE_DRIVER` MUST accept `local` and `s3`. When unset it MUST resolve to `s3` if an S3 bucket is configured and to `local` otherwise (RBD-058-2). Any other value MUST fail boot listing the accepted values.
- **FR-015**: Every code path that stores, reads, copies, signs, or deletes image bytes (document images, chat attachments, markdown-import rehosting, bundle export, assistant image tools, document deletion) MUST go through one storage interface with the same operations the S3 module exposes today (`isEnabled`, `cspImageSources`, `putObject`, `getObject`, `getSignedGetUrl`, `copyObject`, `deleteObjects`), so the driver choice is invisible to callers.
- **FR-016**: The local driver MUST store bytes under `<data dir>/images`, mapping each storage key to a path strictly inside that directory, and MUST reject keys that would escape it. `isEnabled` MUST be true whenever the directory is usable. `cspImageSources` MUST return no extra origins (same-origin is already allowed).
- **FR-017**: A new route `GET /api/docs/:docId/images/:imageId/raw` MUST stream the bytes of a document image with the stored content type, after the same document access check the resolve route performs, authenticating by the existing credentials plus the `accessToken` session cookie, because a browser `<img>` request carries only cookies (RBD-058-20), with `Cache-Control: private, max-age=3600`. 403 and 404 semantics MUST match the resolve route. With the local driver, the resolve route MUST keep returning `{ url }` where `url` is the relative path of this raw route (RBD-058-14), so the client is unchanged.
- **FR-018**: Chat attachments MUST get the equivalent treatment: with the local driver, the attachment resolve route returns the relative URL of a new raw route that enforces the same ownership rule (the user id encoded in the key) before streaming bytes (RBD-058-7, found-in-spec).
- **FR-019**: The S3 driver MUST keep today's behavior and additionally honor `S3_ENDPOINT` (custom endpoint, path-style addressing when an endpoint is set) for S3-compatible services. `cspImageSources` MUST return the origin the presigned URLs will actually use, including a custom endpoint.

**Email**

- **FR-020**: Email MUST be configured by `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`. The existing names `SES_SMTP_HOST`, `SES_SMTP_USER`, `SES_SMTP_PASS`, and `SES_FROM_EMAIL` MUST keep working as aliases; the generic name wins when both are set. `SMTP_PORT` defaults to 465; implicit TLS is used for port 465 and STARTTLS otherwise, with an optional `SMTP_SECURE` override. The SES default host applies only when the configuration arrives through the SES aliases and no host is given, so the hosted deploy needs no new email variable (RBD-058-8).
- **FR-021**: With no sender configured, the server MUST log one line at boot that email is off and skip every send silently afterward; the return shape of the send function (`skipped: true`) is unchanged.

**Hosted-only gating**

- **FR-022**: `SQUIRE_HOSTED` MUST gate every hosted-only item below; it defaults to off. Accepted values are `true` and `false`, case-insensitive; anything else counts as off and is logged once. The flag MUST be resolved once, in one configuration module, and read from there everywhere (RBD-058-16).
- **FR-023**: When off, the server MUST NOT serve the marketing pages (`/` as landing, `/pricing`, `/about`, `/security`), the blog (`/blog` and `/blog/*`), or the legal pages (`/privacy`, `/terms`); those paths return 404, except `/` which serves the application shell. When on, all of them serve exactly as today (RBD-058-5, with `/about`, `/security` found-in-spec).
- **FR-024**: When off, the Content Security Policy MUST NOT include the Google Tag Manager, Google Ads, or Google Analytics sources, and the application shell MUST NOT include the analytics tag. When on, the CSP and the tag are present as today. The client's page-view and conversion calls already guard on the tag being present and need no change (RBD-058-4, analytics tag found-in-spec).
- **FR-025**: The client MUST learn whether the instance is hosted before first render and without an authenticated request, through instance configuration the server injects into the application shell (RBD-058-4). The client MUST use it to hide: the privacy and terms links on the sign-in page, the public-beta usage note and contact address in Settings, the usage meter in Settings, and the welcome-email and self-test controls on the Admin page.
- **FR-026**: When off, the admin sign-up and login notification emails MUST NOT be sent. Support-request, credit-limit (which cannot fire when credits are off), exception, share, and space emails are not gated; they depend on `ADMIN_EMAIL` or the recipient and are operator choices (RBD-058-11).
- **FR-027**: When off, shared-key assistant usage MUST NOT be limited by the monthly signup credit allowance: the quota check reports allowed with usage still recorded, the credit-limit notification does not fire, and the `/api/usage` response marks the allowance as not applicable so the Settings meter can hide. When on, credits work exactly as today (RBD-058-3).
- **FR-028**: When off, `POST /api/admin/users/:userId/welcome-email` and `POST /auth/prod-reset-selftest-account` MUST return 404 (indistinguishable from an unknown route), and the Admin page MUST NOT render their controls. When on, both work as today.
- **FR-029**: When off, the old-domain 301 redirect to squiredocs.com MUST NOT be mounted (found-in-spec, RBD-058-12).
- **FR-030**: The `HTTP-Referer` header sent to OpenRouter MUST be `APP_URL` instead of the hardcoded hosted origin (found-in-spec, RBD-058-12).

**Text that names the server**

- **FR-031**: The REST recipe returned by `get_tool_documentation({ tool: "rest_api" })` MUST build every URL from the request's origin (the same base URL the other MCP tools receive), falling back to `APP_URL`; the static documentation text becomes a function of the base URL.
- **FR-032**: `create_access_token` and `import_markdown_file` MUST fall back to `APP_URL` instead of the hardcoded hosted origin when the request carries no base URL.
- **FR-033**: The Settings page MUST show and copy the MCP URL as the browser's current origin plus `/mcp`.
- **FR-034**: The welcome document template MUST build its connection commands, the JSON config URL, the `agents.md` link, and the documentation link from `APP_URL`, and MUST include the support paragraph (email support, Get Support link) only when hosted. The seeded document's structure is otherwise unchanged, so the existing onboarding tests keep passing with the URL substituted.
- **FR-035**: `/agents.md` MUST be served with the hosted origin replaced by the instance's origin (request origin, falling back to `APP_URL`) when not hosted; the file in the repository keeps the hosted URLs so the existing drift guard test is untouched (found-in-spec, RBD-058-6).

**Hosted deploy and documentation**

- **FR-036**: The production overlay (`k8s/overlays/aws-prod`) MUST set `SQUIRE_HOSTED=true`, `MIGRATE_ON_BOOT=false`, `APP_URL=https://squiredocs.com`, and `STORAGE_DRIVER=s3` on the app container, so production behavior does not depend on any default in this feature. The existing `NODE_ENV` patch may stay (now redundant with the image). `CLIENT_URL`, `GOOGLE_REDIRECT_URI`, and the `SES_*` secret keys keep their current values and names. The migrate Job and the deploy script's Job gate are unchanged.
- **FR-037**: `README.md`, `docs/dev.md`, and `.env.example` MUST document every new or changed variable (`APP_URL`, `SQUIRE_DATA_DIR`, `MIGRATE_ON_BOOT`, `STORAGE_DRIVER`, `S3_ENDPOINT`, `SMTP_*` with the SES aliases, `SQUIRE_HOSTED`, `PUBLIC_ORIGIN` default), the entrypoint boot order, the secrets file and the warning that losing the volume loses the encryption key, and the production overlay values (Constitution I). Documentation edits happen in the implementation phase, not the spec phase.
- **FR-038**: Every behavioral change above MUST be covered by tests: entrypoint secret resolution and file mode (unit, with a temp data dir), advisory-lock migration (integration), cookie flag by scheme (unit), URL defaults (unit), local driver and raw routes including access checks and key safety (integration), SMTP alias resolution (unit), hosted gating of routes, CSP, endpoints, and emails (integration), and the server-naming text (unit snapshot with two origins).

### Key Entities *(include if feature involves data)*

- **Instance configuration**: The resolved, immutable set of values the server boots with: public URL, client URL, callback URL, hosted flag, storage driver, data directory, migrate-on-boot flag, email transport. Resolved once from the environment with the defaults in this spec; every consumer reads the resolved value, never `process.env`.
- **Generated secrets file**: A JSON object under the data directory holding only the four generated secrets, mode 0600, written once per missing value. Environment values override it and are never written to it.
- **Storage driver**: The implementation behind the image storage interface. `local` keeps bytes under the data directory; `s3` keeps them in a bucket (AWS or any S3-compatible endpoint). Stored image rows keep their existing key column; the key is opaque to the driver boundary.
- **Hosted-only surface**: The set of routes, CSP sources, emails, endpoints, UI controls, and text that exist only for squiredocs.com, enumerated in FR-023 to FR-030 and FR-034.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A container started with only database connection variables reaches healthy within 90 seconds on a developer laptop, with the schema fully migrated and a 0600 secrets file on the volume; a restart reuses the same secrets and a pre-restart session cookie still works.
- **SC-002**: The hosted service deployed with the new overlay values passes the production checklist in this spec with zero differences from today's behavior: every listed page, cookie attribute, email, image path, Admin control, and analytics tag present.
- **SC-003**: With an `http://localhost` public URL, 0 of the 5 cookies carry `Secure`; with an `https` public URL, 5 of 5 do; `SameSite` values are unchanged in both cases.
- **SC-004**: With no S3 configuration, 100% of the image paths exercised by the existing image, export, rehost, and chat-attachment test suites pass against the local driver, and a viewer without access is refused on the raw route.
- **SC-005**: With the hosted flag off, a search of every response body for the application shell, Settings page, welcome document, `/agents.md`, and the three MCP tool outputs finds zero occurrences of `squiredocs.com`, and the seven hosted-only paths return 404.
- **SC-006**: With only the `SES_*` names configured, the resolved SMTP transport settings are byte-identical to today's (host, port 465, implicit TLS, user, pass, from).
- **SC-007**: The full backend and client test suites pass, including the new coverage in FR-038, and the existing `agents.md` drift guard and onboarding tests pass without edits to their assertions beyond URL parameterization.
- **SC-008**: Running the image with every variable unset except the database prints no `[SECURITY]` warning and no weak-secret or missing-key error in its log.

## Assumptions

- The instance runs against a Postgres with the pgvector extension and an optional Redis, exactly as production; this feature does not change database or Redis configuration variables.
- `npm run dev` in the development pod keeps starting `server/index.js` directly with `NODE_ENV=development`; the entrypoint is used by the image only. The development pod's existing variables are unaffected.
- The minikube `collab-app` base pod is built from the same Dockerfile and therefore flips to production mode with this feature. Its secrets come from `k8s/auth.env` and the MCP secret; they must be strong, non-default values or the pod will refuse to boot. This is a verification item for the implementer, not a design change (RBD-058-15).
- The image default `MIGRATE_ON_BOOT=true` also applies to the minikube pod; its migrate Job continues to run too. Both are idempotent and lock-protected, so this is harmless; the minikube overlay may set it to `false` to mirror production.
- Keeping the hosted service's `CLIENT_URL` secret value is enough for the compatibility chain in FR-009, but the overlay still sets `APP_URL` explicitly (FR-036) so the chain is never load-bearing in production.
- The design's `APP_URL` default `http://localhost:${SQUIRE_PORT}` requires the container to see `SQUIRE_PORT`; the compose file in 060 passes it through (or sets `APP_URL` directly). This feature only defines the default rule (RBD-058-1).
- The documentation site pages under `documentation/*.md` also mention squiredocs.com (`agents-and-mcp.md`, `markdown.md`, `account-and-support.md`); they are product documentation owned by feature 060's self-hosting documentation work and are not changed here.
- The assistant panel's "how to add a key" message when no model key is configured (design, "AI features without keys") is not assigned to any build step by the design; it is not in this feature (see Design gaps).
- Image bytes are not migrated between drivers. An operator who switches drivers with existing rows accepts that those rows resolve to 404 until they are re-uploaded.
- No schema migration is added by this feature. Feature 059 adds the next migration, which per the repository rule must be numbered above 1795000000000.

## Out of Scope

- `SQUIRE_MODE`, local and team modes, sign-in links, the claim page, the startup-log link, the `squire` CLI, `user_identities`, `GET /auth/providers`, and the sign-in and consent pages rendered from providers (feature 059).
- `compose.yml`, the `./squire` wrapper, `.env.example` for compose, GHCR publishing, multi-architecture builds, `AGENTS.md` at the repository root, the README "Running locally" section, the documentation site's self-hosting page, and the `onboard.md` self-host branch (feature 060).
- Generic OIDC, passwords, `SIGNUP_MODE`, verified-email invite conversion (feature 061).
- Moving hosted-only code out of the repository (rejected by D8).
- Bundled TLS, a Helm chart, multi-replica self-host documentation (design non-goals).

## Design Gaps and Found-in-Spec Items

Flagged per Constitution VI. Each is either recorded as a default in the ledger or needs a design amendment; none is resolved silently.

1. **`APP_URL` default references `SQUIRE_PORT`**, a compose-level host port the container does not see unless passed. Default rule chosen in RBD-058-1; feature 060 must pass `SQUIRE_PORT` or set `APP_URL` in the compose file. Suggested design amendment: state that compose passes `SQUIRE_PORT` into the container.
2. **`STORAGE_DRIVER=local` as the unconditional default would regress the hosted service** (pods have no persistent `/data`; S3 is configured by secret). Refined to an auto-detect default in RBD-058-2 and an explicit overlay value. Suggested design amendment: "local by default when no bucket is configured".
3. **"Signup AI credits" off is undefined.** The grant is a column default, and turning it off would block the shared key for self-hosters who set their own key. RBD-058-3 chooses "no monthly cap when not hosted". This is an interpretation Sam may want to overturn.
4. **Chat attachments use the same S3 module** but the design mentions only document images. Covered by FR-018 (RBD-058-7).
5. **The analytics tag lives in the app shell HTML**, not only in the CSP. Gating the CSP alone would leave a blocked script and console errors on every self-hosted page. Covered by FR-024 and FR-025 (RBD-058-4).
6. **Additional hosted-only items the design does not list**: `/about` and `/security` static pages, the old-domain 301 redirect, the OpenRouter referer header, the Settings public-beta note and usage meter, the Admin page welcome-email and self-test controls, the sign-in page's privacy and terms links. Covered by FR-023, FR-025, FR-028, FR-029, FR-030 (RBD-058-12).
7. **`/agents.md` served by the app hardcodes the hosted URL** six times and is linked from the welcome document, so the try-out path would still point an agent at squiredocs.com. Covered by FR-035 (RBD-058-6). Documentation pages are left to 060.
8. **The "assistant panel shows how to add a key" behavior** is described under "AI features without keys" but assigned to no build step. Not in 058; needs an owner (suggest 059 alongside `squire doctor`'s "semantic search: off").
9. **The design table says `CLIENT_URL` "must be set in production"**; in code it defaults to `http://localhost:5173` and production simply uses whatever it is. The spec's requirement (FR-010) matches the design's "after" column; the "today" wording is slightly off and can be corrected at the next sync.
10. **`NODE_ENV=production` in the Dockerfile changes the minikube base pod**, which the design does not mention. Recorded as a verification item (RBD-058-15).
11. **The hosted overlay must gain four values** (`SQUIRE_HOSTED`, `MIGRATE_ON_BOOT`, `APP_URL`, `STORAGE_DRIVER`); the design names only `MIGRATE_ON_BOOT=false`. Covered by FR-036 and the checklist below.

## Hosted Deploy Checklist

For the maintainer's first deploy of this feature, before `script/build-and-deploy-aws.sh`:

- `k8s/overlays/aws-prod` app container env: `SQUIRE_HOSTED=true`, `MIGRATE_ON_BOOT=false`, `APP_URL=https://squiredocs.com`, `STORAGE_DRIVER=s3`. Plain values in a patch, not secrets.
- No change to `k8s/secrets/*.enc.yaml`: `CLIENT_URL`, `GOOGLE_REDIRECT_URI`, the four secrets, and the `SES_*` keys keep their names (aliases) and values.
- `script/deploy-aws.sh`: no change; the migrate Job gate still runs because `MIGRATE_ON_BOOT=false` leaves migrations to the Job.
- The minikube `collab-app` pod: confirm `k8s/auth.env` and the MCP secret hold non-default values before rebuilding the image, since the pod now boots in production mode.
- After deploy, walk US2's acceptance scenarios and SC-002.
