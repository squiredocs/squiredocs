/**
 * In-process telemetry capture harness (feature 014, contract 6, RBD-7, D6).
 *
 * Starts the OTel SDK in TEST mode with an `InMemorySpanExporter`
 * (SimpleSpanProcessor, so spans are synchronously available on end) plus an
 * on-demand in-memory metric reader, and redirects the pino logger sink to
 * capture log JSON — all with NO network exporter, so it is hermetic and safe
 * under `jest --runInBand`.
 *
 * Usage (call installCapture() BEFORE requiring app modules that emit telemetry):
 *
 *   const capture = require('./helpers/telemetry-capture');
 *   beforeAll(() => capture.installCapture());
 *   beforeEach(() => capture.reset());
 *   afterAll(async () => { await capture.shutdown(); });
 *
 *   const spans = capture.getSpans();
 *   const metrics = await capture.getMetrics();
 *   const lines = capture.getLogLines();
 */
const { InMemorySpanExporter } = require('@opentelemetry/sdk-trace-base');
const { MetricReader } = require('@opentelemetry/sdk-metrics');
const telemetry = require('../../telemetry');
const logger = require('../../logger');

// A MetricReader whose data is pulled on demand via collect() — no periodic
// export, no exporter, fully synchronous for assertions.
class OnDemandMetricReader extends MetricReader {
  async onForceFlush() {}
  async onShutdown() {}
}

let spanExporter = null;
let metricReader = null;
const logLines = [];
let installed = false;

/** Start the SDK in test mode and redirect the log sink. Idempotent. */
function installCapture() {
  if (installed) return;
  spanExporter = new InMemorySpanExporter();
  metricReader = new OnDemandMetricReader();

  logger.__setSink((str) => {
    const trimmed = String(str).trim();
    if (!trimmed) return;
    try {
      logLines.push(JSON.parse(trimmed));
    } catch {
      logLines.push({ raw: trimmed });
    }
  });

  telemetry.start({ spanExporter, metricReader });
  installed = true;
}

/** All spans finished since the last reset(). */
function getSpans() {
  return spanExporter ? spanExporter.getFinishedSpans() : [];
}

/**
 * Collected metrics, flattened to a list of
 * `{ name, dataPoints: [{ value, attributes }] }`.
 */
async function getMetrics() {
  if (!metricReader) return [];
  const { resourceMetrics } = await metricReader.collect();
  const out = [];
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      out.push({
        name: metric.descriptor.name,
        dataPoints: metric.dataPoints.map((dp) => ({ value: dp.value, attributes: dp.attributes })),
      });
    }
  }
  return out;
}

/** Convenience: find one metric by name from a getMetrics() result. */
function findMetric(metrics, name) {
  return metrics.find((m) => m.name === name);
}

/**
 * Serialize the FULL exported span record — name, attributes, status (code +
 * message), AND every event with all its attributes — to a JSON string. Sentinel
 * sweeps must use this (not just `span.attributes`): content can escape through
 * `span.status.message` (raw PG errors) or exception-event attributes
 * (`exception.message` / `exception.stacktrace`), which an attributes-only sweep
 * never sees. This is the shape the RedactionSpanProcessor backstop must scrub.
 */
function serializeSpan(span) {
  if (!span) return '';
  return JSON.stringify({
    name: span.name,
    attributes: span.attributes || {},
    status: span.status || {},
    events: (span.events || []).map((e) => ({ name: e.name, attributes: e.attributes || {} })),
  });
}

/** Captured log lines (parsed JSON objects) since the last reset(). */
function getLogLines() {
  return logLines.slice();
}

/** Clear span/log buffers between tests. Metrics are pulled fresh each collect(). */
function reset() {
  if (spanExporter) spanExporter.reset();
  logLines.length = 0;
}

/** Shut the SDK down and restore the log sink. */
async function shutdown() {
  logger.__resetSink();
  await telemetry.shutdown();
  installed = false;
}

module.exports = {
  installCapture,
  getSpans,
  serializeSpan,
  getMetrics,
  findMetric,
  getLogLines,
  reset,
  shutdown,
};
