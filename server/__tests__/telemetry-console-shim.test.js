/**
 * US1 — console shim (feature 014, FR-006/007/008/009/022).
 *
 * The shim sits under every log call in the app (highest blast radius), so it is
 * proven directly: JSON shape, severity mapping, trace correlation
 * presence/absence, non-throwing serialization of hostile inputs, Error stacks.
 */
const api = require('@opentelemetry/api');
const logger = require('../logger');
const telemetry = require('../telemetry');

let lines = [];

function captureSink(str) {
  const trimmed = String(str).trim();
  if (!trimmed) return;
  try {
    lines.push(JSON.parse(trimmed));
  } catch {
    lines.push({ raw: trimmed });
  }
}

beforeAll(() => {
  // Inert start: registers the tracer provider + context manager (so an active
  // span has a valid trace context) without any exporter.
  telemetry.start();
  logger.__setSink(captureSink);
  logger.installConsoleShim();
});

afterAll(async () => {
  logger.__resetSink();
  logger.uninstallConsoleShim();
  await telemetry.shutdown();
});

beforeEach(() => {
  lines = [];
});

describe('console shim — JSON shape & severity', () => {
  test('console.log emits one JSON line with level/time/msg', () => {
    console.log('hello shim');
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.level).toBe('info');
    expect(typeof line.time).toBe('number');
    expect(line.msg).toBe('hello shim');
    expect(line.raw).toBeUndefined(); // valid JSON, not a fallback
  });

  test('severity mapping across all five methods', () => {
    console.log('l');
    console.info('i');
    console.warn('w');
    console.error('e');
    console.debug('d');
    const levels = lines.map((l) => l.level);
    expect(levels).toEqual(['info', 'info', 'warn', 'error', 'debug']);
  });

  test('util.format variadic + format-string semantics preserved', () => {
    console.log('user %s did %d things', 'alice', 3, { extra: true });
    expect(lines[0].msg).toBe('user alice did 3 things { extra: true }');
  });
});

describe('console shim — trace correlation (RBD-5)', () => {
  test('lines inside a recording span carry matching trace_id/span_id', () => {
    const tracer = telemetry.getTracer();
    let sc;
    tracer.startActiveSpan('unit-span', (span) => {
      sc = span.spanContext();
      console.log('inside a request');
      span.end();
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].trace_id).toBe(sc.traceId);
    expect(lines[0].span_id).toBe(sc.spanId);
  });

  test('lines outside any span omit correlation fields (not fabricated)', () => {
    console.log('startup line');
    expect(lines[0].trace_id).toBeUndefined();
    expect(lines[0].span_id).toBeUndefined();
  });
});

describe('console shim — non-throwing hostile inputs (FR-009)', () => {
  test('circular object does not throw and is serialized', () => {
    const circular = { name: 'root' };
    circular.self = circular;
    expect(() => console.log('circ', circular)).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toContain('Circular');
  });

  test('oversized string is bounded, not stalled or thrown', () => {
    const huge = 'x'.repeat(5_000_000);
    expect(() => console.log(huge)).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0].msg.length).toBeLessThan(20_000);
    expect(lines[0].msg).toContain('truncated');
  });

  test('Error object preserves name, message, and stack', () => {
    const err = new Error('kaboom');
    console.error('failed:', err);
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('error');
    expect(lines[0].msg).toContain('Error: kaboom');
    expect(lines[0].msg).toContain('at '); // a stack frame
  });

  test('deeply nested / mixed args never throw', () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(() => console.warn('deep', deep, [1, 2, 3], null, undefined)).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe('console shim — install idempotence', () => {
  test('installing twice does not double-wrap', () => {
    logger.installConsoleShim();
    logger.installConsoleShim();
    console.log('once');
    expect(lines).toHaveLength(1);
  });
});
