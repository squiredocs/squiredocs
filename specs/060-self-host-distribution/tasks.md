---
description: "Task list for 060-self-host-distribution"
---

# Tasks: Self-Host Distribution

**Input**: `specs/060-self-host-distribution/` (spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md, clarifications-needed.md)

**Tests**: Required. The spec mandates tests (FR-020, FR-021, FR-024, FR-028, FR-033) and Constitution II requires every behavioral change to be test-backed. Tests are written before the code they cover.

**Docker**: The app-dev pod has no Docker daemon. Tasks marked **(GHA)** produce GitHub Actions configuration whose execution can only be observed in Actions; everything else is verified in the pod. Tasks never run `docker`.

**Rules for the implementer**: no edits to `README.md`, `docs/dev.md`, `CLAUDE.md`, `client/scripts/site-footer.mjs`, `client/public/*.html`, `script/build-and-deploy-aws.sh`, `script/deploy-aws.sh`, or `k8s/`; never run `node distribution/publish.mjs --publish`; source files with NUL bytes need `git grep` or `rg`, not plain `grep`; prose is plain sentences, no em dashes, "Squire Docs" in user-facing copy.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [ ] T001 Record hosted documentation golden hashes BEFORE any render edit: render every current `documentation/*.md` page and the 404 with today's `renderPage`/`render404` and write `{ "<slug>.html": "<sha256>" }` to `client/src/__tests__/fixtures/documentation-hosted-golden.json`, with a header comment field naming the commit (`84490ad6` or the current HEAD) and the generating command (RBD-060-30)
- [ ] T002 Add `"test:self-host": "node --test test/self-host/*.test.mjs"` to the root `package.json` scripts
- [ ] T003 [P] Create the stub binaries in `test/self-host/fixtures/stub-bin/` (`docker`, `curl`, `sha256sum`, `shasum`), each POSIX `sh`, mode 0755, driven by `STUB_*` environment variables and appending their argv to `$STUB_LOG` (contracts/install-sh.md "Test hooks")
- [ ] T004 Create `distribution/self-host/` with `release.mjs` exporting `REPOSITORY = '<org>/<repo>'`, `VERSION_TOKEN`, and `ASSET_NAMES` only (logic follows in T006)

---

## Phase 2: Foundational (blocks all stories)

- [ ] T005 [P] Write `test/self-host/release-script.test.mjs`: `parseReleaseTag` accepts `v1.2.3` and `v1.2.3-rc.1` (prerelease true) and rejects `1.2.3`, `v1.2`, `vnext`, `v1.2.3+meta`; `validateRepository` rejects `<org>/<repo>` and a mismatch with the GitHub repository (case-insensitive equality accepted); `stampAssets` writes exactly `ASSET_NAMES`, replaces every version token, leaves no `__SQUIRE_`/`<org>`/`<repo>`, sets `squire` mode 0755, and `SHA256SUMS` verifies with the real `sha256sum -c`; the CLI's `validate` output lines and exit codes (contracts/compose-and-assets.md); stamping tests run against a temp copy of the sources with `REPOSITORY` replaced
- [ ] T006 Implement `distribution/self-host/release.mjs` (`parseReleaseTag`, `validateRepository`, `stampAssets`, and the `validate`/`stamp` CLI) until T005 passes (research R6)
- [ ] T007 [P] Write `test/self-host/compose-and-assets.test.mjs` for `compose.yml` (js-yaml structure assertions), `.env.example` (order, required and forbidden names, assistant-key names derived from `server/api/ai-providers.js`), and the `squire` wrapper (text checks, plus a stub-`docker` run proving exit-code passthrough and `-T` when stdout is a pipe) (contracts/compose-and-assets.md)
- [ ] T008 [P] Create `distribution/self-host/compose.yml` per contracts/compose-and-assets.md (FR-001 to FR-006, RBD-060-18, RBD-060-22), with the app health check copied from the Dockerfile's `/ready` probe
- [ ] T009 [P] Create `distribution/self-host/.env.example` per contracts/compose-and-assets.md (FR-008, RBD-060-11), including the FR-040 `APP_URL` note
- [ ] T010 [P] Create `distribution/self-host/squire` per research R4 and set its git mode to executable (`git update-index --chmod=+x distribution/self-host/squire` at staging time; note it for the merge queue if the implementer does not stage)
- [ ] T011 Write `test/self-host/repository-constant.test.mjs`: every `github.com/<x>/<y>` and `ghcr.io/<x>/<y>` reference in `AGENTS.md`, `distribution/self-host/install.sh`, `distribution/self-host/compose.yml`, and `documentation/self-hosting.md` equals `REPOSITORY` (failures name file and line); files not yet created are reported as missing, not skipped (RBD-060-20)
- [ ] T012 Run `npm run test:self-host` and make T005/T007 green (T011 stays red until US1, US2, and US5 add their files)

**Checkpoint**: release logic, compose file, settings file, and wrapper exist and are tested.

---

## Phase 3: User Story 1 - An agent installs a local instance with one command (P1) MVP

**Goal**: `install.sh` does FR-014 to FR-019 exactly.

**Independent test**: `npm run test:self-host` (install-sh suite) in the pod; the real-Docker run is the `release.yml` agent job (US4).

- [ ] T013 [US1] Write `test/self-host/install-sh.test.mjs` (runs a temp copy of the script with `REPOSITORY` replaced, under `dash` when present): placeholder refusal; usage errors (unknown flag, missing value, positional, `--version v1.2.3`); `--help`; Compose missing, v1, v2 older than 2.24, daemon down (each exits 1 before creating the folder, one message naming the fix); `curl` missing; no checksum tool; existing `compose.yml` prints the exact upgrade command with the folder path and changes nothing; an empty existing folder is treated as fresh; latest-version resolution from a stubbed `Location` header and `--version` skipping it; download failure for one asset names it and removes this run's files and the created folder; checksum mismatch names the file, removes this run's files, never calls `docker compose up`; success writes `.env` as exactly `SQUIRE_VERSION=<v>\n`, renames `env.example` to `.env.example`, makes `squire` executable, calls `up -d --wait`, `./squire doctor`, `./squire claim-link --name --email` in that order (from `$STUB_LOG`), and stdout is exactly the one link line; `--dir` honored; `SQUIRE_INSTALL_ASSET_URL` honored and changes nothing else; port-conflict output yields the RBD-060-32 message; other `up` failure names `docker compose logs app`; doctor failure exits 1 and never calls `claim-link`; a claim-link that prints a non-link exits 1; the script never reads stdin (run with stdin closed); a shellcheck case that runs `shellcheck -s sh` when installed and prints a skip notice otherwise (FR-014 to FR-020, contracts/install-sh.md)
- [ ] T014 [US1] Implement `distribution/self-host/install.sh` per research R5 and contracts/install-sh.md until T013 passes; header comment documents flags and `SQUIRE_INSTALL_ASSET_URL`; set git mode executable as in T010
- [ ] T015 [US1] Add the FR-040 sentence (plain HTTP only on localhost; exposing needs a TLS proxy and an https `APP_URL`) to `install.sh`'s success-path stderr and header, and assert it in `test/self-host/install-sh.test.mjs`

**Checkpoint**: MVP script complete and tested without Docker.

---

## Phase 4: User Story 2 - An agent follows self-host.md without the install script (P1)

**Goal**: `AGENTS.md` is the runbook; `/self-host.md` and `/install.sh` are served verbatim everywhere.

**Independent test**: `npm run test:self-host` (agents-md suite) and `npx jest server/__tests__/self-host-routes.test.js`.

- [ ] T016 [P] [US2] Write `test/self-host/agents-md.test.mjs`: first line is the RBD-060-3 preface naming `https://squiredocs.com/self-host.md` and `CONTRIBUTING.md`; sections appear in FR-023 order (prerequisite with Compose 2.24, install command with success condition, manual commands `mkdir squire-docs && cd squire-docs`, `curl -fsSLO .../releases/latest/download/compose.yml`, `.../squire && chmod +x squire`, `docker compose up -d --wait`, `docker compose exec app squire claim-link`, each with a success condition; the bare-link rule; `claude mcp add --transport http squire-local http://localhost:3910/mcp` and Approve; `docker compose exec app squire token create --name`; recovery: new sign-in link, startup-log link via `docker compose logs app`, change the port, read logs, the two-step upgrade; the `down -v` warning naming the encryption key and `docker compose down` as the safe stop; the FR-040 TLS sentence); every `squire <subcommand>` named exists in `server/cli/index.js` `COMMANDS`; `/ready` is registered in `server/index.js`, `/mcp` is mounted there, and `/claim` is routed in `client/src/App.jsx`; no `./squire` in any command line, only the full `docker compose exec app squire` form (D10, RBD-060-33); says "Squire Docs" not bare "Squire" in prose (FR-022 to FR-024)
- [ ] T017 [US2] Write `AGENTS.md` at the repository root per FR-022/FR-023 and T016 until T016 passes, using `REPOSITORY` literally (RBD-060-20)
- [ ] T018 [P] [US2] Write `server/__tests__/self-host-routes.test.js` per contracts/served-routes.md: both routes in hosted and not-hosted mode return 200, exact content types, `Cache-Control`, and bodies `Buffer.equals` the repository files; `Host: evil.example` changes nothing; `/agents.md` behavior unchanged in both modes; the routes work when the client build directory is missing
- [ ] T019 [US2] Implement `mountDistributionRoutes(app, { repoRoot })` in `server/web-routes.js` and call it first in `mountWebRoutes` (research R10) until T018 passes; export it
- [ ] T020 [P] [US2] Add two `COPY --chown=appuser:appgroup` lines to the runtime stage of `Dockerfile` (`AGENTS.md` to `./AGENTS.md`, `distribution/self-host/install.sh` to `./distribution/self-host/install.sh`), next to the existing `bin/` copy, with a one-line comment; change nothing else (FR-011, FR-013, RBD-060-29)
- [ ] T021 [P] [US2] Add `/self-host.md` and `/install.sh` to the dev proxy in `client/vite.config.js`

**Checkpoint**: an agent can read the runbook from any instance.

---

## Phase 5: User Story 3 - A release publishes the image and the install assets (P1)

**Goal**: `release.yml` builds, smoke-tests, and publishes only after every gate (research R7, R8).

**Independent test**: `npm run test:self-host` (release-workflow suite) in the pod; real runs per quickstart Part B.

- [ ] T022 [US3] Write `test/self-host/release-workflow.test.mjs` per contracts/release-workflow.md "Structure test" (triggers, no branch trigger, permissions, concurrency, job graph, arm64 runner and condition, publish guard, `release.mjs validate`/`stamp` usage, smoke steps present including the no-`-T` doctor call and the served-file `cmp`, asset-name verification step, `latest` only for non-prereleases, no dev endpoints, actions pinned)
- [ ] T023 [US3] (GHA) Create `.github/workflows/release.yml` with jobs `validate`, `build-amd64`, `build-arm64`, and `publish` per contracts/release-workflow.md (the `agent` job is added in T030) until T022's non-agent assertions pass
- [ ] T024 [P] [US3] Edit `.github/workflows/test.yml`: in the `client` job add a `npm run test:self-host` step and a `shellcheck -s sh distribution/self-host/install.sh distribution/self-host/squire` step; leave triggers and other jobs unchanged (FR-028)
- [ ] T025 [US3] Verify hosted-deploy safety without Docker: `git diff main -- Dockerfile` shows only the T020 lines; `script/`, `k8s/` untouched; record in `promotion-notes.md` that the first `release.yml` builds and Sam's next ECR deploy are the Docker evidence (FR-011, SC-006, RBD-060-19)

**Checkpoint**: the release pipeline is defined and structurally tested; its execution is owed to Actions.

---

## Phase 6: User Story 4 - CI plays the agent against the freshly built image (P2)

**Goal**: the driver's `--signin-link` leg and the `agent` job (research R9).

**Independent test**: quickstart Part A step 6 in the pod against the dev server; the `agent` job in Actions.

- [ ] T026 [P] [US4] Write `test/first-run/oauth-driver-args.test.mjs` (runs under `test:first-run`): spawning the driver with `--signin-link` and `--first-run` exits 2; `--signin-link` with a URL whose origin differs from `--server` exits 2 before any request; a source check that the `--signin-link` branch references neither `/auth/dev-login` nor `dev-consent-approve`
- [ ] T027 [US4] Implement `--signin-link`, `--expect-name`, `--expect-email`, and `--script-check` in `test/first-run/oauth-chain-driver.mjs` per contracts/oauth-driver-signin-link.md, keeping the default and `--first-run` legs byte-for-byte in behavior, until T026 passes (FR-027)
- [ ] T028 [US4] Run the three driver legs against the pod's development server (quickstart Part A step 6) and record the outcomes (pass, or the exact failure) in `promotion-notes.md`
- [ ] T029 [US4] Confirm the `modify` script used by `--script-check` is accepted by the current `modify` tool contract (read `get_tool_documentation` output from the dev server or `server/mcp/tools/`), and that it runs in the isolate sandbox (Constitution V)
- [ ] T030 [US4] (GHA) Add the `agent` job to `.github/workflows/release.yml` (load the amd64 tarball, serve `assets/` with `python3 -m http.server`, run `install.sh` with `SQUIRE_INSTALL_ASSET_URL`, `--version`, `--name "CI Agent"`, `--email ci-agent@example.com`, capture stdout, run the driver with `--signin-link "$(tail -n 1 link.txt)"`, `--expect-*`, `--script-check`; `always()` log dump and `down -v`) and make the publish job need it, until T022 passes in full (FR-025, FR-026, RBD-060-6, RBD-060-7)

**Checkpoint**: the agent path is proven in the pod and wired for Actions.

---

## Phase 7: User Story 5 - Documentation names the self-hoster's own instance (P2)

**Goal**: the `self-hosting` page and the self-hosted variant (research R11, R12).

**Independent test**: Vitest documentation suites, the Jest not-hosted documentation tests, and `cd client && npm run build`.

- [ ] T031 [P] [US5] Write `client/src/__tests__/documentation-variant.test.js`: hosted renders of every page (with `self-hosting` removed from the page set) match `documentation-hosted-golden.json`; `variant: 'hosted'` equals the default; self-hosted pages have no Google tag, no canonical, no `og:url`; header keeps only Documentation and Sign In; `filterFooter(FOOTER)` keeps Documentation, Agents, GitHub, Sign In, the brand, and the copyright, and drops Pricing, About, Blog, Sign Up, Privacy, Terms, the mailto, and the emptied Legal and Contact columns; `filterFooter` on a 062-shaped fixture footer (new tagline plus a `/documentation/self-hosting` "Self-host" item) keeps both; `renderVariantBody` turns the `markdown.md` and `agents-and-mcp.md` instance URLs into the sentinel, makes `/security` and `/privacy` body links absolute to `https://squiredocs.com`, and leaves `https://squiredocs.com/install.sh`, `https://squiredocs.com/self-host.md`, and email addresses alone; `HOSTED_ONLY_PATHS` agrees with `server/web-routes.js` `isHostedOnlyPath` (contracts/documentation-variant.md)
- [ ] T032 [US5] Implement the `variant` option, `keepSelfHostedHref`, `filterNavHtml`, `filterFooter`, `renderVariantBody`, `ORIGIN_SENTINEL`, and `HOSTED_ONLY_PATHS` in `client/scripts/render-documentation.mjs` without editing `site-footer.mjs`, until T031 passes (FR-030 to FR-032)
- [ ] T033 [US5] Edit `client/scripts/build-documentation.mjs` to also write the variant to `client/dist/documentation/_self-hosted/` and to fail the build on the sentinel or tag checks in contracts/documentation-variant.md "Build output"; extend `client/src/__tests__/documentation-build.test.js` to cover both outputs
- [ ] T034 [US5] Edit `server/documentation-routes.js` to accept `{ transformHtml }` (read once at mount, send transformed HTML) and `server/web-routes.js` not-hosted branch to mount `documentation/_self-hosted` with the validated, HTML-escaped origin substitution (research R11, contracts/served-routes.md)
- [ ] T035 [US5] Extend `server/__tests__/helpers/web-fixture.js` with `documentation/_self-hosted/` pages containing the sentinel, and add not-hosted cases to `server/__tests__/self-host-routes.test.js`: substitution for `Host: localhost:3910`, hostile `Host` values never appear unescaped and fall back to `APP_URL`, `/documentation/_self-hosted` and `/documentation/_self-hosted/index.html` return the documentation 404 on both instance kinds; confirm `hosted-parity.test.js` and `web-routes.test.js` pass unmodified
- [ ] T036 [US5] Edit `client/vite.config.js` `documentationPagesPlugin` to render `variant: SQUIRE_HOSTED ? 'hosted' : 'self-hosted'` and substitute the escaped dev origin (FR-033, edge case "Vite with SQUIRE_HOSTED unset")
- [ ] T037 [P] [US5] Renumber `order` in `documentation/markdown.md` (11), `documentation/appearance.md` (12), and `documentation/account-and-support.md` (13) (RBD-060-9)
- [ ] T038 [US5] Write `documentation/self-hosting.md` per contracts/documentation-variant.md "The self-hosting page" (FR-029, FR-040, RBD-060-22 Compose version, RBD-060-15 Windows note, RBD-060-18 exposed services), with `REPOSITORY` literal; extend `client/src/__tests__/documentation-build.test.js` to assert the slug, title, order 10 after `agents-and-mcp`, the required topics, the TLS sentence, no "password"/"OIDC" feature claims, and no bare "Squire"; make T011 pass
- [ ] T039 [US5] Attempt the Codex verification (research R15, RBD-060-10). If a connection from the Codex CLI to a Squire Docs instance over MCP is verified end to end, add the section to `documentation/agents-and-mcp.md` with the exact verified commands and re-record that page's golden hash with the reason; otherwise leave the page unchanged and record in `promotion-notes.md` that 062 must drop Codex (062 FR-003, FR-012) and that Sam is asked to verify
- [ ] T040 [US5] Run `cd client && npm run build` and `npm run test:client`; spot-check `client/dist/documentation/_self-hosted/agents-and-mcp.html` for the sentinel and no Google tag, and `client/dist/documentation/editing.html` differing from the pre-change build only by the sidebar entry (SC-005)

**Checkpoint**: documentation is correct on both instance kinds.

---

## Phase 8: User Story 6 - The plugin's onboarding skill sends agents to self-host.md (P3)

**Goal**: one instruction in `onboard.md`, regenerated bundles (research R14).

**Independent test**: `node distribution/publish.mjs && npm run test:first-run`.

- [ ] T041 [US6] Add a short "Self-hosted instance" instruction under Move 1 of `distribution/shared/onboard.md`: when the user asks for a local instance or a `squire-local` server is configured, fetch `https://squiredocs.com/self-host.md`, follow it, and use only the `squire-local` server's tools for that instance (FR-036, D9); keep within the onboard line budget
- [ ] T042 [US6] Edit `distribution/publish.mjs`: `LICENSE_HOLDER = '21st Harmonic LLC'` (RBD-060-13), `SHIP_VERSION` 1.0.2, `REGISTRY_VERSION` 1.0.3, `CURSOR_PLUGIN_VERSION` 1.0.1, with the version-history comments extended; `KIRO_POWER_VERSION` unchanged
- [ ] T043 [US6] Run `node distribution/publish.mjs` (dry run only, never `--publish`) to regenerate `distribution/claude-plugin/`, `distribution/mcp-registry/`, and `distribution/cursor-plugin/`; run `npm run test:first-run`; confirm `.mcp.json` still names `https://squiredocs.com/mcp` and the Kiro bundle is unchanged (FR-037, SC-008)

---

## Phase 9: User Story 7 - The repository is ready to be public (P3)

**Goal**: `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md` (RBD-060-13, RBD-060-14).

**Independent test**: `test/self-host/launch-files.test.mjs`.

- [ ] T044 [P] [US7] Write `test/self-host/launch-files.test.mjs`: `LICENSE` is the MIT text with `Copyright (c) 2026 21st Harmonic LLC` and equals the generated bundle LICENSE text; `package.json` license is `MIT`; `SECURITY.md` names `security@squiredocs.com`, private disclosure, supported versions (latest release and the hosted service), and links `https://squiredocs.com/security`; `CONTRIBUTING.md` points at `docs/dev.md`, names `npm test`, `npm run test:server`, `npm run test:client`, `npm run test:first-run`, `npm run test:self-host`, says contributions are under the MIT license, requires no DCO or CLA, asks for an issue before large changes, and states the writing rules
- [ ] T045 [P] [US7] Create `LICENSE`, `CONTRIBUTING.md`, and `SECURITY.md` at the repository root until T044 passes (FR-038)

---

## Phase 10: Polish and cross-cutting

- [ ] T046 Run the full Docker-free verification: `npm run test:self-host`, `npm run test:server`, `npm run test:client`, `npm run test:first-run`, `cd client && npm run build`; all green (quickstart Part A)
- [ ] T047 Hosted parity re-check: `git diff main --stat` touches no file on the plan's "Not touched" list; `hosted-parity.test.js` unmodified and passing; golden hashes pass (FR-033, FR-039, SC-006)
- [ ] T048 Prose sweep of every new or edited user-facing file (`AGENTS.md`, `install.sh` messages, `.env.example`, `documentation/self-hosting.md`, `onboard.md`, `CONTRIBUTING.md`, `SECURITY.md`): no em dashes, "Squire Docs" not bare "Squire", plain sentences
- [ ] T049 Append an "Implement phase" section to `specs/060-self-host-distribution/promotion-notes.md`: Codex outcome (T039), driver results (T028), the executable-bit staging note (T010, T014), Docker-only checks owed, and confirm the plan's "Documentation owed" list is still accurate for the merge queue

---

## Dependencies and execution order

- Setup (T001 to T004) first; T001 must precede T032.
- Foundational (T005 to T012) blocks every story: install.sh and the workflow consume `release.mjs`, `compose.yml`, `.env.example`, and the wrapper.
- US1 (T013 to T015) and US2 (T016 to T021) are independent of each other after Foundational.
- US3 (T022 to T025) needs Foundational; its smoke steps reference `AGENTS.md` and `install.sh` (US1, US2) for the served-file `cmp`.
- US4 (T026 to T030) needs US1 (install.sh) and US3 (release.yml).
- US5 (T031 to T040) needs T001; independent of US1 to US4 except that T038 makes T011 pass together with T014 and T017.
- US6 (T041 to T043) is independent; T042 shares the LICENSE holder with US7.
- US7 (T044, T045) is independent; T044 compares against the bundle LICENSE produced in T043.
- Polish last.

## Parallel examples

- After T004: T005, T007, T008, T009, T010 in parallel (different files).
- US2: T016 and T018 in parallel; then T017 and T019; T020 and T021 any time.
- US5: T031 and T037 in parallel; T032 then T033, T034, T036.
- US6 and US7 can run alongside US5.

## Implementation strategy

MVP is US1 on top of Foundational: a tested install script and the files it
installs. Then US2 (the runbook and routes, so squiredocs.com can serve both
files after a deploy), then US3 and US4 (release and agent job, verified in
Actions once `REPOSITORY` is set and the repository is public), then US5 for
launch-blocking documentation, then US6 and US7.

## Traceability (FR to tasks)

| FR | Tasks | FR | Tasks |
| --- | --- | --- | --- |
| FR-001 to FR-006 | T007, T008, T011 | FR-021 | T018, T019, T020 |
| FR-007 | T007, T010 | FR-022 to FR-024 | T016, T017 |
| FR-008 | T007, T009 | FR-025, FR-026 | T022, T023, T030 |
| FR-009, FR-010 | T005, T006, T023 | FR-027 | T026, T027, T028 |
| FR-011 | T020, T023, T025 | FR-028 | T024 |
| FR-012 | T022, T023 (GHA) | FR-029 | T038 |
| FR-013 | T020, T023 smoke | FR-030 to FR-032 | T031 to T036 |
| FR-014 to FR-019 | T013, T014 | FR-033 | T001, T031, T036, T040, T047 |
| FR-020 | T003, T013 | FR-034 | T039 |
| FR-035 | plan "Documentation owed" (merge queue) | FR-036, FR-037 | T041 to T043 |
| FR-038 | T042, T044, T045 | FR-039 | T025, T047 |
| FR-040 | T009, T015, T016, T038 | | |
