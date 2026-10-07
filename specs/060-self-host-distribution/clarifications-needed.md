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
