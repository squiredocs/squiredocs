# Implementation Plan: Self-Host Distribution

**Branch**: `060-self-host-distribution` (planned on `main` in the `main-os` worktree; no branch created) | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/060-self-host-distribution/spec.md` (7 stories, FR-001 to FR-040), ledger `clarifications-needed.md` (RBD-060-1 to RBD-060-19 from the spec phase, RBD-060-20 to RBD-060-33 from this phase), design ground truth `design/self-hosting-local-mode.md` (ratified D1 to D12; the upgrade sentence amended 2026-10-07 per RBD-060-16).

## Summary

Build step 3 of the self-hosting design: package what 058 and 059 built so a
developer's agent can install a local instance with one command and no clone.
New files under `distribution/self-host/` (the compose file, the `squire`
wrapper, the self-host settings file, `install.sh`, and a Node release script
that validates tags and stamps assets), a root `AGENTS.md` that is the single
source of `/self-host.md`, two verbatim served routes, and a GitHub Actions
release workflow that builds amd64 and arm64 natively, smoke-tests both, plays
the agent against the amd64 candidate (install, claim, OAuth, tool call, agent
script), and only then publishes the GHCR manifest and the release assets. The
documentation site gains a `self-hosting` page and a self-hosted variant (no
analytics, no canonical, filtered header and footer derived from the one
`FOOTER`, instance origin for instance URLs). The OAuth driver gains a
`--signin-link` leg. The plugin onboarding gains the self-host pointer, with
regenerated bundles. `LICENSE`, `CONTRIBUTING.md`, and `SECURITY.md` land at
the root.

Everything that can run without Docker runs in the existing suites and in
`test.yml`; only the image build, the compose smoke, the agent job, and the
registry and release steps are GitHub-Actions-only (see "Verification split").

## Technical Context

**Language/Version**: POSIX `sh` (install script, wrapper); Node.js 22 (CommonJS server, ESM scripts and tests); GitHub Actions YAML; Docker Compose file format (Compose 2.24.0 or later).

**Primary Dependencies**: None new. Express (served routes), `markdown-it` (existing documentation renderer), `js-yaml` (already installed; tests only), `node:test`, `node:crypto`. CI uses GitHub-hosted runners `ubuntu-latest` and `ubuntu-24.04-arm`, `docker buildx`, `gh`, and `python3 -m http.server`, all preinstalled.

**Storage**: N/A. **No database migration.** Nothing in this feature reads or writes a new table, column, or setting.

**Testing**: Jest (`npm run test:server`) for the served routes and the not-hosted documentation mount; Vitest (`npm run test:client`) for the documentation variant, footer filter, self-hosting page, and the hosted golden hashes; a new `node --test` suite (`npm run test:self-host`) for `install.sh` with a stubbed PATH, the compose and settings files, the wrapper, `release.mjs`, the repository constant, `AGENTS.md` accuracy, and `release.yml` structure; `npm run test:first-run` for the bundle drift guard and budgets; `release.yml` for everything Docker-backed.

**Target Platform**: Linux containers on amd64 and arm64 (`node:22-alpine`); developer hosts with Docker Compose v2.24+ (macOS, Linux, Windows through WSL or `docker compose exec` directly); the hosted k3s cluster (unchanged).

**Project Type**: Web application (Express + React) plus distribution artifacts and CI.

**Performance Goals**: Install to printed link under five minutes on a warm cache (SC-001); the app's `/ready` within the 90 s compose health start period on first boot.

**Constraints**: Hosted output and the ECR deploy unchanged except for additive routes and documentation content (FR-033, FR-039, RBD-060-19); `install.sh` never prompts and stdout carries only the link (FR-014, FR-017); nothing published unless every gate passed (FR-025); no edit to `FOOTER` or the four stamped marketing pages (FR-032); no edit to `README.md`, `docs/dev.md`, or `CLAUDE.md` by plan or implement agents.

**Scale/Scope**: About 14 new files, about 12 edited files, 9 new test files, 3 edited test files, 2 workflows (1 new, 1 edited).

## Constitution Check

*GATE: passed before Phase 0; re-checked after Phase 1 design. No violations.*

| Principle | How 060 complies |
| --- | --- |
| I. Documentation Reflects Reality | `README.md` and `docs/dev.md` changes are listed under "Documentation owed" for the merge queue (this agent and the implement agent may not edit them). The new `documentation/self-hosting.md`, `AGENTS.md`, `CONTRIBUTING.md`, and `SECURITY.md` are part of the change set. |
| II. Test-Backed Changes | Every FR maps to a test task or, for Docker-only behavior, to a `release.yml` gate (traceability in `tasks.md`). New Jest suites touch no database and no fixed keys. Docker-backed behavior has CI assertions, not prose. |
| III. Trunk-Based Solo Workflow | Planned on `main` in a worktree. The release workflow is new ceremony with a concrete failure it prevents: publishing a public image or release that was never booted (SC-004). |
| IV. Collaboration-Safe Document Operations | Not touched. The CI agent job's `modify` call appends one paragraph through the normal tool path on a throwaway instance. |
| V. Secure by Default | `install.sh` verifies every asset against `SHA256SUMS` and refuses without a checksum tool; Postgres and Redis publish no host ports; the app binds `127.0.0.1`; the request origin is validated and HTML-escaped before entering self-hosted documentation HTML (R11); the new routes serve fixed files with no input. New ingestion surface: none (the routes are read-only; `SQUIRE_INSTALL_ASSET_URL` is an operator-set variable in a script the operator runs). |
| VI. Design Docs Are Ground Truth | Built from `design/self-hosting-local-mode.md`. New gaps recorded as RBD-060-20 to RBD-060-33. Amendments owed are listed in `promotion-notes.md` (asset name, Compose minimum version, wrapper TTY handling, served-route source). |
| VII. Horizontally Scalable App Pods | The new routes read immutable files at mount and keep no per-process correctness state. The self-host compose file runs one app container, as the design's non-goals state; nothing makes a single replica a correctness precondition. |
| Tech constraints | No migration, no AI-provider change, no serialization dependency. |

Re-check after Phase 1: unchanged. The documentation variant adds an option to
the existing render module instead of a second renderer, and the release logic
lives in one testable script instead of workflow shell.

## Project Structure

### Documentation (this feature)

```text
specs/060-self-host-distribution/
├── spec.md
├── clarifications-needed.md   # RBD-060-1..19 (spec), RBD-060-20..33 (plan)
├── promotion-notes.md         # + plan-phase section
├── plan.md                    # this file
├── research.md                # R1..R16
├── data-model.md              # release, assets, install folder, variants
├── quickstart.md              # Docker-free and CI validation runs
├── contracts/
│   ├── install-sh.md
│   ├── compose-and-assets.md
│   ├── served-routes.md
│   ├── release-workflow.md
│   ├── documentation-variant.md
│   └── oauth-driver-signin-link.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
AGENTS.md                                   # NEW: self-host runbook, source of /self-host.md
LICENSE                                     # NEW: MIT, 21st Harmonic LLC (RBD-060-13)
CONTRIBUTING.md                             # NEW (RBD-060-14)
SECURITY.md                                 # NEW (RBD-060-14)
Dockerfile                                  # EDIT: two additive COPY lines (R10)
package.json                                # EDIT: "test:self-host" script
.github/workflows/
├── release.yml                             # NEW: build, smoke, agent, publish (R7-R9)
└── test.yml                                # EDIT: test:self-host + shellcheck steps
distribution/
├── self-host/                              # NEW
│   ├── compose.yml
│   ├── squire                              # mode 100755 in git
│   ├── .env.example                        # FR-008; published as the asset env.example (R2)
│   ├── install.sh                          # mode 100755 in git
│   └── release.mjs                         # REPOSITORY, validate, stamp (R1, R6)
├── shared/onboard.md                       # EDIT: self-host pointer (FR-036)
├── publish.mjs                             # EDIT: LICENSE holder, three version bumps (R14)
├── claude-plugin/**  cursor-plugin/**  mcp-registry/**   # REGENERATED
documentation/
├── self-hosting.md                         # NEW: order 10
├── agents-and-mcp.md                       # EDIT only if Codex verifies (FR-034)
├── markdown.md                             # EDIT: order 10 -> 11
├── appearance.md                           # EDIT: order 11 -> 12
└── account-and-support.md                  # EDIT: order 12 -> 13
client/
├── scripts/render-documentation.mjs        # EDIT: variant option, filters (R11)
├── scripts/build-documentation.mjs         # EDIT: also write dist/documentation/_self-hosted/
├── vite.config.js                          # EDIT: variant by SQUIRE_HOSTED; proxy two routes
└── src/__tests__/
    ├── documentation-build.test.js         # EDIT: self-hosting page, order
    ├── documentation-variant.test.js       # NEW
    └── fixtures/documentation-hosted-golden.json   # NEW (recorded before render edits)
server/
├── web-routes.js                           # EDIT: mountDistributionRoutes; not-hosted docs mount
├── documentation-routes.js                 # EDIT: optional transformHtml
└── __tests__/
    ├── self-host-routes.test.js            # NEW
    └── helpers/web-fixture.js              # EDIT: _self-hosted fixture pages
test/
├── first-run/oauth-chain-driver.mjs        # EDIT: --signin-link leg (+ --expect-*, --script-check)
├── first-run/oauth-driver-args.test.mjs    # NEW: flag exclusivity, no dev endpoints in the new leg
└── self-host/                              # NEW node --test suite
    ├── install-sh.test.mjs
    ├── compose-and-assets.test.mjs
    ├── release-script.test.mjs
    ├── repository-constant.test.mjs
    ├── agents-md.test.mjs
    ├── release-workflow.test.mjs
    ├── launch-files.test.mjs
    └── fixtures/stub-bin/                  # docker, curl, sha256sum, shasum stubs
```

Not touched: `client/scripts/site-footer.mjs`, `client/public/*.html`,
`client/public/agents.md`, `server/app-shell.js`, `script/build-and-deploy-aws.sh`,
`script/deploy-aws.sh`, `k8s/`, migrations, `server/cli/` (058/059 behavior is
consumed, not changed), `README.md`, `docs/dev.md`, `CLAUDE.md`.

**Structure Decision**: Distribution artifacts live next to the existing
plugin distribution under `distribution/self-host/`; the root carries only the
files whose location is a convention (`AGENTS.md`, `LICENSE`,
`CONTRIBUTING.md`, `SECURITY.md`). Tests follow the runner that fits each
surface (R13).

## Phases

1. **Setup.** Golden hashes of today's hosted documentation (before any render
   edit); `test:self-host` script and stub-bin fixtures; `distribution/self-host/`
   skeleton with the `REPOSITORY` constant.
2. **Foundational.** `release.mjs` (validate, stamp) and its tests;
   `compose.yml`, `.env.example`, `squire` wrapper and their structure tests;
   repository-constant drift test. Everything later reads these.
3. **US1 install.sh (P1).** Test-first stubbed-PATH suite, then the script.
4. **US2 AGENTS.md and the served routes (P1).** Runbook content and its
   accuracy test; `mountDistributionRoutes`; Dockerfile COPY lines; Vite proxy.
5. **US3 release workflow (P1).** `release.yml` validate/build/smoke/publish
   and its structure test; `test.yml` additions.
6. **US4 agent job (P2).** Driver `--signin-link` leg, verified in the pod
   against the development server; the `agent` job in `release.yml`.
7. **US5 documentation (P2).** Variant renderer, filters, build output,
   not-hosted mount with origin substitution, Vite parity, the
   `self-hosting` page and renumbering, Codex attempt.
8. **US6 onboarding pointer (P3).** `onboard.md`, `publish.mjs` bumps,
   regenerate, drift guard.
9. **US7 launch hygiene (P3).** `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`.
10. **Polish.** Full Docker-free verification, hosted parity re-check,
    promotion notes (owed docs, design amendments, Docker-only checks owed).

## Verification split

| Check | Where it runs | Needs Docker |
| --- | --- | --- |
| `install.sh` flags, refusals, checksum failure and cleanup, `.env`, stdout discipline (stubbed `docker`/`curl`/checksum on PATH, run under `dash`) | pod + `test.yml` (`test:self-host`) | No |
| `shellcheck -s sh` on `install.sh` and `squire` | `test.yml` (binary not in pod; local run skips with a notice) | No |
| `compose.yml` structure (services, health checks, volumes, ports, no `SQUIRE_MODE`/`SQUIRE_HOSTED`), `.env.example` content, wrapper text | pod + `test.yml` | No |
| `release.mjs` tag parsing, placeholder refusal, stamping, `SHA256SUMS` | pod + `test.yml` | No |
| Repository constant drift across the four files | pod + `test.yml` | No |
| `AGENTS.md` section order, subcommands exist in `server/cli`, paths served | pod + `test.yml` | No |
| `release.yml` structure (triggers, `needs` graph, publish guard, permissions) | pod + `test.yml` | No |
| `/self-host.md` and `/install.sh` byte pins, content types, hosted and not hosted | pod + `test.yml` (Jest) | No |
| Documentation variant, footer filter (incl. a 062-shaped `FOOTER`), hosted golden hashes, self-hosting page, terminology gate | pod + `test.yml` (Vitest; `cd client && npm run build` for the real build) | No |
| Bundle regeneration, drift guard, size budgets | pod + `test.yml` (`test:first-run`) | No |
| Driver `--signin-link` leg against the development server | pod, by hand (quickstart) | No |
| Image builds for amd64 and arm64 from the unchanged Dockerfile | `release.yml` only | Yes |
| Compose smoke per architecture: `up --wait`, `doctor --json`, isolate `1+1`, served files | `release.yml` only | Yes |
| Agent job: `install.sh` against local assets and the loaded image, claim, OAuth, `list_documents`, `modify` | `release.yml` only | Yes |
| Multi-arch manifest, `latest` policy, release asset names | `release.yml` only (publish job) | Yes |
| ECR arm64 build and hosted deploy unchanged | Sam's next `script/build-and-deploy-aws.sh` run (release builds are early evidence) | Yes |
| Codex connection | implementer or Sam with a Codex login (not the pod) | No |

## Documentation owed (merge queue applies; agents may not edit)

- **README.md**: title "Squire Docs"; new first section "Run it yourself" per
  FR-035 and RBD-060-12 (install command, what it does, `./squire`, links to
  `https://squiredocs.com/self-host.md` and `/documentation/self-hosting`,
  volume-loss warning); retitle the clone-and-npm section "Developing";
  document `distribution/self-host/` (files, `release.mjs`, the
  `REPOSITORY` constant and how to set it), the image name and tag scheme
  (`ghcr.io/<REPOSITORY>:X.Y.Z`, `latest` only for non-prereleases), the
  release assets (including `env.example` naming, RBD-060-21), `install.sh`
  flags and `SQUIRE_INSTALL_ASSET_URL`, the `/self-host.md` and `/install.sh`
  routes, `release.yml` (triggers, inputs, gates, arm64 condition),
  `npm run test:self-host`, the self-hosted documentation variant, Compose
  2.24+ requirement, and `LICENSE`/`CONTRIBUTING.md`/`SECURITY.md`. Plus any
  058/059 owed README items still outstanding.
- **docs/dev.md**: running `npm run test:self-host` (and that `shellcheck`
  is skipped locally when absent); viewing the self-hosted documentation
  variant in Vite (`SQUIRE_HOSTED` unset); exercising the driver's
  `--signin-link` leg against the dev server; the release process (set
  `REPOSITORY`, bump `package.json`, tag `vX.Y.Z`, watch `release.yml`,
  dispatch inputs); that no Docker-backed check runs in the pod.
- **CLAUDE.md**: no change required.

## Complexity Tracking

No constitution violations. Two choices that look heavier than the minimum are
justified in research: the per-arch tarball hand-off (R7, so published bytes
are tested bytes) and the build-time variant directory (R11, so hosted output
is unchanged by construction).
