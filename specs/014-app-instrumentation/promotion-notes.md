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
