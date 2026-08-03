/**
 * Application metrics (feature 014, US3, contract 4, FR-011/012/013, research D7).
 *
 * Three metric families the design doc names as the app-level golden signals:
 *   • HTTP request count + duration histogram, labeled by (http.route,
 *     http.status_class) ONLY — route TEMPLATE, never the concrete path, so
 *     cardinality stays bounded and no identifier/content enters a label (FR-011).
 *   • ratelimit.rejections counter, labeled by limiter category — makes the
 *     previously-silent 429s countable (FR-012). Recording never throws into the
 *     429 path (edge case).
 *   • PostgreSQL pool observable gauges: total / idle / waiting (FR-013).
 *
 * Instruments are created lazily on first use so this module is import-safe even
 * before telemetry.start() (the global meter is a no-op until then, keeping
 * everything inert with no Collector).
 */
const telemetry = require('../telemetry');

let instruments = null;

function getInstruments() {
  if (instruments) return instruments;
  const meter = telemetry.getMeter();
  instruments = {
    requestCount: meter.createCounter('http.server.request.count', {
      description: 'Count of completed HTTP server requests by route template and status class.',
    }),
    requestDuration: meter.createHistogram('http.server.request.duration', {
      description: 'Duration of HTTP server requests in milliseconds.',
      unit: 'ms',
    }),
    rateLimitRejections: meter.createCounter('ratelimit.rejections', {
      description: 'Count of requests rejected with 429 by limiter category.',
    }),
    collabRenderSkips: meter.createCounter('collab.render_skip.reports', {
      description:
        'Client-reported collaborative-editor render skips (feature 021, DR-3) by node type and error class.',
    }),
    // ── The 041-048 safety counters ────────────────────────────────────────
    // Each of these should sit at or near zero. They are not activity metrics;
    // they are the first symptom of the failure modes that train was built to
    // close, and every one of them was previously reachable only by reading pod
    // logs. Two are additionally rate-suppressed at the source, so counting log
    // LINES undercounts them by design — which is the other half of why they
    // need to be counters.
    bindRefusals: meter.createCounter('collab.bind.refusals', {
      description:
        'Document loads that failed and refused the collaboration bind (feature 041, FR-010). A rising rate means the database is failing reads, and clients are being told to retry rather than served an empty document.',
    }),
    editCapabilityDegraded: meter.createCounter('collab.edit.degraded_closes', {
      description:
        'Editor connections closed with 1013 because a role re-check failed rather than denied (feature 046). This is the signal that a database blip is interrupting people mid-edit; 046 assumes it is rare.',
    }),
    awarenessBlocked: meter.createCounter('collab.awareness.blocked', {
      description:
        'Awareness frames refused for asserting a clientID the connection does not own (feature 044), by reason. Counts frames DROPPED, including those suppressed from the logs.',
    }),
    resupplyResolutions: meter.createCounter('collab.resupply.resolutions', {
      description:
        'Authorship resolutions attempted for sync-relayed rows (feature 045), by outcome: resolved to an author, or honestly refused. The ratio is how the attribution promise is observed rather than asserted.',
    }),
  };
  return instruments;
}

/** `2xx`/`4xx`/`5xx` etc. from a numeric status code; `0xx` if unknown. */
function statusClass(statusCode) {
  const code = Number(statusCode);
  if (!Number.isFinite(code) || code <= 0) return '0xx';
  return `${Math.floor(code / 100)}xx`;
}

/**
 * Low-cardinality route template for the current request. Prefers Express's
 * resolved route (`req.baseUrl` + `req.route.path`, e.g. `/api/docs/:docId`);
 * falls back to `(unmatched)` so a 404 / pre-routing rejection can NEVER put a
 * concrete path (with identifiers) into a label.
 */
function routeTemplate(req) {
  try {
    if (req && req.route && req.route.path) {
      const base = req.baseUrl || '';
      const path = req.route.path;
      const tmpl = `${base}${path}` || '/';
      return tmpl.length > 128 ? tmpl.slice(0, 128) : tmpl;
    }
  } catch {
    /* fall through */
  }
  return '(unmatched)';
}

/**
 * Express middleware: records request count + duration by (http.route,
 * http.status_class) when the response finishes. Mount early in the chain so it
 * times the whole request. Never throws into the request path.
 */
function httpMetricsMiddleware() {
  return function httpMetrics(req, res, next) {
    const start = Date.now();
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      try {
        const labels = {
          'http.route': routeTemplate(req),
          'http.status_class': statusClass(res.statusCode),
        };
        const inst = getInstruments();
        inst.requestCount.add(1, labels);
        inst.requestDuration.record(Date.now() - start, labels);
      } catch {
        /* metrics must never break a request */
      }
    };
    res.on('finish', record);
    res.on('close', record);
    next();
  };
}

/**
 * Increment the rate-limit rejection counter for `category`. Never throws — a
 * metrics fault must not add a failure mode to the 429 path (edge case).
 * @param {string} category - limiter category (e.g. 'auth','chat','search','register')
 */
function recordRateLimitRejection(category) {
  try {
    getInstruments().rateLimitRejections.add(1, {
      'ratelimit.category': typeof category === 'string' && category ? category : 'unknown',
    });
  } catch {
    /* swallow — never break the 429 response */
  }
}

/**
 * Count one client-reported render-skip event (feature 021, DR-3). Attributes
 * are content-free by construction: node type name and error class name only.
 * Never throws — reporting must not break the beacon response.
 */
function recordCollabRenderSkip(nodeType, errorName, count = 1) {
  try {
    getInstruments().collabRenderSkips.add(Number.isFinite(count) && count > 0 ? count : 1, {
      'collab.node_type': typeof nodeType === 'string' && nodeType ? nodeType : 'unknown',
      'collab.error_name': typeof errorName === 'string' && errorName ? errorName : 'unknown',
    });
  } catch {
    /* swallow */
  }
}

/**
 * Count one refused collaboration bind (feature 041, FR-010).
 *
 * Deliberately unlabelled by document: the useful question is "is this
 * happening at all, and is it rising", and a docGuid label would be unbounded
 * cardinality on the one metric most likely to fire in a storm.
 */
function recordBindRefusal() {
  try {
    getInstruments().bindRefusals.add(1);
  } catch {
    /* swallow — a metrics fault must never add a failure mode to the refusal path */
  }
}

/**
 * Count one editor connection closed because its edit capability was DEGRADED —
 * a role re-check that errored rather than denied (feature 046).
 *
 * Separate from an ordinary permission denial on purpose: a denial is the
 * system working, this is the system failing safe, and conflating them would
 * hide the signal inside normal traffic.
 */
function recordEditCapabilityDegraded() {
  try {
    getInstruments().editCapabilityDegraded.add(1);
  } catch {
    /* swallow */
  }
}

/**
 * Count awareness frames dropped by the ownership guard (feature 044).
 *
 * Takes the DROPPED COUNT, not one per log line: the guard suppresses repeated
 * logs per connection and carries the real volume in its payload, so counting
 * calls here would undercount exactly when it matters most. `reason` is a small
 * fixed set from the guard, never user input.
 */
function recordAwarenessBlocked(reason, dropped = 1) {
  try {
    getInstruments().awarenessBlocked.add(Number.isFinite(dropped) && dropped > 0 ? dropped : 1, {
      'awareness.reason': typeof reason === 'string' && reason ? reason : 'unknown',
    });
  } catch {
    /* swallow */
  }
}

/**
 * Count one authorship resolution for a sync-relayed row (feature 045).
 * @param {'resolved'|'unresolved'} outcome
 */
function recordResupplyResolution(outcome) {
  try {
    getInstruments().resupplyResolutions.add(1, {
      'resupply.outcome': outcome === 'resolved' ? 'resolved' : 'unresolved',
    });
  } catch {
    /* swallow */
  }
}

/**
 * Register observable PG pool gauges (total/idle/waiting). Reads the live pool
 * counts on each metric collection interval. Safe to call once at startup.
 * @param {object} opts
 * @param {() => (import('pg').Pool|null|undefined)} opts.getPool
 */
function init({ getPool } = {}) {
  if (typeof getPool !== 'function') return;
  let meter;
  try {
    meter = telemetry.getMeter();
  } catch {
    return;
  }

  const readPool = () => {
    try {
      return getPool();
    } catch {
      return null;
    }
  };

  const total = meter.createObservableGauge('db.pool.connections.total', {
    description: 'Total PostgreSQL pool connections (in use + idle).',
  });
  const idle = meter.createObservableGauge('db.pool.connections.idle', {
    description: 'Idle PostgreSQL pool connections.',
  });
  const waiting = meter.createObservableGauge('db.pool.connections.waiting', {
    description: 'Requests waiting for a PostgreSQL pool connection.',
  });

  total.addCallback((result) => {
    const pool = readPool();
    if (pool && typeof pool.totalCount === 'number') result.observe(pool.totalCount);
  });
  idle.addCallback((result) => {
    const pool = readPool();
    if (pool && typeof pool.idleCount === 'number') result.observe(pool.idleCount);
  });
  waiting.addCallback((result) => {
    const pool = readPool();
    if (pool && typeof pool.waitingCount === 'number') result.observe(pool.waitingCount);
  });
}

module.exports = {
  httpMetricsMiddleware,
  recordRateLimitRejection,
  recordCollabRenderSkip,
  recordBindRefusal,
  recordEditCapabilityDegraded,
  recordAwarenessBlocked,
  recordResupplyResolution,
  init,
  // Exposed for tests
  statusClass,
  routeTemplate,
  _resetForTest: () => {
    instruments = null;
  },
};
