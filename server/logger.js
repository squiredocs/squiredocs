/**
 * Central structured logger + non-throwing `console` shim (feature 014, US1,
 * FR-006/007/008/009, research D4, contract 5).
 *
 * A single pino JSON logger writes one object per line to stdout. Installing the
 * shim replaces `console.log/info/warn/error/debug` process-wide so all ~382
 * existing call sites emit structured JSON with NO call-site rewrite (RBD-8).
 *
 * Guarantees:
 *   • Non-throwing (FR-009): every wrapper is wrapped in try/catch and falls back
 *     to a raw write on the ORIGINAL bound stdout/stderr on any failure, so a
 *     logging fault can never take down a request path.
 *   • `util.format` semantics (FR-007): variadic args + format strings preserved;
 *     Error objects render with their stack.
 *   • Bounded (FR-009): the formatted message is capped; `util.inspect` bounds
 *     object depth/breadth so a circular or huge object never stalls or throws.
 *   • Trace correlation (FR-008 / RBD-5): `trace_id`+`span_id` are attached ONLY
 *     when emitted inside an active recording span; omitted (not fabricated)
 *     otherwise.
 *   • Injection-safe: JSON encoding neutralizes newline/control-char injection
 *     from user-controlled identifiers.
 *
 * The exception-notifier's email path is NOT touched (FR-010): the shim only
 * serializes the notifier's `console.*` lines, never intercepts `notifyException`.
 */
const util = require('util');
const pino = require('pino');
const api = require('@opentelemetry/api');

// Cap the final rendered message so an oversized top-level string arg
// (`console.log('x'.repeat(1e7))`) can't produce an unbounded log line.
const MAX_MESSAGE_LEN = 8192;

// Bound object rendering so a circular/huge object is safe and fast.
const INSPECT_OPTS = { depth: 4, breakLength: Infinity, maxArrayLength: 100, maxStringLength: 2048 };

// The five console methods in scope (FR-007) → pino level.
const LEVEL_BY_METHOD = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
};

// Captured originals so the fallback path never re-enters the shim.
const originalConsole = {};
// Original bound stdout/stderr writers — the last-resort fallback.
const rawStdout = process.stdout.write.bind(process.stdout);
const rawStderr = process.stderr.write.bind(process.stderr);

// Swappable sink so tests can capture log JSON without a network exporter.
// Defaults to a raw write on the original stdout.
let sink = (str) => {
  try {
    rawStdout(str);
  } catch {
    /* nothing else we can safely do */
  }
};

// pino writes complete JSON lines to this destination; we route them through the
// swappable sink.
const destination = {
  write(str) {
    sink(str);
  },
};

const logger = pino(
  {
    level: 'debug', // admit console.debug; pino drops nothing above this
    base: undefined, // no pid/hostname noise on every line
    timestamp: pino.stdTimeFunctions.epochTime, // { time: <epoch ms> }
    formatters: {
      // Emit a readable severity label ("info"/"warn"/"error"/"debug") in `level`.
      level(label) {
        return { level: label };
      },
    },
    messageKey: 'msg',
  },
  destination
);

let installed = false;

/**
 * Attach trace/span IDs iff a recording span is active in the current context
 * (RBD-5). Returns a bindings object ({} when uncorrelated).
 */
function correlationBindings() {
  try {
    const span = api.trace.getSpan(api.context.active());
    if (!span) return null;
    const sc = span.spanContext();
    if (!sc || !sc.traceId || sc.traceId === '00000000000000000000000000000000') return null;
    return { trace_id: sc.traceId, span_id: sc.spanId };
  } catch {
    return null;
  }
}

/** Render console args to a single bounded message string (util.format semantics). */
function renderMessage(args) {
  let msg;
  try {
    msg = util.formatWithOptions(INSPECT_OPTS, ...args);
  } catch {
    // formatWithOptions itself should never throw for normal inputs, but guard.
    try {
      msg = args.map((a) => (typeof a === 'string' ? a : util.inspect(a, INSPECT_OPTS))).join(' ');
    } catch {
      msg = '[unserializable log arguments]';
    }
  }
  if (typeof msg !== 'string') msg = String(msg);
  if (msg.length > MAX_MESSAGE_LEN) {
    msg = `${msg.slice(0, MAX_MESSAGE_LEN)}… [truncated ${msg.length - MAX_MESSAGE_LEN} chars]`;
  }
  return msg;
}

/** Build one console wrapper for `method` at pino `level`. Never throws. */
function makeWrapper(method, level) {
  return function shimmedConsoleMethod(...args) {
    try {
      const message = renderMessage(args);
      const bindings = correlationBindings();
      if (bindings) {
        logger[level](bindings, message);
      } else {
        logger[level](message);
      }
    } catch (err) {
      // Last-resort fallback: raw write, never re-enter the shim or throw.
      try {
        const raw = method === 'error' || method === 'warn' ? rawStderr : rawStdout;
        raw(`${String(args[0])}\n`);
      } catch {
        /* give up silently — logging must never crash the app */
      }
    }
  };
}

/**
 * Install the console shim process-wide. Idempotent. Safe to call before any app
 * module loads (invoked from telemetry.start()).
 */
function installConsoleShim() {
  if (installed) return;
  for (const method of Object.keys(LEVEL_BY_METHOD)) {
    originalConsole[method] = console[method];
    // eslint-disable-next-line no-console
    console[method] = makeWrapper(method, LEVEL_BY_METHOD[method]);
  }
  installed = true;
}

/** Restore the original console methods (test seam). */
function uninstallConsoleShim() {
  if (!installed) return;
  for (const method of Object.keys(LEVEL_BY_METHOD)) {
    if (originalConsole[method]) {
      // eslint-disable-next-line no-console
      console[method] = originalConsole[method];
    }
  }
  installed = false;
}

module.exports = {
  logger,
  installConsoleShim,
  uninstallConsoleShim,
  isInstalled: () => installed,
  // Test seam: redirect the pino sink to capture JSON lines in-process.
  __setSink: (fn) => {
    sink = typeof fn === 'function' ? fn : sink;
  },
  __resetSink: () => {
    sink = (str) => {
      try {
        rawStdout(str);
      } catch {
        /* ignore */
      }
    };
  },
};
