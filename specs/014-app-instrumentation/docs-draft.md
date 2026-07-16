# Docs draft — 014-app-instrumentation (T025, Principle I)

This feature changes observable behavior (structured JSON logs + optional OTLP
export), so README.md + docs/dev.md are owed an update. The IMPLEMENT agent is
barred from editing README.md / docs/dev.md (pipeline override) — the merge
queue / converge step should fold the content below into those files.

---

## For README.md — add an "Observability & Telemetry" subsection

> ### Observability & Telemetry
>
> The server is instrumented with vendor-neutral **OpenTelemetry** (feature 014):
>
> - **Structured logs**: every `console.*` call emits one line of JSON to stdout
>   (`{ level, time, msg, … }`). Lines emitted inside an HTTP request also carry
>   `trace_id` / `span_id` for correlation. No existing log call site was rewritten
>   — a non-throwing `console` shim (pino) does this globally.
> - **Traces**: HTTP → Express → PostgreSQL → Redis are auto-instrumented into one
>   correlated trace per request (route templates as the low-cardinality identity,
>   never concrete URLs). Manual operation-level spans cover the Yjs collaboration
>   path (Redis pub/sub, markdown sync) and MCP tool execution.
> - **Metrics**: HTTP request rate / latency / 5xx (by route template + status
>   class), a rate-limit rejection (429) counter (by limiter category), and
>   PostgreSQL pool gauges (total / idle / waiting).
> - **Export**: all telemetry ships via **OTLP http/protobuf** to the endpoint in
>   `OTEL_EXPORTER_OTLP_ENDPOINT` when set. With no endpoint configured the whole
>   stack is **inert** — no exporter, no crash, no startup delay, no log noise —
>   so dev, CI, and the test suite run unchanged with no Collector.
> - **Privacy invariant**: document content (text, titles, search queries, chat
>   content) NEVER enters any log field the instrumentation adds, span attribute,
>   or metric label. Enforced by an allowlist plus a redaction span processor and
>   proven by sentinel-content tests.
>
> The Collector and observability backend are feature 013.

---

## For docs/dev.md — add an "OTEL_* environment variables" entry to the env catalog

> #### Telemetry (OpenTelemetry — feature 014)
>
> All telemetry is off by default; the app is fully inert with none of these set.
>
> | Var | Default | Effect |
> |---|---|---|
> | `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset) | Collector OTLP base URL. **Unset ⇒ inert** (no export, no noise). |
> | `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | OTLP transport (http/protobuf only; no gRPC dep). |
> | `OTEL_EXPORTER_OTLP_HEADERS` | (none) | Optional auth/tenant headers for the Collector. |
> | `OTEL_SERVICE_NAME` | `squire-server` | `service.name` resource attribute. |
> | `OTEL_RESOURCE_ATTRIBUTES` | (none) | Extra resource attributes (e.g. `deployment.environment=prod`). |
>
> Local dev needs no Collector: leave `OTEL_EXPORTER_OTLP_ENDPOINT` unset and the
> server logs structured JSON to stdout while everything else is inert. Backend
> tests run Collector-less by design.
>
> **Note on the console shim**: `console.log/info/warn/error/debug` are replaced
> process-wide by a non-throwing JSON logger. Local terminal output is now JSON
> lines rather than plain text; pipe through `pino-pretty` if you want a
> human-readable dev view (not a dependency — install ad hoc).

---

## Note for the converge/merge step

- Place the app-Deployment OTel env block from `deployment-env-snippet.yaml`
  (FR-018 / RBD-12) — this feature does not edit k8s YAML.
- No migration, no format-registry change, no client change.
