# Feature Specification: Application OpenTelemetry Instrumentation

**Feature Branch**: `014-app-instrumentation`

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "Application OpenTelemetry instrumentation (server track) — feature 014-app-instrumentation"

**Design ground truth**: `design/observability-and-telemetry.md` (Sam-ratified 2026-07-16). Approved plan: `declarative-tumbling-turtle` (Phase 4/5 app track). Companion feature: `013-o11y-platform` (Collector, monitoring node, dashboards, alarms — specced in parallel; see Out of Scope).

## Overview

The Squire server today emits no metrics, no traces, and only unstructured, ephemeral console logs; when something breaks in production the sole signal is a best-effort exception email. This feature instruments the application itself — vendor-neutral OpenTelemetry tracing and metrics at the single server entrypoint, structured JSON logging correlated to traces, and application-level metrics for the signals an operator actually needs (request health, rate-limit rejections, database pool pressure) — and ships all of it to a cluster-local Collector when one is configured, while degrading to inert behavior when one is not. Document content never enters any telemetry signal; that boundary is a trust invariant, specified here as testable requirements.

## User Scenarios & Testing *(mandatory)*

The "user" of this feature is the operator (Sam) running the public beta, plus the developers and agents who work on the server and must not be broken by the instrumentation.

### User Story 1 - Correlated structured logs for every request (Priority: P1)

As the operator, when I investigate a production incident, every log line the app emits is structured JSON carrying the trace and span identifiers of the request that produced it, so I can go from an error log to the full request trace (and back) in the observability backend — without any of the ~382 existing log call sites having been rewritten.

**Why this priority**: Durable, searchable, correlated logs are the top-ranked gap in the design doc's build order. The console shim is also the highest-risk change (it sits under every log call in the app), so it must land and be proven first.

**Independent Test**: Start the server, exercise any HTTP endpoint, and inspect stdout: every line is valid JSON with severity, timestamp, message, and — for lines emitted inside a request — trace/span IDs. Existing `console.*` call sites function unchanged.

**Acceptance Scenarios**:

1. **Given** the server is running, **When** any existing `console.log`/`warn`/`error` call site executes during an HTTP request, **Then** the emitted stdout line is structured JSON that includes the active request's trace ID and span ID.
2. **Given** a log call executes outside any request context (e.g., at startup), **When** the line is emitted, **Then** it is still valid structured JSON, simply without trace/span correlation fields.
3. **Given** a `console.*` call passes multiple arguments, format strings, an Error object, or a circular object, **When** the shim serializes it, **Then** no exception escapes the logging path and the message content is preserved (Error stacks included).
4. **Given** an exception reaches the exception notifier, **When** the notifier runs, **Then** the existing exception email is still sent — the notifier remains an independent, redundant channel untouched by the logging change.

---

### User Story 2 - Distributed traces across the request path (Priority: P2)

As the operator, I can follow a single user request end to end — HTTP entry, Express route, database queries, Redis operations — as one correlated trace, and I can also see traces for the paths that live outside the HTTP request lifecycle: real-time document collaboration sync and agent (MCP) tool activity.

**Why this priority**: Traces are what turn "the app is slow" into "this query on this route is slow." Auto-instrumentation covers the request path nearly for free once the SDK is in place; the collaboration and MCP paths need deliberate manual spans because no framework hook sees them.

**Independent Test**: With telemetry captured in-process (tests) or exported (verification), make one HTTP request that touches the database and Redis; observe a single trace containing the HTTP server span with child DB and Redis spans. Trigger a collaboration sync and an MCP tool call; observe named spans for each.

**Acceptance Scenarios**:

1. **Given** telemetry is enabled, **When** an HTTP request executes a database query and a Redis operation, **Then** one trace is produced containing the server span and child spans for the database and Redis work, with the route template (not the concrete URL) as the low-cardinality span identity.
2. **Given** a document collaboration update propagates through the pub/sub and markdown-sync path, **When** the update is processed, **Then** manual spans record the operation with the document identifier (GUID) and operation type as attributes.
3. **Given** an agent invokes an MCP tool, **When** the tool executes, **Then** a span records the tool name, outcome (success/error), and duration.
4. **Given** no telemetry endpoint is configured, **When** any of the above paths execute, **Then** behavior is identical except no data is exported — no errors, no startup delay, no crash.

---

### User Story 3 - Application metrics that were previously invisible (Priority: P2)

As the operator, I can see request rate, latency, and 5xx error rate for the app; a counter of rate-limit rejections (429s), which today are completely silent; and gauges of database connection pool pressure (total/idle/waiting), so saturation is visible before it becomes an outage.

**Why this priority**: These three metric families are the app-level golden signals the design doc names explicitly. The 429 counter and pool gauges cover known blind spots: feature 010 added the limits and pool bounds but no visibility into either.

**Independent Test**: Exercise the app past a rate limit and against the database; verify via test-scoped metric capture that the 429 counter increments, request metrics record count/duration/status, and pool gauges report plausible values.

**Acceptance Scenarios**:

1. **Given** metrics are enabled, **When** HTTP requests complete, **Then** request count and duration are recorded with route template and status class, sufficient to derive rate, latency distribution, and 5xx rate.
2. **Given** a client exceeds a rate limit, **When** the uniform 429 is sent, **Then** a rate-limit rejection counter increments, labeled by limiter category (e.g., API vs. registration admission) but never by any content-derived value.
3. **Given** the database pool is in use, **Then** gauges report the pool's total, idle, and waiting counts on the standard metric collection interval.

---

### User Story 4 - Safe by default: no Collector, no content, no test breakage (Priority: P1)

As a developer (or CI, or a dev-pod agent), I can run the server and the full backend test suite in an environment with no telemetry Collector at all, and everything passes and behaves normally. As the operator, I have machine-checked assurance that document content — text, titles, search queries, chat content — never appears in any log line, span attribute, or metric label.

**Why this priority**: Ties with US1 because both are invariants, not features: a telemetry stack that breaks Collector-less environments breaks every dev/test workflow, and a privacy leak into the weaker-access-control telemetry store is a trust-invariant break per the design doc.

**Independent Test**: Run the backend suite serially with no telemetry endpoint configured — green. Run the privacy tests: exercise logging/tracing/metrics around content-bearing operations with sentinel content and assert no sentinel strings appear in captured telemetry.

**Acceptance Scenarios**:

1. **Given** no telemetry endpoint is configured (dev pod, CI, tests), **When** the server starts, **Then** startup is not blocked, nothing crashes, and no export-failure noise floods the logs.
2. **Given** a telemetry endpoint is configured but unreachable, **When** the server runs, **Then** the app serves traffic normally; export failures are contained (bounded buffering and drop semantics, at most quiet periodic diagnostics).
3. **Given** operations on documents with known sentinel content (document text, title, search query, chat message), **When** logs, spans, and metrics are captured in tests, **Then** the sentinel strings appear nowhere in any telemetry output, while identifiers (document GUID, user ID, route template) are permitted.
4. **Given** the full backend test suite runs serially, **Then** it passes without a Collector and without new flakiness.

---

### Edge Cases

- **Log call during shim initialization or after logger failure**: logging must never throw into application code; worst case falls back to raw stdout output.
- **Circular/huge objects passed to `console.*`**: serialization must be bounded (depth/size) and non-throwing; the process must not stall serializing a pathological object.
- **Trace context across async boundaries**: log lines emitted from async continuations of a request (timers, promise chains, WebSocket message handlers spawned by a request) carry the correct trace context or none — never a different request's context.
- **Collector endpoint present but slow**: export must be non-blocking with bounded buffering; app latency and memory must not grow with a stalled exporter.
- **Graceful shutdown**: pending telemetry is flushed on SIGTERM within the existing shutdown window; shutdown never hangs waiting on an unreachable Collector.
- **High-frequency collaboration traffic**: manual spans on the sync path must not create per-keystroke span floods; spans are scoped to meaningful sync operations, not individual CRDT update messages whose volume is unbounded.
- **Exception-notifier interplay**: an error that is both logged and emailed must not be double-transformed or suppressed by the shim.
- **429 counter under limiter-store failure**: if the rate limiter's backing store errors, counting must not introduce a new failure mode into the 429 path.
- **Log-injection via user-controlled identifiers**: structured JSON encoding must neutralize newline/control-character injection so a crafted identifier cannot forge log lines.

## Requirements *(mandatory)*

### Functional Requirements

**Tracing**

- **FR-001**: The system MUST initialize vendor-neutral OpenTelemetry tracing and metrics once, at the single server entrypoint, before application modules load, using CommonJS require-hook auto-instrumentation. The server module system remains CommonJS; no ESM migration is proposed or required (Sam-ratified: design doc "Application instrumentation" + plan module-system note, 2026-07-16).
- **FR-002**: Auto-instrumentation MUST cover inbound HTTP, Express routing, PostgreSQL client operations, and Redis (ioredis) operations, producing a single correlated trace per request across those layers.
- **FR-003**: HTTP server span identity MUST use route templates (e.g., `/api/documents/:id`), never concrete URLs containing identifiers or query strings.
- **FR-004**: The system MUST create manual spans for the WebSocket/Yjs collaboration path (Redis pub/sub propagation and markdown sync), scoped to meaningful sync operations (not per CRDT update message), attributed with document GUID and operation type.
- **FR-005**: The system MUST create manual spans for MCP tool invocations, attributed with tool name, agent/user identifier, outcome (success/error), and duration.

**Structured logging**

- **FR-006**: The system MUST provide a central structured logger emitting one JSON object per line to stdout, with at minimum severity, timestamp, and message fields.
- **FR-007**: The system MUST install the logger behind a global `console` shim such that all existing `console.log`/`info`/`warn`/`error`/`debug` call sites (~382) emit structured JSON without any call-site rewrite.
- **FR-008**: Log lines emitted within an active trace context MUST include that context's trace ID and span ID; lines outside any trace context MUST omit the correlation fields, not fabricate them.
- **FR-009**: The logging path MUST be non-throwing: serialization failures, circular references, and oversized payloads degrade to a bounded best-effort representation (Error stacks preserved), never to an exception reaching application code.
- **FR-010**: The existing exception-email notifier MUST remain functionally unchanged as an independent, redundant error channel.

**Metrics**

- **FR-011**: The system MUST record HTTP request metrics sufficient to derive request rate, latency distribution, and 5xx error rate, labeled by route template and status class only.
- **FR-012**: The system MUST increment a rate-limit rejection counter whenever a 429 response is sent, labeled by limiter category; this replaces the currently silent rejection.
- **FR-013**: The system MUST expose PostgreSQL pool gauges (total connections, idle connections, waiting requests) sampled on the standard metric collection interval.

**Export & degradation**

- **FR-014**: All telemetry MUST export via OTLP to an endpoint configured exclusively through the standard OpenTelemetry environment variables (`OTEL_EXPORTER_OTLP_ENDPOINT` and related); no bespoke configuration surface.
- **FR-015**: When no endpoint is configured, the system MUST run with telemetry inert: no crash, no startup block, no repeated export-error log noise, and negligible overhead. Dev pods, CI, and tests run in this mode by default.
- **FR-016**: When an endpoint is configured but unreachable, export failure MUST be contained: bounded buffering with drop semantics, no unbounded memory growth, no added request latency, no crash.
- **FR-017**: On graceful shutdown, the system MUST attempt to flush pending telemetry within a bounded time that fits inside the existing shutdown window, and MUST complete shutdown even if the flush cannot reach the Collector.
- **FR-018**: The only deployment change in this feature is the app Deployment's environment variables pointing the SDK at the Collector (values supplied by feature 013); no other infrastructure or Kubernetes change ships here.

**Privacy invariant (trust-level)**

- **FR-019**: Document content MUST NEVER enter any telemetry signal: no document text, document titles, search query strings, or chat message content in log lines, span names/attributes, or metric labels. Permitted identifiers: document GUIDs, user IDs, agent IDs, route templates, tool names, operation types, status codes, durations, counts. A violation is a trust-invariant break, not a style issue (design doc "Privacy invariant", Sam-ratified 2026-07-16).
- **FR-020**: The privacy invariant MUST be enforced by the instrumentation layer itself (deliberate attribute construction plus a redaction/limiting safeguard on emitted telemetry), not by convention alone, and MUST be covered by automated tests (FR-024).

**Testing**

- **FR-021**: All behavior above MUST be covered by the backend test suite, which runs serially and passes with no Collector present.
- **FR-022**: Tests MUST cover the console shim: JSON output shape, severity mapping, trace-ID correlation presence/absence, non-throwing serialization of hostile inputs (circular, oversized, multi-arg, format strings), and preservation of Error stacks.
- **FR-023**: Tests MUST cover the 429 counter (increments on rate-limit rejection with the correct category label), the PG pool gauges (report plausible values), and span presence for the key paths — an HTTP→PG→Redis request trace, a collaboration sync span, and an MCP tool span — using in-process telemetry capture, no network exporter.
- **FR-024**: Tests MUST assert the privacy invariant: with sentinel document text, title, search query, and chat content flowing through the instrumented paths, captured telemetry (logs, spans, metrics) contains none of the sentinel strings.

### Key Entities

- **Trace / Span**: one trace per logical operation (HTTP request, collaboration sync operation, MCP tool call); spans carry low-cardinality attributes (route template, doc GUID, tool name, outcome) and never content.
- **Structured log line**: JSON record with severity, timestamp, message, and optional trace/span IDs; produced by every `console.*` call via the shim.
- **App metric**: request count/duration by route template + status class; rate-limit rejection counter by limiter category; PG pool gauges (total/idle/waiting).
- **Telemetry endpoint configuration**: standard OTel environment variables on the app Deployment; absence means inert mode.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of app log output is structured JSON (zero unstructured lines from app code paths), with zero of the ~382 existing call sites edited for that purpose.
- **SC-002**: For any single request exercising the database and Redis, an operator can retrieve one correlated trace and every log line that request produced, joined by trace ID — demonstrated end to end during verification.
- **SC-003**: Rate-limit rejections are countable: a synthetic burst past a limit produces a matching increase in the rejection counter (previously: zero visibility).
- **SC-004**: The full backend test suite (run serially) and the production build pass with no Collector configured; server startup in Collector-less mode is not measurably degraded (within normal variance).
- **SC-005**: Privacy sentinel tests pass: zero occurrences of sentinel document text, titles, search queries, or chat content in any captured telemetry across the instrumented paths.
- **SC-006**: With an unreachable endpoint configured, the app serves traffic for a sustained period with flat memory and unchanged request latency.
- **SC-007**: The exception-email channel fires for a synthetic exception exactly as it did before this feature.

## Out of Scope

Owned by feature **013-o11y-platform** (specced in parallel; the design doc is the shared contract):

- The OTel Collector DaemonSet and its configuration (receivers, processors, exporters).
- The dedicated monitoring node, OpenObserve backend, its S3 bucket, TLS/private CA, and ingress rules.
- Dashboards, in-stack alerts, SLOs, and the independent-path CloudWatch/Route 53 alarms.
- All Terraform/IaC and Kubernetes changes **except** the app Deployment environment variables named in FR-018.
- Collection of container logs, host/cluster metrics, datastore-level metrics, and cert-expiry metrics (Collector-side receivers).

Also out of scope for 014:

- Any ESM migration of the server (explicitly rejected; see FR-001).
- Rewriting existing `console.*` call sites to direct logger calls (the shim exists precisely to avoid this; opportunistic rewrites are not part of this feature).
- Frontend/browser instrumentation.
- Sampling-policy tuning beyond a safe default (revisit with real beta traffic data).

## Assumptions

- The interface contract with feature 013 is exactly the standard OTLP environment variables; 014 needs no knowledge of the Collector's internals, and either feature can merge first (014 is inert until the endpoint variables exist).
- Trace context in the WebSocket/Yjs and MCP paths starts fresh traces where no inbound HTTP context exists; cross-service context propagation beyond this app is not required (single-app system).
- The existing graceful-shutdown path (feature 010's SIGTERM handling) is the integration point for telemetry flush; its time budget accommodates a bounded flush attempt.
- Log output continues to go to stdout only; durability/shipping of those lines is the Collector's job (feature 013), not this feature's.
- Default sampling records all traces at beta traffic volume; revisited with data, not pre-optimized.
- See `clarifications-needed.md` for decisions taken as RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16) where the design doc and plan were silent.
