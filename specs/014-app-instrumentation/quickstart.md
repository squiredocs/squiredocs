# Quickstart / Validation Guide — 014-app-instrumentation

Runnable checks that prove the feature works end to end. All run in the dev pod with **no Collector** (inert mode) except where an endpoint is noted. Backend tests are serial.

## Prerequisites

- Dev pod up (`docs/dev.md`); deps installed (`npm install` after the `package.json` change).
- No `OTEL_EXPORTER_OTLP_ENDPOINT` set ⇒ inert mode (the default dev/CI/test state).

## 1. Collector-less inertness (US4 / FR-015, SC-004)

```bash
# Server starts, serves, no export noise, no startup block:
npm run build            # stays green
npm test                 # full backend suite, serial, green with no Collector
```
Expected: build + suite pass; server logs show no OTLP/export errors.

## 2. Structured logs + trace correlation (US1 / SC-001, SC-002)

- Start the server, hit any endpoint, inspect stdout: every line is valid JSON with `level`, `time`, `msg`.
- A line emitted inside a request carries `trace_id` + `span_id`; a startup line does not (RBD-5).
- Verify no `console.*` call site was edited: `git diff --stat` shows the ~382 sites unchanged.

Automated: `telemetry-console-shim.test.js` asserts JSON shape, severity mapping, correlation presence/absence, non-throwing serialization of circular/oversized/multi-arg/format-string/Error inputs, and stack preservation.

## 3. Traces across HTTP→PG→Redis + collab + MCP (US2 / SC-002)

Automated (`telemetry-traces.test.js`, in-memory capture): one request touching DB + Redis yields one trace with server span + child pg/ioredis spans, route-template identity; a collab propagation yields an op-level span with `document.guid`; an MCP `executeTool` yields a span with `mcp.tool.name`/`outcome`/duration.

## 4. Metrics: request signals, 429 counter, PG pool gauges (US3 / SC-003)

Automated (`telemetry-metrics.test.js`): request count/duration recorded by `(http.route, http.status_class)`; a burst past a rate limit increments `ratelimit.rejections{category}`; pool gauges report plausible `total/idle/waiting`.

Manual: `RL_TEST_ENABLE=1` + a synthetic burst → counter increments (previously zero visibility).

## 5. Privacy sentinels (US4 / FR-024, SC-005)

Automated (`telemetry-privacy.test.js`): flow sentinel strings through document text, title, search query, and chat content; assert **zero** occurrences in any captured span/metric/log; assert permitted identifiers (doc GUID, user id, route template) are present.

## 6. Exception notifier unchanged (SC-007)

Automated: existing `exception-notifier.test.js` stays green; a synthetic exception still emails.

## 7. Endpoint-configured degradation (SC-006) — verification-only

With `OTEL_EXPORTER_OTLP_ENDPOINT` pointed at an unreachable host: app serves traffic, memory flat, latency unchanged, at most quiet periodic diagnostics; SIGTERM drains within `SHUTDOWN_DEADLINE_MS`.

## Gate before merge

- [ ] `npm test` (serial) green, no Collector
- [ ] `npm run build` green
- [ ] All five new telemetry test files pass
- [ ] `git diff` touches only `server/`, `server/__tests__/`, and `package.json`/lockfile
- [ ] README.md + docs/dev.md doc-update task recorded for implement/converge (Principle I)
