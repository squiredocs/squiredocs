# Research: Self-Host Distribution (060)

Phase 0 output for `plan.md`. Each entry records a decision, why, and what else
was considered. Product decisions that the design and spec leave open are in
`clarifications-needed.md` (RBD-060-1 to RBD-060-19 from the spec phase,
RBD-060-20 onward from this phase). Code facts were checked against `main` at
`84490ad6` on 2026-10-07.

---

## R1. Where the repository name lives (RBD-060-1, RBD-060-20)

**Decision**: The `<org>/<repo>` value is one constant, `REPOSITORY`, exported
by `distribution/self-host/release.mjs`. Four files carry it as a literal
because they are served or published verbatim and cannot read a constant at
run time: `AGENTS.md`, `distribution/self-host/install.sh`,
`distribution/self-host/compose.yml`, and `documentation/self-hosting.md`. A
Docker-free drift test (`test/self-host/repository-constant.test.mjs`) finds
every `github.com/<x>/<y>` release URL and `ghcr.io/<x>/<y>` image reference in
those four files and fails, naming file and line, unless each equals
`REPOSITORY`. Until Sam decides, `REPOSITORY` is the literal `<org>/<repo>`.
`install.sh` refuses to run while its constant contains `<` (one message:
"This install script has not been released yet."). The release workflow
refuses to publish unless `REPOSITORY` has no placeholder characters and equals
the lowercased `github.repository` of the run.

**Rationale**: RBD-060-1 wanted one place and a refusal to publish a
placeholder. It also put `<org>/<repo>` into `AGENTS.md`, but `AGENTS.md` is
served verbatim from the image (FR-021), not stamped at release, so a
release-time stamp cannot reach it. The constant plus a drift test keeps one
source of truth for the value, and the `github.repository` equality check also
stops a fork from publishing under the canonical name.

**Alternatives considered**: Stamping `AGENTS.md` at image build time (breaks
the byte pin between the repository file and the served file, FR-021);
defaulting to `squiredocs/squire-docs` now (squiredocs.com would serve install
instructions for a repository that does not exist yet, which an agent would
follow and fail on).

## R2. Release asset names on GitHub (RBD-060-21)

**Decision**: The self-host settings file is published as the release asset
`env.example`. `install.sh` downloads `env.example`, verifies it under that
name, and saves it in the install folder as `.env.example`. `SHA256SUMS` lists
`compose.yml`, `squire`, and `env.example`. After `gh release create`, the
workflow lists the release's assets and fails if the names are not exactly
`compose.yml`, `squire`, `env.example`, `SHA256SUMS`.

**Rationale**: GitHub's release documentation states that it renames asset
filenames with leading or trailing periods. An asset uploaded as
`.env.example` would not be downloadable under that name, so FR-009's literal
asset list cannot be met as written. The install folder still holds
`.env.example`, which is what users and the spec's Install folder entity see.

**Alternatives considered**: Uploading `.env.example` and discovering the
renamed name at install time (needs the GitHub API, which RBD-060-15 avoids);
dropping the file from the assets (FR-009 and the design list it).

## R3. Compose file shape (FR-001 to FR-006, RBD-060-18, RBD-060-22)

**Decision**:

- `app.image: ghcr.io/<REPOSITORY>:${SQUIRE_VERSION:-__SQUIRE_VERSION__}`. The
  token `__SQUIRE_VERSION__` is replaced by the release stamp (R6).
- `app.environment`: `APP_URL: ${APP_URL:-http://localhost:${SQUIRE_PORT:-3910}}`,
  `DATABASE_URL: postgresql://squire:squire@postgres:5432/squire`,
  `REDIS_HOST: redis`, `REDIS_PORT: "6379"`. No `SQUIRE_MODE`, no
  `SQUIRE_HOSTED`, no `NODE_ENV` (the image sets it).
- `app.env_file: [{ path: .env, required: false }]`, so optional settings a
  self-hoster adds to `.env` (assistant keys, SMTP, S3) reach the container.
  `environment` wins over `env_file`, so `.env` cannot redirect the database.
- `app.ports: ["127.0.0.1:${SQUIRE_PORT:-3910}:3001"]`; `app.volumes:
  [squire-data:/data]`; `app.depends_on` both with `condition: service_healthy`;
  `app.healthcheck` probes `/ready` with the same node one-liner as the
  Dockerfile and a 90 s start period.
- `postgres`: `pgvector/pgvector:pg16`, `POSTGRES_USER/PASSWORD/DB=squire`,
  `pg_isready -h 127.0.0.1 -U squire -d squire`, volume `postgres-data`, no
  `ports`.
- `redis`: `redis:7`, `redis-cli ping`, volume `redis-data`, no `ports`.

**Rationale**: Compose reads `.env` only for interpolation; without `env_file`
a key added to `.env` never reaches the app, which would make
`.env.example`'s optional settings dead text. `required: false` keeps the
manual path (which writes no `.env`) working, and needs Compose 2.24.0 or
later, so `install.sh` and `AGENTS.md` require that version (RBD-060-22). The
nested `APP_URL` default keeps FR-004's behavior when `APP_URL` is unset and
lets an instance behind a TLS proxy set an https `APP_URL` in `.env`
(FR-040, RBD-060-11's note).

**Alternatives considered**: Listing every optional variable under
`environment` as `${VAR:-}` (passes empty strings into the container, which
modules that read `process.env` directly may treat as set); a hardcoded
`APP_URL` (then the TLS-proxy instruction in FR-040 cannot be followed without
editing `compose.yml`).

## R4. The `squire` wrapper and TTYs (FR-007, D10, RBD-060-23)

**Decision**: The wrapper is:

```sh
#!/bin/sh
cd "$(dirname "$0")" || exit 1
if [ -t 0 ] && [ -t 1 ]; then exec docker compose exec app squire "$@"; fi
exec docker compose exec -T app squire "$@"
```

`AGENTS.md` keeps the design's `docker compose exec app squire` form (D10).
The CI smoke runs that exact form with no terminal attached and checks that
stdout holds only the JSON or link, which proves the AGENTS.md form on the
shipped Compose version. If CI shows Compose allocating a TTY there, the
implement phase adds `-T` to `AGENTS.md` and records a design amendment.

**Rationale**: With a TTY allocated, the container's stdout and stderr arrive
merged on one stream with CRLF line endings. `install.sh` captures
`./squire claim-link`'s stdout, so a merged stream would put the CLI's
explanation into the captured link. `exec` passes the exit code through.

**Alternatives considered**: Always `-T` (a person running `./squire` in a
terminal loses colors and line editing for no reason); never `-T` (R4's
capture problem).

## R5. `install.sh` structure (FR-014 to FR-020, RBD-060-15 to -17, -32)

**Decision**: One POSIX `sh` file using `set -eu` and plain functions: no
arrays, no `local`, no `[[`, no `pipefail`. Flow:

1. Parse flags (`--dir`, `--version`, `--name`, `--email`, `--help`); unknown
   flag or missing value exits 2 with usage on stderr.
2. Refuse a placeholder `REPOSITORY` (R1).
3. Prerequisites: `docker compose version --short` must parse as 2.24.0 or
   later (v1 or older v2 name the upgrade); `docker info` must succeed (names
   "start Docker Desktop or the docker service"); `curl` must exist; one of
   `sha256sum` or `shasum` must exist.
4. Folder: if `<dir>/compose.yml` exists, print the upgrade command (FR-018)
   with the folder path and, when resolvable, the latest version, and exit 1.
   Otherwise create the folder, remembering whether this run created it.
5. Version: `--version` or the tag named by the `Location` of
   `https://github.com/<REPOSITORY>/releases/latest` (strip `v`).
6. Assets: base URL is `${SQUIRE_INSTALL_ASSET_URL:-https://github.com/<REPOSITORY>/releases/download/v<version>}`;
   download `SHA256SUMS`, `compose.yml`, `squire`, `env.example` into the
   folder with `curl -fsSL`; verify the three against `SHA256SUMS`; rename
   `env.example` to `.env.example`; `chmod +x squire`; write `.env` with
   `SQUIRE_VERSION=<version>`. A trap removes every file this run created
   (and the folder, if this run created it and it is now empty) on any failure
   before step 7 starts. Volumes are never touched.
7. `docker compose up -d --wait` with its output on stderr, captured to a
   temporary file; on failure, a "port is already allocated" or "address
   already in use" match prints the port message (RBD-060-32), anything else
   names `docker compose logs app`. Exit 1.
8. `./squire doctor` (output to stderr); failure exits 1 with doctor's output
   and mints nothing.
9. `./squire claim-link [--name] [--email]`; its stdout is captured, checked
   to be exactly one line matching `^https?://[^ ]+/claim#[A-Za-z0-9_-]+$`,
   and printed to stdout as the script's only stdout line.

All progress and errors go to stderr (RBD-060-17). The header comment
documents `SQUIRE_INSTALL_ASSET_URL` (RBD-060-6). The script never reads from
stdin.

**Rationale**: Every step maps one-to-one to FR-015, and each failure exits
with one message naming the next action (SC-002). The `Location` redirect
needs no token and no JSON (RBD-060-15).

**Alternatives considered**: Bash (not POSIX, fails D12's "POSIX sh" and
Alpine/Debian `/bin/sh`); `jq`-based API lookup (extra prerequisite).

## R6. Release stamping and validation script (FR-005, FR-009, FR-010)

**Decision**: `distribution/self-host/release.mjs` (Node ESM, no dependency)
exports `REPOSITORY`, `parseReleaseTag(tag)`, `validateRepository(repo,
githubRepository)`, and `stampAssets({ version, outDir })`, and has a CLI:

- `node distribution/self-host/release.mjs validate --tag vX.Y.Z --github-repository owner/name`
  prints `version=`, `prerelease=`, `image=` lines for `$GITHUB_OUTPUT`, or
  exits 1 naming the problem (non-semver tag, placeholder, mismatch).
- `node distribution/self-host/release.mjs stamp --version X.Y.Z --out dir`
  writes `compose.yml` (version token replaced), `squire` (copied, mode
  0755), `env.example` (from `distribution/self-host/.env.example`, version
  token replaced), and `SHA256SUMS`, then
  re-reads them and fails if any `__SQUIRE_` token or `<org>`/`<repo>`
  remains.

Semver: `^v(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$`; a prerelease suffix sets
`prerelease=true`. Build metadata (`+...`) is rejected because image tags
cannot carry `+`.

**Rationale**: Keeping the logic in a Node module makes it testable in the pod
and in `test.yml` (Docker-free), so the only GitHub-Actions-only parts of the
release are the Docker and registry steps.

**Alternatives considered**: Inline shell in the workflow (untestable without
Actions); `sed` stamping (no post-stamp validation).

## R7. Release workflow mechanics (FR-010 to FR-012, FR-025, FR-026, RBD-060-4, RBD-060-26)

**Decision**: `.github/workflows/release.yml`:

- Triggers: `push.tags: ['v*']` and `workflow_dispatch` with inputs
  `publish` (boolean, default false) and `allow_single_arch` (boolean,
  default false). Permissions: `contents: write`, `packages: write`.
- `validate` (ubuntu-latest): R6 `validate` (on dispatch from a branch, the
  version is `0.0.0-ci.<run_number>`, and `publish` is forced false); R6
  `stamp` into `assets/`; upload the assets artifact. Outputs version,
  prerelease, image, `publish`, and `arm64` (true when the repository is
  public; GitHub's arm64 runners are not available to private repositories).
- `build` (matrix amd64 on `ubuntu-latest`, arm64 on `ubuntu-24.04-arm`; the
  arm64 leg has `if: needs.validate.outputs.arm64 == 'true'`): `docker buildx
  build --platform linux/<arch> --load -t <image>:<version>` with the
  `org.opencontainers.image.source` label passed on the command line (no
  Dockerfile change); then the smoke (R8); then `docker save` to
  `image-<arch>.tar` and upload it.
- `agent` (ubuntu-latest, needs `build` amd64 and `validate`): R9.
- `publish` (needs all; runs only when the ref is a `v*` tag and either the
  trigger was a push or `inputs.publish` is true): fails unless both arch
  tarballs exist or `allow_single_arch` is true; logs in to GHCR with
  `GITHUB_TOKEN`; pushes each tarball under a staging tag
  `<image>:<version>-<arch>`, assembles the multi-arch index with `docker
  buildx imagetools create -t <image>:<version>` (plus `-t <image>:latest`
  when not a prerelease), inspects it and fails unless the expected
  platforms are listed; then `gh release create v<version> assets/*` (with
  `--prerelease` when needed) and verifies the asset names (R2).
- A workflow-level `concurrency` group per tag prevents two publishes of one
  version.

**Rationale**: Native runners avoid QEMU (RBD-060-4). Saving the tested image
and pushing those exact bytes in a job that runs only after every gate means a
failure anywhere publishes nothing (FR-025, SC-004). Staging tags carry the
version, are created only after every gate passed, and point at bytes that
were tested.

**Alternatives considered**: `push-by-digest` from the build jobs (blobs land
in GHCR before the gates run); rebuilding in the publish job (the published
bytes would not be the tested bytes); QEMU on one runner (slow and flaky for a
Node server plus Postgres).

## R8. What the smoke test runs (FR-012, RBD-060-7)

**Decision**: Per architecture, in a temporary folder holding the stamped
`compose.yml` and a `.env` with `SQUIRE_VERSION=<version>`:

1. `docker compose up -d --wait --wait-timeout 300` exits 0.
2. `docker compose exec app squire doctor --json` (no `-T`, no terminal) is
   valid JSON with `ok: true`, and stdout holds nothing else (R4).
3. `docker compose exec app node -e "<script>"` loads `isolated-vm`, creates
   an isolate, evaluates `1+1`, and prints `2`.
4. `curl -fsS http://127.0.0.1:3910/self-host.md` equals `AGENTS.md` and
   `/install.sh` equals the script (the image carries both, FR-013).
5. `docker compose down -v` in an `always()` step.

**Rationale**: The native-module risk is load-and-execute per CPU; the rest
proves the compose file, health checks, and served files on the real image.

## R9. The agent job and the driver's sign-in-link leg (FR-026, FR-027, RBD-060-27)

**Decision**: The agent job loads `image-amd64.tar` (so the image exists
under its release tag and Compose's default `pull_policy: missing` contacts
no registry), serves `assets/` with `python3 -m http.server 8000`, then runs:

```sh
SQUIRE_INSTALL_ASSET_URL=http://127.0.0.1:8000 sh distribution/self-host/install.sh \
  --dir "$RUNNER_TEMP/squire-docs" --version "$VERSION" \
  --name "CI Agent" --email "ci-agent@example.com" > link.txt
node test/first-run/oauth-chain-driver.mjs --server http://localhost:3910 \
  --signin-link "$(tail -n 1 link.txt)" --expect-name "CI Agent" \
  --expect-email "ci-agent@example.com" --script-check
```

The driver's new leg (`--signin-link <url>`): parse the token from the URL
fragment; `POST /auth/signin-link` with `Accept: application/json` and
`{ token }` (prefill is already on the link); assert `ok`, the user's name and
email when `--expect-*` are given, and keep `welcomeDocId`; collect the
`accessToken` and `refreshToken` cookies from `Set-Cookie`; `POST
/auth/refresh` with the refresh cookie to obtain the session Bearer token,
the same exchange the SPA performs; `GET /auth/providers` must report
`hasOwner: true`; the authorize sanity step as today; `POST /mcp/auth/approve`
with the Bearer token, `Accept: application/json`, `approved: true`, and the
PKCE parameters; take the code from the returned `redirectUrl`; then the
existing token exchange and `list_documents`. `--script-check` adds one
`modify` call on `welcomeDocId` with a one-line script that appends a
paragraph, and asserts no `is_error`.

The existing default and `--first-run` legs are unchanged. `--signin-link` is
exclusive with `--first-run` (usage error).

**Rationale**: `/mcp/auth/approve` reads only the Authorization header
(`requireAuth`), while redemption sets cookies, so the refresh exchange is the
production path from a cookie session to a Bearer token. The leg can also be
exercised in the pod against the development server with a link from
`node bin/squire.js claim-link`, which makes FR-027 Docker-free to verify.

**Alternatives considered**: Reading `accessToken` directly from `Set-Cookie`
(works, but skips the path the browser uses); the dev consent endpoint (absent
from the production image).

## R10. Serving `/self-host.md` and `/install.sh` (FR-013, FR-021, RBD-060-2, RBD-060-29)

**Decision**: `server/web-routes.js` gains `mountDistributionRoutes(app, {
repoRoot })`, called by `mountWebRoutes` before the hosted/not-hosted split
(and before the client-build check, so a server without a client build still
serves them). It reads `AGENTS.md` and `distribution/self-host/install.sh`
once at mount, as Buffers, and serves them with `Content-Type:
text/markdown; charset=utf-8` and `text/x-shellscript; charset=utf-8`,
`Cache-Control: public, max-age=300`, no substitution. A missing file leaves
that route unmounted. The Dockerfile's runtime stage adds two `COPY
--chown=appuser:appgroup` lines (`AGENTS.md` to `/app/AGENTS.md`,
`distribution/self-host/install.sh` to `/app/distribution/self-host/install.sh`).
The Vite dev server proxies `/self-host.md` and `/install.sh` to the backend.

**Rationale**: Byte pins are trivial when the server sends the file it read.
The ECR build uses the same Dockerfile, so squiredocs.com serves both files
after its next deploy, which is how D12's URLs come to exist; the two COPY
lines are additive and change no existing layer's content.

**Alternatives considered**: Copying the files into `client/public` at build
time (two copies in the repository or a build step that can drift); serving
them from the static middleware (hosted serves `/agents.md` that way, but the
not-hosted branch would need a second rule, and the content types would be
guessed).

## R11. The self-hosted documentation variant (FR-030 to FR-033, RBD-060-8, RBD-060-24, RBD-060-25)

**Decision**: `client/scripts/render-documentation.mjs` gains a `variant`
option (`'hosted'` default, `'self-hosted'`) on `renderPage` and `render404`,
and an exported `renderVariantBody(bodyHtml, variant)`. For `self-hosted`:

- no Google tag; no `<link rel="canonical">` and no `og:url`;
- header nav and footer filtered by one rule, `keepSelfHostedHref(href)`:
  drop `mailto:` links, `/signup`, and any path in the hosted-only list
  (`/pricing`, `/about`, `/blog`, `/security`, `/privacy`, `/terms`, and
  `/blog/...`); keep everything else, including hrefs the rule does not know
  (so 062's "Self-host" link and new tagline flow through). A footer column
  whose list ends up empty is removed. The footer is
  `filterFooter(FOOTER)`, computed from the imported constant, never a
  second footer;
- body: instance URLs, meaning text matching `https://squiredocs.com/mcp`
  or `https://squiredocs.com/api/`, become `__SQUIRE_ORIGIN__/mcp` and `__SQUIRE_ORIGIN__/api/`; body links whose
  href is a hosted-only path become `https://squiredocs.com<path>`.
  Distribution URLs (`https://squiredocs.com/install.sh`,
  `https://squiredocs.com/self-host.md`) and email addresses are untouched.

`build-documentation.mjs` writes the hosted pages exactly as today to
`client/dist/documentation/` and the variant to
`client/dist/documentation/_self-hosted/`. The nested directory is never
reachable by URL: both instance kinds route `/documentation/*` nested paths to
the documentation 404 before the static middleware, and `readKnownSlugs`
ignores directories.

`server/documentation-routes.js` gains an optional `{ transformHtml }`
argument. Hosted mounts as today (sendFile, byte-identical). Not hosted mounts
the `_self-hosted` directory with `transformHtml(html, req)` replacing
`__SQUIRE_ORIGIN__` with the request origin from `buildBaseUrl(req)`, after
checking it parses as an http(s) origin and HTML-escaping it; an invalid
origin falls back to `getInstanceConfig().appUrl`. Files are read once at
mount.

The Vite plugin renders the variant from `SQUIRE_HOSTED` and substitutes the
dev request's origin, so dev and production agree (FR-033).

**Rationale**: Hosted output stays the same function with the same inputs, so
byte identity is structural, and a golden-hash test proves it (R12). The
sentinel limits substitution to instance URLs, which a blanket
`squiredocs.com` replacement cannot do once the page also names
`squiredocs.com/install.sh`. The `Host` header is client-controlled, so the
origin is validated and escaped before it enters HTML (Constitution V).

**Alternatives considered**: One build with a serve-time transform of the
hosted HTML (has to parse and filter HTML on every request and would couple
the server to the footer markup); the configured `APP_URL` only (RBD-060-8
chose the request origin to match `/agents.md`; `APP_URL` remains the
fallback).

## R12. Proving hosted byte identity (FR-033, SC-005, RBD-060-30)

**Decision**: Before any render code changes, a task records
`client/src/__tests__/fixtures/documentation-hosted-golden.json`: the SHA-256
of every hosted page and the 404 as built from `main` today. The Vitest test
renders the hosted variant of the current sources with the `self-hosting`
page removed from the page set and compares hashes; `agents-and-mcp` is
compared only while the Codex section is absent (if FR-034 ships the section,
its entry is regenerated in the same commit with the reason in the commit
message). The renumbered `order` values do not change hosted HTML.

**Rationale**: "Identical except for these additions" is testable only
against a recorded before-state.

## R13. Where the Docker-free tests run (FR-020, FR-024, FR-028, RBD-060-28)

**Decision**: A new `node --test` suite, `test/self-host/*.test.mjs`, run by a
new script `npm run test:self-host`, covering `install.sh` (stubbed PATH),
`compose.yml`, `.env.example`, the wrapper, `release.mjs`, the repository
constant, `AGENTS.md` structure and accuracy, and `release.yml`'s structure.
It parses YAML with `js-yaml` (already in `node_modules`). Shell tests run
the script under `dash` when present (POSIX check) and `sh` otherwise.
`shellcheck -s sh` runs when the binary exists and is skipped with a printed
notice otherwise; `test.yml` runs it explicitly (GitHub's Ubuntu image ships
it). Server route pins are Jest (`server/__tests__/self-host-routes.test.js`);
documentation variant tests are Vitest (`client/src/__tests__/`). `test.yml`
gains a `npm run test:self-host` step and a `shellcheck` step in the client
job (no database needed).

**Rationale**: The install script and release logic have no database and no
React, so neither Jest's database setup nor Vitest fits; `node --test` is
already the runner for `test:first-run`.

## R14. Plugin bundles (FR-036 to FR-038)

**Decision**: Add one short subsection to `distribution/shared/onboard.md`
under Move 1 ("Self-hosted instance"), then `node distribution/publish.mjs`
(dry run). `LICENSE_HOLDER` becomes `21st Harmonic LLC` (RBD-060-13). Bumps:
`SHIP_VERSION` 1.0.1 to 1.0.2 (onboard text and LICENSE), `REGISTRY_VERSION`
1.0.2 to 1.0.3 (LICENSE), `CURSOR_PLUGIN_VERSION` 1.0.0 to 1.0.1 (LICENSE).
`KIRO_POWER_VERSION` is unchanged (its bundle has no LICENSE and no onboard
text). The version-history comments in `publish.mjs` gain the reasons.
`--publish` is never run.

**Rationale**: The publishing design's bump-on-any-change rule, applied per
channel (channels version independently).

## R15. Codex verification (FR-034, RBD-060-10)

**Decision**: A single implement task attempts the verification with whatever
Codex CLI and login the implementer has. The app-dev pod has neither, so the
expected outcome in the pipeline is: section omitted, `promotion-notes.md`
tells 062 to drop Codex, and Sam is asked to verify on his machine. The hosted
golden hash for `agents-and-mcp` therefore stays in force unless the section
ships.

## R16. Hosted deploy safety (FR-011, FR-039, RBD-060-19)

**Decision**: The only Dockerfile change is the two additive COPY lines
(R10). No `ARG`, no platform logic, no label, no change to stages or the
builder. `script/build-and-deploy-aws.sh`, `script/deploy-aws.sh`, and `k8s/`
are not touched. Hosted-visible changes after the next deploy: the two new
routes, the new documentation page, its sidebar entry, and (if verified) the
Codex section; nothing else. The release workflow's amd64 and arm64 builds
exercise the same Dockerfile, which is the earliest evidence the ECR build
still works; Sam's next hosted deploy is the final check.
