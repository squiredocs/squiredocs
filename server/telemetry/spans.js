/**
 * Manual-span helper (feature 014, US2, contract 3, FR-004/FR-005).
 *
 * `withSpan(name, attributes, fn)` wraps an operation that lives outside the
 * Express request lifecycle — the Yjs collaboration path (redis-pubsub,
 * markdown-sync) and MCP `executeTool` — in one operation-level span:
 *   • attributes are allowlist-filtered by construction (privacy.safeAttributes),
 *   • `outcome` (success|error) + `duration_ms` are recorded,
 *   • the span is always ended,
 *   • the wrapper never throws beyond fn's own error, and never adds a failure
 *     mode if the span machinery itself faults.
 *
 * Handles both synchronous fns (e.g. a Redis publish) and promise-returning fns.
 */
const api = require('@opentelemetry/api');
const telemetry = require('../telemetry');
const { safeAttributes } = require('./privacy');

const { SpanStatusCode } = api;

/**
 * @template T
 * @param {string} name - span name (operation identity, never content)
 * @param {Record<string, any>} attributes - allowlist-filtered before use
 * @param {(span?: object) => T} fn - the operation
 * @returns {T}
 */
function withSpan(name, attributes, fn) {
  let tracer;
  try {
    tracer = telemetry.getTracer();
  } catch {
    // Telemetry unavailable — run the operation untraced.
    return fn();
  }

  const attrs = safeAttributes(attributes);

  return tracer.startActiveSpan(name, { attributes: attrs }, (span) => {
    const start = Date.now();

    const finish = (outcome) => {
      try {
        span.setAttribute('outcome', outcome);
        span.setAttribute('duration_ms', Date.now() - start);
        span.end();
      } catch {
        /* never throw from the span wrapper */
      }
    };

    const onError = (err) => {
      try {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err && err.message });
      } catch {
        /* ignore */
      }
      finish('error');
    };

    try {
      const result = fn(span);
      if (result && typeof result.then === 'function') {
        return result.then(
          (value) => {
            finish('success');
            return value;
          },
          (err) => {
            onError(err);
            throw err;
          }
        );
      }
      finish('success');
      return result;
    } catch (err) {
      onError(err);
      throw err;
    }
  });
}

module.exports = { withSpan };
