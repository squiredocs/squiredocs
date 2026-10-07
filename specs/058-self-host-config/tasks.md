---
description: "Task list for 058 self-host configuration foundation"
---

# Tasks: Self-Host Configuration Foundation

**Input**: `specs/058-self-host-config/` (plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md, clarifications-needed.md)

**Prerequisites**: plan.md, spec.md

**Tests**: Required. FR-038 and Constitution II make tests part of every story. Backend tests run with `npm run test:server` (per-worker database, `DATABASE_URL` is a BASE name); client tests with `npm run test:client`. Tests must exercise production modules, not copies of route code. Suites that create documents clean them up by `doc_guid`; users and images by their ids.

**Migration**: none. Do not add a node-pg-migrate migration in this feature.

**NUL bytes**: some server files contain NUL bytes and plain `grep` silently misses matches. Use `git grep` or `rg` for every search in these tasks.

**Organization**: grouped by user story (spec priorities: US1 P1, US2 P1, US3 P2, US4 P2, US5 P3, US6 P3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 to US6

---

## Phase 1: Setup

- [ ] T001 Normalize the test environment in `server/__tests__/setup.js`: delete `SQUIRE_HOSTED`, `APP_URL`, `STORAGE_DRIVER`, `S3_ENDPOINT`, `MIGRATE_ON_BOOT`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` from `process.env`; set `SQUIRE_DATA_DIR` to `path.join(os.tmpdir(), 'squire-test-data-w' + getWorkerId() + '-' + process.pid)` (create it; register an `afterAll`-safe cleanup via `process.on('exit')` with `fs.rmSync(..., { recursive: true, force: true })`). Comment why (RBD-058-19, RBD-058-28).
- [ ] T002 [P] Add `/.squire-data/` to `.gitignore`.

---

## Phase 2: Foundational (blocks every story)

- [ ] T003 Create `server/instance-config.js` per `data-model.md` section 1 and `contracts/storage-and-boot.md`: pure `resolveInstanceConfig(env)` returning a frozen object (`appUrl`, `appUrlSource`, `clientUrl`, `googleRedirectUri`, `publicOrigin`, `cookieSecure`, `insecureRemoteHttp`, `hosted`, `hostedInvalidValue`, `dataDir`, `migrateOnBoot`, `storageDriver`, `s3`, `smtp`), `ConfigError` with messages from `contracts/environment.md`, memoized `getInstanceConfig()`, `_resetInstanceConfigForTests()`, and `hostedOnly(req, res, next)` (`next('route')` when not hosted). Require only `node:` built-ins. `APP_URL` chain per RBD-058-18 (no `SQUIRE_PORT`); SMTP per research R12.
- [ ] T004 [P] Unit suite `server/__tests__/instance-config.test.js` against the real `resolveInstanceConfig`: APP_URL chain (explicit, from CLIENT_URL, default with PORT and without), origin normalization (path and trailing slash dropped), invalid APP_URL and invalid CLIENT_URL-as-source errors name the variable; CLIENT_URL, GOOGLE_REDIRECT_URI, PUBLIC_ORIGIN defaults and explicit overrides; `cookieSecure` for http and https; `insecureRemoteHttp` for `http://192.168.1.5`, `http://localhost`, `http://127.0.0.1`, `http://[::1]` in production and development; SQUIRE_HOSTED `true`/`TRUE`/`false`/unset/`1`/`yes`; STORAGE_DRIVER auto-detect with and without `S3_IMAGE_BUCKET`, explicit `local`/`s3`, unknown value error lists `local, s3`; MIGRATE_ON_BOOT default and invalid; SQUIRE_DATA_DIR relative path error; S3_ENDPOINT invalid; and the SMTP matrix (generic only, SES only with no host gives `email-smtp.us-west-2.amazonaws.com`, port 465 and `secure: true`, both set with generic winning, `SMTP_PORT=587` gives `secure: false`, `SMTP_SECURE` override, no sender). Also assert `hostedOnly` calls `next('route')` and `next()` for the two flag values.

**Checkpoint**: config module green. Stories can start.

---

## Phase 3: User Story 1 - The image boots with nothing configured (P1) MVP

**Goal**: entrypoint resolves secrets, migrates under a lock, then loads the server; image runs in production mode with `/ready` health.

**Independent test**: quickstart step 1, plus the suites below.

### Tests for US1

- [ ] T005 [P] [US1] Unit suite `server/__tests__/boot-secrets.test.js` against `server/boot/secrets.js` with a temp `dataDir` per test: fresh dir generates four 64-hex values, writes `secrets.json` with mode `0o600` (check `fs.statSync(...).mode & 0o777`), mutates `env`; second call reuses the file and writes nothing (mtime unchanged); env value wins and is never written to the file; a file missing one key gets only that key added and other keys (including an unknown future key) preserved; unparseable file and a JSON array both throw naming the path and are left byte-identical; unwritable dir (chmod `0o500`, skip when running as root) throws naming the dir and the `chown` fix; `API_KEY_ENCRYPTION_KEYS` set means `API_KEY_ENCRYPTION_KEY` is neither read nor generated (RBD-058-26); `generate: false` reads but never creates; two `resolveSecrets` calls racing on one empty dir (one forced to lose by pre-creating the final file between its generate and publish steps through an injected hook, or by running the two in child processes) end with identical values in both `env` objects (RBD-058-31); the log line lists names only, never values.
- [ ] T006 [P] [US1] Integration suite `server/__tests__/migrate-lock.test.js` against `server/boot/migrate-lock.js` using the worker's database from `helpers/db.js` (research R5): two concurrent calls with a recording `runMigrate` stub never overlap; default `runMigrate` against the already-migrated worker database resolves; a rejecting stub rejects and releases the lock (a following call acquires within 1 s); `connectTimeoutMs: 1500` against an unused port rejects with the "did not accept connections" message; assert `MIGRATE_LOCK_KEY !== 7241865325823964`. Do not write to any database other than the worker's.
- [ ] T007 [P] [US1] Create fixture `server/__tests__/fixtures/entrypoint-probe-server.js` that requires the real `server/auth/jwt.js`, `server/mcp/auth/jwt.js`, and `server/crypto.js`, calls `crypto.encrypt('probe')`, and sets `global.__entrypointProbe = { ok: true, env: { ...selected names present } }`.
- [ ] T008 [US1] Ordering suite `server/__tests__/entrypoint-order.test.js` against `server/boot/entrypoint.js`: inside `jest.isolateModules`, with `NODE_ENV=production`, the four secrets deleted, temp `SQUIRE_DATA_DIR`, `MIGRATE_ON_BOOT=false`, `main({ serverModule: <fixture>, dotenvPath: <nonexistent> })` resolves and the probe reports ok; control case requires the fixture directly under the same env and expects the `FATAL: ACCESS_TOKEN_SECRET` throw; invalid `STORAGE_DRIVER` rejects before any secrets file is written; with `MIGRATE_ON_BOOT=true` and a stubbed `runMigrationsWithLock` (jest.mock of `server/boot/migrate-lock.js`) the call order is telemetry start, secrets, then migrate, then server require (spy on `server/telemetry.js` `start`), and a migrate rejection means the fixture is never required. Restore `process.env` after each test.

### Implementation for US1

- [ ] T009 [P] [US1] Implement `server/boot/secrets.js` per research R4 and `contracts/storage-and-boot.md` (`SECRET_NAMES`, `resolveSecrets({ env, dataDir, generate, log })`, atomic write with `wx` temp file, `fsync`, then `linkSync` for first creation (adopt the winner's file on `EEXIST`) or `rename` when adding a key, mode `0o600`, `SecretsError`).
- [ ] T010 [P] [US1] Implement `server/boot/migrate-lock.js` per research R5 (`MIGRATE_LOCK_KEY` named constant with a comment explaining the distinct key, connection config from `DATABASE_URL` or `DB_*` without mutating `env`, bounded retry, `pg_advisory_lock`, default `runMigrate` spawning `node script/migrate.js` with `stdio: 'inherit'`, unlock and `end()` in `finally`).
- [ ] T011 [US1] Implement `server/boot/entrypoint.js` `main({ env, serverModule, dotenvPath, log })` (`dotenvPath` defaults to `.env` in the working directory; tests pass a path that does not exist so a developer's real `.env` never leaks in) in the order of research R3 (dotenv first, RBD-058-25; then `telemetry.start()`, RBD-058-32; `pg` required lazily in `migrate-lock.js`), and `script/entrypoint.js` as the launcher that prints `[Boot] <message>` and exits 1 on rejection. Depends on T003, T009, T010.
- [ ] T012 [US1] Update `Dockerfile` per `contracts/storage-and-boot.md`: `ENV NODE_ENV=production SQUIRE_DATA_DIR=/data MIGRATE_ON_BOOT=true`; `RUN mkdir -p /data && chown appuser:appgroup /data && chmod 0750 /data` before `USER appuser`; `HEALTHCHECK` on `http://localhost:3001/ready` with `--start-period=90s`; `CMD ["node", "script/entrypoint.js"]` (keep `CMD`, not `ENTRYPOINT`, so the migrate Job's `command:` still overrides it). Update the comments that reference `/health` and the migrate Job.
- [ ] T013 [US1] In `server/index.js`, after config resolution, log the one-time boot lines from `contracts/environment.md` (`SQUIRE_HOSTED` invalid value, plain-http remote warning, email off) by reading `getInstanceConfig()`; call `getInstanceConfig()` near the top so `npm run dev` (which bypasses the entrypoint) still fails fast on invalid config. Leave the `[SECURITY] NODE_ENV` assertion as it is.

**Checkpoint**: US1 suites green; the image boots bare (quickstart step 1, maintainer machine).

---

## Phase 4: User Story 2 - The hosted service keeps running unchanged (P1)

**Goal**: production overlay pins every new value; hosted behavior is asserted with the flag on.

**Independent test**: quickstart step 6 render; hosted-parity suite.

- [ ] T014 [P] [US2] Create `k8s/overlays/aws-prod/patches/app-self-host-config.yaml` (Deployment `collab-app`, container `collab-app`, env `SQUIRE_HOSTED="true"`, `MIGRATE_ON_BOOT="false"`, `APP_URL="https://squiredocs.com"`, `STORAGE_DRIVER="s3"`, header comment citing FR-036) and add `- path: patches/app-self-host-config.yaml` to `k8s/overlays/aws-prod/kustomization.yaml` with a comment.
- [ ] T015 [P] [US2] Update the header comment in `k8s/overlays/aws-prod/patches/app-node-env.yaml`: the image now defaults `NODE_ENV=production`; the patch stays as belt and braces; the minikube base pod is no longer development mode. No value change.
- [ ] T016 [P] [US2] Create `k8s/overlays/minikube/patches/app-self-host-config.yaml` (collab-app env `SQUIRE_HOSTED="true"`, `MIGRATE_ON_BOOT="false"`), add it to `k8s/overlays/minikube/kustomization.yaml`, and update that file's header comment (base pod now runs production mode from the image, RBD-058-15).
- [ ] T017 [P] [US2] Add env `SQUIRE_HOSTED` value `"true"` to the app-dev container in both `k8s/overlays/minikube/app-dev.yaml` and `devcontainer/k8s/app-dev.yaml` (the hardened sandbox pod that supersedes it; takes effect on the next sandbox `up`, never restart from inside the pod), with a comment pointing at RBD-058-28.
- [ ] T018 [US2] Render check: run `kubectl kustomize k8s/overlays/aws-prod` and `kubectl kustomize k8s/overlays/minikube` in the app-dev pod (render only, never apply; kubectl defaults to production contexts) and confirm the values in quickstart step 6 and that `db-migrate-job` still runs `npm run migrate`. Record the output summary in `specs/058-self-host-config/promotion-notes.md`.
- [ ] T019 [US2] Hosted-parity integration suite `server/__tests__/hosted-parity.test.js`: with `SQUIRE_HOSTED=true` and `APP_URL=https://squiredocs.com`, mount the production `mountWebRoutes` (T049) against a temp client build directory containing stub `landing.html`, `pricing.html`, `about.html`, `security.html`, `index.html`, `agents.md`, `documentation/`, `blog/`; assert `/`, `/pricing`, `/about`, `/security` serve their files, `/privacy` and `/terms` serve the shell, the shell contains the analytics snippet and `{"hosted":true}`, `/agents.md` is verbatim, the CSP contains the Google sources; with `buildCspDirectives` and an S3 storage stub assert the bucket origin is in `img-src`; assert the jwt cookie options carry `secure: true, sameSite: 'strict'` under `NODE_ENV=production`; assert `resolveInstanceConfig` with only the production `SES_*` names yields host `email-smtp.us-west-2.amazonaws.com`, port 465, `secure: true`. Depends on T049, T024.
- [ ] T020 [US2] Make existing suites that assert hosted behavior set `SQUIRE_HOSTED=true` before requiring modules (and `_resetInstanceConfigForTests()` where they reset env): at least `server/__tests__/admin-welcome-email.test.js`, `server/__tests__/integration/prod-reset.test.js`, `server/__tests__/ai-usage.test.js`, `server/__tests__/ai-usage-byok.test.js`, `server/__tests__/onboarding.test.js`, and any suite asserting `notifyNewUser` or `notifyLogin` sends (find them with `git grep -n "notifyNewUser\|notifyLogin" -- '*__tests__*'`). Run the full backend suite after Phases 5 to 8 and fix any remaining hosted-assumption failure the same way; do not weaken assertions.

---

## Phase 5: User Story 3 - Sign-in works on a plain-http local instance (P2)

**Goal**: cookie `Secure` follows `APP_URL`; redirect and callback derive from `APP_URL`.

**Independent test**: suites below; quickstart step 2.

### Tests for US3

- [ ] T021 [P] [US3] Unit suite `server/auth/__tests__/cookie-secure.test.js` against the real `server/auth/jwt.js` exports `getCookieOptions`, `getAccessTokenCookieOptions`, `getClearCookieOptions`: production plus `APP_URL=http://localhost:3910` gives `secure: false, sameSite: 'strict'`; production plus `https://docs.example.com` gives `secure: true, sameSite: 'strict'`; development plus http gives `secure: false, sameSite: 'lax'`. Use `_resetInstanceConfigForTests()` between cases. Update `server/auth/__tests__/jwt.test.js` assertions that tied `secure` to `NODE_ENV` alone.
- [ ] T022 [P] [US3] Integration suite `server/__tests__/auth-oauth-cookies.test.js` mounting the real `server/auth/routes.js` router with supertest and stub `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`: `GET /auth/google?returnTo=/docs` sets `oauth_redirect`, `oauth_return_to`, `oauth_state` without `Secure` for an http `APP_URL` and with `Secure` for https, `SameSite=Lax` in both; the provider redirect's `redirect_uri` equals `${APP_URL}/auth/google/callback` when `GOOGLE_REDIRECT_URI` is unset and the explicit value when set; in production with `CLIENT_URL` unset the `oauth_redirect` value equals `APP_URL`.
- [ ] T023 [P] [US3] Extend `server/__tests__/url.test.js`: with `PUBLIC_ORIGIN` unset, an alias host maps to `APP_URL`; with `PUBLIC_ORIGIN` set, the explicit value wins; non-alias hosts unchanged.

### Implementation for US3

- [ ] T024 [US3] `server/auth/jwt.js`: replace the load-time `COOKIE_BASE`, `COOKIE_OPTIONS`, `ACCESS_TOKEN_COOKIE_OPTIONS` constants with functions that read `getInstanceConfig().cookieSecure` for `secure`, keeping `sameSite` on `NODE_ENV` and every `maxAge` unchanged; same for `getClearCookieOptions`. Leave the secret guards untouched (FR-008).
- [ ] T025 [US3] `server/auth/routes.js`: `DEFAULT_CLIENT_URL` becomes a call to `getInstanceConfig().clientUrl`; the three `secure: isProduction` on `oauth_redirect`, `oauth_return_to`, `oauth_state` become `secure: getInstanceConfig().cookieSecure`. No other change in this file for US3 (feature 059 rewrites it next).
- [ ] T026 [P] [US3] `server/auth/google.js`: `GOOGLE_REDIRECT_URI` read from `getInstanceConfig().googleRedirectUri` when the OAuth client is built.
- [ ] T027 [P] [US3] `server/url.js`: `PUBLIC_ORIGIN` read from `getInstanceConfig().publicOrigin` at call time; update the header comment.
- [ ] T028 [US3] `server/index.js`: `CLIENT_URL` for CORS from `getInstanceConfig().clientUrl`; keep `http://localhost:5173` and `http://localhost:3001` in the allow-list.

**Checkpoint**: US3 suites green.

---

## Phase 6: User Story 4 - Images work without S3 (P2)

**Goal**: storage facade with local and S3 drivers; raw routes; every byte path through the facade.

**Independent test**: suites below; quickstart step 3.

### Tests for US4

- [ ] T029 [P] [US4] Unit suite `server/__tests__/image-storage-local.test.js` against `server/image-storage/local-driver.js` with a temp `dataDir`: put, get, readObject (content type round-trips), copy, delete (missing keys ignored), `NoSuchKey` code on a missing object; key safety rejects `''`, `/abs`, `../x`, `a/../../x`, `a\\b`, `a\0b` with `InvalidKey` and never touches a path outside `images/`; `isEnabled()` true for a writable dir and false (with one log line) for an unwritable one; `cspImageSources()` is `[]`; `getSignedGetUrl` throws.
- [ ] T030 [P] [US4] Unit suite `server/__tests__/image-storage-s3.test.js` against `server/image-storage/s3-driver.js` with the AWS SDK client mocked at `send`: unchanged command shapes for put, get, copy, delete; `readObject` returns `ContentType`; with `S3_ENDPOINT=http://minio:9000` the client is built with that endpoint and `forcePathStyle: true` and `cspImageSources()` returns `['http://minio:9000']`; without it the virtual-hosted origin is returned as today; `isEnabled()` false with no bucket.
- [ ] T031 [P] [US4] Unit suite `server/__tests__/image-storage-facade.test.js`: driver selection from `STORAGE_DRIVER` and auto-detect; `kind` matches; and a guard that `git grep -l "image-storage/\(s3\|local\)-driver"` over `server/` (excluding `server/image-storage/` and `__tests__`) returns nothing and that no file requires `s3-images`.
- [ ] T032 [US4] Integration suite `server/__tests__/document-images-routes.test.js` mounting the production `createDocumentImagesRouter` (T038) with `STORAGE_DRIVER=local`, a temp `SQUIRE_DATA_DIR`, real `documents` and `documentImages` on the worker database, and users created in the suite: upload as editor returns 201 with the app URL shape; upload as viewer 403; resolve as viewer returns `{ url: '/api/docs/<doc>/images/<img>/raw' }` with `Cache-Control: no-store`; raw with Bearer and raw with only the `accessToken` cookie both return 200, the bytes, the stored content type, `Cache-Control: private, max-age=3600`, `nosniff`, and the sandbox CSP; raw as a user without access 403; unknown image id 404; image of another document 404; no auth 401; driver disabled gives 503 on upload; bytes survive a fresh `local-driver` instance over the same directory (restart simulation). With `STORAGE_DRIVER=s3` and a mocked driver, resolve returns the presigned URL and upload with no bucket returns 503 (US4 scenario 7). Clean up documents by `doc_guid` and users by id.
- [ ] T033 [P] [US4] Extend `server/__tests__/chat-attachments.test.js` (local driver, temp dir): upload then resolve returns `/api/chat/attachments/raw?ref=...`; raw as owner streams bytes with the stored type via cookie and via Bearer; raw for another user's key 400; markdown attachment raw 404; S3 path unchanged with the mocked driver.
- [ ] T034 [P] [US4] Local-driver coverage for the other byte paths, using the real modules with `STORAGE_DRIVER=local` and a temp dir: bundle export includes image bytes (`server/__tests__/docs-export-bundle.test.js`), document copy copies the object (`server/__tests__/image-rehost.test.js` or the existing copy test), markdown-import rehost stores bytes (`server/__tests__/markdown-import.test.js`), the assistant view-image tool reads bytes (`server/__tests__/chat-tools.test.js`), document deletion removes the files. Add one local-driver case per suite; keep the existing mocked cases.

### Implementation for US4

- [ ] T035 [US4] Create `server/image-storage/s3-driver.js` by moving `server/s3-images.js` (use `git mv` to keep history), reading settings from `getInstanceConfig().s3`, adding `S3_ENDPOINT` support and `readObject` per research R7; create `server/image-storage/local-driver.js` per research R7 and data-model section 3; create the facade `server/image-storage/index.js` per `contracts/storage-and-boot.md`.
- [ ] T036 [US4] Switch every consumer from `./s3-images` to the facade: `server/index.js`, `server/document-images.js`, `server/api/chat-attachments.js`, `server/api/chat.js`, `server/api/chat-tools.js`, `server/api/docs-export.js`, `server/image-rehost.js`, `server/mcp/image-validate.js`; and every `jest.mock('.../s3-images')` path in `__tests__/integration/docs-import-api.test.js`, `__tests__/integration/sync-push.cross-doc-images.route.test.js`, `__tests__/integration/sync-push.route.test.js`, `server/__tests__/chat-attachments-ratelimit.test.js`, `server/__tests__/chat-attachments.test.js`, `server/__tests__/docs-export-bundle.test.js`, `server/__tests__/image-rehost.test.js`, `server/__tests__/markdown-import.test.js`, `server/api/__tests__/chat-models.test.js`, `server/api/__tests__/chat-strip-ui-only.test.js`, `server/api/__tests__/chat.durable-failures.test.js`, `server/mcp/__tests__/tools/modify-from-markdown-rehost.test.js`, `server/mcp/__tests__/tools/modify-sources.test.js` (13 files; mocks add `kind: 's3'` and `readObject` where the consumer needs them). Confirm with `git grep -n "s3-images"` that only comments and `migrations/1786000000000_create-document-images.js` remain; update stale comments.
- [ ] T037 [US4] Add `requireAuthOrCookie` to `server/auth/middleware.js` per research R8 and RBD-058-20 (header path identical to `requireAuth`, cookie path via `permissions.extractUser({ queryToken })`, same scope checks). Unit-test it in `server/__tests__/auth-middleware-cookie.test.js` (header, cookie, neither, invalid cookie, scoped token without `documents:read`).
- [ ] T038 [US4] Create `server/api/document-images-routes.js` exporting `createDocumentImagesRouter({ documents, documentImages, storage, notifyException })`: move the upload and resolve handlers out of `server/index.js` unchanged (move-only), make resolve return the raw path when `storage.kind === 'local'`, and add `GET /api/docs/:docId/images/:imageId/raw` per `contracts/http-routes.md`. Keep the upload route's own `express.json({ limit: '20mb' })` and the body-parser skip in `server/index.js`. Mount the router in `server/index.js` where the handlers were.
- [ ] T039 [US4] `server/index.js` document deletion: use the facade (`storage.isEnabled()` and `storage.deleteObjects`) and fix the log text that says S3.
- [ ] T040 [US4] `server/api/chat-attachments.js`: facade; resolve returns `/api/chat/attachments/raw?ref=<encodeURIComponent(ref)>` for the local driver; add the raw route per `contracts/http-routes.md`.
- [ ] T041 [US4] `server/api/docs-export.js`, `server/image-rehost.js`, `server/mcp/image-validate.js`, `server/api/chat.js`, `server/api/chat-tools.js`, `server/document-images.js`: verify each path works with the local driver (no S3-only assumption such as presigned URLs or `isEnabled` meaning "S3 configured" in messages); change user-facing strings that say "S3" to "image storage".
- [ ] T042 [US4] CSP `img-src` uses `storage.cspImageSources()` from the facade (wired in T050).

**Checkpoint**: US4 suites green; `npm run test:client` still green (client unchanged; `ImageNodeView` uses whatever URL resolve returns).

---

## Phase 7: User Story 5 - A self-hosted instance never presents the hosted service (P3)

**Goal**: every hosted-only surface gated; server-naming text built from the request origin or `APP_URL`.

**Independent test**: suites below; quickstart step 4.

### Tests for US5

- [ ] T043 [P] [US5] Integration suite `server/__tests__/web-routes.test.js` mounting the production `mountWebRoutes` with a temp client build directory (same stub files as T019) and `SQUIRE_HOSTED` unset: the seven hosted paths plus `/landing.html`, `/pricing.html`, `/about.html`, `/security.html`, and a root `blog.css` return 404; `/`, `/index.html`, `/docs`, `/d/<uuid>` serve the shell containing `{"hosted":false}` and no `googletagmanager`; `/documentation` still serves; `/agents.md` contains no `squiredocs.com` and contains the request's origin (use `Host: localhost:3910`); `buildCspDirectives({ hosted: false, storage })` has no Google source in any directive; the old-domain middleware (exported from `server/web-routes.js` as `oldDomainRedirect`) does not redirect when not hosted and redirects when hosted.
- [ ] T044 [P] [US5] Unit suite `server/__tests__/app-shell.test.js` against `server/app-shell.js` using the real `client/index.html` source: not hosted has no Google tag and has `{"hosted":false}`; hosted has the tag immediately after `<head>`, before any other script, with `G-9HGTDJRJWH` and `AW-18023084061`, and `{"hosted":true}`; the theme bootstrap script is preserved; the injected object carries only `hosted`.
- [ ] T045 [P] [US5] Gating suites: `server/__tests__/hosted-gating.test.js` covering (a) `POST /api/admin/users/:id/welcome-email` on the real admin router returns the same status and body as an unknown admin path when not hosted and works when hosted; (b) `POST /auth/prod-reset-selftest-account` on the real auth router likewise; (c) `checkQuota` on the worker database for a user past their allowance returns `allowed: true, notApplicable: true` with `usedCents` intact when not hosted and `allowed: false` when hosted; (d) `notifyNewUser` and `notifyLogin` do not call the transport when not hosted (spy on `nodemailer.createTransport`); (e) the OpenRouter headers carry `HTTP-Referer` equal to `APP_URL`.
- [ ] T046 [P] [US5] Server-naming text suite `server/mcp/__tests__/tools/server-naming-text.test.js`: `get_tool_documentation({ tool: 'rest_api' })` handler output with `agentToken.baseUrl` `http://localhost:3910` and with `https://docs.example.com` contains only that origin and no `squiredocs.com`; with no `baseUrl` it uses `APP_URL`; `create_access_token` and `import_markdown_file` outputs fall back to `APP_URL`; `buildWelcomeDocNodes({ appUrl: 'http://localhost:3910', hosted: false })` contains no `squiredocs.com`, no support paragraph, no beta-credit sentence; `buildWelcomeDocNodes({ appUrl: 'https://squiredocs.com', hosted: true })` deep-equals today's `WELCOME_DOC_NODES` (snapshot taken from the pre-change module in the same commit).
- [ ] T047 [P] [US5] Client tests: `client/src/__tests__/instance.test.js` (`isHosted()` true only for literal `true`); `client/src/pages/__tests__/SettingsPage.test.jsx` cases for the MCP URL equal to `window.location.origin + '/mcp'` (shown and copied), beta note and meter hidden when not hosted or `usage.notApplicable`, shown when hosted; `client/src/pages/__tests__/AdminPage.test.jsx` cases hiding the welcome-email button and self-test card when not hosted; a `LoginPage` test hiding the legal links when not hosted.

### Implementation for US5

- [ ] T048 [US5] Create `server/app-shell.js` (`renderAppShell(html, { hosted })`, the Google tag snippet moved verbatim from `client/index.html`) and remove the snippet from `client/index.html`.
- [ ] T049 [US5] Create `server/web-routes.js` exporting `buildCspDirectives({ hosted, storage })`, `oldDomainRedirect`, and `mountWebRoutes(app, { clientBuildPath, storage })` per research R9 and R10 and RBD-058-27: hosted branch mounts today's routes in today's order (landing, pricing, about, security, documentation, blog, static with `index: false` and today's `setHeaders`, `/agents.md` falls to static, shell catch-all); not-hosted branch mounts documentation, the 404 list, the `/agents.md` rewriter (`buildBaseUrl(req)`), static with `index: false`, and the shell for `/`, `/index.html`, and `*`. The shell is rendered once per mount. Keep the "client build missing" fallback.
- [ ] T050 [US5] Wire `server/web-routes.js` into `server/index.js`: helmet CSP from `buildCspDirectives`, `app.use(oldDomainRedirect)` in place of the inline middleware, and `mountWebRoutes` in place of the static block (move-only for the hosted branch).
- [ ] T051 [P] [US5] `client/vite.config.js`: a `transformIndexHtml` plugin applying `renderAppShell` (loaded with `createRequire`) using `process.env.SQUIRE_HOSTED`; gate `staticPagesPlugin` on the same flag (RBD-058-28).
- [ ] T052 [P] [US5] Create `client/src/instance.js` (`isHosted()`); update `client/src/components/LoginPage.jsx` (legal links only when hosted; no other change), `client/src/pages/SettingsPage.jsx` (MCP URL from `window.location.origin`; usage meter and beta note only when hosted and not `usage.notApplicable`), `client/src/pages/AdminPage.jsx` (welcome-email button and self-test card only when hosted), `client/src/App.jsx` (`/privacy`, `/terms` resolve to the landing view when not hosted).
- [ ] T053 [P] [US5] `server/api/admin.js`: `hostedOnly` first on the welcome-email route; the 503 message names `SMTP_FROM`. `server/auth/routes.js`: `hostedOnly` first on `/prod-reset-selftest-account` (one-line change).
- [ ] T054 [P] [US5] `server/ai-usage.js` `checkQuota`: not-hosted branch per research R9 (query still runs; `allowed: true, notApplicable: true`).
- [ ] T055 [P] [US5] `server/email.js` gating of `notifyNewUser` and `notifyLogin` (RBD-058-23); `server/api/ai-providers.js` OpenRouter `HTTP-Referer` from `getInstanceConfig().appUrl` (build the headers object at call time if it is a module constant).
- [ ] T056 [P] [US5] `server/mcp/tools/tool-documentation/export-api.js` `buildExportApiDocumentation(baseUrl)` (keep `EXPORT_API_DOCUMENTATION` built with `https://squiredocs.com`); `server/mcp/tools/tool-documentation/index.js` per-base-URL `rest_api` entry with `getDocs(tool, { baseUrl })` and `getSection(tool, id, { baseUrl })`; `server/mcp/tools/get-tool-documentation.js` passes `agentToken.baseUrl || getInstanceConfig().appUrl`. Keep existing tool-documentation tests passing.
- [ ] T057 [P] [US5] `server/mcp/tools/create-access-token.js` (two places) and `server/mcp/tools/import-markdown-file.js`: fallback base URL `getInstanceConfig().appUrl`.
- [ ] T058 [P] [US5] `server/onboarding/welcome-template.js` `buildWelcomeDocNodes({ appUrl, hosted })` per research R11 and RBD-058-22, keeping `WELCOME_DOC_NODES` as the hosted build; `server/onboarding.js` seeds with `buildWelcomeDocNodes({ appUrl, hosted })` from the instance config. Leave the "Welcome to Squire Docs!" H1 untouched (client kickoff coupling).

**Checkpoint**: US5 suites green; `server/__tests__/agents-md-claims.test.js` and the onboarding suite pass with no assertion edits beyond URL parameterization (SC-007).

---

## Phase 8: User Story 6 - Email through any SMTP server (P3)

**Goal**: generic SMTP names with SES aliases; one boot log line when off.

**Independent test**: SMTP cases in T004; suite below; quickstart step 5.

- [ ] T059 [US6] `server/email.js`: build the transport lazily from `getInstanceConfig().smtp` (`host`, `port`, `secure`, `auth`), skip silently when `from` is unset (no per-message warning; return shape `{ ok: false, skipped: true }` unchanged), keep the `Squire Docs <from>` display name; update the header comment. The boot log line is emitted from `server/index.js` (T013).
- [ ] T060 [P] [US6] Suite `server/__tests__/email-transport.test.js` against the real `server/email.js` with `nodemailer.createTransport` spied: generic variables produce exactly that host, port, `secure`, and auth; SES-only produces the byte-identical hosted transport (`email-smtp.us-west-2.amazonaws.com`, 465, `secure: true`); no sender means `sendEmail` returns `skipped: true` and logs nothing at warn level. Keep `server/__tests__/welcome-email.test.js` green.

---

## Phase 9: Polish and cross-cutting

- [ ] T061 Update `README.md` per plan.md "Documentation updates" (variable table from `contracts/environment.md`, boot order, secrets file and the lost-volume warning, production overlay values, raw routes, hosted gating, remove `JWT_SECRET`).
- [ ] T062 Update `docs/dev.md` per plan.md "Documentation updates" (app-dev `SQUIRE_HOSTED=true`, local-driver try-out with `SQUIRE_DATA_DIR=/local-dev/.squire-data`, test-setup normalization, minikube base pod in production mode, `npm run dev` bypasses the entrypoint).
- [ ] T063 [P] Update `.env.example` with every variable in `contracts/environment.md` and its default, keeping `CLIENT_URL=http://localhost:5173` (RBD-058-30).
- [ ] T064 Run `npm run test:server`, `npm run test:client`, and `npm run test:first-run` in the app-dev pod; all green. Then `git grep -n "squiredocs.com" -- server client/src` and confirm every remaining hit is hosted-only (behind the flag), a test, a comment, or `server/url.js`'s alias default.
- [ ] T065 Record in `specs/058-self-host-config/promotion-notes.md`: the design amendments to request (plan.md list, including the FR-009/RBD-058-1 sync to RBD-058-18), the maintainer verification items (quickstart steps 1 and 6, minikube secrets), and that quickstart step 1 needs a machine with Docker.

---

## Dependencies and execution order

- Phase 1 (T001, T002) and Phase 2 (T003, T004) block everything.
- US1 (T005 to T013): needs T003. T011 needs T009 and T010. T008 needs T007 and T011.
- US3 (T021 to T028): needs T003. Independent of US1.
- US4 (T029 to T042): needs T003. T036 needs T035. T038 needs T037 and T035. T032 needs T038.
- US5 (T043 to T058): needs T003; T049 needs T048 and T035 (CSP uses the facade); T050 needs T049; T043 needs T049.
- US6 (T059, T060): needs T003.
- US2 (T014 to T020): T014 to T018 can start any time; T019 needs T049 and T024; T020 runs after US3 to US6 land.
- Polish last.

Shared-file serialization (not parallel even across stories): `server/index.js` (T013, T028, T036, T038, T039, T050), `server/auth/routes.js` (T025, T053), `server/email.js` (T055, T059), `server/api/chat-attachments.js` (T036, T040).

## Parallel examples

- After T003: T005, T006, T007, T009, T010 (US1); T021, T022, T023 (US3); T029, T030 (US4); T044, T046 (US5); T060 (US6); T014 to T017 (US2 manifests).
- Within US5 after T049: T051, T052, T053, T054, T056, T057, T058 touch different files.

## Implementation strategy

1. MVP: Phases 1 and 2, then US1 (bare boot) plus the US2 manifests (T014 to T018). That alone must not change hosted behavior, because the overlay pins every new value.
2. US3 and US4 next (P2), then US5 and US6 (P3), then T019 and T020 to prove hosted parity with the full gate set in place.
3. Constitution I requires docs in the same commit as the behavior. Either land the feature as one commit after T065, or, if committing per story, move that story's share of T061 to T063 (its variables and behavior) into the story's commit. Deploys stay with the maintainer.
