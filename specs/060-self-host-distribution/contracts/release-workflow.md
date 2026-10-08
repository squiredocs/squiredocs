# Contract: `.github/workflows/release.yml`

## Triggers and permissions

```yaml
on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      publish:            { type: boolean, default: false }
      allow_single_arch:  { type: boolean, default: false }
permissions:
  contents: read          # the publish job alone adds contents: write, packages: write
defaults:
  run:
    shell: bash           # GitHub runs it as bash --noprofile --norc -eo pipefail
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
```

Never triggered by a branch push (RBD-060-4). `test.yml` is unchanged in its
triggers.

Review findings M2 to M4: every job but `publish` runs with the read-only
token; `publish` declares `permissions: { contents: write, packages: write }`.
Every `run` step uses bash with `pipefail`, so `release.mjs validate | tee`
fails the step when `validate` fails. Every third-party action is pinned to a
full commit SHA with the version tag it was resolved from in a trailing
comment (`uses: actions/checkout@<sha> # v4.4.0`); bump one by resolving the
new tag with `git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag>`
(the peeled `^{}` SHA for an annotated tag).

## Jobs

| Job | Runner | Needs | Does | Fails when |
| --- | --- | --- | --- | --- |
| `validate` | ubuntu-latest | | `release.mjs validate` (tag push or tag-ref dispatch) or a `0.0.0-ci.<run_number>` version (branch dispatch); `release.mjs stamp` into `assets/`; upload `assets`; outputs `version`, `prerelease`, `image`, `arm64`, `publish` | non-semver tag; placeholder `REPOSITORY`; `REPOSITORY` differs from lowercased `github.repository`; a token remains after stamping |
| `build-amd64` | ubuntu-latest | validate | buildx `--platform linux/amd64 --load -t <image>:<version>` with `--label org.opencontainers.image.source=https://github.com/<REPOSITORY>`; smoke (below); `docker save` -> `image-amd64.tar`; upload | build or any smoke step fails |
| `build-arm64` | ubuntu-24.04-arm | validate; `if: arm64 == 'true'` | same for arm64 | same |
| `agent` | ubuntu-latest | validate, build-amd64 | quickstart "agent job" steps (research R9) | `install.sh` non-zero; last stdout line not a claim link; redemption, owner, approve, token, `list_documents`, or `modify` fails |
| `publish` | ubuntu-latest | validate, build-amd64, build-arm64, agent; `if: always()` guarded by explicit result checks | see below | see below |

`arm64` output: `true` when `github.event.repository.private == false`;
otherwise `false`, and the summary says the arm64 leg was skipped because
GitHub's arm64 runners are not available to private repositories.

## Smoke steps (each build job)

1. Temp folder with the stamped `compose.yml` and `.env`
   (`SQUIRE_VERSION=<version>`).
2. `docker compose up -d --wait --wait-timeout 300`.
3. `docker compose exec app squire doctor --json > doctor.json`; `node`
   asserts `ok === true` and that the file is exactly one JSON value.
4. `docker compose exec app node -e "<isolated-vm 1+1>"` prints `2`.
5. `curl -fsS http://127.0.0.1:3910/self-host.md | cmp - AGENTS.md` and the
   same for `/install.sh`.
6. `always()`: `docker compose logs app` to the job log, then
   `docker compose down -v`.

## Publish job

Skipped (by its `if`) unless `needs.validate.outputs.publish == 'true'` (a
`v*` tag ref and either a push trigger or `inputs.publish`); the run summary
then says "not a release run; nothing published". When `publish` is true, its
first step fails with a message naming the missing gate unless `build-amd64`
and `agent` succeeded and either `build-arm64` succeeded or (`build-arm64` was
skipped and `inputs.allow_single_arch` is true). It never succeeds silently
with a gate missing.

1. Check out the repository and set up Node, then decide `latest`:
   `git ls-remote --tags origin` into a file and
   `release.mjs latest --version <version> --ls-remote <file>` prints
   `latest=true` only when `<version>` has no prerelease suffix and no
   `vX.Y.Z` release tag is higher (prerelease tags are ignored). A backport
   such as v1.2.4 published after v1.3.0 therefore leaves `latest` on 1.3.0
   (review finding L2, RBD-060-43).
2. Download the image tarballs and `assets`.
3. `docker login ghcr.io` with `GITHUB_TOKEN`.
4. Per arch: `docker load`, `docker tag` to the staging tag
   `<image>:<version>-<arch>` (for example `1.2.3-amd64`, `1.2.3-arm64`),
   `docker push`. The staging tags carry the exact tested bytes (RBD-060-26),
   stay in GHCR after the release as the per-architecture images the manifest
   points at, and are not meant to be pulled directly; `<image>:<version>` and
   `<image>:latest` are the public tags.
5. `docker buildx imagetools create -t <image>:<version> [-t <image>:latest]`
   from the staging tags (`latest` only when step 1 printed `latest=true`).
6. `docker buildx imagetools inspect <image>:<version>` lists exactly the
   expected platforms, else fail.
7. `gh release create v<version> assets/* --title "Squire Docs <version>" --notes ... --latest=<true|false> [--prerelease]`,
   with the step 1 decision, so GitHub's `releases/latest` (which `install.sh`
   follows) never moves back either.
8. `gh release view v<version> --json assets` names exactly
   `compose.yml`, `squire`, `env.example`, `SHA256SUMS`, else fail.

## Structure test (Docker-free)

`test/self-host/release-workflow.test.mjs` parses the YAML and asserts: the
triggers above and no `branches`; read-only top-level permissions with the
write scopes only on `publish`; the workflow-level `bash` default and no
step overriding it; `publish` needs all
four upstream jobs; `publish` has the explicit guard expression; `validate`
runs `release.mjs validate` and `stamp`; the arm64 job uses
`ubuntu-24.04-arm` and the condition; the agent job runs `install.sh` with
`SQUIRE_INSTALL_ASSET_URL` and the driver with `--signin-link`; no step uses
`/auth/dev-login` or `dev-consent-approve`; every action is pinned to a
40-character SHA with a `# vX.Y.Z` comment, one SHA per action version; the
`latest` decision feeds both the manifest tags and `gh release create`.
