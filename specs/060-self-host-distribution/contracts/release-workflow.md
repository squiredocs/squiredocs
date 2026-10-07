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
  contents: write
  packages: write
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
```

Never triggered by a branch push (RBD-060-4). `test.yml` is unchanged in its
triggers.

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

1. Download the image tarballs and `assets`.
2. `docker login ghcr.io` with `GITHUB_TOKEN`.
3. Per arch: `docker load`, `docker tag` to `<image>:<version>-<arch>`, `docker push`.
4. `docker buildx imagetools create -t <image>:<version> [-t <image>:latest]`
   from the per-arch tags (`latest` only when `prerelease == 'false'`).
5. `docker buildx imagetools inspect <image>:<version>` lists exactly the
   expected platforms, else fail.
6. `gh release create v<version> assets/* --title "Squire Docs <version>" --notes ... [--prerelease]`.
7. `gh release view v<version> --json assets` names exactly
   `compose.yml`, `squire`, `env.example`, `SHA256SUMS`, else fail.

## Structure test (Docker-free)

`test/self-host/release-workflow.test.mjs` parses the YAML and asserts: the
triggers above and no `branches`; the two permissions; `publish` needs all
four upstream jobs; `publish` has the explicit guard expression; `validate`
runs `release.mjs validate` and `stamp`; the arm64 job uses
`ubuntu-24.04-arm` and the condition; the agent job runs `install.sh` with
`SQUIRE_INSTALL_ASSET_URL` and the driver with `--signin-link`; no step uses
`/auth/dev-login` or `dev-consent-approve`; every action is pinned to a major
version tag or SHA.
