# Promotion notes: 060-self-host-distribution

Records relaxations consciously accepted during this feature's pipeline,
preconditions for release and launch, and items handed to other features or
to Sam. Later phases append here.

## Spec phase (2026-10-07)

- **No relaxations introduced by the spec.** It encodes the ratified design
  (`design/self-hosting-local-mode.md`, D1 to D12, build step 3) plus the
  RATIFIED-BY-DEFAULT decisions in `clarifications-needed.md` (RBD-060-1 to
  RBD-060-19).

- **Placeholders Sam must replace before the first release tag**:
  1. The GHCR organization and repository name (RBD-060-1). The release
     workflow refuses to publish while the placeholder is present.
  2. The `LICENSE` copyright holder (RBD-060-13; default 21st Harmonic LLC).
  3. The first release version (RBD-060-5; `package.json` says 1.0.0).

- **What cannot be verified in the app-dev pod** (no Docker daemon): the
  compose stack, `install.sh` against a real daemon, the multi-architecture
  build, the smoke tests, and the agent job. These run in GitHub Actions on
  the public repository (RBD-060-4) or on a maintainer machine. The
  Docker-free `install.sh` tests (FR-020) and the served-route tests
  (FR-021) run everywhere. The arm64 runner may be unavailable while the
  repository is private; the workflow reports the skip and refuses a silent
  single-architecture publish.

- **Inputs from 058 and 059 that this feature depends on** (verified on
  `main` at `9a490f94`): the image CMD `node script/entrypoint.js`,
  `NODE_ENV=production`, `/data` owned by the app user, HEALTHCHECK on
  `/ready`, generated secrets, `MIGRATE_ON_BOOT=true`, `squire` on `PATH`,
  `claim-link` printing the link as its only stdout line, `doctor --json`
  with `ok` and `failed`, `POST /auth/signin-link` JSON mode setting cookies
  and returning `{ok, user}`, and `POST /mcp/auth/approve` as the
  session-authenticated consent route the CI driver uses in place of the dev
  endpoint.

- **Items handed to this feature by 058 and 059, all covered**: documentation
  page hardcodes (RBD-058-6, FR-030), the Google tag on documentation pages
  (RBD-058-41, FR-030), compose passing `APP_URL` explicitly (058 spec gap 1,
  FR-004), a self-host `.env.example` with local mode as the default (059
  orchestrator note, FR-008), and the README and `AGENTS.md` volume-loss
  warning (design, "Generated secrets"; FR-023, FR-035).

- **Coordination with feature 062** (lands after 060, rebases onto it):
  - This feature does not edit `client/scripts/site-footer.mjs`'s `FOOTER`
    string or the four stamped marketing pages (FR-032). The self-hosted
    documentation footer is derived from `FOOTER` by filtering, so 062's
    tagline and its new "Self-host" link flow through. If 062's "Self-host"
    link (`/documentation/self-hosting`) is added to `FOOTER`, it resolves on
    self-hosted instances and the filter keeps it.
  - 062's launch gate items owned by 060: `LICENSE`, `/documentation/self-hosting`,
    `/install.sh`, `/self-host.md`.
  - Codex: FR-034 and RBD-060-10. The implement phase records here whether
    the Codex section shipped; if it did not, 062 must drop Codex from its
    hero and agent list (062 FR-003, FR-012).

- **Design-doc amendments to request in Squire** (never hand-edit the
  exports; amend the source doc, then `node design/sync.mjs`):
  1. "Images and upgrades": upgrading needs the `SQUIRE_VERSION` change
     before `pull` (RBD-060-16).
  2. "Agent-facing documentation": `/self-host.md` and `/install.sh` are
     served by every instance, verbatim (RBD-060-2); the `AGENTS.md`
     convention note and preface line (RBD-060-3).
  3. "Images and upgrades": tag form, `latest` policy, prerelease handling
     (RBD-060-5), and the smoke test definition (RBD-060-7).
  4. "Release files and the install script": the asset-source override for
     CI (RBD-060-6), latest-version discovery and the installation test
     (RBD-060-15), stdout and stderr discipline (RBD-060-17).
  5. "The compose file": internal credentials and unpublished ports
     (RBD-060-18).
  6. Build sequence step 3: the CI job uses `POST /mcp/auth/approve` with the
     owner session for consent (no dev endpoint in the production image).

- **Documentation owed by the merge queue** (spec, plan, and implement
  agents may not edit these files):
  - `README.md`: title "Squire Docs"; the opening "Run it yourself" section
    (FR-035, RBD-060-12); the release and image naming
    (`ghcr.io/<org>/<repo>`, tag scheme); `install.sh` and its flags and the
    asset-source override; `/self-host.md` and `/install.sh` routes; the
    release workflow and the agent job; `distribution/self-host/` layout;
    the self-hosting documentation page; `LICENSE`, `CONTRIBUTING.md`,
    `SECURITY.md`. Plus the 058 and 059 owed items if still outstanding.
  - `docs/dev.md`: how to run the Docker-free `install.sh` tests; how to
    render the self-hosted documentation variant in Vite (`SQUIRE_HOSTED`
    unset); the release process (tag, workflow, placeholders); that no
    Docker-backed check runs in the pod.

- **Pre-existing conditions noted, deliberately not changed here**:
  1. `test:first-run` runs `node --test test/first-run/*.test.mjs`;
     `oauth-chain-driver.mjs` is a hand-run script, not a test. The CI agent
     job invokes it directly; it is not added to `test:first-run`.
  2. `.github/workflows/test.yml` uses `pgvector/pgvector:pg15` while the
     design and compose use `pg16`. Left as is; the compose file follows the
     design (production uses pg16).
  3. The plugin bundle licenses say "Squire Docs" as the holder; aligned to
     RBD-060-13 in this feature because the bundles are regenerated anyway.

## Plan phase (2026-10-07)

- **No relaxations introduced by the plan.** New defaults are RBD-060-20 to
  RBD-060-33. No database migration.

- **Spec text the plan deviates from, by recorded default**:
  1. FR-009 and US1 scenario 1 name the asset `.env.example`; it is published
     as `env.example` because GitHub renames dot-leading asset names
     (RBD-060-21). Installed name unchanged.
  2. FR-005 and RBD-060-1 assumed the release stamps the repository name
     into every file; `AGENTS.md` and `install.sh` are served from the image,
     so the name is a repository constant mirrored in four files with a drift
     test (RBD-060-20).
  3. FR-014/FR-015's "v2" check is tightened to Compose 2.24 or later
     (RBD-060-22).

- **Design-doc amendments to request in Squire** (in addition to the spec
  phase's list): the asset name `env.example` (RBD-060-21); Compose 2.24+ and
  `env_file` with `required: false`, and the overridable `APP_URL` default
  (RBD-060-22); the wrapper's conditional `-T` (RBD-060-23); the served
  files come from the image built from the repository (RBD-060-29).

- **Docker-only checks owed** (cannot run in the pod; all are `release.yml`
  gates or maintainer runs): both image builds from the unchanged Dockerfile,
  the per-arch compose smoke, the agent job, the manifest and asset checks,
  the upgrade check (quickstart Part B step 5), and the hosted deploy
  (quickstart "Hosted deploy check"). The first real run needs the
  repository public (arm64) and `REPOSITORY` set.

- **Hosted deploy note**: after the next hosted deploy, check that the edge
  (CloudFront and the WAF rate rule) passes `/install.sh` and `/self-host.md`
  with the contract content types; a cached 404 from before the deploy would
  need an invalidation.

- **Documentation owed** is listed in `plan.md` ("Documentation owed"),
  superseding the spec phase's shorter list only by adding: `release.mjs`
  and `REPOSITORY`, `npm run test:self-host`, the dispatch inputs, the
  Compose 2.24 requirement, and the driver's `--signin-link` leg.

## Implement phase (2026-10-07/08)

- **Relaxations**: none. New defaults are RBD-060-34 and RBD-060-36 to
  RBD-060-38; RBD-060-35 (Codex) and the RBD-060-1 ratification came from Sam
  through the orchestrator.

- **Repository name (RBD-060-1, RATIFIED by Sam 2026-10-07)**:
  `squiredocs/squiredocs` in `release.mjs` and its four mirrors. The release
  workflow still refuses to run anywhere else, so runs in `samg/collab` fail
  at `validate` and publish nothing. The LICENSE holder (21st Harmonic LLC,
  RBD-060-13) and the first version stay defaults for Sam to confirm.

- **Launch-gate items for 062**: `LICENSE`, `/documentation/self-hosting`,
  `/install.sh`, and `/self-host.md` exist (the two routes go live with the
  next hosted deploy). **Codex: KEEP.** The Codex section in
  `documentation/agents-and-mcp.md` was written from Codex's documented MCP
  setup; Sam confirmed Codex works on 2026-10-07; the exact commands
  (`codex mcp add squire --url https://squiredocs.com/mcp`,
  `codex mcp login squire`, the `[mcp_servers.squire]` block) are to be
  checked by Sam before launch (RBD-060-35). 062 keeps Codex in its copy.

- **Driver results (T028)**, against a local-mode dev server started from
  this worktree on a scratch database (`collab_060_scratch`, dropped after)
  and port 3960, `SQUIRE_MODE=local`, `ENABLE_DEV_ENDPOINTS=1`:
  `--signin-link` on a fresh instance with `--expect-name "CI Agent"
  --expect-email ci-agent@example.com --script-check`: PASS (claim, owner
  check, refresh exchange, `hasOwner`, `/mcp/auth/approve`, token,
  `list_documents`, `modify` in the isolate). `--signin-link` on the claimed
  instance with a bare `claim-link`: PASS. Default leg: PASS. `--first-run`:
  PASS. Two fixes came out of this run: the leg must peek and post the
  prefilled name and email (RBD-060-34), and the `modify` script must be
  `export default function edit(doc) { ... }` (T029; the contract's
  one-liner would have failed the CI agent job).

- **Executable bits (T010, T014)**: `distribution/self-host/squire`,
  `install.sh`, `release.mjs`, and the four stubs are committed as 100755
  (checked with `git ls-files -s`). The merge queue needs no extra step.

- **Docker-only checks owed** (none can run in the pod):
  1. The first `release.yml` run (quickstart Part B steps 1 to 4) in
     `squiredocs/squiredocs` once it is public: both image builds, both
     compose smokes, the agent job, manifest platforms, `latest` policy,
     asset names. This is also the first evidence that the Dockerfile's two
     COPY lines build (FR-011).
  2. The `docker compose exec app squire doctor --json` smoke step is what
     proves RBD-060-23 (no TTY without `-T` in a non-interactive shell). If it
     fails on stray output, add `-T` to AGENTS.md's commands and request a
     design amendment.
  3. US3 scenario 3, the upgrade check: quickstart Part B step 5 lists the
     exact commands for a maintainer machine. Nothing automates it.
  4. Sam's next `script/build-and-deploy-aws.sh` run (quickstart "Hosted
     deploy check"); `git diff main -- Dockerfile script k8s` shows only the
     two COPY lines and their comment.
  5. `shellcheck -s sh` on `install.sh` and `squire`: runs in `test.yml`;
     not installed in the pod (the local case skips with a notice).

- **Hosted output**: every hosted documentation page matches the recorded
  golden hashes except `agents-and-mcp` (Codex section, re-recorded with the
  reason); a pre- and post-change `npm run build` differ only by the new
  sidebar entry on each page.

- **Documentation owed by the merge queue** (unchanged from `plan.md`, plus):
  README "Run it yourself" and the distribution items should name
  `squiredocs/squiredocs`, `ghcr.io/squiredocs/squiredocs`, and
  https://github.com/squiredocs/squiredocs/releases; mention the Codex
  section; `docs/dev.md` should describe running the driver legs against a
  local-mode server on a scratch database (quickstart Part A step 6). No
  `CLAUDE.md` change.

- **Contract amendments to record** (specs, not design):
  `contracts/oauth-driver-signin-link.md` (peek then redeem with the
  prefill; the `edit(doc)` script form); `contracts/served-routes.md` (the
  plain-host check, RBD-060-37); `contracts/install-sh.md` (stdin closed for
  children, RBD-060-36; absolute paths in messages, RBD-060-38).
