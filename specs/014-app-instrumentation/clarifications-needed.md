# Clarifications Ledger — 014-app-instrumentation

Decisions the design doc (`design/observability-and-telemetry.md`) and the approved plan
(`declarative-tumbling-turtle`) did not answer were taken with the best default and recorded
here as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)** per Constitution Principle VI.
Decisions the doc/plan already made are Sam-ratified 2026-07-16 and are cited in the spec, not
re-decided (SDK choice, CJS-stays, pino-behind-console-shim, metric list, OTLP env config,
privacy invariant, Jest serial testing, 013/014 scope split, exception notifier kept).

---

## RBD-1: Span granularity on the collaboration path

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Question**: The design doc requires "manual spans" on the WebSocket/Yjs path
  (`server/redis-pubsub.js`, `server/markdown-sync.js`) but not at what granularity. Per
  CRDT update message would trace every keystroke.
- **Decision**: Spans cover meaningful sync operations (e.g., a pub/sub propagation, a
  markdown-sync run), not individual CRDT update messages (spec FR-004, edge case
  "High-frequency collaboration traffic").
- **Why this default**: Per-keystroke spans give unbounded span volume during active
  collaboration — cost and noise with no diagnostic value; operation-level spans answer the
  actual question ("is sync slow/failing for this doc").

## RBD-2: Trace sampling default

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Question**: Neither doc nor plan states a sampling policy.
- **Decision**: Record all traces at beta traffic volume; tuning is explicitly out of scope
  until real data exists (spec Assumptions, Out of Scope).
- **Why this default**: Beta traffic is tiny; full sampling maximizes the diagnostic value the
  feature exists to provide, and the design doc's cost knob is S3 lifecycle, not sampling.

## RBD-3: Metric label taxonomy

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Question**: The doc names the metric families (request rate/latency/5xx, 429 counter, PG
  pool gauges) but not their labels.
- **Decision**: Request metrics labeled by route template + status class; 429 counter labeled
  by limiter category (API vs. registration admission, matching `server/rate-limit.js`'s two
  paths); pool gauges labeled total/idle/waiting. No other labels (spec FR-011..013).
- **Why this default**: Lowest-cardinality set that still supports the design doc's
  golden-signal dashboards; anything higher-cardinality risks both cost and the privacy
  invariant.

## RBD-4: Unreachable-endpoint degradation semantics

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Question**: "Degrade gracefully" is required, but the concrete semantics when an endpoint
  is configured yet unreachable are unstated.
- **Decision**: Bounded buffering with drop semantics, no added request latency, no unbounded
  memory, at most quiet periodic diagnostics; graceful shutdown attempts a bounded flush and
  completes regardless (spec FR-016, FR-017, SC-006).
- **Why this default**: Telemetry must never take down or slow the thing it observes; matches
  standard OTel batch-exporter behavior, so no bespoke machinery.

## RBD-5: Log lines outside a trace context

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Question**: What correlation fields do startup/background log lines carry?
- **Decision**: Omit trace/span fields entirely rather than fabricating placeholder IDs
  (spec FR-008).
- **Why this default**: Fabricated IDs poison trace-join queries; absence is truthful and
  queryable ("uncorrelated lines").

## RBD-6: Privacy-invariant test method

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Question**: The doc mandates the invariant and that the instrumentation layer enforces it,
  but not how to make it testable.
- **Decision**: Sentinel-content tests: flow known sentinel strings through document text,
  title, search, and chat paths; assert zero occurrences in captured logs/spans/metrics.
  Enforcement is deliberate attribute construction plus a redaction/limiting safeguard, not
  convention (spec FR-020, FR-024, SC-005).
- **Why this default**: Sentinel assertion is the strongest black-box check available without
  enumerating every attribute; it fails loudly on any future leak path.

## RBD-7: Test-time telemetry capture

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Question**: How do tests observe spans/metrics with no Collector present?
- **Decision**: In-process capture (in-memory span/metric readers); no network exporter in
  tests (spec FR-023, FR-021).
- **Why this default**: Keeps the serial Jest suite hermetic and Collector-free, per the
  plan's testing constraint.

## RBD-8: No opportunistic console.* rewrites

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Question**: Should any of the ~382 call sites be migrated to direct logger calls while
  we're in there?
- **Decision**: No — the shim is the whole point; call-site rewrites are out of scope
  (spec Out of Scope).
- **Why this default**: Minimizes diff/risk in a change that already sits under every log
  call; rewrites add review surface with zero behavioral gain.

## RBD-9: MCP span attribution set

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Question**: The doc says "manual spans for the MCP subsystem" without naming attributes.
- **Decision**: Tool name, agent/user identifier, outcome (success/error), duration — never
  tool arguments or results, which can carry document content (spec FR-005, FR-019).
- **Why this default**: Tool args/results are the most likely MCP-side privacy-leak vector;
  the named set answers the operational questions (which tools, how often, failing for whom).

---

---

## PLAN-phase decisions (2026-07-16)

Implementation-level defaults taken during planning where the design doc/plan were silent. Recorded per Principle VI. Details in `research.md` (D1–D8) and `plan.md`.

## RBD-10: OTLP transport = HTTP/protobuf (port 4318)

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Decision**: Export via OTLP **http/protobuf** using `exporter-*-otlp-proto`, honoring `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_PROTOCOL`.
- **Why**: Avoids a native gRPC dependency; standard, robust, env-driven. gRPC gains nothing at beta volume. Backend stays swappable (design-doc invariant).

## RBD-11: Individual instrumentation packages, not the umbrella

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Decision**: Install `instrumentation-{http,express,pg,ioredis}` individually rather than `auto-instrumentations-node`.
- **Why**: Explicit, minimal require-hook set and dependency surface — a security-review-friendly choice for a dep-gating repo (Principle V). The umbrella pulls ~40 mostly-disabled instrumentations.

## RBD-12: 013/014 env-var seam ownership (resolves OBS-1)

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Decision**: 014 consumes `process.env` OTel vars only; it declares the app-Deployment env block in `contracts/telemetry-contracts.md` but does **not** apply any k8s YAML. Whoever owns the Deployment patch (013/ops) applies it. Merge order remains free (014 inert until vars exist).
- **Why**: Honors the pipeline override (nothing outside `server/`+tests+`package.json`) and the FR-018 scope line; avoids a collision with the parallel 013 agent.

---

## IMPLEMENT-phase decisions (2026-07-16)

## RBD-13: Providers built directly, not via NodeSDK

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)
- **Question**: The plan/research (D3) named `@opentelemetry/sdk-node`'s `NodeSDK`
  as the bootstrap orchestrator. During implementation, NodeSDK's span export was
  found NOT to function under jest's runtime (a directly-constructed provider
  exports reliably; the NodeSDK-wrapped `NodeTracerProvider` drops spans in-process
  under jest), which would have made the in-process capture tests (FR-023/024)
  impossible.
- **Decision**: `server/telemetry.js` builds the providers DIRECTLY from the same
  packages — `BasicTracerProvider` + explicit span processors,
  `MeterProvider` + reader, `AsyncLocalStorageContextManager`, and
  `registerInstrumentations({...})` for the four require-hook instrumentations —
  instead of `new NodeSDK({...})`. Behavior is otherwise identical: same building
  blocks, same trimodal export, same auto-instrumentation, same require-ordering
  guarantee (start() before app modules). Proven both in a standalone process
  (real HTTP→PG→Redis single trace) and under jest (in-process capture).
- **Why this default**: It is the only way to satisfy the mandated in-process
  capture tests while keeping full trimodal control and preserving the exact
  prod behavior; it also removes a layer (NodeSDK's env auto-config) that was the
  source of the inertness landmine. `@opentelemetry/context-async-hooks` and
  `@opentelemetry/instrumentation` were added as explicit direct deps (they were
  already transitive). `sdk-node` is retained in `package.json` (harmless; keeps
  the version-aligned set) but no longer required by app code.

---

## POST-MERGE REVIEW decisions (2026-07-16)

## RBD-14: Error-path scrub = DROP message/stack entirely (not truncate)

- **Status**: RATIFIED by Sam 2026-07-16 (upgraded from RATIFIED-BY-DEFAULT; this
  hardens the privacy invariant's default; see
  promotion-notes HIGH-1).
- **Question**: Post-merge review (HIGH-1) proved the privacy backstop swept only
  `span.attributes`, so error text could still escape through two channels the
  design doc's invariant covers: `span.status.message` (instrumentation-pg sets it
  to the raw PG error, which embeds user-supplied values) and `exception` span
  events (`recordException` from ioredis/express/MCP — MCP modify errors quote
  document text by design). Should the backstop TRUNCATE these to a bounded length,
  or DROP them entirely?
- **Decision**: DROP entirely — strict default. `RedactionSpanProcessor.onEnd` now
  clears `span.status.message` (keeping `status.code=ERROR`), and reduces every
  `exception` event to `exception.type` alone, dropping `exception.message` and
  `exception.stacktrace`. `withSpan`'s own error path likewise records only the
  error CLASS (`exception.type`) — never message or stack. Non-exception event
  attributes are allowlist-filtered.
- **Why this default**: Truncation still exports a prefix of user content — for a
  PG error like `duplicate key ... Detail: Key=(<user value>)` the leaked bytes sit
  right where truncation keeps them. There is no reliable way to extract "just the
  error class" from a free-form upstream message string, so the only invariant-safe
  choice is to drop the message and preserve the content-free `exception.type` /
  `status.code` for triage and error-rate dashboards. Consistent with RBD-9 (never
  export tool args/results) and the design doc's trust-level invariant.

---

## Notes / observations for downstream phases

- **OBS-1**: At spec time (2026-07-16), `specs/013-o11y-platform/` existed but was empty —
  the parallel SPEC agent had not landed its artifacts. The 013/014 seam in this spec is
  drawn strictly from the design doc and the approved plan: 014 owns everything in
  `server/` plus the app Deployment's OTel env vars; 013 owns the Collector and everything
  beyond it. If 013's spec draws the env-var line differently, reconcile at plan time.
- **OBS-2**: The `~382 console.* call sites` figure was re-verified against the codebase at
  spec time (grep over `server/`, excluding tests): exactly 382.
