# Clarifications Ledger: 060-self-host-distribution

Per Constitution VI, unanswered product decisions get the best default,
recorded here. Work never blocks on the maintainer, and nothing is decided
silently. All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-10-07)** unless later overturned.

Ground truth: `design/self-hosting-local-mode.md` (ratified, D1 to D12).
Supporting designs: `design/plugin-marketplace-publishing.md` (distribution
conventions), `design/product-documentation-site.md` (documentation pages),
`design/oss-launch-messaging.md` (feature 062, which links into this feature's
outputs). Items marked **Sam must decide** have a default so work proceeds,
but the default is a placeholder, not a preference.

---

## RBD-060-1 - Image and repository name (Sam must decide)

**Question**: The design names the image `ghcr.io/<org>/<repo>` and the
manual commands download from `github.com/<org>/<repo>/releases`. Neither
the organization nor the repository name is decided. Today `origin` is
`github.com:samg/collab`; feature 062 links to `https://github.com/squiredocs`
and the plugin mirrors live under that organization.

**Why it matters**: The name appears in `compose.yml`, `install.sh`,
`AGENTS.md`, the documentation page, the README, and the release workflow. A
release published under the wrong name is a public artifact that cannot be
unpublished cleanly.

**Default chosen**: One build-time constant, `squiredocs/squire-docs`, held
in exactly one place (the release workflow stamps it into the assets; the
repository copies of `compose.yml` and `AGENTS.md` carry the literal
placeholder `<org>/<repo>`). The release workflow MUST fail validation if any
asset or the image name still contains `<org>` or `<repo>` at publish time.

**Rationale**: The `squiredocs` organization is already the public home of the
plugin mirrors and the launch copy, and a one-place constant makes the
eventual decision a one-line change. Sam decides the repository name before
the first release tag.

**RATIFIED by Sam 2026-10-07: squiredocs/squiredocs.** `REPOSITORY` in
`distribution/self-host/release.mjs` and its four mirrors (`AGENTS.md`,
`install.sh`, `compose.yml`, `documentation/self-hosting.md`) carry
`squiredocs/squiredocs`; the image is `ghcr.io/squiredocs/squiredocs` and the
assets come from https://github.com/squiredocs/squiredocs/releases. The
same-repository publish guard (RBD-060-20) stays, so a run in the current
private `samg/collab` repository fails validation and publishes nothing. The
placeholder refusals stay too, tested against a copy with the placeholder put
back.

---

## RBD-060-2 - `/self-host.md` and `/install.sh` are served on every instance, verbatim

**Question**: The design says `self-host.md` "sits next to the existing
`/agents.md`" and `install.sh` "is served from squiredocs.com". Feature 058
made `/agents.md` an every-instance route with origin substitution when not
hosted, and marketing pages hosted-only. Which rule applies to these two?

**Why it matters**: Decides whether a self-hoster's agent can re-read the
recovery steps from the instance it is working on, and whether the files
need the origin substitution that `/agents.md` gets.

**Default chosen**: Both routes are served on every instance (hosted or not)
and the bytes are served verbatim, with no origin substitution: `text/markdown`
for `/self-host.md`, `text/x-shellscript` for `/install.sh`. A test pins the
served bytes to `AGENTS.md` and `distribution/self-host/install.sh`.

**Rationale**: The URLs inside both files refer to the distribution source
(the install URL, GitHub releases, GHCR) and to `localhost:3910`, none of
which means "this instance", so substitution would be wrong. They name no
hosted-only feature, so the hosted-only gate does not apply. Serving them
everywhere keeps the two served files one copy of one source.

---

## RBD-060-3 - `AGENTS.md` at the repository root is the self-host runbook

**Question**: The design says `self-host.md` "is kept in the repository as
`AGENTS.md` and is published from there, so there is one source." The file
name `AGENTS.md` is also the convention that Codex, Cursor, and other agents
read automatically as instructions for working inside the repository, a
different audience (contributors with a clone) from the design's (agents
without a clone, setting up an instance).

**Why it matters**: A contributor's Codex session would open the repository
and be told to install Squire Docs with Docker. Renaming the source would
contradict a ratified sentence.

**Default chosen**: Follow the design: `AGENTS.md` is the self-host runbook
and the single source of `/self-host.md`. Its first line states what it is
(the self-hosting runbook for agents, served at
`https://squiredocs.com/self-host.md`) and that contributor guidance is in
`CONTRIBUTING.md` and `CLAUDE.md`. Flagged as a design amendment candidate:
either acknowledge the convention in the design or move the source to
`distribution/self-host/self-host.md`.

**Rationale**: The design is explicit and ratified; the preface line removes
the ambiguity for a repository-reading agent at the cost of one sentence.

---

## RBD-060-4 - CI system, runners, and what cannot run

**Question**: The design says CI "builds and smoke-tests both architectures"
and runs the agent job, without naming the system. The repository's only CI
is GitHub Actions (`.github/workflows/test.yml`: amd64 `ubuntu-latest`,
push-triggered, no Docker build, no registry login). The `origin` remote is
GitHub; there is no GitLab CI file. The app-dev pod has no Docker daemon.

**Why it matters**: Native arm64 execution needs an arm64 runner; QEMU
emulation of a Node server plus Postgres is slow and flaky. GitHub's hosted
arm64 runners (`ubuntu-24.04-arm`) are free for public repositories and
billed as larger runners for private ones.

**Default chosen**: A new GitHub Actions workflow, `release.yml`, triggered by
`v*` tag pushes and `workflow_dispatch`. It builds each architecture
natively on its own runner (`ubuntu-latest` for amd64, `ubuntu-24.04-arm`
for arm64), runs the smoke test on each, merges the two digests into one
manifest, runs the agent job on amd64, and only then publishes tags and the
release. The arm64 jobs are conditional on the runner being available; when
skipped, the workflow reports the skip and still refuses to publish a
multi-architecture manifest (a single-architecture publish needs an explicit
dispatch input, so a skip never passes silently). The existing `test.yml`
keeps running on every push and gains the Docker-free tests. Nothing in this
feature can run inside the app-dev pod; Docker-backed verification is owed to
CI on a public repository or a maintainer machine and is listed in
`promotion-notes.md`.

**Rationale**: Native runners avoid both QEMU and the isolate module's
cross-compilation question; the repository goes public at launch, which is
when the workflow first matters.

---

## RBD-060-5 - Tag scheme, `latest`, and `SQUIRE_VERSION`

**Question**: The design says "semver tags plus `latest`" and that
`compose.yml` reads the tag from `SQUIRE_VERSION`, but not the git tag form,
whether prereleases move `latest`, or whether `SQUIRE_VERSION` carries a `v`.

**Default chosen**: Git tags `vX.Y.Z` with an optional prerelease suffix
(`v1.2.0-rc.1`) trigger a release. The image is tagged `X.Y.Z` (no `v`);
`latest` moves only for non-prerelease tags; prereleases are marked as such on
GitHub and `install.sh` without `--version` never selects one. No `X.Y` or
`X` floating tags. `SQUIRE_VERSION` holds `X.Y.Z`. `package.json`'s `version`
is not consulted by the workflow; it is bumped to match by the maintainer when
tagging (owed in `promotion-notes.md`).

**Rationale**: One tag form keeps `compose.yml`, `.env`, and the release
name consistent; floating minor tags would let `pull` silently cross
migrations that users did not choose.

---

## RBD-060-6 - How the CI agent job feeds `install.sh` a local image and local assets

**Question**: `install.sh` downloads assets from the published release and
compose pulls the image from GHCR, but the agent job runs before either is
published.

**Why it matters**: Without an override the job either publishes first (so a
broken build is public) or cannot use the real script.

**Default chosen**: `install.sh` honors one environment variable,
`SQUIRE_INSTALL_ASSET_URL`, the base URL from which it downloads the four
assets (default: the GitHub releases download URL for the chosen version).
The job serves the generated assets from a local static server on that URL,
loads the candidate image into the local Docker daemon under its release tag,
and relies on compose's default pull policy (`missing`) so no registry is
contacted. The override changes nothing else and is documented in the
script's header, not in `self-host.md`.

**Rationale**: One variable, no second code path, and the job exercises the
same checksum verification as a user.

---

## RBD-060-7 - What the smoke test and the agent job prove

**Question**: The design says CI "builds and smoke-tests both architectures"
because the isolate module is native, and that a job plays the agent; it does
not define the smoke test or say whether the agent job runs per architecture.

**Default chosen**: The smoke test, on each architecture: `docker compose up
-d --wait` with the release `compose.yml` exits 0 within the health-check
budget; `squire doctor --json` reports `ok: true`; and a trivial script runs
inside the isolate sandbox (a one-line `node -e` inside the container that
loads the module and evaluates `1+1`). The agent job runs once, on amd64,
and ends with `list_documents` plus one `modify` call with a trivial script,
so the sandbox is also exercised through the real MCP path.

**Rationale**: The native-module risk is load-and-execute on each CPU, which
the per-architecture check covers cheaply; the end-to-end chain is
architecture-independent HTTP and runs once.

---

## RBD-060-8 - Documentation pages on a self-hosted instance: header, footer, body links, and 062 coordination

**Question**: RBD-058-6 and RBD-058-41 handed this feature the Google tag and
the squiredocs.com mentions in documentation pages. The pages also carry a
hardcoded header (Pricing, About, Documentation, Blog, Sign In, Sign Up), the
shared footer (Pricing, About, Documentation, Blog, agents.md, GitHub, Sign
up, Log in, Privacy, Terms, contact mailto, copyright), a canonical URL and
Open Graph URL on squiredocs.com, and two body links to `/security` and
`/privacy`. On a self-hosted instance Pricing, About, Blog, Security,
Privacy, and Terms return 404 (RBD-058-5). The footer source
(`client/scripts/site-footer.mjs`) is edited by feature 062 in an isolated
commit that lands after this feature.

**Default chosen**: On a not-hosted instance the documentation header shows
Documentation and Sign In only; the footer keeps Documentation, Sign In,
`/agents.md`, GitHub, and the copyright line and drops Pricing, About, Blog,
Sign Up, Privacy, Terms, and the contact mailto; the canonical and Open Graph
URL tags are omitted; the Google tag is omitted; `https://squiredocs.com`
in instance URLs becomes the request origin (the same substitution
`/agents.md` uses); the `/security` and `/privacy` body links become
absolute `https://squiredocs.com/security` and `https://squiredocs.com/privacy`
(they describe the hosted service's policies, which is the accurate
reference). Email addresses are unchanged. The self-hosted footer is derived
from the one `FOOTER` string by filtering anchor elements by href, never by a
second footer, and this feature does not edit `FOOTER` or the four stamped
marketing pages, so 062's tagline and link changes flow into the variant
untouched. Hosted output stays byte-identical apart from this feature's
content additions.

**Rationale**: Deriving the variant keeps one footer source (062's own
assumption) and avoids a merge conflict in the one file both features touch.
Pointing the policy links at the hosted pages is more honest than hiding
them: a self-hoster using the hosted embedding provider is still covered by
that policy text.

---

## RBD-060-9 - Where the self-hosting page sits in the sidebar

**Question**: The design fixes the path `/documentation/self-hosting` but not
the sidebar position. Orders are unique integers and the twelve existing
pages use 1 to 12 with no gaps.

**Default chosen**: `order: 10`, directly after "Agents and MCP" (9);
"Markdown export, import, and sync", "Appearance", and "Account and support"
move to 11, 12, 13. Title "Self-hosting"; description "Run your own Squire
Docs instance with Docker Compose, sign in with a claim link, and connect
your agent."

**Rationale**: The page is the natural continuation of connecting an agent,
and the launch pages link to it directly, so sidebar depth matters less than
adjacency.

---

## RBD-060-10 - The Codex section

**Question**: Feature 062's copy names Codex as a supported agent ("Connect
Claude Code, Codex, or any MCP agent"). Nothing in `documentation/` or
`agents.md` mentions Codex, the self-hosting design does not, and the
plugin design lists a Codex mirror as "not started". Can a working Codex
setup be described accurately?

**Why it matters**: A documented path that does not work is worse than
none; 062 needs to know whether to keep the word.

**Default chosen**: The implement phase verifies, end to end, a connection
from the Codex CLI to a Squire Docs instance over MCP, trying first the
OAuth path (register the server by URL, run the CLI's MCP login) and then
the token path (an `sk_sqd_` token from `squire token create` or Settings,
supplied through the CLI's bearer-token environment-variable setting). The
section documents only what was verified, with the exact commands and
configuration. If the OAuth path works, it is primary and the token path is
the headless fallback; if only the token path works, the section says so
plainly; if neither works, the section is omitted and `promotion-notes.md`
tells 062 to drop Codex. The result is flagged for Sam either way, because
verification needs a Codex login the pod does not have.

**Rationale**: The spec cannot assert a third-party tool's behavior from
memory; it can require the claim be proven before it is published.

**Overtaken 2026-10-07 by RBD-060-35**: Sam confirmed Codex works with Squire
Docs and asked for the section, written from Codex's documented setup.

---

## RBD-060-11 - Scope of the self-host `.env.example`

**Question**: The design says `.env.example` "lists every setting with its
default". The full setting list (README table from 058 and 059) runs to
dozens of variables, several hosted-only.

**Default chosen**: The self-host file lists, in groups and each commented
out with its default: `SQUIRE_PORT`, `SQUIRE_VERSION` (uncommented, stamped
by the release); `SQUIRE_MODE` (local, with a one-line note that team mode
is a later release); assistant keys (`ANTHROPIC_API_KEY`,
`GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`, and the others the AI
provider module reads) and `GOOGLE_GENERATIVE_AI_API_KEY` as the semantic
search key; `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`,
`SMTP_SECURE`; `STORAGE_DRIVER`, `S3_IMAGE_BUCKET`, `S3_ENDPOINT`, and the
AWS credentials; `APP_URL` with the note that it is derived from
`SQUIRE_PORT` unless the instance is behind a TLS proxy; and a closing line
pointing at the README for the full list. It never lists `SQUIRE_HOSTED`,
`NODE_ENV`, `CLIENT_URL`, `MIGRATE_ON_BOOT`, the four secrets, or
`ENABLE_DEV_ENDPOINTS`.

**Rationale**: The design's "only setting a try-out user might need is
`SQUIRE_PORT`" sets the tone: the file is a menu of things a self-hoster may
turn on, not the configuration reference.

---

## RBD-060-12 - README title and opening section (applied by the merge queue)

**Question**: The design says the README "opens with the install command for
people and links to `self-host.md` for agents". The README's title is
"Collaborative Rich Text Editor" and its Installation section is a clone-and-
npm walkthrough.

**Default chosen**: The title becomes "Squire Docs". A new first section,
"Run it yourself", carries the install command, a paragraph on what it does,
`./squire`, the two links, and the volume-loss warning. The existing
clone-and-npm section is retitled "Developing" and kept. Applied by the merge
queue, with the 058 and 059 owed README items.

**Rationale**: The README is the public repository's face at launch; a title
that does not name the product is a defect under Principle I, and the change
is one line.

---

## RBD-060-13 - Copyright holder in `LICENSE` (Sam must decide)

**Question**: Sam chose MIT on 2026-10-07. The site footer reads "© 2026 21st
Harmonic LLC"; `distribution/publish.mjs` generates bundle licenses with
"Copyright (c) 2026 Squire Docs".

**Default chosen**: `Copyright (c) 2026 21st Harmonic LLC`, and the generated
bundle licenses are changed to the same holder (bumping the bundle versions,
which this feature already does). Sam confirms the legal entity before the
repository goes public.

**Rationale**: A limited company is a legal person; "Squire Docs" is a
product name. The footer is the more deliberate statement.

---

## RBD-060-14 - Contributor terms and the security policy

**Question**: The task asks whether a DCO or CLA is needed under MIT and what
`SECURITY.md` says.

**Default chosen**: No DCO sign-off and no CLA. `CONTRIBUTING.md` states that
contributions are accepted under the repository's MIT license (the inbound
equals outbound rule), points at `docs/dev.md` for setup, names `npm test`,
`npm run test:server`, `npm run test:client`, and `npm run test:first-run`,
says the maintainer merges to `main` with no pull-request ceremony required
of them but that external changes arrive as pull requests, asks for an issue
before large changes, and notes the writing rules (plain sentences, no em
dashes, "Squire Docs" in user-facing copy). `SECURITY.md` names
`security@squiredocs.com`, asks for private disclosure with a reproduction,
promises an acknowledgment, states that the latest release and the hosted
service receive fixes, offers no bounty, and links the public security page.

**Rationale**: MIT contributions carry an implied license grant; a CLA adds
ceremony Principle III forbids without a concrete failure it prevents.

---

## RBD-060-15 - Latest-version discovery and what counts as an installation

**Question**: The design's `install.sh` downloads "the latest release (or
`--version`)" and refuses a folder that "already holds an installation",
without saying how either is determined.

**Default chosen**: Without `--version`, the script resolves the latest
non-prerelease by following `https://github.com/<org>/<repo>/releases/latest`
(the `Location` header names the tag) and never calls the GitHub API, so it
needs no token and no JSON parsing. A folder holds an installation when it
contains `compose.yml`; an empty or missing folder is fresh. The wrapper is
POSIX `sh`; Windows users run `docker compose exec app squire` directly
(noted in the documentation page).

**Rationale**: The redirect works unauthenticated and rate-limit free;
`compose.yml` is the one file every manual and scripted install shares.

---

## RBD-060-16 - Upgrading is two steps (design gap)

**Question**: The design says "Upgrading is `docker compose pull && docker
compose up -d --wait`", but `install.sh` writes `SQUIRE_VERSION` to `.env`
and `compose.yml` reads the tag from it, so `pull` fetches nothing new until
the version changes.

**Default chosen**: The documented and printed upgrade is: set
`SQUIRE_VERSION` in `.env` to the new release, then `docker compose pull &&
docker compose up -d --wait` in the install folder. The existing-install
refusal prints exactly this, with the folder path and, when it can resolve
it, the latest version. A rerun after a failed `--wait` lands on the same
message, which also serves as the restart hint. An `--upgrade` flag is a
follow-on, not in the design's flag list. Flagged as a design amendment.

**Rationale**: Pinning is what makes installs reproducible and
`SHA256SUMS` meaningful; the cost is one line edit, which agents handle.

---

## RBD-060-17 - `install.sh` output discipline

**Question**: The design says the link is printed "on its own line as the
last line of output" but not where progress text goes.

**Default chosen**: Progress and errors go to stderr; stdout carries only the
claim link. `docker compose` output is passed through on stderr. The design's
"last line of output" holds for a terminal (stderr and stdout interleave)
and `| tail -n 1` on stdout is the link.

**Rationale**: Agents capture stdout; a link that can be isolated with one
pipe is the machine-checkable success condition the design asks for.

---

## RBD-060-18 - Compose credentials and internal ports

**Question**: The design's compose file does not state the Postgres user,
password, or database, or whether Postgres and Redis publish ports.

**Default chosen**: Postgres and Redis publish no host ports. Postgres runs
with user `squire`, password `squire`, database `squire`, set in
`compose.yml` and consumed by the app through `DATABASE_URL` on the compose
network; these are not secrets because nothing outside the compose network
can reach them. Redis runs without a password. An operator who exposes either
service edits the file and owns the consequence; the self-hosting page says
so.

**Rationale**: Generating a database password per install would need
`install.sh` to write it into `.env` and the manual path to do the same by
hand, for no gain while the ports stay unpublished.

---

## RBD-060-19 - The workflow is not the hosted deploy

**Question**: The hosted service builds arm64 to ECR through
`script/build-and-deploy-aws.sh` and deploys by digest. Does the GHCR release
replace or feed it?

**Default chosen**: No. The release workflow and the hosted deploy are
independent; the hosted service keeps building from the commit it deploys.
Nothing in this feature touches the deploy scripts or the overlays. Whether
the hosted service should later deploy the GHCR digest is a follow-on
question for Sam.

**Rationale**: The design's fourth goal is that the hosted service keeps
running with no behavior change; coupling the two paths at launch adds risk
for no launch value.

---

# Plan phase (2026-10-07)

All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-10-07)**.
Research references are to `research.md`.

## RBD-060-20 - The repository name is a code constant mirrored in four served files

**Question**: RBD-060-1 has the release workflow stamp the name into assets,
but `AGENTS.md` and `install.sh` are served verbatim from the image (FR-021),
not from release assets, so a release-time stamp cannot reach them.

**Default chosen**: `REPOSITORY` in `distribution/self-host/release.mjs` is
the one definition. `AGENTS.md`, `install.sh`, `compose.yml`, and
`documentation/self-hosting.md` carry it as a literal, and a Docker-free
drift test fails on any mismatch. Until Sam decides, the value is the literal
`<org>/<repo>`; `install.sh` refuses to run while it is, and the release
workflow refuses to publish unless the value has no placeholder and equals the
lowercased `github.repository` (R1). Setting the name is a find-and-replace
that the drift test checks.

**Rationale**: Keeps one source of truth and RBD-060-1's refusal, and also
stops a fork from publishing under the canonical name. A hosted deploy before
the decision serves runbook text with a visible placeholder and a script that
refuses cleanly, which nothing links to until 062 lands.

## RBD-060-21 - The settings file is published as the asset `env.example`

**Question**: FR-009 lists the asset `.env.example`, but GitHub renames
release assets whose names start with a period.

**Default chosen**: The repository file stays `distribution/self-host/.env.example`
(FR-008). The release asset is `env.example`, `SHA256SUMS` lists it under that
name, and `install.sh` saves it as `.env.example` in the install folder. The
publish job fails unless the release's asset names are exactly `compose.yml`,
`squire`, `env.example`, `SHA256SUMS` (R2). Spec amendment candidate for
FR-009 and US1 scenario 1.

## RBD-060-22 - Compose 2.24 or later; optional settings reach the container through `env_file`

**Question**: Compose reads `.env` only for interpolation, so keys a
self-hoster adds to `.env` (assistant keys, SMTP, S3) never reach the app
unless the compose file passes them.

**Default chosen**: `app.env_file: [{ path: .env, required: false }]`, with
`environment` (database, Redis, `APP_URL`) taking precedence. `required:
false` needs Docker Compose 2.24.0 or later, so `install.sh`, `AGENTS.md`,
and the documentation page require that version and name it in the
prerequisite message. `APP_URL` is `${APP_URL:-http://localhost:${SQUIRE_PORT:-3910}}`
so an instance behind a TLS proxy can set an https `APP_URL` in `.env`
(extends FR-004 without changing its default) (R3). Design amendment
candidate ("The compose file").

## RBD-060-23 - The wrapper disables the TTY when it is not interactive

**Question**: `docker compose exec` allocates a TTY by default, which merges
the CLI's stderr into stdout with CRLF line endings; `install.sh` captures
`./squire claim-link`'s stdout.

**Default chosen**: `./squire` passes `-T` unless both stdin and stdout are
terminals (R4). `AGENTS.md` keeps D10's `docker compose exec app squire`
form; the CI smoke runs that form with no terminal and checks stdout is clean.
If CI shows otherwise, the implement phase adds `-T` to `AGENTS.md` and
records a design amendment.

## RBD-060-24 - How the self-hosted documentation variant is produced and served

**Question**: The spec leaves the mechanism to the plan (Assumptions) and
RBD-060-8 asks for the request origin in instance URLs.

**Default chosen**: Built at build time from the same renderer with a
`variant` option into `client/dist/documentation/_self-hosted/` (never
addressable by URL), served by not-hosted instances from memory with the
sentinel `__SQUIRE_ORIGIN__` replaced per request. Only text matching
`https://squiredocs.com/mcp` and `https://squiredocs.com/api/` is an instance
URL; distribution URLs (`/install.sh`, `/self-host.md`) and email addresses
stay. The request origin from `buildBaseUrl(req)` is used only if it parses
as an http(s) origin, and is HTML-escaped; otherwise `APP_URL` is used (R11).

**Rationale**: Hosted output stays the same code path with the same inputs.
The `Host` header is client-controlled, so it cannot enter HTML unchecked.

## RBD-060-25 - One href rule filters the self-hosted header, footer, and body links

**Default chosen**: `keepSelfHostedHref` drops `mailto:`, `/signup`, and the
hosted-only paths (the server's `isHostedOnlyPath` list, checked by a test),
and keeps every other href, including ones it has never seen, so 062's
"Self-host" link and tagline pass through. Footer columns left empty are
removed. The header uses the same rule (leaving Documentation and Sign In).
Hosted-only body links become absolute `https://squiredocs.com` links.

## RBD-060-26 - Release mechanics: tested bytes are the published bytes

**Default chosen**: Each architecture builds natively, smoke-tests, and saves
its image as a tarball artifact. The publish job, which runs only after every
gate and only for a `v*` tag ref (push, or dispatch with `publish: true`),
loads and pushes those tarballs under `<version>-<arch>` staging tags,
assembles the manifest, moves `latest` only for non-prereleases, creates the
release, and verifies the asset names. A dispatch from a branch uses version
`0.0.0-ci.<run_number>` and never publishes. A single-architecture publish
needs `allow_single_arch: true`; otherwise a skipped arm64 leg fails the
publish job with a message (R7).

## RBD-060-27 - The CI agent's auth leg uses the SPA's refresh exchange

**Default chosen**: The driver redeems the link in JSON mode, exchanges the
refresh cookie at `POST /auth/refresh` for the session Bearer token (as the
SPA does), checks `GET /auth/providers` reports an owner, and approves
consent at `POST /mcp/auth/approve`. The agent-script operation is one
`modify` call that appends a paragraph to the welcome document (R9).

## RBD-060-28 - A `node --test` suite for the Docker-free distribution tests

**Default chosen**: `npm run test:self-host` runs `test/self-host/*.test.mjs`
(using `dash` when present for POSIX fidelity). `shellcheck` runs when
installed and is skipped with a notice otherwise; `test.yml` runs it
explicitly. `npm test` is unchanged (R13).

## RBD-060-29 - Where the served files come from in the image

**Default chosen**: Two additive `COPY` lines in the Dockerfile's runtime
stage put `AGENTS.md` at `/app/AGENTS.md` and `install.sh` at
`/app/distribution/self-host/install.sh`. The routes read them from the
repository-relative path at mount, the same path in development and in the
image. Because the hosted image is built from the same Dockerfile,
squiredocs.com serves both after its next deploy (R10).

## RBD-060-30 - Hosted byte identity is proven against recorded hashes

**Default chosen**: The first implementation task records the SHA-256 of
every hosted documentation page and the 404 as built today. The test compares
the hosted render (without the new page in the page set) to those hashes;
`agents-and-mcp` is re-recorded only if the Codex section ships (R12).

## RBD-060-31 - `SHA256SUMS` stays in the install folder

**Question**: US1's independent test expects "the four release files" in the
folder, while the Install folder entity lists four files without
`SHA256SUMS`.

**Default chosen**: Keep `SHA256SUMS` in the folder. It names `env.example`
(RBD-060-21), so a by-hand re-check of `.env.example` needs that name; the
self-hosting page does not ask users to re-verify.

## RBD-060-32 - The port-conflict message

**Default chosen**: When `docker compose up` fails with "port is already
allocated" or "address already in use", `install.sh` prints `Port <p> is in
use. Set SQUIRE_PORT in <dir>/.env and run docker compose up -d --wait
again.`, following the design's example CLI wording with the install
folder's path and the `--wait` the rest of the flow uses.

## RBD-060-33 - The manual claim step in `AGENTS.md` uses the full docker form

**Question**: FR-023's list of manual commands includes `./squire claim-link`,
while its last sentence (and D10) require the full `docker compose exec app
squire` form in `AGENTS.md`; US2 scenario 1 accepts either.

**Default chosen**: `AGENTS.md` writes the manual claim step as `docker
compose exec app squire claim-link`, and may mention `./squire claim-link` as
the short form for people in prose but never as a step an agent runs. The
`agents-md` test asserts the full form appears in every command line. This
follows D10 ("AGENTS.md keeps the full docker command because it works from
any folder"). Spec text amendment candidate for FR-023.

# Implement phase (2026-10-07)

All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-10-07)**
unless marked otherwise.

## RBD-060-34 - The driver peeks the link and posts the prefilled name and email

**Question**: contracts/oauth-driver-signin-link.md has the driver redeem
with body `{ token }`, but `POST /auth/signin-link` refuses a claim link
without `name` and `email` in the body (`claim_invalid`, field `name`): the
prefill is stored with the link and the claim page reads it through
`POST /auth/signin-link/peek`, then posts it back.

**Default chosen**: The `--signin-link` leg calls `POST /auth/signin-link/peek`
(read-only), then posts `{ token, name, email }` from the peek's `prefill` for
a claim link and `{ token }` for a sign-in link, exactly as the claim page
does. Verified against a local-mode server on a fresh and a claimed instance.
Contract amendment candidate.

## RBD-060-35 - Codex section written from Codex's documented MCP setup

**Decision (orchestrator, relaying Sam)**: Codex section written from Codex's
documented MCP setup; Sam confirmed Codex works on 2026-10-07; exact commands
to be checked by Sam before launch. The section in
`documentation/agents-and-mcp.md` uses `codex mcp add squire --url
https://squiredocs.com/mcp`, `codex mcp login squire`, the
`[mcp_servers.squire]` `url` form in `~/.codex/config.toml`, and
`bearer_token_env_var` for the headless token path, as OpenAI's Codex MCP page
documented them on 2026-10-07 (developers.openai.com/codex/mcp, which
redirects to learn.chatgpt.com/docs/extend/mcp). It names
`http://localhost:3910/mcp` for a self-hosted instance. The agents-and-mcp
golden hash was re-recorded in the same commit for this section only. Not run
from the pod (no Codex login).

## RBD-060-36 - install.sh closes stdin for every command it runs

**Question**: Under `curl ... | sh`, the shell reads the script from stdin, and
`docker compose exec` (and `curl`) inherit it, so a child could swallow the
rest of the script.

**Default chosen**: Every `docker`, `curl`, and `./squire` call in
`install.sh` reads `/dev/null`. A test feeds the script text on stdin to
stubs that log anything they read and asserts nothing was read. `docker
compose up` output is captured and written to stderr when the command ends
(needed for the port-conflict match), so it is not streamed live.

## RBD-060-37 - The request origin must be a plain host before it enters documentation HTML

**Question**: research R11 validates the origin with `new URL(v).origin === v`,
but the WHATWG URL parser accepts quotes and similar characters in a host
(`Host: x'onmouseover='...` round-trips), which escaping alone made safe but
left in the page.

**Default chosen**: `safeOrigin` additionally requires the host to be a DNS
name or IP literal with an optional port; anything else falls back to
`APP_URL`. The value is still HTML-escaped. The Vite plugin applies the same
rule with `localhost:5173` as its fallback.

## RBD-060-38 - The existing-install message names the folder's absolute path

**Default chosen**: The upgrade command printed for an existing install uses
the folder's absolute path (`cd /abs/path && docker compose pull && ...`), so
it works from wherever the agent runs it. The port-conflict and
`docker compose logs app` messages use the same absolute path.

## RBD-060-39 - Self-hosted documentation uses the configured origin, not the request Host

**Question**: Post-merge review M5. `safeOrigin` put the request's own origin
into self-hosted documentation pages. A caching reverse proxy in front of an
instance could store a page carrying a client-chosen Host for every visitor.

**Default chosen**: When `APP_URL` or `CLIENT_URL` is set (`appUrlSource` is
not `'default'`), the page always carries that configured origin. The
request origin, still validated and escaped per RBD-060-37, is used only on
the localhost default, where no proxy is expected. The shipped `compose.yml`
always sets `APP_URL`, so every Compose install uses the configured origin.
This narrows RBD-060-8 and research R11, which chose the request origin to
match `/agents.md`; `/agents.md` itself is unchanged.

## RBD-060-40 - install.sh installs only into an absent or empty folder

**Question**: Post-merge review H2. `--dir` pointing at a non-empty folder
overwrote `.env`, `.env.example`, `squire`, and `SHA256SUMS`, and a failed
download then removed those files even though the user had them first.

**Default chosen**: A folder holding `compose.yml` still prints the upgrade
command (FR-018). Any other non-empty folder (hidden files count) is refused
before any download, exit 1, naming the folder and `--dir`; a `--dir` that is
a file is refused the same way. The cleanup rule is unchanged, and now can
only remove files this run created in a folder it created or found empty.

## RBD-060-41 - Each install gets its own Compose project name

**Question**: Post-merge review M1. Compose names a project after the
folder's basename, so two installs in folders that share a basename (for
example `~/a/squire-docs` and `~/b/squire-docs`) shared containers and
volumes.

**Default chosen**: `install.sh` writes
`COMPOSE_PROJECT_NAME=squire-docs-<8 random hex digits>` (from
`od -An -N4 -tx1 /dev/urandom`) into `.env`, and fails naming `od` if it
cannot. Compose reads `.env` from the folder it runs in, and every
`docker compose` and `./squire` call (the wrapper changes to its own folder
first), the printed upgrade command, and the documented commands run in the
install folder, so they all use the project. Volumes are now prefixed with
that name; `documentation/self-hosting.md` says to keep the line. The manual
path in `AGENTS.md` writes no `.env` and keeps the folder-name project, which
is fine for its single fixed folder.

## RBD-060-42 - SQUIRE_PORT given to install.sh is saved to .env

**Question**: Post-merge review M6. `SQUIRE_PORT` set for the install was
used for the first `up` but not saved, so the next `docker compose up` from
the folder moved the instance back to 3910.

**Default chosen**: When `SQUIRE_PORT` is set and non-empty, `install.sh`
checks it is a number from 1 to 65535 (else exit 1 before creating anything,
which also keeps a newline or other text out of `.env`) and writes
`SQUIRE_PORT=<value>` into `.env`. Empty means unset.

## RBD-060-43 - `latest` moves only to the highest X.Y.Z release

**Question**: Post-merge review L2. `release.yml` tagged every non-prerelease
image `latest`, so a backport (v1.2.4 after v1.3.0) moved `latest` back, and
`gh release create` would also have moved GitHub's Latest release, which
`install.sh` follows.

**Default chosen**: The publish job lists tags with `git ls-remote --tags
origin` and `release.mjs latest` prints `latest=true` only when the version
has no prerelease suffix and no `vX.Y.Z` release tag is higher (prerelease
tags are ignored). That one decision sets both the `:latest` manifest tag and
`gh release create --latest=true|false`.

---

**Sam's decisions, 2026-10-08 (upgrading the defaults above):**

- **RBD-060-13 RATIFIED with a change:** the copyright holder is `Sam Goldstein`, not the LLC (21st Harmonic LLC is a single-member registered business with no assets yet; Sam can assign the copyright to it later). Line: `Copyright (c) 2025-2026 Sam Goldstein`, in `LICENSE` and every generated plugin bundle. The marketing pages' "© 21st Harmonic LLC" copy is unaffected.
- **RBD-060-5 RATIFIED:** the first release is `v1.0.0` (image `ghcr.io/squiredocs/squiredocs:1.0.0` plus `latest`).
- **RBD-060-10 RATIFIED:** the Codex section ships; Sam confirmed Codex works and signed off the commands as written.
