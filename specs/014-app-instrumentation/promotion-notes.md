# Promotion Notes — 014-app-instrumentation

Running record of what each pipeline phase produced and what the next phase / the maintainer
needs to know. SPEC phase entries below; later phases append.

## SPEC phase (2026-07-16)

- **Artifacts**: `spec.md`, `clarifications-needed.md` (9 RATIFIED-BY-DEFAULT decisions +
  2 observations), `checklists/requirements.md`, this file.
- **Ground truth used**: `design/observability-and-telemetry.md` (committed, Sam-ratified
  2026-07-16) and the approved plan `declarative-tumbling-turtle` (Phases 4–5, app track).
  Constitution v1.1.1 reviewed; Principle VI (ledger for defaults) and Principle II
  (test-backed, serial backend suite) shape the spec's testing FRs.
- **Scope seam with 013**: 014 = everything inside `server/` (SDK init, manual spans, pino
  console shim, app metrics) + app Deployment OTel env vars only. 013 = Collector, monitoring
  node, backend, dashboards, alarms, all other IaC/k8s. 014 is inert without 013 (standard
  OTel env vars are the entire contract), so merge order is free.
- **Deliberate spec-level stances a planner should not undo**:
  - CJS stays; instrumentation via require hooks (design-doc decision — do not re-open ESM).
  - Privacy invariant is specced as testable FRs (FR-019/020/024) with sentinel-content
    tests; reviews treat violations as trust-invariant breaks.
  - Collector-less inertness (FR-015) is a P1 user story, not a nice-to-have — dev pods,
    CI, and the serial Jest suite all run without a Collector.
  - Collab-path span granularity is operation-level, not per-CRDT-message (RBD-1).
- **Known risks to carry into PLAN**:
  - The console shim sits under every log call in the app — highest-blast-radius change;
    US1 acceptance scenarios (hostile inputs, non-throwing path, notifier untouched) exist
    to force test-first treatment.
  - SDK init must precede application module loading at `server/index.js` (which currently
    starts with `dotenv` then immediate requires) — ordering is an implementation landmine
    the plan must address explicitly.
  - Interaction between the shim and the exception notifier's own console usage needs a
    look at plan time (edge case recorded).
- **Pipeline overrides honored**: no branch/commit (stayed on `main`), no
  `create-new-feature.sh`, no `.specify/feature.json` write, directory created manually,
  no edits to CLAUDE.md / README.md / docs/dev.md, no user interaction.
- **Not done at spec time (deliberately)**: no code changes, no dependency additions, no
  README/docs updates (docs change with behavior, at implement time per Principle I).

## PLAN phase (2026-07-16)

- **Artifacts**: `plan.md`, `research.md` (D1–D8 impl decisions), `data-model.md` (telemetry signal shapes + permitted-identifier allowlist), `contracts/telemetry-contracts.md` (6 contracts), `quickstart.md`, `tasks.md`. Ledger gained RBD-10/11/12 (OTLP http-proto, individual instrumentations, 013/014 env seam resolving OBS-1).
- **Setup-script note**: `setup-plan.sh`/`setup-tasks.sh` were NOT run — with `SPECIFY_FEATURE_DIRECTORY` set they call `_persist_feature_json`, which would overwrite the shared `.specify/feature.json` (currently `specs/012-chat-error-surfacing`) to 014, violating the "never write feature.json" override and risking a clash with the parallel 013 agent. Paths are fixed, so templates were resolved/written manually. `.specify/feature.json` left untouched.
- **Module design**: bootstrap `server/telemetry.js` (required 2nd in index.js, after dotenv, before all app requires) + `server/logger.js` (pino + console shim) + `server/telemetry/{privacy,metrics,spans}.js`. Trimodal export (OTLP | in-memory test | inert). CJS stays.
- **Constitution**: gate PASS pre- and post-design; no Complexity Tracking rows. One owed item — README.md + docs/dev.md update (Principle I) — deferred to implement/converge by override, captured as a Polish task in tasks.md.
- **Overrides honored**: stayed on `main`, no branch/commit, no create-new-feature.sh, no feature.json write, no edits to CLAUDE.md/README.md/docs/dev.md, no touch to specs/013-*, no user interaction (all defaults RATIFIED-BY-DEFAULT).
- **Carry to IMPLEMENT**: pin the 0.x OTel experimental packages as a mutually-compatible set at install (record lockfile); confirm `postgres-persistence.getPool()` exposes live pool counts; ensure the console shim never intercepts the exception-notifier email path (only serializes its log lines).

## IMPLEMENT phase (2026-07-16)

- **Branch/worktree**: `014-app-instrumentation` in a dedicated worktree. Committed granularly; NOT pushed/merged.
- **All 26 tasks complete** (T001–T026), tasks.md checkboxes updated.
- **New files**: `server/telemetry.js`, `server/logger.js`, `server/telemetry/{privacy,spans,metrics}.js`, `server/__tests__/helpers/telemetry-capture.js`, `server/__tests__/helpers/otel-e2e-child.js` (fixture), and 6 test files (`telemetry-console-shim`, `-traces`, `-metrics`, `-inert`, `-privacy`, `-degradation`).
- **Edited**: `server/index.js` (telemetry.start() 2nd after dotenv; http-metrics middleware; pool-gauge init; telemetry flush in createShutdown), `server/shutdown.js` (telemetry dep + guarded flush step), `server/rate-limit.js` (429 counter at both reject points), `server/redis-pubsub.js` + `server/markdown-sync.js` + `server/mcp/tools/index.js` (op-level manual spans). `server/postgres-persistence.js` UNCHANGED — `getPool()` already exposes total/idle/waiting (T020 no-op). `server/exception-notifier.js` UNCHANGED (T009 verified — the shim only serializes its console lines).
- **RBD-13 (new ledger entry)**: providers built directly (`BasicTracerProvider` + `MeterProvider` + `registerInstrumentations` + `AsyncLocalStorageContextManager`) instead of `NodeSDK`, because NodeSDK's span export does not function under jest while a directly-built provider does. Behavior/auto-instrumentation identical; proven standalone (real HTTP→PG→Redis single trace) AND under jest (in-process capture). Added explicit deps `@opentelemetry/context-async-hooks@1.30.1` + `@opentelemetry/instrumentation@0.57.2`; `sdk-node@0.57.2` retained but unused by app code.
- **Inertness landmine handled**: always pass explicit `spanProcessors` (redaction-only in inert mode) so there is never a fallback to the env-default OTLP-at-localhost exporter. Verified: `mode=inert` with no OTEL env, zero export attempts, zero crash.
- **Resolved dependency set**: recorded in `research.md` (D2 closure). `npm ls` clean.
- **Gate results (worktree, against `collab_test_db_014`)**: backend `160 suites / 2841 tests` green (adds 6 suites / 32 tests over the pre-feature 154/2809, incl. exception-notifier still green → FR-010/SC-007); client `49 suites / 613` green; `npm run build` green; inert `node -e` smoke green (`mode=inert`, JSON logs, bounded shutdown).
  - NOTE: `npm run test:server` cannot be used verbatim inside a worktree — the repo jest config's `testPathIgnorePatterns`/`modulePathIgnorePatterns` include `/.claude/worktrees/`, which makes jest find ZERO tests when run FROM a worktree. Ran the suite with CLI overrides (`--testPathIgnorePatterns "/node_modules/" "/client/" --modulePathIgnorePatterns "/__nomod__/"`). This is a worktree-run-only concern; the shipped config is correct for the main tree and is NOT changed.
- **For the merge queue**:
  - Place the app-Deployment OTel env block from `deployment-env-snippet.yaml` (FR-018/RBD-12) — 014 edits no k8s YAML. Defer to 013 for who applies it if 013 owns an app-deployment patch.
  - Fold `docs-draft.md` into README.md + docs/dev.md (Principle I doc obligation, deferred by override).
  - `git diff` touches only `server/`, `server/__tests__/`, `package.json`/lockfile, and this feature's `specs/014-*` artifacts. No `specs/013-*`, no `infra/`, no CLAUDE.md/README.md/docs/dev.md edits.
- **Degradation test (F1)**: shipped as a real test (`telemetry-degradation.test.js`) — points the exporter at `127.0.0.1:1` (connection REFUSED = deterministic/fast, not a timeout), asserts no throw, no unhandled rejection, bounded shutdown. Not flaky.
