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
