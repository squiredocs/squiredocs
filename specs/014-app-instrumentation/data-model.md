# Phase 1 Data Model — 014-app-instrumentation

This feature adds no persistent entities and no database schema (no migration). The "entities" are the in-memory telemetry signal shapes and their attribute contracts. The permitted-identifier allowlist below is the load-bearing artifact for the privacy invariant (FR-019/020).

## Permitted-identifier allowlist (privacy invariant)

The **only** attribute/label values allowed in any signal. Anything not on this list is dropped by the redaction safeguard.

| Key (canonical) | Example | Signals |
|---|---|---|
| `document.guid` | `doc_a1b2…` (GUID) | collab spans |
| `user.id` | numeric/opaque user id | MCP span, (log context) |
| `agent.id` | agent/token principal id | MCP span |
| `http.route` (route template) | `/api/documents/:id` | HTTP span, request metrics |
| `http.status_class` | `2xx`/`4xx`/`5xx` | request metrics |
| `http.status_code` | `429` | HTTP span |
| `mcp.tool.name` | `modify` | MCP span, MCP metrics |
| `sync.operation` / `collab.operation` | `pubsub.update`, `markdown.sync` | collab spans |
| `ratelimit.category` | `auth`,`chat`,`search` (`register` removed 2026-07-18 — sign-up unlimited, no `register` 429; see 010 promotion-notes §8) | 429 counter |
| `outcome` | `success`/`error` | MCP span |
| durations / counts (numeric) | ms, n | all |

**Explicitly forbidden anywhere**: document text, document titles, search query strings, chat message content, tool arguments, tool results, concrete URLs/query strings, request/response bodies, headers.

## Signal: Trace / Span

- **HTTP server span** (auto): identity = route template (FR-003); child spans for pg + ioredis auto-instrumented. Redaction strips `http.target`/`url.full`/query.
- **Collaboration span** (manual, op-level — RBD-1): one per propagation/sync operation on `redis-pubsub.js` (publish/propagate) and `markdown-sync.js` (sync run). Attributes: `document.guid`, `collab.operation`. Never per CRDT message.
- **MCP tool span** (manual): one per `executeTool()` in `mcp/tools/index.js`. Attributes: `mcp.tool.name`, `agent.id`/`user.id`, `outcome`, duration. Never args/results (RBD-9).
- **Context**: collab + MCP paths start fresh root spans (no inbound HTTP context — spec Assumptions). No cross-service propagation (single app).

## Signal: Structured log line

- One JSON object per line to stdout. Fields: `level`/`severity`, `time`/`timestamp`, `msg`/`message`, plus `trace_id`+`span_id` when emitted inside a recording span (omitted otherwise — RBD-5). Error objects contribute name/message/stack.
- Produced by every `console.log/info/warn/error/debug` via the shim; call sites unchanged (FR-007/SC-001).
- Non-throwing; bounded depth/size; injection-safe by JSON encoding (FR-009).

## Signal: App metric

| Metric | Instrument | Labels | Source |
|---|---|---|---|
| `http.server.request.count` | counter | `http.route`, `http.status_class` | http metrics middleware |
| `http.server.request.duration` | histogram (ms) | `http.route`, `http.status_class` | http metrics middleware |
| `ratelimit.rejections` | counter | `ratelimit.category` | `rate-limit.js` (both 429 points) |
| `db.pool.connections.total` | observable gauge | — | `pool.totalCount` |
| `db.pool.connections.idle` | observable gauge | — | `pool.idleCount` |
| `db.pool.connections.waiting` | observable gauge | — | `pool.waitingCount` |

(Metric names are indicative; final names follow OTel semconv where one exists, otherwise the app-namespaced form above. Label taxonomy is fixed by RBD-3 — no other labels.)

## Config: Telemetry endpoint

- Standard OTel env vars only (FR-014): `OTEL_EXPORTER_OTLP_ENDPOINT` (+ `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, headers). Absence ⇒ inert mode (FR-015). No bespoke config surface.
- Applied to the process by the app Deployment (FR-018) — declared for ops/013 in `contracts/telemetry-contracts.md`, not edited by this feature.
