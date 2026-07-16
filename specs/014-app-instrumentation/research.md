# Phase 0 Research — 014-app-instrumentation

All spec-level open points were resolved in `clarifications-needed.md` (9 RATIFIED-BY-DEFAULT). This file records the *implementation* decisions the plan depends on. No `NEEDS CLARIFICATION` markers remain.

## D1 — SDK init before application modules (CJS require ordering)

- **Decision**: A single `server/telemetry.js` bootstrap, required as the **second** line of `server/index.js` (immediately after `require('dotenv').config()` and before every other `require`). It registers the OTel instrumentation require-hooks and installs the console shim synchronously, then returns.
- **Rationale**: OTel's CJS auto-instrumentation monkey-patches modules as they are `require`d; it must run before `express`/`pg`/`ioredis` are loaded. dotenv must run first so a dev `.env` can supply `OTEL_*`. In prod the Deployment injects `OTEL_*` into the process env before node starts, so relative order of dotenv vs telemetry is irrelevant there. This is the simplest ordering that satisfies both.
- **Alternatives considered**: `node --require ./server/telemetry.js` (or `--import` for ESM) — strictly correct and endpoint-agnostic, but changes the start command (Dockerfile/scripts, outside this feature's clean `server/`-only footprint) and loses the dev `.env` convenience. Kept documented as a fallback if any instrumentation proves to load too late via in-file require.

## D2 — Dependency set and pinning

Repo convention is caret ranges. New dependencies (caret, target lines current as of the OTel JS 2025 stable/experimental split):

| Package | Range | Notes |
|---|---|---|
| `@opentelemetry/api` | `^1.9.0` | stable; a transitive copy is already in `node_modules` |
| `@opentelemetry/sdk-node` | `^0.57.0` | experimental line; orchestrates providers + instrumentations |
| `@opentelemetry/sdk-trace-base` | `^1.30.0` | `BatchSpanProcessor`, `InMemorySpanExporter`, custom `SpanProcessor` |
| `@opentelemetry/sdk-metrics` | `^1.30.0` | `PeriodicExportingMetricReader`, `InMemoryMetricReader` |
| `@opentelemetry/resources` | `^1.30.0` | service.name/version resource |
| `@opentelemetry/semantic-conventions` | `^1.30.0` | attribute keys |
| `@opentelemetry/instrumentation-http` | `^0.57.0` | inbound HTTP spans + route template |
| `@opentelemetry/instrumentation-express` | `^0.45.0` | Express routing spans |
| `@opentelemetry/instrumentation-pg` | `^0.50.0` | PostgreSQL client spans |
| `@opentelemetry/instrumentation-ioredis` | `^0.46.0` | Redis spans |
| `@opentelemetry/exporter-trace-otlp-proto` | `^0.57.0` | OTLP/HTTP-protobuf traces |
| `@opentelemetry/exporter-metrics-otlp-proto` | `^0.57.0` | OTLP/HTTP-protobuf metrics |
| `pino` | `^9.5.0` | JSON logger behind the console shim |

- **Rationale**: The four instrumentations are installed individually (not the umbrella `auto-instrumentations-node`) to keep the require-hook set explicit and the dependency surface minimal — a security-review-friendly choice for a repo that gates new deps (Principle V / Tech Constraints). OTLP **http/protobuf** (4318) avoids a native gRPC dependency and honors `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_PROTOCOL` cleanly.
- **Version caveat (carry to implement)**: the `0.x` experimental packages must be installed as a **mutually compatible set** — pin whatever compatible minors `npm install` resolves at implement time and record the resolved lockfile; the ranges above are the target lines, not a guarantee across independent bumps.
- **Alternatives**: OTLP/gRPC (native `@grpc/grpc-js`, heavier, marginal gain); `auto-instrumentations-node` (drags in ~40 instrumentations, most disabled — larger attack/audit surface).

## D3 — Inert / capture / export trimodal

- **Decision**: `telemetry.start()` selects processors: OTLP exporters when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; injected in-memory exporter/reader in tests (via the capture harness); **no processor at all** when neither. In the no-processor case, spans/metrics are still created (cheap) but never exported — zero network attempts, zero error noise (FR-015).
- **Rationale**: Matches the design doc's "inert without a Collector" invariant and keeps the SDK's hot path negligible. Standard `BatchSpanProcessor` already gives bounded buffering + drop semantics for the unreachable-endpoint case (RBD-4/FR-016) with no bespoke machinery.
- **Alternatives**: Start a no-op exporter that swallows exports (still constructs batches needlessly); env-gate the whole `start()` to a no-op when unset (loses in-test capture path). Rejected for the cleaner trimodal.

## D4 — Console shim: non-throwing, semantics-preserving

- **Decision**: `logger.js` wraps `console.log/info/warn/error/debug`. Each wrapper: applies `util.format`-equivalent variadic handling, serializes via pino with a bounded depth/size guard, injects `trace_id`/`span_id` from the active OTel context when a span is recording (omit otherwise — RBD-5), preserves `Error` name+message+stack, and is wrapped in try/catch that falls back to the original bound stream write. `console.trace/dir/table/group*` etc. are left as-is or lightly routed — only the five named methods are in scope (FR-007).
- **Rationale**: The shim sits under every log call (highest blast radius per promotion-notes). Non-throwing + fallback guarantees a logging bug can never take down a request path (FR-009). JSON encoding inherently neutralizes newline/control-char log injection from user-controlled identifiers (edge case).
- **Alternatives**: `pino`'s own `console` integrations / OpenTelemetry logs SDK + appender — heavier, and the logs SDK export path is out of scope (stdout only; 013 ships the lines). Rejected.

## D5 — Trace/metric privacy enforcement

- **Decision**: Two layers. (1) Deliberate attribute construction — manual spans and metric labels draw only from the permitted-identifier allowlist. (2) A `RedactionSpanProcessor` on `onEnd` that drops any attribute key outside the allowlist and truncates values, plus route-template enforcement on HTTP spans (drop `http.target`/`url.full`/query). Metric label sets are fixed in code (no dynamic content-derived labels possible).
- **Rationale**: FR-020 requires enforcement "by the instrumentation layer itself, not convention." The processor is the machine-checked backstop the sentinel tests exercise (FR-024/SC-005).
- **Alternatives**: Convention-only (fails FR-020); a full OTel `View`/attribute-filter for metrics (metrics labels are already statically bounded, so overkill). Kept construction + span redaction; metric labels bounded by code.

## D6 — Test-time capture (Collector-free, serial Jest)

- **Decision**: `server/__tests__/helpers/telemetry-capture.js` starts the SDK with `InMemorySpanExporter` + a `SimpleSpanProcessor` and an `InMemoryMetricReader`, plus a pino stream sink capturing log JSON. Tests assert on captured spans/metrics/log lines. No network exporter. The harness resets between tests and is safe under `--runInBand`.
- **Rationale**: Matches RBD-7 and the serial-suite constraint; hermetic and deterministic. `SimpleSpanProcessor` (not batch) makes spans synchronously available for assertions.
- **Alternatives**: Spin a mock OTLP receiver (network, flaky under serial suite). Rejected.

## D7 — HTTP request metrics source

- **Decision**: A thin Express middleware records request count + duration histogram labeled by route template (`req.route`/matched path) and status class, into `metrics.js`'s meter. The 5xx rate is derived from the status-class label. Route template (not concrete URL) is the label — same low-cardinality rule as spans (FR-003/FR-011).
- **Rationale**: The http instrumentation gives spans; app-owned metrics need an explicit recorder to guarantee the exact label taxonomy (RBD-3) and to keep 5xx derivable. A middleware mounted early + a finish-listener is the standard pattern and keeps content out of labels.
- **Alternatives**: Rely solely on instrumentation-http's built-in metrics — less control over label taxonomy and status-class bucketing. Kept the explicit middleware.

## D8 — Graceful-shutdown flush

- **Decision**: `telemetry.shutdown()` (SDK `shutdown()` = force-flush + provider shutdown) is added as a guarded step in `createShutdown`'s ordered drain, bounded by the existing `SHUTDOWN_DEADLINE_MS` backstop; it resolves even if the Collector is unreachable.
- **Rationale**: FR-017 — flush within the existing window, never hang. `createShutdown` already wraps each step in `safe()` and has a force-exit timer, so the flush inherits both guards.
- **Alternatives**: A separate SIGTERM handler for telemetry (racy with the ordered drain). Rejected — reuse the one drain.
