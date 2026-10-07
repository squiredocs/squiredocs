# Feature Specification: Self-Host Distribution

**Feature Branch**: `060-self-host-distribution`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "060-self-host-distribution: build step 3 (Distribution) of the ratified design 'Proposal: Self-Hosting and Local Mode' (design/self-hosting-local-mode.md, D1 to D12). Ship the compose file, the ./squire wrapper, a self-host .env.example, SHA256SUMS and the release assets; the multi-architecture GHCR image with semver tags; install.sh and self-host.md served from squiredocs.com and kept in the repository; a CI job that plays the agent against the freshly built image; the self-hosting documentation page, the README opening, and a Codex section; the onboard.md self-host pointer; and the launch hygiene files (LICENSE, CONTRIBUTING.md, SECURITY.md)."

## Ground truth and scope

`design/self-hosting-local-mode.md` (ratified by Sam 2026-10-07, D1 to D12) is ground truth (Constitution VI). The sections this feature implements are "The try-out path", "Spin-up" (the compose file, images and upgrades, release files and the install script), "The squire CLI" (the wrapper, D10), "Agent-facing documentation", "Build sequence" step 3, and decisions D9, D10, and D12. Features 058 (self-host configuration) and 059 (identity and local mode) are merged on `main`; this feature packages what they built and does not change their behavior. Where the design is silent, the choice is recorded in `clarifications-needed.md` as RATIFIED-BY-DEFAULT and nothing is decided silently.

In scope:

- `compose.yml`, the `squire` host wrapper, a self-host `.env.example`, and `SHA256SUMS`, published as release assets pinned to each release's image tag.
- The container image published to GHCR for amd64 and arm64 with semver tags plus `latest`, built and smoke-tested in CI on both architectures.
- `install.sh` (served at `https://squiredocs.com/install.sh`, kept at `distribution/self-host/install.sh`) and `self-host.md` (served at `https://squiredocs.com/self-host.md`, published from the repository's `AGENTS.md`).
- A CI job that plays the agent: install, claim, OAuth chain, first tool call.
- Documentation: the `/documentation/self-hosting` page, the README's opening install section, a Codex section in `documentation/agents-and-mcp.md`, and the removal of squiredocs.com hardcodes and the Google tag from documentation pages served by self-hosted instances (RBD-058-6, RBD-058-41).
- The one-instruction self-host pointer in `distribution/shared/onboard.md` (D9) with regenerated bundles.
- Launch hygiene: `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`.

Out of scope: team mode, OIDC, and passwords (feature 061); the marketing pages and the footer tagline (feature 062); the git history scrub and making the repository public (Sam's operations); any deploy; a Docker-free install (D7); a Helm chart or multi-replica documentation (design non-goals); bundled TLS (design non-goal); a plugin `user_config` server setting (D9).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An agent installs a local instance with one command (Priority: P1)

A developer with Docker installed tells their coding agent "set up Squire Docs locally". The agent fetches the install instructions, runs the install command with the developer's git name and email, and relays the sign-in link the script prints as its last line. The developer clicks the link, clicks Continue, and is signed in as the owner of their own instance with a welcome document. No account, key, or clone of the repository is involved.

**Why this priority**: This is the flow the whole design is built around and the one the open source launch pages (feature 062) advertise with the command `curl -fsSL https://squiredocs.com/install.sh | sh`. Without it, nothing else in this feature has a user.

**Independent Test**: On a machine with Docker Compose v2 and no prior install, run the install command with `--name` and `--email`. Verify the folder is created, the four release files are present and checksum-verified, the stack is healthy, `squire doctor` passes, and the last line of output is a bare claim link that opens a prefilled claim page and signs the developer in.

**Acceptance Scenarios**:

1. **Given** Docker Compose v2 and a running daemon, **When** `curl -fsSL https://squiredocs.com/install.sh | sh -s -- --name "Ada" --email "ada@example.com"` runs, **Then** it creates `./squire-docs`, downloads `compose.yml`, `squire`, `.env.example`, and `SHA256SUMS` for the latest release, verifies every file against `SHA256SUMS`, writes `.env` with `SQUIRE_VERSION` set to that release, starts the stack and waits for every container to be healthy, runs `squire doctor`, and prints a claim link of the form `http://localhost:3910/claim#<token>` as the last line of its output with nothing appended.
2. **Given** the printed link, **When** the developer opens it, **Then** the claim page shows "Ada" and "ada@example.com" prefilled, and clicking Continue signs them in as the owner and opens the welcome document.
3. **Given** `docker compose` is missing, reports v1, or the daemon is not running, **When** the script runs, **Then** it stops before creating anything, exits non-zero, and prints one message naming the fix.
4. **Given** `./squire-docs` already holds an installation, **When** the script runs, **Then** it changes nothing, exits non-zero, and prints the upgrade command for that folder.
5. **Given** a downloaded file whose checksum does not match `SHA256SUMS`, **When** the script verifies it, **Then** it exits non-zero naming the file, starts nothing, and leaves no partial installation that a later run would mistake for a working one.
6. **Given** `--dir other-folder` and `--version 1.2.0`, **When** the script runs, **Then** it installs into `other-folder` with that release's assets and `SQUIRE_VERSION=1.2.0`.
7. **Given** port 3910 is taken, **When** the stack starts, **Then** the script exits non-zero and the message names `SQUIRE_PORT` in `.env` as the fix, matching the CLI's error wording.
8. **Given** the script runs without a terminal attached (piped, in CI, or from an agent), **When** it needs any input, **Then** it never prompts; every input comes from flags or defaults.

---

### User Story 2 - An agent follows self-host.md without the install script (Priority: P1)

An agent (or a person) who prefers not to pipe a script into a shell fetches `https://squiredocs.com/self-host.md` and runs the listed commands by hand. Every step has a command and a machine-checkable success condition. The same file tells the agent how to print the claim link, how to recover (new link, change port, read logs, upgrade), and warns that `docker compose down -v` deletes every document.

**Why this priority**: The design makes the install script a convenience, not a requirement, and the plugin's onboarding skill sends agents to this file (D9). It is the one source agents execute from.

**Independent Test**: Fetch `/self-host.md` from squiredocs.com and from a self-hosted instance; verify it is the repository's `AGENTS.md` byte for byte, and that running its manual commands on a clean machine ends with a working claimed instance.

**Acceptance Scenarios**:

1. **Given** the served `/self-host.md`, **When** an agent reads it, **Then** it finds, in order: the prerequisite check (`docker compose version` reports v2), the install command, the equivalent manual commands (`mkdir`, download `compose.yml` and `squire` from the release, `docker compose up -d --wait`, `./squire claim-link` or its `docker compose exec app squire claim-link` form) each with its success condition, the rule that the claim link is printed bare on its own line with nothing appended, the recovery steps (new sign-in link, change the port, read logs, upgrade), the `down -v` warning with `docker compose down` named as the safe stop, and the warning that losing the data volume loses the generated encryption key.
2. **Given** the manual commands, **When** an agent runs them on a clean machine, **Then** each success condition is observable (`docker compose up -d --wait` exits 0, `squire doctor` exits 0, `claim-link` prints one link line) and the instance is claimable.
3. **Given** the repository, **When** `AGENTS.md` changes, **Then** the served `/self-host.md` changes with it; a test pins the two as the same bytes.
4. **Given** a self-hosted instance, **When** `GET /self-host.md` or `GET /install.sh` is requested, **Then** the same files are served as on squiredocs.com (RBD-060-2).

---

### User Story 3 - A release publishes the image and the install assets (Priority: P1)

A maintainer tags a release. CI builds the image for amd64 and arm64, smoke-tests both, publishes it to GHCR under the semver tag and `latest`, and attaches `compose.yml`, `squire`, `.env.example`, and `SHA256SUMS`, pinned to that image tag, to the GitHub release. A self-hoster upgrades by changing the version and running `docker compose pull && docker compose up -d --wait`; migrations run on boot.

**Why this priority**: `install.sh` and `self-host.md` both download from the latest release. Without a release that carries the assets and a pullable image, neither works.

**Independent Test**: Push a release tag to a test repository wired to the workflow; verify the image manifest lists both architectures, both tags resolve, the release carries the four assets, `SHA256SUMS` matches them, and `compose.yml` names the tagged image.

**Acceptance Scenarios**:

1. **Given** a tag `vX.Y.Z` is pushed, **When** the release workflow completes, **Then** `ghcr.io/<org>/<repo>:X.Y.Z` is a multi-architecture image for `linux/amd64` and `linux/arm64`, `latest` points at the same digest for a non-prerelease tag, and the release carries exactly the four assets with `compose.yml` and `.env.example` pinned to `X.Y.Z`.
2. **Given** a published release, **When** `docker compose up -d --wait` runs with its `compose.yml` on either architecture, **Then** the app container reports healthy on `/ready`, `squire doctor` exits 0, and the sandbox for agent scripts runs (the native module loads on both architectures).
3. **Given** an installed instance on release A, **When** the operator sets `SQUIRE_VERSION` to release B and runs `docker compose pull && docker compose up -d --wait`, **Then** the instance comes up on B with its documents, owner, and secrets intact and migrations applied.
4. **Given** the production deploy script (`script/build-and-deploy-aws.sh`, arm64 to ECR), **When** this feature is merged, **Then** that path builds and runs unchanged; the hosted service's behavior and served bytes do not change.
5. **Given** a tag that is not a semver release tag, **When** it is pushed, **Then** no image or release is published.

---

### User Story 4 - CI plays the agent against the freshly built image (Priority: P2)

Every release candidate is proven by a job that does what the agent in User Story 1 does: runs `install.sh` against the image just built, redeems the claim link the script prints (JSON mode), and drives the full MCP OAuth chain to a successful tool call, using a sign-in link instead of the dev faucet because the production image serves no development endpoints.

**Why this priority**: It is the machine-checkable form of the design's goal ("every command has a machine-checkable success condition"). It can only exist after stories 1 and 3.

**Independent Test**: Run the job on a candidate build; it must fail if the script's last line is not a valid claim link, if redemption fails, if consent cannot be approved with the owner session, or if the first tool call errors.

**Acceptance Scenarios**:

1. **Given** the image built in the same workflow run and the release assets generated for it, **When** the job runs `install.sh` with `--name` and `--email` against them (without contacting GHCR or a published release, RBD-060-6), **Then** the script exits 0 and its last stdout line parses as `http://localhost:<port>/claim#<token>`.
2. **Given** that link, **When** the driver redeems it in JSON mode, **Then** it receives the owner session, the user carries the given name and email, and the instance reports an owner.
3. **Given** the owner session, **When** the driver runs the OAuth chain (discovery, dynamic registration, PKCE authorize, consent approval through the production approval route, code exchange), **Then** it obtains a token and a `list_documents` call succeeds, and an operation that executes an agent script succeeds (RBD-060-7).
4. **Given** the job runs in CI, **When** the workflow triggers, **Then** it runs on the push of a release tag and can be started by hand; it does not run on every branch push (RBD-060-4).

---

### User Story 5 - Documentation names the self-hoster's own instance (Priority: P2)

A person reads about self-hosting on `/documentation/self-hosting` (linked from the launch pages and footer). On a self-hosted instance, every documentation page names that instance rather than squiredocs.com, carries no analytics tag, and links only to pages the instance serves. The README opens with the install command, and the Agents and MCP page gains a Codex section.

**Why this priority**: Feature 062's pages link to `/documentation/self-hosting`, and the 058 promotion notes hand the documentation-page hardcodes and the Google tag to this feature. Not blocking the install path, but blocking launch.

**Independent Test**: Build the site, serve it from a not-hosted instance, and scan the HTML: zero Google tag scripts, zero `https://squiredocs.com` URLs that mean "this instance", no links to hosted-only paths; then serve it hosted and diff against today's output: identical except for the new page and the Codex section.

**Acceptance Scenarios**:

1. **Given** the documentation site, **When** built, **Then** a page with slug `self-hosting` exists at `/documentation/self-hosting`, appears in the sidebar after "Agents and MCP" (RBD-060-9), and covers: prerequisites, the one-command install, what the script does, signing in with a claim link (including `./squire claim-link` and the startup-log link), connecting an agent (`claude mcp add --transport http squire-local http://localhost:3910/mcp`), what works without an API key and what a key adds, configuration through `.env` (port, keys, SMTP, S3), upgrading, backing up the three volumes, stopping safely versus `down -v`, exposing the instance only behind TLS, and where to get help.
2. **Given** a self-hosted (not hosted) instance, **When** any documentation page is served, **Then** it contains no Google tag, no canonical or Open Graph URL pointing at squiredocs.com, the five instance URLs in `markdown.md` and `agents-and-mcp.md` show the instance's own origin, the header and footer contain only links the instance serves (RBD-060-8), and the contact and security email addresses stay as they are.
3. **Given** the hosted service, **When** the same pages are served, **Then** they are byte-identical to today's output except for the new page, the sidebar entry, and the Codex section.
4. **Given** `documentation/agents-and-mcp.md`, **When** read, **Then** a Codex section describes a working connection to a Squire Docs instance over MCP; if a working setup cannot be described accurately and verified, the section is omitted and feature 062 is told to drop Codex (RBD-060-10).
5. **Given** the README, **When** opened on GitHub, **Then** its first section after the title shows the install command for people, says what it does, links to `self-host.md` for agents and to `/documentation/self-hosting`, mentions `./squire`, and carries the volume-loss warning (RBD-060-12).

---

### User Story 6 - The plugin's onboarding skill sends agents to self-host.md (Priority: P3)

A developer who has the Claude Code plugin installed asks for a local instance. The onboarding skill has one instruction for this case: fetch `https://squiredocs.com/self-host.md` and follow it, then use only the `squire-local` server's tools. The plugin's own server entry stays pointed at the hosted service (D9).

**Why this priority**: Small, isolated, and gated on the bundle drift guard. Useful once self-host.md exists.

**Independent Test**: Edit `distribution/shared/onboard.md`, regenerate with `node distribution/publish.mjs` (dry run), and run `npm run test:first-run`; the drift guard passes and the generated `claude-plugin/commands/onboard.md` carries the pointer.

**Acceptance Scenarios**:

1. **Given** `onboard.md`, **When** the user asks for a local instance or a `squire-local` server is configured, **Then** the skill tells the agent to fetch `https://squiredocs.com/self-host.md`, follow it, and use only the local server's tools for that instance.
2. **Given** the regenerated bundles, **When** the drift guard and size budgets run, **Then** they pass, the `url` in `.mcp.json` is still `https://squiredocs.com/mcp`, and the ship version is bumped per the publishing design.
3. **Given** this feature, **When** it merges, **Then** no mirror repository has been pushed to (`--publish` is never run).

---

### User Story 7 - The repository is ready to be public (Priority: P3)

A visitor to the public repository finds an MIT `LICENSE`, a `CONTRIBUTING.md` that says how to set up, test, and submit changes, and a `SECURITY.md` that says where to report vulnerabilities.

**Why this priority**: Feature 062's launch gate requires the `LICENSE` file; the rest is launch hygiene with no behavior.

**Independent Test**: The three files exist at the repository root with the required content; the `LICENSE` is the MIT text with the chosen copyright holder (RBD-060-13).

**Acceptance Scenarios**:

1. **Given** the repository root, **When** listed, **Then** `LICENSE` (MIT, matching `package.json`'s `"license": "MIT"`), `CONTRIBUTING.md`, and `SECURITY.md` exist.
2. **Given** `SECURITY.md`, **When** read, **Then** it names `security@squiredocs.com` as the reporting channel, asks for private disclosure, and states which versions receive fixes.
3. **Given** `CONTRIBUTING.md`, **When** read, **Then** it points at `docs/dev.md` for development setup, names the test commands, says changes go to `main` through the maintainer, states the license terms contributions fall under, and requires no DCO sign-off or CLA (RBD-060-14).

---

### Edge Cases

- The install folder exists and is empty: the script treats it as a fresh install (only a folder holding `compose.yml` counts as an installation).
- Neither `sha256sum` nor `shasum` exists: the script refuses to continue rather than skipping verification.
- The release download succeeds for some files and fails for others: the script exits at the first failure and removes what it downloaded in that run, so a rerun starts clean.
- The script is run with `--version` naming a release that has no assets (a pre-asset tag): the download fails with the release named in the message.
- `docker compose up -d --wait` times out (slow machine, first image pull): the script exits non-zero and names `docker compose logs app` as the next step; a rerun does not reinstall because the folder now holds an installation, and it prints the upgrade command instead, which also serves as the restart hint (RBD-060-16).
- `squire doctor` fails after the stack is healthy (for example an `APP_URL` that is neither localhost nor https after a user edit): the script exits non-zero with doctor's output and mints no link.
- `./squire` is run from another directory: it changes to its own folder first, so it finds `compose.yml`.
- The wrapper is run on a system without `docker compose` v2: the docker error is passed through unchanged.
- A self-hosted instance that sets `SQUIRE_PORT=4000`: `APP_URL` follows, the claim link and the documentation pages name port 4000, and `claude mcp add` in the self-hosting page is shown with 3910 as the default plus a sentence saying to use the configured port.
- `self-host.md` is fetched from a self-hosted instance: the file is served verbatim; its URLs refer to the distribution source (squiredocs.com and GitHub), not to the instance, which is correct.
- The hosted service is upgraded: `/self-host.md` and `/install.sh` are served there too; neither contains anything instance-specific.
- The GHCR image name is still the placeholder when a release is cut: the release workflow must fail at validation rather than publish an image under a placeholder name (RBD-060-1).
- An arm64 runner is unavailable for a private repository: the arm64 smoke leg is the only thing that cannot run, and the workflow reports it as skipped rather than passing silently (RBD-060-4).
- A pre-release tag (`v1.2.0-rc.1`): image tagged `1.2.0-rc.1`, no `latest` move, release marked pre-release; `install.sh` without `--version` never selects it.
- The Vite development server with `SQUIRE_HOSTED` unset: documentation pages render the self-hosted variant so a developer can see it.

## Requirements *(mandatory)*

### Functional Requirements

**Compose file and wrapper**

- **FR-001**: The repository MUST carry `distribution/self-host/compose.yml` defining three services: `app` (the published image), `postgres` (`pgvector/pgvector:pg16`), and `redis` (Redis 7). Postgres and Redis MUST NOT publish ports on the host; they are reachable only on the compose network with fixed credentials that are not secrets (RBD-060-18).
- **FR-002**: Every service MUST have a health check. `postgres` MUST use `pg_isready -h 127.0.0.1` (so the check passes only once TCP connections are accepted), `app` MUST check `/ready`, and `app` MUST depend on both with `service_healthy`, so `docker compose up -d --wait` returns only when the app can serve requests.
- **FR-003**: Data MUST live in three named volumes: `squire-data` (mounted at `/data`), `postgres-data`, and `redis-data`.
- **FR-004**: The app port MUST be published as `127.0.0.1:${SQUIRE_PORT:-3910}:3001`, and `APP_URL=http://localhost:${SQUIRE_PORT:-3910}` MUST be passed to the container explicitly. The container keeps listening on 3001.
- **FR-005**: The image reference MUST be `ghcr.io/<org>/<repo>:${SQUIRE_VERSION:-<pinned>}`, where `<org>/<repo>` is one build-time constant used by the compose file, `install.sh`, `self-host.md`, the documentation page, and the release workflow (RBD-060-1), and `<pinned>` is stamped to the release's version by the release workflow. The repository copy MUST carry a placeholder that the release workflow refuses to publish.
- **FR-006**: `compose.yml` MUST set no `SQUIRE_MODE` and no `SQUIRE_HOSTED`, so the instance boots in local mode, not hosted, with migrations on boot and generated secrets (the image defaults from 058 and 059).
- **FR-007**: `distribution/self-host/squire` MUST be a POSIX `sh` script that changes to its own directory and runs `docker compose exec app squire "$@"`, passing the exit code through. It MUST be shipped executable (D10).
- **FR-008**: `distribution/self-host/.env.example` MUST be a self-host file, not the repository's development `.env.example`. It MUST list `SQUIRE_PORT` and `SQUIRE_VERSION` first, state that local mode is the default, and list the optional settings a self-hoster may set, each commented out with its default (RBD-060-11). It MUST NOT set `SQUIRE_MODE=team`, `SQUIRE_HOSTED`, `NODE_ENV`, `CLIENT_URL`, development database URLs, Google placeholders, or placeholder secrets.

**Release assets and the image**

- **FR-009**: Every release MUST publish exactly these assets: `compose.yml`, `squire`, `.env.example`, and `SHA256SUMS` (SHA-256 of the other three in `sha256sum` format), with `compose.yml` and `.env.example` pinned to that release's image tag.
- **FR-010**: Releases MUST be cut from semver git tags `vX.Y.Z` (with an optional prerelease suffix). The image MUST be tagged `X.Y.Z`; `latest` MUST move only for non-prerelease tags; `SQUIRE_VERSION` values carry no `v` (RBD-060-5).
- **FR-011**: The image MUST be built for `linux/amd64` and `linux/arm64` and published to GHCR as one multi-architecture manifest. The build MUST use the existing `Dockerfile`; any Dockerfile change MUST keep `script/build-and-deploy-aws.sh` (single-platform arm64 build to ECR) working unchanged.
- **FR-012**: CI MUST smoke-test the image on both architectures before publishing: the container boots to healthy on `/ready` under the release `compose.yml`, `squire doctor --json` reports `ok: true`, and the agent-script sandbox (the native isolate module) loads and executes a trivial script (RBD-060-4, RBD-060-7).
- **FR-013**: The image MUST contain the served copies of `self-host.md` (from `AGENTS.md`) and `install.sh` so an instance can serve them (FR-021).

**install.sh**

- **FR-014**: `distribution/self-host/install.sh` MUST be POSIX `sh` (no bashisms; passes `shellcheck -s sh` with no errors), MUST never prompt, MUST exit non-zero with one specific message at the first failure, and MUST accept `--dir <path>` (default `./squire-docs`), `--version <X.Y.Z>` (default: the latest non-prerelease release), `--name <name>`, and `--email <email>`. Unknown flags are a usage error.
- **FR-015**: The script MUST, in order: (1) check `docker compose version` reports v2 and the daemon answers `docker info`, stopping with a message naming the fix; (2) create the install folder, or stop and print the upgrade command if the folder already holds `compose.yml`; (3) download the four release assets, verify the three files against `SHA256SUMS` using `sha256sum` or `shasum -a 256` (stopping if neither exists), and write `.env` containing `SQUIRE_VERSION=<version>`; (4) run `docker compose up -d --wait` then `./squire doctor`; (5) run `./squire claim-link` with `--name` and `--email` passed through when given, and print the link as the last line of stdout with nothing after it.
- **FR-016**: On any failure after files were downloaded in the same run but before the stack started, the script MUST remove those files so a rerun starts clean. It MUST NOT remove anything it did not create in that run, and MUST NOT remove volumes.
- **FR-017**: The script's progress and error text MUST go to stderr; stdout MUST carry only the claim link, so `sh install.sh | tail -n 1` is the link. Every error MUST name the next action (port in use names `SQUIRE_PORT` in `.env`; a failed wait names `docker compose logs app`).
- **FR-018**: The upgrade command printed by step (2) and documented in `self-host.md` MUST be: set `SQUIRE_VERSION` in `<dir>/.env` to the new release, then `docker compose pull && docker compose up -d --wait` in that folder (RBD-060-16).
- **FR-019**: The script MUST allow its asset source to be overridden through an environment variable (default: the GitHub release download URL for `<org>/<repo>`), so CI can run it against assets generated in the same workflow run; the override MUST NOT change any other behavior (RBD-060-6).
- **FR-020**: A test suite MUST exercise `install.sh` without Docker by stubbing `docker`, `curl`, and the checksum tool on `PATH`: the v1 and daemon-down refusals, the existing-install refusal and its upgrade command, checksum failure and cleanup, `.env` content, flag parsing, and that the claim link is the last stdout line.

**self-host.md and the served routes**

- **FR-021**: The server MUST serve `GET /self-host.md` (`text/markdown`) and `GET /install.sh` (`text/x-shellscript`) on every instance, hosted or not, verbatim, with no origin substitution (RBD-060-2). A test MUST pin the served bytes to `AGENTS.md` and `distribution/self-host/install.sh`.
- **FR-022**: `AGENTS.md` at the repository root MUST be the single source of `self-host.md`. It MUST open with one line saying what the file is (the self-hosting runbook for agents, served at `https://squiredocs.com/self-host.md`) and that contributor guidance is in `CONTRIBUTING.md` (RBD-060-3).
- **FR-023**: `AGENTS.md` MUST contain, in this order: the prerequisite check; the install command with its success condition (exit 0, last line is the link); the equivalent manual commands from the design (`mkdir squire-docs && cd squire-docs`, download `compose.yml` and `squire` from the latest release, `chmod +x squire`, `docker compose up -d --wait`, `./squire claim-link`), each with a success condition; the rule to print the claim link bare on its own line with nothing appended; the agent connection command `claude mcp add --transport http squire-local http://localhost:3910/mcp` and the Approve step; the headless fallback `docker compose exec app squire token create --name <agent>`; recovery steps (new sign-in link, startup-log link, change the port, read logs, upgrade per FR-018); and the warnings that `docker compose down -v` deletes every document and the generated encryption key while `docker compose down` is the safe stop. Commands in `AGENTS.md` MUST use the full `docker compose exec app squire` form (D10).
- **FR-024**: `AGENTS.md` MUST stay accurate to the shipped CLI: a test MUST assert that every `squire` subcommand it names exists in `server/cli`, and that every URL path it names (`/claim`, `/mcp`, `/ready`) is served.

**CI job that plays the agent**

- **FR-025**: A GitHub Actions workflow (the repository's CI system is `.github/workflows/`; see RBD-060-4) MUST, on a release tag push and on manual dispatch: build both architectures, smoke-test both (FR-012), run the agent job (FR-026), and only then publish the image tags and create the release with the assets. A failure anywhere MUST publish nothing.
- **FR-026**: The agent job MUST: load the candidate image under its release tag so compose does not pull; serve the generated assets locally and point `install.sh` at them (FR-019); run `install.sh --name --email`; take the last stdout line as the claim link; redeem it in JSON mode through `POST /auth/signin-link` (the 059 contract) and assert the owner's name and email; drive the OAuth chain with `test/first-run/oauth-chain-driver.mjs` using a new sign-in-link leg (discovery, registration, PKCE authorize with the owner session, approval through `POST /mcp/auth/approve`, code exchange); assert `list_documents` succeeds; and run one agent-script operation (RBD-060-7). The production image serves no development endpoints, so the job MUST NOT depend on `/auth/dev-login` or `/auth/dev-consent-approve`.
- **FR-027**: `oauth-chain-driver.mjs` MUST gain a `--signin-link <url>` option that replaces the dev faucet leg; its existing `--first-run` and default legs MUST keep working against the development server.
- **FR-028**: The existing `Test` workflow (`npm run test:server`, `test:client`, `test:first-run`) MUST keep running on every branch push and MUST gain the Docker-free `install.sh` tests (FR-020) and the served-route tests (FR-021).

**Documentation**

- **FR-029**: A documentation page with frontmatter slug `self-hosting`, title "Self-hosting", and the sidebar position in RBD-060-9 MUST exist at `documentation/self-hosting.md` and pass the existing validator and terminology gate. It MUST cover the topics in User Story 5 scenario 1, name only features that exist (no passwords, no OIDC, no team-mode providers; a sentence that team mode is coming is allowed), say "Squire Docs" never bare "Squire", and link to `self-host.md` for agents and to the repository.
- **FR-030**: On a not-hosted instance, served documentation pages MUST contain no Google tag, no `<link rel="canonical">` or Open Graph URL naming squiredocs.com, and MUST show the instance's own origin wherever a page shows an instance URL (today `https://squiredocs.com/api/...` and `https://squiredocs.com/mcp` in `markdown.md` and `agents-and-mcp.md`). Email addresses and references to the hosted service as a product MUST stay unchanged.
- **FR-031**: On a not-hosted instance, the documentation header and footer MUST contain only links the instance serves. Dropped: Pricing, About, Blog, Sign Up, Privacy, Terms, and the contact mailto. Kept: Documentation, Sign In, `/agents.md`, GitHub, and the copyright line. The two body links to `/security` and `/privacy` (in `account-and-support.md` and `search.md`) MUST become absolute links to the hosted pages on a not-hosted instance (RBD-060-8).
- **FR-032**: The self-hosted footer variant MUST be derived from the single `FOOTER` source in `client/scripts/site-footer.mjs` by filtering, never by a second hand-written footer, and this feature MUST NOT edit the `FOOTER` string or the four stamped marketing pages (feature 062 owns them; RBD-060-8).
- **FR-033**: On the hosted service, documentation pages MUST be byte-identical to today's output apart from the new page, its sidebar entry, and the Codex section. The Vite development server MUST render the same variant as production for the same `SQUIRE_HOSTED` value.
- **FR-034**: `documentation/agents-and-mcp.md` MUST gain a Codex section only if a connection from Codex to a Squire Docs instance over MCP has been verified end to end during implementation; the section MUST describe the verified path (RBD-060-10). If no path can be verified, the section MUST be omitted and `promotion-notes.md` MUST tell feature 062 to drop Codex from its copy.
- **FR-035 (README, applied by the merge queue)**: `README.md` MUST open, directly after its title, with a "Run it yourself" section containing the install command, one paragraph on what it does (folder, stack, claim link, two clicks), the `./squire` wrapper, links to `https://squiredocs.com/self-host.md` for agents and `/documentation/self-hosting` for people, and the warning that the data volume holds the generated encryption key. Its title MUST read "Squire Docs" (RBD-060-12). The rest of the README is updated by the merge queue per 058's and 059's owed lists; this feature adds the self-host distribution items (release assets, image name, `install.sh`, `/self-host.md`, the workflow).

**Plugin onboarding pointer**

- **FR-036**: `distribution/shared/onboard.md` MUST gain one instruction: when the user asks for a local instance, or a `squire-local` server is configured, fetch `https://squiredocs.com/self-host.md`, follow it, and use only the local server's tools for that instance (D9). The plugin's `.mcp.json` URL MUST stay `https://squiredocs.com/mcp`.
- **FR-037**: Bundles MUST be regenerated with `node distribution/publish.mjs` (dry run) and the ship version bumped; `--publish` MUST NOT be run; the drift guard and size budgets MUST pass.

**Launch hygiene**

- **FR-038**: `LICENSE` MUST be the MIT license text with the copyright holder in RBD-060-13; `CONTRIBUTING.md` and `SECURITY.md` MUST exist with the content in User Story 7 (RBD-060-14). The generated bundle `LICENSE` files MUST name the same holder.

**Hosted parity and safety**

- **FR-039**: Nothing in this feature MAY change the hosted service's behavior: `/agents.md`, the app shell, marketing pages, blog, and the ECR deploy path are untouched; the two new routes are additive.
- **FR-040**: `self-host.md`, `install.sh`, and the documentation page MUST state that plain HTTP is supported only on localhost and that exposing an instance requires a TLS-terminating proxy and an https `APP_URL` (design, Security considerations).

### Key Entities

- **Release**: a semver git tag, its multi-architecture image under `ghcr.io/<org>/<repo>`, and its four assets; `latest` is an alias for the newest non-prerelease.
- **Release asset**: one of `compose.yml`, `squire`, `.env.example`, `SHA256SUMS`; the first two and the fourth are what `self-host.md`'s manual path downloads.
- **Install folder**: a directory holding `compose.yml`, `squire`, `.env.example`, `.env`; its presence (specifically `compose.yml`) is what `install.sh` treats as an existing installation.
- **Claim link**: minted by feature 059; this feature only transports it (last stdout line of `install.sh`, the `--signin-link` leg of the driver).
- **Documentation page variant**: the hosted rendering (today's) and the self-hosted rendering (no tag, instance origin, filtered header and footer) of the same markdown source.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a laptop with Docker and a warm image cache, the install command finishes and prints a claim link in under five minutes, and the developer reaches a signed-in instance with an agent connected after exactly two clicks (Continue, Approve) and no typing (design goal).
- **SC-002**: 100% of `install.sh` failure paths exit non-zero with a message that names a next action; a tampered asset is refused every time.
- **SC-003**: `self-host.md` served from squiredocs.com and from a self-hosted instance equals the repository's `AGENTS.md` byte for byte.
- **SC-004**: The release workflow produces a manifest listing both architectures, and the smoke and agent jobs pass on a candidate before any tag is published; a failing job publishes nothing.
- **SC-005**: On a self-hosted instance, a scan of every served documentation page finds zero analytics scripts, zero instance URLs naming squiredocs.com, and zero links to paths that return 404 on that instance; on the hosted service, the diff against today's pages is limited to the new page, the sidebar entry, and the Codex section.
- **SC-006**: The hosted deploy path (`script/build-and-deploy-aws.sh`) completes unchanged after merge; the hosted service's served `/agents.md`, shell, and marketing pages are byte-identical before and after.
- **SC-007**: `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, and `/documentation/self-hosting` exist, so feature 062's launch gate items owned by 060 are satisfied.
- **SC-008**: The plugin bundles pass the drift guard with the onboarding pointer in place and no mirror push.

## Assumptions

- Features 058 and 059 are merged on `main` with their review fixes (verified: `9a490f94`). The image already runs `node script/entrypoint.js`, sets `NODE_ENV=production`, owns `/data`, checks `/ready`, generates secrets, migrates on boot, and ships `squire` on `PATH`. `claim-link` prints exactly one stdout line (the link); explanations go to stderr. `doctor --json` returns `{ok, failed, checks, info}`. These are relied on, not rebuilt.
- The CI system is GitHub Actions (`.github/workflows/test.yml` is the only workflow; the `origin` remote is GitHub). There is no GitLab CI file. The arm64 build and smoke test rely on GitHub-hosted arm64 runners (RBD-060-4); nothing in this feature can run inside the app-dev pod, which has no Docker daemon, so Docker-backed verification is owed to CI or a maintainer machine.
- The GHCR organization and repository name are not decided; 062 links to `https://github.com/squiredocs` and the plugin mirrors live under that organization, so the placeholder is `squiredocs/<repo>` (RBD-060-1). Sam decides the repository name before the first release.
- The first public release version is Sam's call; the workflow works for any `vX.Y.Z`.
- The isolate module ships prebuilt binaries for both Linux architectures (musl), so the multi-architecture build compiles nothing; the smoke test still proves it loads.
- The self-hosted documentation variant is produced by the existing build and server machinery; whether it is two rendered outputs selected at serve time or one output transformed at serve time is a plan decision. The outcome (FR-030 to FR-033) is what the spec fixes.
- The 062 implementation branch rebases onto this feature and edits `FOOTER` and the four marketing pages in its own isolated commit; this feature avoids those files (FR-032).
- `README.md`, `docs/dev.md`, and `CLAUDE.md` are not edited by the spec, plan, or implement agents; FR-035 and the plan's owed list are applied by the merge queue.

## Design gaps and found-in-spec items

Each is recorded with its default in `clarifications-needed.md`; none is resolved silently.

1. The design names the image as `ghcr.io/<org>/<repo>` and the manual commands use `github.com/<org>/<repo>`; neither is decided (RBD-060-1). Sam must decide.
2. The design says upgrading is `docker compose pull && docker compose up -d --wait`, but it also says `install.sh` writes `SQUIRE_VERSION` into `.env` and `compose.yml` reads the tag from it, so a bare `pull` never fetches a newer release. The upgrade needs a version change first (RBD-060-16). Suggested amendment: state the two-step upgrade, or add an `--upgrade` flag to the install script later.
3. The design does not say whether `/self-host.md` and `/install.sh` are served by self-hosted instances or only by squiredocs.com (RBD-060-2).
4. The design makes the root `AGENTS.md` the source of `self-host.md`. The `AGENTS.md` filename is also the convention several agents (Codex among them) read as instructions for working inside a repository, which is a different audience (RBD-060-3). Suggested amendment: acknowledge the convention and the preface line, or rename the source file.
5. The design's CI job runs `install.sh` "against the freshly built image", but the script downloads assets from a published release and compose pulls from GHCR; at job time neither exists (RBD-060-6).
6. The design's smoke test says "builds and smoke-tests both architectures" without saying what the smoke test is or whether the agent job runs on both (RBD-060-7, RBD-060-4).
7. The design does not say what the self-hosted documentation header and footer carry, or how the `/security` and `/privacy` body links behave off the hosted service (RBD-060-8).
8. The design does not mention Codex; feature 062's copy names it as supported (RBD-060-10).
9. The design says `.env.example` "lists every setting with its default"; the full setting table is long and partly hosted-only (RBD-060-11).
10. The design says the README "opens with the install command" but the README's title is still "Collaborative Rich Text Editor" (RBD-060-12).
11. The copyright holder for `LICENSE` is not stated anywhere: the site footer says "21st Harmonic LLC" and the generated bundle licenses say "Squire Docs" (RBD-060-13). Sam must decide.
12. The design's compose file does not state the Postgres credentials or whether the database and Redis ports are published (RBD-060-18).
13. The design's `install.sh` does not say how the latest version is discovered or what counts as "already holds an installation" (RBD-060-15).
