# Telemetry Contracts — 014-app-instrumentation

The interfaces this feature exposes. Three consumers: the OTel Collector (feature 013), the operator reading signals, and the test harness.

## Contract 1 — OTLP export configuration (with feature 013)

The entire contract with 013 is the **standard OpenTelemetry environment variables** on the app Deployment (FR-014/FR-018). 014 has no knowledge of the Collector internals; 013 (or ops) supplies the values.

| Env var | Purpose | 014 behavior when unset |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector OTLP base URL | **inert** — no exporter, no export attempts, no error noise |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default) | default http/protobuf |
| `OTEL_EXPORTER_OTLP_HEADERS` | auth/tenant headers | none |
| `OTEL_SERVICE_NAME` | resource `service.name` | `squire-server` default |
| `OTEL_RESOURCE_ATTRIBUTES` | extra resource attrs | none |

**Deployment env-var block (declared here for ops/013 to apply — NOT edited by this feature):**

```yaml
# app Deployment container env (feature 013 / ops applies this; FR-018)
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: "http://<collector-service>:4318"
- name: OTEL_EXPORTER_OTLP_PROTOCOL
  value: "http/protobuf"
- name: OTEL_SERVICE_NAME
  value: "squire-server"
```

- **Merge order is free**: 014 is inert until these exist; 013 can land first, second, or concurrently.
- **Seam reconciliation (OBS-1)**: if 013's spec draws the env-var line differently (e.g. names the Deployment patch as 013's), defer to 013 for *who applies the YAML*; 014 only consumes `process.env`.

## Contract 2 — Bootstrap API (`server/telemetry.js`)

```text
start()            // idempotent; registers instrumentation require-hooks +
                   // installs console shim + builds providers per mode
                   // (OTLP | in-memory[test] | inert). Call FIRST in index.js.
shutdown()         // force-flush + provider shutdown, bounded, resolves even
                   // if Collector unreachable. Wired into createShutdown drain.
getTracer(name)    // named tracer for manual spans
getMeter(name)     // named meter for app metrics
```

## Contract 3 — Manual span helper (`server/telemetry/spans.js`)

```text
withSpan(name, attributes, fn)  // starts a span with allowlisted attributes,
                                // records outcome=success|error + duration,
                                // ends span; never throws into fn's caller
                                // beyond fn's own errors. Attributes filtered
                                // to the permitted-identifier allowlist.
```

Used by `redis-pubsub.js` (op-level collab spans), `markdown-sync.js` (sync run), `mcp/tools/index.js` (`executeTool`).

## Contract 4 — Metrics API (`server/telemetry/metrics.js`)

```text
init({ getPool })              // registers PG pool observable gauges reading
                               // getPool().{totalCount,idleCount,waitingCount}
httpMetricsMiddleware()        // Express middleware: records request count +
                               // duration by (http.route, http.status_class)
recordRateLimitRejection(cat)  // increments ratelimit.rejections{category=cat};
                               // never throws into the 429 path (edge case)
```

`rate-limit.js` calls `recordRateLimitRejection(className)` at its 429 emit point (`reject429`). _(**Superseded 2026-07-18:** the second emit point, `registrationAdmissionMiddleware`, no longer exists — the registration admission caps were removed and sign-up is now unlimited, so there is no `register`-category 429 to count. See feature 010 `promotion-notes.md` §8. `reject429` still counts every remaining category: auth, token, search, import, export, chat, upload.)_

## Contract 5 — Console shim (`server/logger.js`)

- Replaces `console.log/info/warn/error/debug` process-wide with JSON emitters. No call-site change (FR-007).
- **Output shape**: `{ level, time, msg, [trace_id], [span_id], ...fields }` — one line, valid JSON.
- **Guarantees**: non-throwing (FR-009), Error stacks preserved, bounded depth/size, trace correlation present iff inside a recording span (FR-008/RBD-5), injection-safe.
- **Non-goals**: does not alter the exception notifier's email path (FR-010); does not rewrite call sites (RBD-8).

## Contract 6 — Test capture harness (`server/__tests__/helpers/telemetry-capture.js`)

```text
installCapture()   // starts SDK with InMemorySpanExporter (SimpleSpanProcessor)
                   // + InMemoryMetricReader + pino stream sink
getSpans() / getMetrics() / getLogLines()
reset()            // clears buffers between tests (serial-safe)
```

No network exporter; hermetic under `jest --runInBand` (RBD-7).
