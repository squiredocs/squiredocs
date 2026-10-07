# Research: 058 Self-Host Configuration Foundation

Phase 0 output for `plan.md`. Every item below was checked against the code at
commit `1720536d` (2026-10-07). Decisions that pick a product default are also
recorded in `clarifications-needed.md` (RBD-058-18 onward); this file holds the
technical reasoning.

No `NEEDS CLARIFICATION` remains in the Technical Context.

---

## R1. Where instance configuration lives and how consumers read it

**Decision**: New module `server/instance-config.js`. It exports a pure
`resolveInstanceConfig(env)` that returns a frozen object (or throws a
`ConfigError` naming the variable), a memoized `getInstanceConfig()` that
resolves `process.env` on first call, `_resetInstanceConfigForTests()`, and a
`hostedOnly` Express middleware. The module requires nothing from `server/`
(only `node:url` and `node:path`), so `server/auth/jwt.js`, `server/email.js`,
and `server/crypto.js` can require it without a cycle.

Consumers call `getInstanceConfig()` at call time where they can (cookie
options, email transport, quota check, CSP builder, route gates). Modules that
compute a constant at load time today (`server/auth/jwt.js` cookie bases,
`server/auth/google.js` redirect URI, `server/url.js` `PUBLIC_ORIGIN`) switch to
a getter so a test can change config without `jest.isolateModules`.

**Rationale**: RBD-058-16 requires one resolution point. A pure resolver makes
the default chain unit-testable with plain objects. Call-time reads let
integration tests flip `SQUIRE_HOSTED` between cases in one file, which is the
cheapest way to test both the hosted and self-hosted branches of the same
production route (Constitution II).

**Alternatives considered**: Reading `process.env` in each module (the status
quo that produced the `NODE_ENV` unset incident). A config object passed down
from `server/index.js` (does not reach modules that load before it, such as
`jwt.js`).

## R2. `APP_URL` default chain

**Decision**: explicit `APP_URL`, else `CLIENT_URL`, else
`http://localhost:<PORT or 3001>`. Normalized with `new URL(v).origin`; a value
that is not an absolute `http:` or `https:` URL throws naming `APP_URL` (or
`CLIENT_URL` when that was the source). `SQUIRE_PORT` is not consulted
(RBD-058-18).

**Rationale**: The design was amended on 2026-10-07 after the spec was written:
"Inside the container it defaults to `CLIENT_URL` if set, else
`http://localhost:<PORT>`. The container cannot see the host port, so
`compose.yml` passes `APP_URL` explicitly." Constitution VI makes the design
win over spec FR-009 and RBD-058-1, which still name `SQUIRE_PORT`. Dropping it
removes a variable that would only ever be set by mistake inside the container.

Derived values: `CLIENT_URL` defaults to `APP_URL`;
`GOOGLE_REDIRECT_URI` defaults to `${APP_URL}/auth/google/callback`;
`PUBLIC_ORIGIN` defaults to `APP_URL`. `cookieSecure` is
`new URL(APP_URL).protocol === 'https:'`.

**Hosted check**: the overlay sets `APP_URL=https://squiredocs.com` and keeps
the `CLIENT_URL` secret (also `https://squiredocs.com`), so every derived value
is byte-identical to today.

**Development check**: with neither `APP_URL` nor `CLIENT_URL`, `CLIENT_URL`
becomes `http://localhost:3001` instead of today's `http://localhost:5173`
(RBD-058-30). `.env.example` keeps `CLIENT_URL=http://localhost:5173`, the CORS
allow-list keeps both localhost origins, and `getClientUrl` in development still
prefers the request's `Origin` or `Referer`, so the Vite workflow is unchanged.

## R3. Entrypoint ordering and how to test it

**Decision**: `script/entrypoint.js` is a thin file that calls
`main()` from `server/boot/entrypoint.js`. `main({ env = process.env,
serverModule = '../index.js', dotenvPath = '.env', log = console })` runs, in order:

1. `require('dotenv').config()` so a `.env` value is in `env` before the secrets
   file is consulted (dotenv never overrides existing variables, so loading it
   after the secrets file would let the file beat `.env`; RBD-058-25).
1a. `require('../telemetry').start()`. `server/index.js` starts OpenTelemetry
   first because its require hooks only instrument modules loaded after it;
   the entrypoint loads `pg` (for the migration lock) and writes boot log
   lines before `server/index.js` runs, so it must start telemetry itself.
   `start()` is idempotent, so the call in `server/index.js` becomes a no-op
   (RBD-058-32). `server/boot/migrate-lock.js` also requires `pg` lazily inside
   the function, so a hosted boot (`MIGRATE_ON_BOOT=false`) never loads it
   early.
2. `resolveInstanceConfig(env)`: fail fast on a bad `APP_URL`,
   `STORAGE_DRIVER`, or `SQUIRE_DATA_DIR`.
3. `resolveSecrets({ env, dataDir })` from `server/boot/secrets.js`, which
   writes the four values into `env`.
4. `if (config.migrateOnBoot) await runMigrationsWithLock({ env, log })` from
   `server/boot/migrate-lock.js`.
5. `require(serverModule)`.

`script/entrypoint.js` catches any rejection, prints the message, and exits 1.

**Test**: `server/__tests__/entrypoint-order.test.js` calls `main()` in-process
with `NODE_ENV=production`, the four secrets deleted, `SQUIRE_DATA_DIR` set to a
temp directory, `MIGRATE_ON_BOOT=false`, and `serverModule` pointing at a
fixture (`server/__tests__/fixtures/entrypoint-probe-server.js`) that requires
the real `server/auth/jwt.js`, `server/mcp/auth/jwt.js`, and `server/crypto.js`
and calls `crypto.encrypt('probe')`. Each require runs inside
`jest.isolateModules` so the module-load guards execute fresh. A control case
requires the fixture without calling `main()` and asserts it throws the
`FATAL: ACCESS_TOKEN_SECRET` error, proving the test would catch a reordering.
This exercises the real guards, not a mirror.

**Alternatives considered**: An env variable that swaps the server module
(a production-code seam whose only purpose is testing). Spawning the real image
(covered by `quickstart.md`, too slow for the unit suite).

## R4. Secrets file

**Decision**: `server/boot/secrets.js` exports
`resolveSecrets({ env, dataDir, generate = true })` and
`SECRET_NAMES = ['ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET', 'MCP_JWT_SECRET', 'API_KEY_ENCRYPTION_KEY']`.

- For each name: environment wins; else the file's value; else, when
  `generate` is true, `crypto.randomBytes(32).toString('hex')` (64 hex
  characters, which satisfies `crypto.js`'s key parser and the JWT guards).
- `API_KEY_ENCRYPTION_KEY` is skipped (neither read nor generated) when
  `API_KEY_ENCRYPTION_KEYS` is set: an operator running a keyring rotation has
  chosen keys explicitly, and a generated legacy key would turn a clear
  "missing key" error into a silent wrong-key decrypt failure (RBD-058-26).
- The file is read with `fs.readFileSync`; a missing file is an empty object;
  any other read error, a parse error, or a non-object JSON value throws naming
  the path and saying not to delete it (deleting it loses the BYOK key).
- Written only when at least one value was generated: merge the existing file
  object with the new values (never environment values), write
  `secrets.json.tmp-<pid>` with `{ mode: 0o600, flag: 'wx' }`, `fsync`, then
  publish it. When no file existed, publish with `fs.linkSync(tmp, final)`
  (fails with `EEXIST` if another replica on the same volume won the race; the
  loser deletes its temp file, re-reads the winner's file, and adopts its
  values), so two replicas starting together on a shared volume can never end
  up with different secrets (Constitution VII, RBD-058-31). When adding a
  missing key to an existing file, publish with `rename`. A write error throws: "Cannot write <path>: the data directory must
  be writable by the app user (uid 100). For a bind mount run
  `chown -R 100:101 <dir>`."
- `generate: false` is the read-only mode feature 059's `squire` CLI uses to
  load the same secrets without ever creating them.

**Rationale**: FR-003, FR-004, RBD-058-9, plus the keyring edge the spec did not
consider.

## R5. Migrations on boot under an advisory lock

**Decision**: `server/boot/migrate-lock.js` exports
`runMigrationsWithLock({ env, log, connectTimeoutMs = 60000, runMigrate })`.

- Builds its own pg connection config from `DATABASE_URL` or the `DB_*`
  variables (same defaults as `server/index.js`), without writing
  `DATABASE_URL` into the server's environment (RBD-058-25:
  `script/setup-db-env.js` does not URL-encode the password, and the server
  keeps its object config).
- Connects with retry: exponential backoff from 500 ms capped at 5 s, total
  budget `connectTimeoutMs`; on exhaustion throws "Postgres at host:port did not
  accept connections within 60s".
- `SELECT pg_advisory_lock($1)` with `MIGRATE_LOCK_KEY`, a named constant
  distinct from node-pg-migrate's internal lock key `7241865325823964`
  (RBD-058-24). node-pg-migrate takes its own lock on a separate connection in
  the child process; reusing its key would deadlock the child against its
  parent.
- `runMigrate` defaults to spawning `node script/migrate.js` with
  `stdio: 'inherit'` and the parent's environment (the child builds its own
  `DATABASE_URL` through `setup-db-env.js`, exactly as the Kubernetes Job
  does). Non-zero exit rejects with the exit code.
- `pg_advisory_unlock` and `client.end()` in `finally`.

The lock wraps the whole of `script/migrate.js`, including its pre-step
`pgmigrations` dedupe, which today runs outside any lock.

**Test**: `server/__tests__/migrate-lock.test.js` (integration, per-worker
database).
1. Two concurrent `runMigrationsWithLock` calls with a `runMigrate` stub that
   records enter and exit timestamps and sleeps 200 ms: the intervals do not
   overlap.
2. One call with the default `runMigrate` against the worker's already
   migrated database exits 0 (node-pg-migrate reports no migrations to run).
3. A stub that rejects: the call rejects and the lock is released (a second
   call acquires it immediately).
4. Connection to an unused port with `connectTimeoutMs: 1500`: rejects with the
   timeout message.
The "empty database" case (US1 scenario 4) is covered by `quickstart.md`
against the built image, because creating and fully migrating a scratch
database per test run costs far more than the unit suite's budget and the Job
already exercises the same `script/migrate.js` on every deploy.

## R6. Cookie `Secure` flag

**Decision**: `server/auth/jwt.js` replaces the load-time `COOKIE_BASE` with
`cookieBase()` that reads `getInstanceConfig().cookieSecure` for `secure` and
keeps `sameSite: isProduction ? 'strict' : 'lax'`. `getCookieOptions`,
`getAccessTokenCookieOptions`, and `getClearCookieOptions` call it.
`server/auth/routes.js` replaces `secure: isProduction` on the three transient
OAuth cookies with `secure: getInstanceConfig().cookieSecure`. Nothing else in
`routes.js` changes (it is the file feature 059 rewrites most).

**Test**: `server/auth/__tests__/cookie-secure.test.js` (unit, real `jwt.js`
functions) for both schemes in production and development; and
`server/__tests__/auth-oauth-cookies.test.js` mounting the real `routes.js`
router with supertest, hitting `GET /auth/google` with stub Google credentials,
and asserting the three `Set-Cookie` headers.

## R7. Image storage interface

**Decision**: New directory `server/image-storage/`:

- `index.js`: the facade. Selects the driver from `getInstanceConfig().storageDriver`
  on first use and re-exports `isEnabled`, `cspImageSources`, `putObject`,
  `getObject`, `readObject`, `getSignedGetUrl`, `copyObject`, `deleteObjects`,
  plus `kind` (`'local'` or `'s3'`).
- `s3-driver.js`: today's `server/s3-images.js` moved verbatim, plus
  `S3_ENDPOINT` (`endpoint` and `forcePathStyle: true` on the client;
  `cspImageSources` returns `new URL(S3_ENDPOINT).origin` when set) and
  `readObject` (returns `{ body, contentType }` from `GetObjectCommand`).
- `local-driver.js`: bytes under `<dataDir>/images/objects/<key>`, content type
  under `<dataDir>/images/meta/<key>.json`. `keyToPath` rejects empty keys, keys
  containing `\0` or `\\`, absolute keys, and any key whose resolved path is
  not strictly inside the root (`path.relative` starts with `..` or is
  absolute). Writes are temp-file-plus-rename. `isEnabled()` runs a one-time
  `mkdir -p` and `fs.accessSync(W_OK)` and caches the result, logging once on
  failure. `getSignedGetUrl` throws (callers branch on `kind`).
  `deleteObjects` ignores `ENOENT`. `cspImageSources` returns `[]`.

`server/s3-images.js` is deleted; every consumer requires
`./image-storage` instead (RBD-058-19). The consumers, all verified with
`git grep`: `server/index.js`, `server/document-images.js`,
`server/api/chat-attachments.js`, `server/api/chat.js`,
`server/api/chat-tools.js`, `server/api/docs-export.js`,
`server/image-rehost.js`, `server/mcp/image-validate.js`. The `jest.mock`
path changes in 13 test files (listed in `tasks.md`).

**Test safety**: `server/__tests__/setup.js` sets `SQUIRE_DATA_DIR` to a
per-worker, per-process temp directory and deletes `STORAGE_DRIVER`, so a
suite that forgets a mock writes to a throwaway directory, never to `/data`
or another worker's files.

**Rationale**: FR-015 to FR-019. A facade keeps the driver choice invisible to
the eight consumers. Keeping the file name `s3-images.js` for the facade would
leave a misleading name on the path every self-hoster's images go through.

## R8. Raw routes and how a browser authenticates them

**Finding**: `requireAuth` (`server/auth/middleware.js:52`) accepts only an
`Authorization` header. The client resolves `/api/docs/:docId/images/:imageId`
with a Bearer request and puts the returned URL in `<img src>`, which sends
cookies only. A raw route behind `requireAuth` would 401 every image.

**Decision**: New middleware `requireAuthOrCookie` in
`server/auth/middleware.js`: an `Authorization` header goes through the same
path as `requireAuth`; otherwise the `accessToken` cookie is verified with
`permissions.extractUser({ queryToken })`, the same call the WebSocket upgrade
uses for the same cookie (`server/index.js:1829`). Scope checks apply as in
`requireAuth` (RBD-058-20).

The access cookie is `httpOnly`, path `/`, `SameSite=Strict` in production,
and is re-issued by every `/auth/refresh`, and the resolve call that precedes
each raw fetch goes through the client's refresh-on-401 logic, so the cookie is
fresh when the `<img>` loads. A stale cookie shows the existing "Image
unavailable" placeholder, the same outcome as an expired presigned URL today.

**Routes** (contracts in `contracts/http-routes.md`):

- `GET /api/docs/:docId/images/:imageId/raw`: `requireAuthOrCookie`, then
  `documents.hasAccess`, then `documentImages.getImage(imageId, docId)`,
  then `storage.readObject(row.s3_key)`. Content type from the row (it is
  already constrained to the four allowed image types at upload).
- `GET /api/chat/attachments/raw?ref=attachment:<key>`:
  `requireAuthOrCookie`, then `attachmentKeyForUser(ref, userId)` (existing
  ownership rule), then `storage.readObject(key)`. Streams only if the stored
  content type is in `ALLOWED_IMAGE_MIME_TYPES`; otherwise 404.

Both set `Cache-Control: private, max-age=3600`,
`X-Content-Type-Options: nosniff`, and
`Content-Security-Policy: default-src 'none'; sandbox` (defense in depth on a
same-origin byte route; Constitution V). Both routes are mounted whatever the
driver; with the S3 driver they serve bytes too (harmless, and it keeps the
contract driver-independent).

With the local driver, the resolve routes return `{ url: <relative raw path> }`
(RBD-058-14). With S3 they return the presigned URL as today.

**Route extraction**: the upload and resolve routes move out of
`server/index.js` (move-only) into `server/api/document-images-routes.js`
(`createDocumentImagesRouter({ documents, documentImages, storage,
notifyException })`), next to the new raw route, so tests mount the production
router instead of re-implementing it.

## R9. Hosted-only gating mechanism

**Decision**:

- `hostedOnly(req, res, next)`: `getInstanceConfig().hosted ? next() : next('route')`.
  Placed first in a route's handler list, a gated route behaves exactly like an
  unregistered one: Express skips to the next matching route and, for a `POST`,
  falls through to the default "Cannot POST" 404 (FR-028, RBD-058-29).
  - `POST /api/admin/users/:userId/welcome-email` (`server/api/admin.js`).
  - `POST /auth/prod-reset-selftest-account` (`server/auth/routes.js`, one
    line).
- Pages, CSP, and the app shell move into `server/web-routes.js`:
  `buildCspDirectives({ hosted, storage })` and
  `mountWebRoutes(app, { clientBuildPath, config, storage })`. When hosted,
  it mounts exactly today's routes in today's order (landing, pricing, about,
  security, documentation, blog, static, shell). When not hosted, it mounts
  documentation, a 404 for the hosted paths and their static-file variants, the
  `/agents.md` rewriter, static with `index: false`, and the shell for `/` and
  `*` (RBD-058-27).
- The old-domain 301 middleware in `server/index.js` is wrapped in
  `if (config.hosted)`.
- `notifyNewUser` and `notifyLogin` in `server/email.js` return early when not
  hosted (RBD-058-23). The call sites in `completePostAuth` are untouched, so
  feature 059's rewrite of that function does not conflict.
- `checkQuota` in `server/ai-usage.js`: when not hosted, still runs the usage
  query, and returns `{ allowed: true, notApplicable: true, creditCents,
  usedCents, remainingCents, extraCreditCents }`. `server/api/chat.js` already
  fires `notifyCreditLimitReached` only on `!allowed`, so it never fires.
- OpenRouter `HTTP-Referer` in `server/api/ai-providers.js` becomes
  `getInstanceConfig().appUrl` (read when the headers are built).

## R10. App shell injection and the client's hosted flag

**Decision**: `server/app-shell.js` exports `renderAppShell(html, { hosted })`.
It inserts, right after `<head>`:

- when hosted: the Google tag snippet exactly as it appears in
  `client/index.html` today (moved into this module as a constant);
- always: `<script>window.__SQUIRE_INSTANCE__={"hosted":true|false}</script>`.

The analytics snippet is removed from `client/index.html`. `mountWebRoutes`
reads `client/dist/index.html` once at mount, renders it once per flag value,
and serves the string with `Content-Type: text/html; charset=utf-8` and
`Cache-Control: public, max-age=0` (what `res.sendFile` sends today).
`express.static` runs with `index: false`, and `/index.html` is routed to the
shell, so no path serves the un-injected file.

Vite development: `client/vite.config.js` gains a `transformIndexHtml` plugin
that loads `server/app-shell.js` through `createRequire` and applies it with
`SQUIRE_HOSTED` from the dev pod's environment; the existing marketing
static-pages plugin is gated on the same flag. The app-dev pod sets
`SQUIRE_HOSTED=true` so development keeps mirroring the hosted service
(RBD-058-28).

Client: new `client/src/instance.js` exports `isHosted()` returning
`window.__SQUIRE_INSTANCE__?.hosted === true` (default false: an instance that
forgot to inject behaves as self-hosted, which never leaks hosted text).
Consumers: `client/src/components/LoginPage.jsx` (legal links),
`client/src/pages/SettingsPage.jsx` (beta note, usage meter also hidden when
`usage.notApplicable`, MCP URL from `window.location.origin`),
`client/src/pages/AdminPage.jsx` (welcome-email column button and self-test
card), `client/src/App.jsx` (`/privacy`, `/terms` views fall back to the
landing view when not hosted, for client-side navigation).

## R11. Text that names the server

**Decision**:

- `server/mcp/tools/tool-documentation/export-api.js` exports
  `buildExportApiDocumentation(baseUrl)`; the seven hardcoded URLs become
  `${baseUrl}`. `tool-documentation/index.js` builds the `rest_api` entry per
  base URL (a small `Map` cache) and `getDocs(tool, { baseUrl })` /
  `getSection(tool, id, { baseUrl })` accept it. `get-tool-documentation.js`
  passes `agentToken.baseUrl || getInstanceConfig().appUrl`.
  `EXPORT_API_DOCUMENTATION` stays exported, built with the hosted origin, for
  the existing size and section tests.
- `create-access-token.js` (two places) and `import-markdown-file.js`: fallback
  becomes `getInstanceConfig().appUrl`.
- `server/onboarding/welcome-template.js` exports
  `buildWelcomeDocNodes({ appUrl, hosted })`; `WELCOME_DOC_NODES` stays as
  `buildWelcomeDocNodes({ appUrl: 'https://squiredocs.com', hosted: true })` so
  the hosted output is byte-identical and existing imports keep working.
  `server/onboarding.js` calls the builder with the instance config. Hosted-only
  nodes: the support paragraph and the "currently in free public beta,
  including a $10 AI credit allotment" sentence (RBD-058-22).
- `/agents.md`: when not hosted, a route reads `client/dist/agents.md` once and
  serves it with every `https://squiredocs.com` replaced by
  `buildBaseUrl(req)`, `Content-Type: text/markdown; charset=utf-8`. When hosted
  the static middleware serves the file as today.

## R12. Generic SMTP

**Decision**: `resolveInstanceConfig` produces `config.smtp`:
`{ host, port, secure, user, pass, from, viaSesAliases }` with
`host = SMTP_HOST || SES_SMTP_HOST || (viaSesAliases ? 'email-smtp.us-west-2.amazonaws.com' : undefined)`,
`port = Number(SMTP_PORT) || 465`, `secure = SMTP_SECURE ? SMTP_SECURE === 'true' : port === 465`,
`user = SMTP_USER || SES_SMTP_USER`, `pass = SMTP_PASS || SES_SMTP_PASS`,
`from = SMTP_FROM || SES_FROM_EMAIL`. `viaSesAliases` is true when no
generic `SMTP_*` name is set and at least one `SES_*` name is.
`server/email.js` reads it lazily; `sendEmail` skips with no per-message
warning when `from` is unset; `server/index.js` logs one boot line
`[Email] off (no SMTP_FROM)`. The admin welcome-email 503 message names
`SMTP_FROM`. A `from` with no `host` (generic names, no host) logs one boot
warning and every send skips.

## R13. Hosted production safety review

Every hosted behavior was traced against the overlay values
(`SQUIRE_HOSTED=true`, `MIGRATE_ON_BOOT=false`,
`APP_URL=https://squiredocs.com`, `STORAGE_DRIVER=s3`) plus today's secrets:

| Area | Hosted result | Why identical |
| --- | --- | --- |
| Boot | Entrypoint finds all four secrets in env, never touches `/data`, skips migrations, requires `server/index.js` | env wins (FR-003); `MIGRATE_ON_BOOT=false` |
| Migrate Job | `command: ["npm"] args: ["run","migrate"]` overrides `CMD` | The Dockerfile keeps `CMD`, not `ENTRYPOINT` |
| Cookies | `Secure` and `SameSite=Strict` | `APP_URL` is https; `NODE_ENV=production` |
| Redirects | `CLIENT_URL` secret unchanged | explicit value wins |
| Google callback | `GOOGLE_REDIRECT_URI` secret unchanged | explicit value wins |
| `PUBLIC_ORIGIN` | `https://squiredocs.com` | defaults to `APP_URL` |
| Images | S3, same CSP origin | `STORAGE_DRIVER=s3`, no `S3_ENDPOINT` |
| Email | SES host default, 465, implicit TLS | only `SES_*` set, `viaSesAliases` |
| Pages, CSP, analytics, credits, emails, admin controls | present | `SQUIRE_HOSTED=true` |
| Probes | readiness `/ready`, liveness `/health` | overlay unchanged; Dockerfile `HEALTHCHECK` is ignored by Kubernetes |
| Securitycontext | runs as uid 100 | `/data` is created in the image but never written in hosted |

## R14. Integration points left for feature 059

- `getInstanceConfig().appUrl` is the link base for `${APP_URL}/claim#<token>`.
- `resolveSecrets({ env, dataDir, generate: false })` is the CLI's secret
  loader.
- `server/boot/entrypoint.js` `main()` is where 059 can add nothing: the
  startup-log claim link belongs after `lifecycle` marks ready inside
  `server/index.js`.
- `hostedOnly` and `getInstanceConfig().hosted` are available for 059's sign-in
  page decisions; 059 owns `SQUIRE_MODE` and adds it to the same module.
- 058 adds no migration, so 059's migration remains the campaign's only one
  (numbered above `1795000000000`).
