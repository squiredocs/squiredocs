---
description: "Task list for 014-app-instrumentation"
---

# Tasks: Application OpenTelemetry Instrumentation

**Input**: Design documents from `specs/014-app-instrumentation/`

**Prerequisites**: plan.md, research.md, data-model.md, contracts/telemetry-contracts.md, quickstart.md

**Tests**: REQUIRED — the spec mandates them (FR-021..024). The highest-risk change (console shim) is written test-first.

**Organization**: By user story (US1 P1 shim, US2 P2 traces, US3 P2 metrics, US4 P1 invariants).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no incomplete dependency)
- All paths absolute-from-repo-root (`server/…`).

---

## Phase 1: Setup (Shared Infrastructure)

- [X] T001 Add OpenTelemetry + pino dependencies to `package.json` per `research.md` D2 (caret ranges; `@opentelemetry/{api,sdk-node,sdk-trace-base,sdk-metrics,resources,semantic-conventions,instrumentation-http,instrumentation-express,instrumentation-pg,instrumentation-ioredis,exporter-trace-otlp-proto,exporter-metrics-otlp-proto}` + `pino`); run `npm install`, commit lockfile, verify the 0.x experimental packages resolve to a mutually-compatible set.
- [ ] T002 [P] Create in-process capture harness `server/__tests__/helpers/telemetry-capture.js` (`installCapture`/`getSpans`/`getMetrics`/`getLogLines`/`reset` over `InMemorySpanExporter`+`SimpleSpanProcessor`, `InMemoryMetricReader`, pino stream sink) per contract 6 — serial-safe, no network exporter.

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ Blocks ALL user stories — the SDK must start and the privacy safeguard must exist before any signal is emitted.**

- [ ] T003 Create `server/telemetry.js` bootstrap: `start()` (idempotent; registers http/express/pg/ioredis instrumentation require-hooks; builds trace+metric providers **trimodally** — OTLP proto exporters when `OTEL_EXPORTER_OTLP_ENDPOINT` set, injected in-memory in tests, **no processor** when neither), `shutdown()` (bounded force-flush, resolves even if Collector unreachable), `getTracer()`, `getMeter()`; resource from `OTEL_SERVICE_NAME` default `squire-server` (contract 2, research D1/D3/D8).
- [ ] T004 Create `server/telemetry/privacy.js`: permitted-identifier allowlist (data-model), `RedactionSpanProcessor` (drop non-allowlisted attribute keys + truncate on span end; strip `http.target`/`url.full`/query), and a safe-attribute helper shared by manual spans (research D5, FR-019/020).
- [ ] T005 Edit `server/index.js`: require `./telemetry` and call `start()` as the **second** statement (immediately after `require('dotenv').config()`, before every other `require`) so instrumentation hooks + the console shim install before `express`/`pg`/`ioredis`/all app modules load (research D1, FR-001).
- [ ] T006 Edit `server/index.js`: add `telemetry.shutdown` as a guarded step in the `createShutdown({...})` deps/drain so pending telemetry flushes within `SHUTDOWN_DEADLINE_MS` and shutdown completes regardless (FR-017).

**Checkpoint**: SDK boots inert with no Collector; redaction processor active. User stories can begin.

---

## Phase 3: User Story 1 — Correlated structured logs (Priority: P1) 🎯 MVP

**Goal**: Every `console.*` line becomes trace-correlated JSON with zero call-site edits.

**Independent Test**: Start server, hit an endpoint, stdout lines are JSON with `trace_id`/`span_id` inside requests; hostile inputs never throw; the ~382 sites are unchanged.

- [ ] T007 [P] [US1] Write `server/__tests__/telemetry-console-shim.test.js` FIRST (must fail): JSON shape, severity mapping, correlation present in-span / absent out-of-span (RBD-5), non-throwing serialization of circular/oversized/multi-arg/format-string/Error inputs, Error-stack preservation (FR-022).
- [ ] T008 [US1] Create `server/logger.js`: single pino JSON logger to stdout + non-throwing `console.log/info/warn/error/debug` shim (variadic/`util.format` semantics, bounded depth/size, `trace_id`/`span_id` from active OTel context when recording, fallback to raw stdout write on any failure) (FR-006/007/008/009).
- [ ] T009 [US1] Install the shim from `telemetry.start()` (before app modules log); verify the exception notifier's email path is untouched — the shim only serializes its `console.*` lines, never intercepts `notifyException` (FR-010, edge case). Confirm T007 passes.

**Checkpoint**: US1 independently functional — MVP.

---

## Phase 4: User Story 2 — Distributed traces (Priority: P2)

**Goal**: One correlated trace per request (HTTP→PG→Redis) plus manual op-level spans for collab and MCP.

**Independent Test**: In-memory capture shows a server span with child pg/ioredis spans (route-template identity), a collab sync span, and an MCP tool span.

- [ ] T010 [P] [US2] Write `server/__tests__/telemetry-traces.test.js` FIRST (must fail): HTTP→PG→Redis single-trace assertion, collab span with `document.guid`, MCP span with `mcp.tool.name`/`outcome`/duration (FR-023).
- [ ] T011 [US2] Create `server/telemetry/spans.js` `withSpan(name, attributes, fn)` helper (allowlist-filtered attrs, records `outcome`+duration, ends span, non-throwing wrapper) (contract 3).
- [ ] T012 [US2] Configure http instrumentation for route-template span identity in `server/telemetry.js`; ensure redaction strips concrete URL/query (FR-003).
- [ ] T013 [P] [US2] Add op-level manual spans in `server/redis-pubsub.js` around publish/propagate (`collab.operation`, `document.guid`) — never per CRDT message (RBD-1, FR-004).
- [ ] T014 [P] [US2] Add a manual span in `server/markdown-sync.js` around a sync run (`collab.operation`, `document.guid`) (FR-004).
- [ ] T015 [P] [US2] Add a manual span in `server/mcp/tools/index.js` `executeTool()` (`mcp.tool.name`, `agent.id`/`user.id`, `outcome`, duration) — never tool args/results (RBD-9, FR-005). Confirm T010 passes.

**Checkpoint**: US1 + US2 both work independently.

---

## Phase 5: User Story 3 — App metrics (Priority: P2)

**Goal**: HTTP golden signals, the 429 rejection counter, and PG pool gauges.

**Independent Test**: Capture shows request count/duration by `(http.route, http.status_class)`; a rate-limit burst increments `ratelimit.rejections{category}`; pool gauges report plausible total/idle/waiting.

- [ ] T016 [P] [US3] Write `server/__tests__/telemetry-metrics.test.js` FIRST (must fail): request metrics, 429 counter increment with correct category label, pool gauge values (FR-023).
- [ ] T017 [US3] Create `server/telemetry/metrics.js`: `httpMetricsMiddleware()` (count+duration histogram by route template + status class), `recordRateLimitRejection(category)` (never throws into the 429 path), `init({getPool})` (register observable pool gauges) (contract 4, FR-011/012/013).
- [ ] T018 [US3] Edit `server/index.js`: mount `httpMetricsMiddleware()` early in the middleware chain and call `metrics.init({ getPool: () => persistenceProvider.getPool() })`.
- [ ] T019 [US3] Edit `server/rate-limit.js`: call `recordRateLimitRejection(className)` at both 429 emit points (`reject429` path and `registrationAdmissionMiddleware`) (FR-012).
- [ ] T020 [US3] Edit `server/postgres-persistence.js` only if needed to expose live pool counts via `getPool()` for the gauges. Confirm T016 passes.

**Checkpoint**: US1 + US2 + US3 all work independently.

---

## Phase 6: User Story 4 — Safe by default: no Collector, no content (Priority: P1)

**Goal**: Machine-checked inertness (Collector-less) and the privacy invariant across all signals.

**Independent Test**: Full suite green with no Collector; sentinel content never appears in any captured log/span/metric.

- [ ] T021 [P] [US4] Write `server/__tests__/telemetry-inert.test.js`: with no endpoint configured, `start()`/emit/`shutdown()` never crash, no export attempts, no repeated error noise; startup path unblocked (FR-015/021).
- [ ] T022 [P] [US4] Write `server/__tests__/telemetry-privacy.test.js`: flow sentinel document text, title, search query, and chat content through the instrumented paths; assert zero sentinel occurrences in captured logs/spans/metrics; assert permitted identifiers (doc GUID, user id, route template) ARE present (FR-024/SC-005).
- [ ] T023 [US4] If T022 exposes any leak path, harden `server/telemetry/privacy.js` (allowlist/redaction) and/or the offending attribute construction until sentinels are clean. Confirm T021+T022 pass.

**Checkpoint**: All four stories independently functional; invariants proven.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T024 Record the resolved OTel experimental version set + lockfile snapshot in `research.md`/`promotion-notes.md` (D2 caveat closure).
- [ ] T025 [P] Record the owed README.md + docs/dev.md update (new observability behavior + `OTEL_*` env catalog) for the implement/converge phase — this PLAN/implement track must not silently skip Principle I; the edit itself is deferred by pipeline override.
- [ ] T026 Run quickstart validation: `npm test` (serial, no Collector) + `npm run build` green; confirm `git diff` touches only `server/`, `server/__tests__/`, and `package.json`/lockfile.

---

## Dependencies & Execution Order

- **Setup (P1)** → no deps.
- **Foundational (P2)** → depends on Setup; **blocks all stories** (T003 bootstrap + T004 privacy + T005/T006 wiring).
- **US1 (Phase 3, P1)** → after Foundational. MVP.
- **US2 (Phase 4, P2)** & **US3 (Phase 5, P2)** → after Foundational; independent of US1 and of each other (different files).
- **US4 (Phase 6, P1)** → privacy test (T022) needs US1+US2+US3 surfaces present to flow sentinels through all signals; inert test (T021) needs only Foundational.
- **Polish (Phase 7)** → after all desired stories.

### Within each story

- Test task written first and must FAIL before implementation.
- Bootstrap/provider (foundational) before helpers before call-site edits.

### Parallel opportunities

- T002 ∥ T001 setup.
- Test-first files across stories (T007, T010, T016, T021, T022) are all `[P]` (distinct files).
- Manual-span call-site edits T013 ∥ T014 ∥ T015 (distinct files).
- After Foundational, US2 and US3 can proceed in parallel.

---

## Parallel Example

```bash
# After Foundational, launch the three story test files together:
Task: "Write telemetry-console-shim.test.js (US1)"
Task: "Write telemetry-traces.test.js (US2)"
Task: "Write telemetry-metrics.test.js (US3)"

# US2 manual-span edits in parallel (distinct files):
Task: "Manual span in server/redis-pubsub.js"
Task: "Manual span in server/markdown-sync.js"
Task: "Manual span in server/mcp/tools/index.js"
```

---

## Implementation Strategy

- **MVP** = Setup + Foundational + US1 (the console shim — highest blast radius, proven first).
- **Incremental**: add US2 (traces) → US3 (metrics) → US4 (invariant proofs), each independently testable.
- Backend tests run serially (`jest --runInBand`); verify each story's tests fail before implementing.

## Notes

- Only `server/` + `server/__tests__/` + `package.json`/lockfile change. The app Deployment OTel env vars (FR-018) are declared in `contracts/telemetry-contracts.md` for ops/013 to apply — not edited here.
- No migration, no format-registry change, no client code.
