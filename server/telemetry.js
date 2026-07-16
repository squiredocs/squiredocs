/**
 * OpenTelemetry bootstrap (feature 014, research D1/D3/D8, contract 2).
 *
 * The single spine of app instrumentation. `start()` is required as the SECOND
 * statement of `server/index.js` (immediately after `require('dotenv').config()`
 * and before every other require) so the CJS require-hook auto-instrumentation
 * patches `http`/`express`/`pg`/`ioredis` — and the console shim installs —
 * BEFORE any application module loads (FR-001).
 *
 * TRIMODAL export (research D3):
 *   • test    — injected in-memory exporter/reader (via the capture harness).
 *   • OTLP    — `OTEL_EXPORTER_OTLP_ENDPOINT` set → OTLP http/protobuf exporters
 *               (BatchSpanProcessor gives bounded buffering + drop semantics for
 *               an unreachable endpoint — FR-016).
 *   • inert   — neither → redaction-only span pipeline, NO exporter, NO metric
 *               reader: spans record (so trace context + log correlation still
 *               work) but are never exported; zero network, zero error noise
 *               (FR-015). The app starts and the full serial test suite passes
 *               with no Collector.
 *
 * IMPORTANT (inertness landmine): NodeSDK, given no span processors, falls back
 * to `getSpanProcessorsFromEnv()` which DEFAULTS to an OTLP exporter at
 * localhost:4318 — i.e. NOT inert. So we ALWAYS pass an explicit `spanProcessors`
 * array (redaction-only in inert mode) to keep full control of export behavior.
 *
 * The server is and stays CommonJS.
 */
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');
const { BatchSpanProcessor, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
const { IORedisInstrumentation } = require('@opentelemetry/instrumentation-ioredis');
const api = require('@opentelemetry/api');

const { RedactionSpanProcessor } = require('./telemetry/privacy');
const logger = require('./logger');

const TRACER_NAME = 'squire-server';
const METER_NAME = 'squire-server';

let sdk = null;
let started = false;
let mode = 'uninitialized';

/** Build the resource with a stable, env-overridable service.name. */
function buildResource() {
  return new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'squire-server',
  });
}

/** The four explicit instrumentations (no umbrella package — RBD-11). */
function buildInstrumentations() {
  return [
    new HttpInstrumentation(),
    // Express spans carry the resolved route TEMPLATE onto the http span, which
    // is what gives us low-cardinality route identity (FR-003). The concrete
    // URL/query is stripped by the RedactionSpanProcessor.
    new ExpressInstrumentation(),
    // Never enable enhancedDatabaseReporting — that would attach query parameters
    // (potential document content) to db.statement. Off by default; kept off.
    new PgInstrumentation(),
    new IORedisInstrumentation(),
  ];
}

/**
 * Initialize the SDK. Idempotent — the first call wins; later calls (e.g.
 * index.js after the test harness already started it) are no-ops.
 *
 * @param {object} [opts]
 * @param {object} [opts.spanExporter] - test-injected span exporter (in-memory).
 * @param {object} [opts.metricReader] - test-injected metric reader (in-memory).
 * @returns {{ mode: string }}
 */
function start(opts = {}) {
  if (started) return { mode };

  // Install the non-throwing console shim FIRST so every subsequent app-module
  // log line is structured JSON correlated to its trace (FR-006/007). This is
  // independent of export mode — logging always works, Collector or not.
  try {
    logger.installConsoleShim();
  } catch {
    /* logging must never take the process down */
  }

  const resource = buildResource();
  const instrumentations = buildInstrumentations();
  const redaction = new RedactionSpanProcessor();

  let spanProcessors;
  let metricReader;

  if (opts.spanExporter || opts.metricReader) {
    // ── test mode: in-memory capture, no network ──────────────────────────
    mode = 'test';
    spanProcessors = [redaction];
    if (opts.spanExporter) spanProcessors.push(new SimpleSpanProcessor(opts.spanExporter));
    metricReader = opts.metricReader;
  } else if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    // ── OTLP mode: export over http/protobuf (RBD-10) ─────────────────────
    mode = 'otlp';
    // Required lazily so a missing/omitted exporter dep never breaks inert/test.
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
    const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
    spanProcessors = [redaction, new BatchSpanProcessor(new OTLPTraceExporter())];
    metricReader = new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() });
  } else {
    // ── inert mode: redaction-only pipeline, no exporter, no reader ────────
    mode = 'inert';
    spanProcessors = [redaction];
    metricReader = undefined;
  }

  const config = { resource, instrumentations, spanProcessors };
  if (metricReader) config.metricReader = metricReader;

  sdk = new NodeSDK(config);
  try {
    sdk.start();
  } catch (err) {
    // A telemetry init failure must never block app startup (FR-015). Fall back
    // to a fully inert process: instrumentation may be partially registered, but
    // nothing exports and nothing throws.
    mode = 'inert-failed';
    try {
      // eslint-disable-next-line no-console
      console.warn('[telemetry] SDK start failed — continuing without telemetry:', err && err.message);
    } catch { /* ignore */ }
  }

  started = true;
  return { mode };
}

/**
 * Flush + shut down telemetry within a bounded time, resolving even if the
 * Collector is unreachable (FR-017). Wired into `createShutdown`'s ordered drain.
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function shutdown(timeoutMs = 4000) {
  if (!sdk || !started) return;
  const bounded = new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    if (typeof t.unref === 'function') t.unref();
  });
  try {
    await Promise.race([sdk.shutdown().catch(() => {}), bounded]);
  } catch {
    /* resolve regardless — shutdown must never hang on an unreachable Collector */
  } finally {
    started = false;
  }
}

/** Named tracer for manual spans (delegates to the global provider). */
function getTracer(name = TRACER_NAME) {
  return api.trace.getTracer(name);
}

/** Named meter for app metrics (delegates to the global provider). */
function getMeter(name = METER_NAME) {
  return api.metrics.getMeter(name);
}

/** Current export mode: 'inert' | 'otlp' | 'test' | 'inert-failed' | 'uninitialized'. */
function getMode() {
  return mode;
}

module.exports = {
  start,
  shutdown,
  getTracer,
  getMeter,
  getMode,
  // Test seam: allow the capture harness / inert tests to reset module state
  // between test files (jest sandboxes files, but be explicit).
  _resetForTest: () => {
    sdk = null;
    started = false;
    mode = 'uninitialized';
  },
};
