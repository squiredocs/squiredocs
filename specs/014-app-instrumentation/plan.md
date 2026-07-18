# Implementation Plan: Application OpenTelemetry Instrumentation

**Branch**: `014-app-instrumentation` (work stays on `main` per pipeline override) | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/014-app-instrumentation/spec.md`

**Design ground truth**: `design/observability-and-telemetry.md` (Sam-ratified 2026-07-16). Approved plan: `declarative-tumbling-turtle` (Phases 4–5). Companion feature: `013-o11y-platform` (Collector + backend, parallel).

## Summary

Instrument the Squire server with vendor-neutral OpenTelemetry — traces (auto-instrumented HTTP/Express/pg/ioredis plus manual spans for the collaboration and MCP paths), metrics (HTTP golden signals, a 429 rejection counter, PG pool gauges), and structured JSON logging correlated to traces via a non-throwing `console` shim — and export it over OTLP to a cluster-local Collector when one is configured, degrading to fully inert behavior when one is not. Document content never enters any signal; that boundary is enforced by a redaction span processor plus deliberate attribute construction and proven by sentinel-content tests.

The single technical spine is **require-ordering**: a bootstrap module (`server/telemetry.js`) initializes the OTel SDK's require-hook auto-instrumentation and installs the console shim *before* any application module (`express`, `pg`, `ioredis`, and the ~382 `console.*` call sites) loads. The server stays CommonJS. Everything is inert and non-throwing without a Collector so the dev pod, CI, and the serial Jest suite are unaffected.

## Technical Context

**Language/Version**: Node.js 22.23 / CommonJS (no ESM migration — FR-001, design-doc ruling)

**Primary Dependencies (new)**: `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-metrics`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`, OTLP proto exporters (traces + metrics), the four instrumentation packages (http, express, pg, ioredis), and `pino`. Existing: Express 4, `pg` 8, `ioredis` 5, `rate-limiter-flexible` 11.

**Storage**: N/A — no schema change, no migration. Telemetry egress is stdout (logs) + OTLP (traces/metrics); durability is feature 013's Collector.

**Testing**: Jest `--runInBand` (serial, shared DB) with in-process capture (`InMemorySpanExporter`, `InMemoryMetricReader`, pino stream sink). No network exporter, no Collector.

**Target Platform**: Linux server (single `app.listen` entrypoint, k3s Deployment).

**Project Type**: Single web-service backend (`server/`), CommonJS.

**Performance Goals**: No measurable startup regression in Collector-less mode (SC-004); flat memory + unchanged request latency with an unreachable endpoint (SC-006). Full-sampling at beta volume (RBD-2).

**Constraints**: SDK init strictly before app-module load; console shim non-throwing and semantics-preserving; zero rewrites of the ~382 `console.*` sites; privacy invariant machine-checked; only `server/` + tests + `package.json` touched (the app Deployment env vars are 013's/ops' surface, not edited here).

**Scale/Scope**: ~9 new/modified `server/` files + new test files + `package.json`. Public-beta traffic volume.

## Constitution Check

*GATE: evaluated against constitution v1.1.1. Re-checked after design below.*

| Principle | Assessment |
|-----------|------------|
| **I. Documentation Reflects Reality** | README/dev.md updates are owed at *implement* time (behavior change). This PLAN agent is barred from editing them (override); a Polish task records the owed doc edit for the implement/converge phase. **PASS with carried task.** |
| **II. Test-Backed Changes** | Every behavior is covered by new serial Jest tests (US1 shim, US2 spans, US3 metrics, US4 inertness + privacy sentinels). No format-registry change, so the round-trip suite is untouched. **PASS.** |
| **III. Trunk-Based Solo Workflow** | No new ceremony; work on `main`, no PR. **PASS.** |
| **IV. Collaboration-Safe Document Operations** | No document mutation, no format-registry change, no positional targeting. Manual collab-path spans are read-only observers of the sync path. **PASS.** |
| **V. Secure by Default** | Telemetry treats identifiers as the only permitted attributes; content is excluded by construction *and* by a redaction safeguard; log-injection is neutralized by JSON encoding. Strengthens the posture. **PASS.** |
| **VI. Design Docs Are Ground Truth** | Plan derives from `design/observability-and-telemetry.md`; the 9 open points are RATIFIED-BY-DEFAULT in `clarifications-needed.md`. No design doc is hand-edited. **PASS.** |

**Complexity Tracking**: no violations — table omitted.

## Project Structure

### Documentation (this feature)

```text
specs/014-app-instrumentation/
├── spec.md                     # complete (SPEC phase)
├── clarifications-needed.md    # 9 RATIFIED-BY-DEFAULT + 2 OBS + new PLAN entries
├── promotion-notes.md          # phase log (PLAN appends)
├── plan.md                     # this file
├── research.md                 # Phase 0
├── data-model.md               # Phase 1 (telemetry entities)
├── contracts/
│   ├── requirements.md         # (checklist, from SPEC)
│   └── telemetry-contracts.md  # Phase 1 (env vars, span/metric/log contracts)
├── quickstart.md               # Phase 1 (validation guide)
└── tasks.md                    # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
server/
├── telemetry.js            # NEW  OTel SDK bootstrap: resource, instrumentations
│                           #      (http/express/pg/ioredis), trace+metric providers,
│                           #      conditional OTLP vs inert vs in-memory (tests),
│                           #      privacy span processor, flush()/shutdown()
├── logger.js               # NEW  pino JSON logger + non-throwing console shim +
│                           #      trace/span correlation from active OTel context
├── telemetry/
│   ├── privacy.js          # NEW  attribute allowlist + redaction SpanProcessor;
│   │                       #      safe-attribute helper (shared by manual spans)
│   ├── metrics.js          # NEW  meters: HTTP req histogram/counter, 429 counter,
│   │                       #      PG pool observable gauges; http metrics middleware
│   └── spans.js            # NEW  manual-span helpers (withSpan) for collab + MCP
├── index.js                # EDIT require telemetry+shim FIRST (after dotenv);
│                           #      mount http-metrics middleware; wire pool into
│                           #      metrics; add telemetry.shutdown to createShutdown
├── rate-limit.js           # EDIT increment 429 counter at both reject points
├── postgres-persistence.js # EDIT (minimal) ensure getPool() exposes pool for gauges
├── redis-pubsub.js         # EDIT manual span around publish/propagate (op-level)
├── markdown-sync.js        # EDIT manual span around a sync run
└── mcp/tools/index.js      # EDIT manual span in executeTool (name/agent/outcome/dur)

server/__tests__/
├── telemetry-console-shim.test.js   # NEW  US1 (FR-022)
├── telemetry-traces.test.js         # NEW  US2 (FR-023 span presence)
├── telemetry-metrics.test.js        # NEW  US3 (FR-023 counter+gauges)
├── telemetry-inert.test.js          # NEW  US4 (FR-015/021 Collector-less)
├── telemetry-privacy.test.js        # NEW  US4 (FR-024/SC-005 sentinels)
└── helpers/telemetry-capture.js     # NEW  in-memory exporters/readers harness

package.json                # EDIT add OTel + pino deps (caret, repo convention)
```

**Structure Decision**: Flat `server/*.js` matches repo convention; a small `server/telemetry/` subdir groups the three helper modules (privacy, metrics, spans) under the `telemetry.js` bootstrap without sprawling the top level. No `shared/` code (nothing is client-shared). Nothing outside `server/` + tests + `package.json` is touched — the app Deployment OTel env vars (FR-018) are declared in the contracts doc for ops/013 to apply, not edited by this feature.

## Architecture Notes (load-bearing decisions)

1. **Require ordering (the landmine).** `server/index.js` currently does `require('dotenv').config()` then immediately requires `express`, `pg`-backed modules, `ioredis`, etc. New order: line 1 `require('dotenv').config()` → line 2 `require('./telemetry').start()` (registers instrumentation require-hooks + installs the console shim) → then all existing requires. Env is loaded first so an `.env`-provided `OTEL_*` in dev is honored; in prod the Deployment sets `OTEL_*` before node starts, so ordering is moot there. Belt-and-suspenders alternative documented in research.md: `node -r ./server/telemetry.js`.

2. **Inert / capture / export trimodal.** `telemetry.start()` chooses processors by environment: (a) `OTEL_EXPORTER_OTLP_ENDPOINT` set → OTLP proto exporters with a batch span processor + periodic metric reader; (b) test mode → injected in-memory exporter/reader (via the capture harness); (c) neither → **no exporter/processor at all** (spans/metrics created but dropped, zero export attempts, no error noise). Graceful shutdown always calls `telemetry.shutdown()` which force-flushes within a bounded timeout and resolves regardless (wired into `createShutdown` deps).

3. **Console shim.** `logger.js` builds one pino JSON logger to stdout and replaces `console.log/info/warn/error/debug` with wrappers that: map level, run pino's serializers, inject `trace_id`/`span_id` from `trace.getSpan(context.active())?.spanContext()` when present (omit otherwise — RBD-5), preserve `console.*` variadic + `util.format` semantics, cap serialization depth/size, preserve `Error` stacks, and never throw (fallback to the original bound `process.stdout.write`). The ~382 call sites are untouched. The exception notifier keeps its own `console.*` usage (now routed through the shim) but its email path is unchanged and independent (FR-010) — the shim must not intercept or transform the notifier's flow, only serialize its log lines.

4. **Privacy enforcement (two layers).** (a) *Construction*: manual spans and metric labels only ever set attributes from the permitted-identifier set (doc GUID, user/agent ID, route template, tool name, operation type, status class, limiter category, counts, durations). (b) *Safeguard*: a `RedactionSpanProcessor` runs on span end and drops/validates any attribute key not on the allowlist and truncates values, so an accidental content attribute cannot escape. Auto-instrumentation's HTTP span uses route templates, never concrete URLs (FR-003) — enforced via the http instrumentation config + the redaction pass on `http.target`/`url.full`.

5. **429 counter.** `rate-limit.js` emits 429 at two points: `reject429()` (per-IP/per-user classes via `enforce`) and `registrationAdmissionMiddleware()` (registration admission). Both increment the counter labeled by limiter category (the `className`, e.g. `auth`/`chat`/`search` and `register`). Counting is wrapped so a metrics failure never adds a failure mode to the 429 path (edge case). _(**Amended 2026-07-18:** the second point, `registrationAdmissionMiddleware()`, and the `register` category were removed with the registration admission caps — sign-up is now unlimited. `reject429()` remains the sole 429 emit/count point; see feature 010 promotion-notes §8.)_

6. **PG pool gauges.** `metrics.js` registers OTel observable gauges that read `persistenceProvider.getPool().{totalCount,idleCount,waitingCount}` on the metric collection interval. `postgres-persistence.js` already exposes `getPool()`; the only possible edit is confirming/exposing that seam. index.js passes the provider to `metrics.init()`.

7. **Manual spans, operation-level (RBD-1).** `redis-pubsub.js` wraps `publishUpdate`/`publishAwareness` (or the propagation handler) in one span per propagation op, attributed with doc GUID + op type — never per CRDT update message. `markdown-sync.js` wraps a sync run. `mcp/tools/index.js` `executeTool()` wraps each invocation (tool name, agent/user id, outcome, duration) — never tool args/results (RBD-9).

## Constitution Re-check (post-design)

No new violations introduced. The design adds no format-registry surface, no schema change, no document mutation, and no client code. The one owed item (README/dev.md doc update) is a constitution Principle I obligation deferred to implement/converge time by pipeline override and captured as a Polish task. **GATE PASS.**
