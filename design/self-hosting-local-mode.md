<!-- source: https://squiredocs.com/d/62f408ea-a884-4d2e-a129-fbbbf8abb7e5
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Proposal: Self-Hosting and Local Mode

## Summary

This proposal defines how someone runs their own copy of Squire Docs, starting with the case that matters most at open-source launch: an individual developer who asks an AI agent to set it up on their laptop. It covers the spin-up (a Docker Compose file that boots with no configuration), a new instance mode called local mode (one owner, signed in by a one-time link printed from a terminal command, no passwords and no email), and how the developer's agent connects to its own instance over the existing MCP OAuth flow.

Team mode, the path for shared instances with real sign-in providers, is outlined here so the two modes fit together. Its detailed design belongs in an amendment to [Squire Authentication and Sharing](https://squiredocs.com/d/503fb6a8-d165-49c7-bc98-883a68b14540).

Status: proposed 2026-10-07. Nothing here is built.

## Goals

- A developer with Docker installed gets a working instance, signed in, with their agent connected, in under five minutes and two clicks.
- The steps are a fixed script an agent can follow without improvising: every step has a command, and every command has a machine-checkable success condition.
- No external accounts or keys are required to try it: no Google OAuth app, no SMTP server, no S3 bucket, no LLM API key.
- The hosted service at squiredocs.com keeps running from the same codebase with no behavior change.

## Non-goals

- SAML, LDAP, SCIM, and trusted-header authentication.
- A Helm chart or documented multi-replica self-host. The code supports multiple replicas through Redis, but launch documentation covers one app container.
- Bundled TLS. Local mode serves plain HTTP on localhost. People exposing an instance put their own reverse proxy in front.
- A Docker-free install (see Decisions, D7).

## The try-out path

This is the flow the design is built around. The developer types something like "set up Squire Docs locally" into Claude Code (or another agent with a shell).

1. The agent reads `AGENTS.md` at the repository root (or the "Running locally" section at the top of the README), which gives it the exact commands below.
2. The agent downloads `compose.yml` and the `./squire` wrapper and runs `docker compose up -d --wait`. The command returns when every container reports healthy.
3. The agent runs `docker compose exec app squire doctor --json` and checks that it reports `ok: true`.
4. The agent runs `docker compose exec app squire claim-link --name "<name>" --email "<email>"`, using the developer's git identity as defaults, and prints the link on its own line.
5. The developer clicks the link. The claim page shows the prefilled name and email, they click Continue, and they are signed in as the instance owner with a welcome document.
6. The agent runs `claude mcp add --transport http squire-local http://localhost:3910/mcp` and makes its first tool call. Claude Code opens the authorization page, which already has the owner's session, so it shows the consent card. The developer clicks Approve.
7. The agent syncs a spec from the repository and hands back the document URL, as `/squire:onboard` does against the hosted service today.

The developer clicks twice (Continue, Approve) and types nothing except the original request.

## Instance modes

An instance runs in one of two modes, set by `SQUIRE_MODE`. Mode decides who can sign in and how.

**Local mode** (`SQUIRE_MODE=local`, the default for a fresh install):

- There is one owner account. It is created by the first claim link and has `is_admin = true`.
- The only way to sign in is a sign-in link minted by the `squire` CLI inside the container. There is no password form and no sign-up page.
- Sign-up is closed. Nobody else can create an account, including people on the same network.
- Sharing a document with an email address still records a pending invite, but nobody can redeem it until the instance moves to team mode. The share dialog says so.

**Team mode** (`SQUIRE_MODE=team`):

- One or more sign-in providers are configured: local email and password, a generic OIDC provider, Google. The detailed design is the Authentication and Sharing amendment.
- Sign-up is controlled by `SIGNUP_MODE` (`open`, `invite`, or `closed`) and an optional allowed-domains list.
- CLI sign-in links keep working, as the recovery path for an administrator.
- The server refuses to boot in team mode with no provider configured, with an error that names the variables to set.

The hosted service runs in team mode with Google as its only provider, which is today's behavior.

Moving from local to team mode is a configuration change and a restart. The owner account and its documents carry over. The owner can add a password or link an OIDC identity from Settings.

## Spin-up

### The compose file

`compose.yml` defines three services:

- `app`: the published Squire Docs image.
- `postgres`: `pgvector/pgvector:pg16`, the same image production uses.
- `redis`: Redis 7. The application treats Redis as optional when `REDIS_HOST` is unset, but bundling it in compose has no setup cost for the user and keeps the self-host configuration the same as production.

Each service has a health check. `app` waits on `service_healthy` for both dependencies. Its own health check is `/ready`, which reports Postgres and Redis reachability and stays 503 until startup finishes, so `docker compose up --wait` returns only when the app can serve requests. The Dockerfile's `HEALTHCHECK` changes from `/health` to `/ready` so the image behaves the same outside compose. The Postgres check is `pg_isready -h 127.0.0.1`: without `-h` it uses the Unix socket, which answers while the image's first-run initialization server is still running, before Postgres accepts TCP connections, and the app's migration step would then fail to connect.

Data lives in three named volumes: `squire-data` (generated secrets and local image storage), `postgres-data`, and `redis-data`. The app port is published on `127.0.0.1:${SQUIRE_PORT:-3910}` (the container still listens on 3001; only the host port changes), so it is not reachable from other machines unless the user changes the binding.

`.env` is optional. `.env.example` lists every setting with its default. The only setting a try-out user might need is `SQUIRE_PORT`, if 3910 is taken.

### Zero-configuration boot

These are the changes that let the image boot with no environment variables set:

- **The image runs with ****`NODE_ENV=production`****.** The Dockerfile sets it. This keeps the production cookie settings (`SameSite=Strict`), the weak-secret checks, and the development-endpoint gate, and it stops the boot-time `[SECURITY] NODE_ENV is UNSET` warning in `server/index.js`.
- **An entrypoint runs before the server.** The image's command becomes `node script/entrypoint.js`, which does three things in order: loads or generates secrets (below) into `process.env`, runs migrations if enabled (below), then requires `server/index.js`. The order matters because `server/auth/jwt.js`, `server/mcp/auth/jwt.js`, and `server/crypto.js` check their secrets when they are first required and throw in production if they are missing. The secrets must be in `process.env` before `server/index.js` is loaded.
- **Generated secrets.** If `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `MCP_JWT_SECRET`, or `API_KEY_ENCRYPTION_KEY` is unset, the entrypoint reads it from `/data/secrets.json`, or generates it and writes the file (mode 0600) on first boot. Environment variables always win over the file. The existing guards stay as they are and now pass. Losing the volume loses the encryption key, which makes stored BYOK keys unreadable; `AGENTS.md` and the README state this.
- **A writable data directory.** The image runs as the non-root `appuser`. Docker creates a named volume's mount point as root when the path does not exist in the image, so the Dockerfile creates `/data` and gives it to `appuser`. Without this, writing `secrets.json` fails with a permission error on first boot.
- **Migrations on boot.** With `MIGRATE_ON_BOOT=true` (the image default), the entrypoint runs `script/migrate.js` while holding a Postgres advisory lock, so concurrent replicas run it once. The production Kubernetes manifests set it to `false` and keep the migration Job.
- **One public URL.** `APP_URL` (default `http://localhost:${SQUIRE_PORT}`) is the configured public origin. `CLIENT_URL` and `GOOGLE_REDIRECT_URI` default from it. In production `getClientUrl` in `server/auth/routes.js` returns `CLIENT_URL` regardless of the request, so this default is what makes post-sign-in redirects land on the local instance. `server/url.js` already returns the request's own origin for hosts other than the hosted service's, so the OAuth discovery documents and the URLs MCP tools return are already correct on localhost. What is not correct is text that hardcodes squiredocs.com; see Changes to existing behavior.
- **Cookie security follows the URL.** The `Secure` flag is set when `APP_URL` is `https`, not when `NODE_ENV=production`. Safari does not store `Secure` cookies on `http://localhost`, so the current rule would break sign-in for Safari users. This applies to all five cookies that set it: the access and refresh cookies (`server/auth/jwt.js`) and the `oauth_redirect`, `oauth_return_to`, and `oauth_state` cookies (`server/auth/routes.js`). `SameSite` stays tied to `NODE_ENV`.
- **Local image storage.** `STORAGE_DRIVER=local` (default) stores image bytes under `/data/images`. Today `GET /api/docs/:docId/images/:imageId` returns JSON `{ url }` holding a presigned S3 URL, and the client puts that URL in the `<img>` tag. The local driver keeps that contract: the resolve route returns the URL of a new route, `GET /api/docs/:docId/images/:imageId/raw`, which runs the same access check and streams the bytes. The client does not change. `STORAGE_DRIVER=s3` keeps today's behavior and gains an `S3_ENDPOINT` option for S3-compatible services such as MinIO.
- **Generic SMTP.** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` replace the SES-specific names, which stay as aliases. Email stays optional, and with it unset the server skips sending and logs once at boot.
- **Hosted-only features off by default.** `SQUIRE_HOSTED=true` turns on the pieces that only make sense for squiredocs.com: marketing, pricing, and blog pages; privacy and terms pages; the Google Analytics and Google Ads sources in the Content Security Policy; signup AI credits; admin sign-up and login notification emails; the beta welcome email; and the production self-test reset endpoint. With it unset, `/` goes to the app's sign-in or document list.

### AI features without keys

The core loop (the editor, version history, sharing, and the MCP surface) needs no LLM key, because the developer's own agent supplies the AI. Features that call a model degrade:

- The in-app assistant panel shows how to add a key. Per-user BYOK keys in Settings already exist and work unchanged. Server-wide keys come from the same environment variables production uses.
- Content search already falls back to full-text when `GOOGLE_GENERATIVE_AI_API_KEY` is unset (`server/search.js`), and the indexer skips embedding. `squire doctor` reports this as "semantic search: off (no embedding key)".

### Images and upgrades

Images are published to GHCR as multi-architecture (amd64 and arm64) builds with semver tags plus `latest`. `isolated-vm` is a native module, so CI builds and smoke-tests both architectures. `compose.yml` reads the tag from `SQUIRE_VERSION`. Upgrading is `docker compose pull && docker compose up -d --wait`; migrations run on boot.

## The squire CLI

The image ships a `squire` command, run as `docker compose exec app squire <command>`. It uses the same database connection as the server. Commands that matter for this proposal:

- `squire doctor [--json]` reports database reachability, migration state, Redis state, mode, `APP_URL`, which optional features are on (email, S3, semantic search, assistant keys), and whether the instance has an owner. It exits non-zero when the instance cannot serve requests.
- `squire claim-link [--name N] [--email E]` mints a sign-in link for the owner. On an unclaimed instance the link creates the owner. On a claimed instance it signs the owner in.
- `squire login-link --email E` mints a sign-in link for any existing user. This is the administrator recovery path in team mode.
- `squire mode` prints the current mode and what changing it would require.

The compose download includes a one-line wrapper, `./squire`, that runs `docker compose exec app squire "$@"` from its own folder. People use it (`./squire claim-link`); agents and AGENTS.md use the full docker command (D10).

Every error message from the CLI names the next action, for example "Port 3910 is in use. Set SQUIRE_PORT in .env and run docker compose up -d again."

## Sign-in links

A sign-in link is how a person proves they control the machine the instance runs on. Anyone who can run `docker compose exec` already has full control of the database, so the link grants nothing they could not take anyway.

How a link works:

- The CLI generates 32 random bytes, stores their SHA-256 hash in a `signin_links` table with the target (owner claim or a user id), a 15-minute expiry, and a `used_at` column, and prints `${APP_URL}/claim#<token>`.
- The token is in the URL fragment, so it never reaches server access logs or a `Referer` header. The claim page reads it in the browser and posts it to `POST /auth/signin-link`.
- The server accepts a token once. It checks the hash, the expiry, and `used_at`, marks it used, then runs the normal post-sign-in path (`completePostAuth`): the session cookies, the `auth_events` row, and welcome-document seeding on first sign-in.
- On an unclaimed instance, the page shows name and email fields prefilled from the CLI arguments, and submitting creates the owner. Email is required because pending invites and the account record key on it, but it is never verified or sent to in local mode.
- On a claimed instance, a `claim-link` signs in the existing owner. The CLI ignores `--name` and `--email` and says so, and the page shows no fields, only "Signed in as <owner>". Changing the owner's name or email happens in Settings.
- There is no HTTP endpoint or MCP tool that mints a link. The only way to get one is the CLI inside the container.

Why not trust requests from localhost instead: Docker's port publishing makes every request reach the container from the bridge gateway address, so `req.ip` cannot tell a local browser from another machine. The application also deliberately uses a numeric `trust proxy` hop count, so forwarded headers cannot be used either.

Sessions after sign-in are the existing JWT cookies, unchanged. `POST /auth/refresh` re-issues the 7-day refresh cookie each time it runs, so an owner who uses the instance at least once a week stays signed in. After 7 days without use, the owner asks their agent for a new link, or runs `squire claim-link` themselves.

## Connecting the agent

The agent connects with the existing MCP OAuth 2.1 flow, the same as against the hosted service:

- `claude mcp add --transport http squire-local http://localhost:3910/mcp` registers the server. The first tool call triggers discovery, dynamic client registration, and PKCE authorization.
- Claude Code's callback is a localhost URL, which `checkRedirectUri` already accepts for auto-registered clients.
- Because the owner already has a browser session from the claim link, `/authorize` shows the consent card directly. The owner clicks Approve.

The agent never handles a long-lived credential this way, which matches the existing token-handling rule in `onboard.md` that tokens are not pasted into the conversation. For a machine with no browser, `squire token create --name <agent>` writes an `sk_sqd_` token to a file with mode 0600, matching the existing headless fallback in `onboard.md`.

The first-run consent collapse from feature 031 does not fire here, because the account was created by the claim link, not in the OAuth round trip. Extending it would remove the Approve click; see D2.

### The plugin and onboarding skill

The Claude Code plugin's `.mcp.json` points its `squire` server at `https://squiredocs.com/mcp`. The bundle drift guard (`test/first-run/bundle-drift.test.mjs`) exempts the `url` field from comparison, so changing the URL does not break the guard.

Claude Code registers a plugin's server under a scoped name, `plugin:<plugin>:<server>`, with tools named `mcp__plugin_<plugin>_<server>__*`. A server added with `claude mcp add` has its own name, so a plugin server and a locally added server do not clash by name. If both point at different URLs, both connect, and the agent sees two sets of Squire Docs tools: one for the hosted service and one for the local instance. If both point at the same URL, Claude Code connects only the locally added one.

The proposal:

- The self-host path adds the local server as `squire-local`, so its tools (`mcp__squire-local__*`) cannot be mistaken for the hosted service's.
- `onboard.md` gains a self-host branch. When the user asks for a local instance, or a `squire-local` server is configured, the skill follows the try-out path and uses only the local server's tools.
- Later, the plugin can let its user choose the server URL. Claude Code documents `${user_config.KEY}` substitution in a plugin's MCP server `url`, which is the supported way to do this. The general `${VAR:-default}` syntax is documented for `.mcp.json` files but not confirmed for plugin-bundled ones, so it should not be relied on without a test.

### The welcome document

The welcome document is seeded on the owner's first sign-in, as today. Its template (`server/onboarding/welcome-template.js`) hardcodes squiredocs.com in its connection instructions and support links. Those become `APP_URL`-relative, and the support links appear only when `SQUIRE_HOSTED=true`.

## Agent-facing documentation

`AGENTS.md` at the repository root is written for an agent to execute, not for a person to read. It contains:

- A prerequisite check: `docker compose version` must report v2.
- The try-out path as numbered commands, each with its success condition.
- The rule for printing the claim link: bare, on its own line, with nothing appended.
- Recovery steps: get a new sign-in link, change the port, read logs, upgrade.
- A warning that `docker compose down -v` deletes every document, and that `docker compose down` (without `-v`) is the safe way to stop.

The README's first section repeats the short version for people, and the documentation site gets a self-hosting page.

## Changes to existing behavior

| Area | Today | After |
| --- | --- | --- |
| Text that names the server | The REST recipe returned by `get_tool_documentation({ tool: "rest_api" })` (`server/mcp/tools/tool-documentation/export-api.js`), the fallbacks in `create-access-token.js` and `import-markdown-file.js`, the MCP URL in Settings (`client/src/pages/SettingsPage.jsx`), and the welcome template all hardcode squiredocs.com | Built from the request's origin or `APP_URL`. Without this, the try-out path's last step tells a local agent to sync the developer's file to the hosted service. |
| Redirect origin | `CLIENT_URL` must be set in production | Defaults from `APP_URL` |
| Cookie `Secure` flag | Set on five cookies when `NODE_ENV=production` | Set when `APP_URL` is https |
| Image `NODE_ENV` | Not set in the Dockerfile; the Kubernetes overlay sets it | `production`, set in the Dockerfile |
| Boot sequence | `node server/index.js` | `node script/entrypoint.js`: secrets, then migrations, then the server |
| Secrets | Production refuses to boot without env values | Generated and persisted on first boot, env overrides |
| Health check | Dockerfile checks `/health` | Dockerfile checks `/ready` |
| User records | `users.google_id` is `NOT NULL UNIQUE`; creation upserts on it | Nullable; users resolved through `user_identities` |
| Migrations | Kubernetes Job only | On boot by default; Job kept in production |
| Image storage | S3 only; uploads return 503 without it | Local disk by default, served by a new `/raw` route; S3 optional |
| Email | SES variable names, port 465 fixed | Generic SMTP variables, SES names as aliases |
| Sign-in page | Google button only | Rendered from the instance's providers; local mode shows the CLI instruction |
| Consent page copy | "Continue with Google" | Rendered from the instance's providers |
| First admin | A migration hardcodes one email | The claim link creates the owner; the hosted service keeps its existing admin rows |
| Marketing, credits, notifications | Always on | Behind `SQUIRE_HOSTED` |

## Security considerations

- **Sign-in links** are single-use, expire in 15 minutes, are stored hashed, travel in the URL fragment, and can only be minted from inside the container.
- **Local mode exposure.** The default port binding is `127.0.0.1`. Serving plain HTTP on any other address is not supported. The app's Content Security Policy includes `upgrade-insecure-requests` (a Helmet default), so a browser reaching `http://192.168.x.x:3910` upgrades every request and the WebSocket to https, and the app does not load. Browsers exempt localhost from the upgrade, which is why the try-out path works. Anyone exposing an instance beyond their own machine puts a TLS-terminating reverse proxy in front and sets an https `APP_URL`. `squire doctor` reports an error when `APP_URL` is neither localhost nor https.
- **Pending invites.** Today pending invites convert by email at every sign-in. In local mode nobody but the owner can sign in, so this is safe. In team mode with local passwords, invites must convert only for verified email addresses; that rule belongs to the Authentication and Sharing amendment and must ship before local passwords do.
- **Development endpoints** stay behind `ENABLE_DEV_ENDPOINTS=1`, which the image never sets.
- **Generated secrets** are readable by anyone with access to the data volume, the same trust boundary as the database.

## Build sequence

Proposed pipeline features, in order:

1. **Self-host configuration foundation.** `APP_URL`, cookie flag, generated secrets, migrations on boot, local image storage, generic SMTP, `SQUIRE_HOSTED`, welcome template URLs. No user-visible change on the hosted service.
2. **Identity and local mode.** A `user_identities` table keyed by issuer and subject (Google rows backfilled), the provider registry and `GET /auth/providers`, `SQUIRE_MODE`, sign-in links, the `squire` CLI, and the sign-in and consent pages rendered from providers. Adds a migration.
3. **Distribution.** `compose.yml`, the GHCR multi-arch image, `AGENTS.md`, the README section, the documentation page, the `onboard.md` self-host branch, and a CI job that plays the agent: boot the stack, run `doctor`, redeem a claim link, and drive the OAuth chain with the existing `test/first-run/oauth-chain-driver.mjs` (which needs a sign-in-link leg in place of the dev faucet).
4. **Team mode.** Generic OIDC, local passwords, `SIGNUP_MODE`, and the verified-email invite rule, per the Authentication and Sharing amendment. Can follow launch.

Build step 2 also replaces the Google-only user creation. Today `users.google_id` is `NOT NULL UNIQUE` (`migrations/003_create_users_table.js`), `findOrCreateUser` upserts `ON CONFLICT (google_id)`, and `completePostAuth` takes a Google-shaped profile. Step 2 makes `google_id` nullable (kept for the hosted service's existing rows until a later cleanup), resolves users through `user_identities`, and changes `completePostAuth` to accept an already-resolved user so every sign-in method shares it.

The CI job in step 3 runs the production image, where `/auth/dev-login` returns 404, so its sign-in leg uses a CLI sign-in link. The feature 031 first-run collapse never fires in local mode (the claim link creates the account, not the OAuth round trip), so that path stays covered by the existing first-run tests in the development environment.

Repository work that is not a pipeline feature (licence, history scrub, moving production operations files out, `CONTRIBUTING`, `SECURITY.md`) is tracked separately.

## Decisions

Each decision lists the proposed default. None are ratified yet.

- **D1. Local mode is the default for a fresh install.** Proposed: yes. Team mode is opt-in through `SQUIRE_MODE=team`.
- **D2. Two clicks at launch.** Proposed: yes. The claim link and the consent card stay separate. Extending feature 031's auto-issue so a claim link can carry an `/authorize` request and approve it in one round trip is possible, but it changes a security-reviewed gate and can wait until the basic path ships.
- **D3. Docker Compose is the primary install, not a single all-in-one image.** Proposed: yes. An all-in-one image would have to run Postgres with pgvector inside the app container.
- **D4. Redis is bundled in the compose file.** Proposed: yes, even though the code runs without it.
- **D5. Sign-in links expire in 15 minutes and are single-use.** Proposed: yes.
- **D6. No email is needed in local mode.** Proposed: yes. Team-mode invites can be copied as links when SMTP is unset.
- **D7. A Docker-free install is deferred.** Proposed: yes. An `npx squire-docs` path with embedded Postgres (PGlite supports pgvector) would reach developers without Docker, but it means porting the `pg` pool, advisory locks, and node-pg-migrate to it.
- **D8. Hosted-only code stays in the repository behind ****`SQUIRE_HOSTED`****.** Proposed: yes. Moving it to a private repository gives a cleaner public tree at the cost of maintaining a split.
- **D9. The Claude Code plugin stays pointed at the hosted service.** Decided by Sam 2026-10-07. Self-hosters add their instance with `claude mcp add --transport http squire-local http://localhost:3910/mcp`. A plugin setting for the server URL (`user_config`) can be revisited once self-host users ask for it.
- **D10. A ****`./squire`**** wrapper script ships next to the compose file.** Decided by Sam 2026-10-07. It forwards its arguments to `docker compose exec app squire`, so a person can run `./squire claim-link` without an agent. AGENTS.md keeps the full docker command because it works from any folder.

## Open questions

- Should the plugin gain a `user_config` setting for its server URL, so plugin users can point it at a local instance instead of adding `squire-local` separately? This needs a test of how `user_config` behaves when the user leaves it blank.
  - I don't understand - I need more info
  - **Claude (10-07): **The Claude Code plugin ships a config file that tells Claude Code where the server is, and today that is always squiredocs.com. So a developer who has the plugin installed and also runs a local instance has two Squire Docs servers in Claude Code, and the agent has to pick the right one. There are two ways to handle it. (a) Leave the plugin pointing at the hosted service only, and have self-hosters add their local server with one command (claude mcp add ... squire-local). (b) Have the plugin ask for a server URL when it is installed (Claude Code calls this user_config), so one plugin can serve both. (b) is tidier but has an untested piece: what happens when someone leaves the URL blank. Recommendation: (a) at launch. Self-hosters already have the repo and AGENTS.md, so they do not need the plugin to get set up. Revisit (b) once there are self-host users asking for it.
    - a. leave it as is.
  - **Claude (10-07): **Resolved as D9: option (a).
- Default port: keep 3001, which matches development and production, or pick a less common port to avoid collisions on developer machines?
  - Pick a less common one
  - **Claude (10-07): **Resolved: the default host port is 3910, which none of the common dev tools use (3000, 3001, 4000, 5000, 5173, 8000, 8080). The container still listens on 3001 internally, so development and production do not change. The doc body is updated.
- Should `squire claim-link` be runnable from the host without `docker compose exec`, for example as a small script in the repository that wraps it?
  - I'm not sure i need more info
  - **Claude (10-07): **To mint a sign-in link today the command is docker compose exec app squire claim-link, and it has to be run from the folder holding compose.yml. Agents handle that fine. The case it matters for is a person signing back in without their agent, for example after a week away when their session has expired. The option is a tiny ./squire script shipped next to compose.yml that forwards to that command, so a person types ./squire claim-link. A second option: while the instance has no owner, the server also prints a claim link in its startup log, which is what Jupyter does, so docker compose logs app shows it. Recommendation: do both. AGENTS.md keeps the full docker command because it works from anywhere; the README tells people about ./squire.
    - sure let's add the wrapper
  - **Claude (10-07): **Resolved as D10: the wrapper is in. The startup-log claim link was not adopted; it stays out unless Sam wants it.
- Licence and git history handling are decided outside this document but block publishing.
  - ok