/**
 * Telemetry privacy enforcement (feature 014, FR-019/FR-020, research D5).
 *
 * TWO layers implement the trust-level privacy invariant "document content
 * never enters telemetry":
 *
 *   1. CONSTRUCTION — `safeAttributes()` filters any attribute object down to the
 *      permitted-identifier allowlist. Manual spans (spans.js) and metric labels
 *      only ever carry allowlisted keys because they build their attributes
 *      through this helper / a fixed label set.
 *
 *   2. BACKSTOP — `RedactionSpanProcessor` runs on span end and DROPS every
 *      attribute key not on the allowlist (so an accidental content attribute,
 *      or a content-bearing key from auto-instrumentation — `db.statement`, the
 *      concrete `url.full`/`http.target`, a Redis publish payload — can never be
 *      exported) and truncates over-long string values.
 *
 * The allowlist is deliberately strict: unrecognized keys are dropped by default,
 * so a future instrumentation that adds a new content-bearing attribute is
 * redacted without a code change. It still admits the well-known, content-free
 * operational semconv keys (http.method, db.system, net.peer.*) so
 * auto-instrumentation traces stay useful.
 *
 * A violation is a trust-invariant break, proven absent by the sentinel-content
 * tests (FR-024 / SC-005), not a style issue.
 */

// The ONLY attribute/metric-label keys allowed in any exported signal. Values
// for keys not in this set are dropped by the RedactionSpanProcessor backstop.
const PERMITTED_ATTRIBUTE_KEYS = new Set([
  // ── App identifiers (manual spans + metric labels) ──────────────────────
  'document.guid',
  'user.id',
  'agent.id',
  'mcp.tool.name',
  'collab.operation',
  'sync.operation',
  'ratelimit.category',
  'outcome',
  'duration_ms',
  // ── HTTP identity: route TEMPLATE + status only (never concrete path/query)
  'http.route',
  'http.status_class',
  'http.status_code',
  'http.method',
  'http.request.method',
  'http.response.status_code',
  'http.scheme',
  'url.scheme',
  'http.flavor',
  'network.protocol.version',
  'network.protocol.name',
  // ── Network peers: host/port only, no content ───────────────────────────
  'server.address',
  'server.port',
  'net.host.name',
  'net.host.port',
  'net.peer.name',
  'net.peer.port',
  'network.peer.address',
  'network.peer.port',
  'net.transport',
  'network.transport',
  // ── Datastore: system / name / operation / table only.
  //    NEVER db.statement, db.parameters, db.connection_string — those can
  //    carry query text or the Redis publish payload (document bytes).
  'db.system',
  'db.system.name',
  'db.name',
  'db.namespace',
  'db.operation',
  'db.operation.name',
  'db.sql.table',
  'db.collection.name',
]);

// Explicit denylist of the highest-risk keys. Redundant with the strict
// allowlist (these are simply absent from it), but named here so intent is
// unmistakable and so a future well-meaning allowlist edit can't quietly admit
// one of them without also removing it from this set.
const FORBIDDEN_ATTRIBUTE_KEYS = new Set([
  'db.statement',
  'db.parameters',
  'db.connection_string',
  'db.query.text',
  'db.query.parameter',
  'http.target',
  'http.url',
  'url.full',
  'url.path',
  'url.query',
  'http.request.body',
  'http.response.body',
]);

// Max retained length for any string attribute value (defense against a large
// value slipping through on an allowlisted key).
const MAX_ATTRIBUTE_VALUE_LEN = 256;

/** True iff `key` may appear as an attribute/label in an exported signal. */
function isPermittedKey(key) {
  return PERMITTED_ATTRIBUTE_KEYS.has(key) && !FORBIDDEN_ATTRIBUTE_KEYS.has(key);
}

/**
 * Filter an attribute object to the permitted-identifier allowlist, dropping
 * unknown keys, undefined/null values, and truncating over-long strings. Used at
 * CONSTRUCTION time by manual spans so only allowlisted attributes are ever set.
 * @param {Record<string, any>} [attributes]
 * @returns {Record<string, any>}
 */
function safeAttributes(attributes) {
  const out = {};
  if (!attributes || typeof attributes !== 'object') return out;
  for (const key of Object.keys(attributes)) {
    if (!isPermittedKey(key)) continue;
    let value = attributes[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (value.length > MAX_ATTRIBUTE_VALUE_LEN) value = value.slice(0, MAX_ATTRIBUTE_VALUE_LEN);
    } else if (typeof value !== 'number' && typeof value !== 'boolean') {
      // Only primitive identifiers/counts are permitted; coerce anything else to
      // a bounded string rather than risk exporting a structured content payload.
      value = String(value).slice(0, MAX_ATTRIBUTE_VALUE_LEN);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Span processor backstop: on span end, strip every non-allowlisted attribute
 * key (in place, before the exporter serializes the span) and truncate over-long
 * string values. Never throws — a logging/telemetry fault must never propagate.
 *
 * Mutating `span.attributes` in `onEnd` is safe because the exporter reads the
 * same object reference (batch export serializes it after all processors' onEnd),
 * so redaction is applied regardless of processor registration order.
 */
class RedactionSpanProcessor {
  constructor({ maxLen = MAX_ATTRIBUTE_VALUE_LEN } = {}) {
    this._maxLen = maxLen;
  }

  onStart() {}

  onEnd(span) {
    try {
      const attrs = span && span.attributes;
      if (!attrs || typeof attrs !== 'object') return;
      for (const key of Object.keys(attrs)) {
        if (!isPermittedKey(key)) {
          delete attrs[key];
          continue;
        }
        const value = attrs[key];
        if (typeof value === 'string' && value.length > this._maxLen) {
          attrs[key] = value.slice(0, this._maxLen);
        }
      }
    } catch {
      /* never throw from a span processor */
    }
  }

  forceFlush() {
    return Promise.resolve();
  }

  shutdown() {
    return Promise.resolve();
  }
}

module.exports = {
  PERMITTED_ATTRIBUTE_KEYS,
  FORBIDDEN_ATTRIBUTE_KEYS,
  MAX_ATTRIBUTE_VALUE_LEN,
  isPermittedKey,
  safeAttributes,
  RedactionSpanProcessor,
};
