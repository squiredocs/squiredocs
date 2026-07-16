/**
 * US4 — safe by default: Collector-less inertness (feature 014, FR-015/021).
 *
 * With no telemetry endpoint configured, start()/emit/shutdown() never crash,
 * make no export attempts, and produce no repeated export-error noise; the
 * startup path is never blocked. This is the default dev/CI/test state.
 *
 * NOTE: this file does NOT use the capture harness — it exercises the real inert
 * mode (no injected exporter). Requires no DB/Redis.
 */
const logger = require('../logger');
const telemetry = require('../telemetry');
const { withSpan } = require('../telemetry/spans');
const metrics = require('../telemetry/metrics');

let logCapture = [];
const rejections = [];
function onRejection(err) {
  rejections.push(err);
}

beforeAll(() => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  process.on('unhandledRejection', onRejection);
  logger.__setSink((str) => {
    const t = String(str).trim();
    if (t) {
      try {
        logCapture.push(JSON.parse(t));
      } catch {
        logCapture.push({ raw: t });
      }
    }
  });
});

afterAll(async () => {
  process.removeListener('unhandledRejection', onRejection);
  logger.__resetSink();
  logger.uninstallConsoleShim();
  await telemetry.shutdown();
});

beforeEach(() => {
  logCapture = [];
});

describe('inert mode (no Collector endpoint)', () => {
  test('start() returns synchronously in inert mode — startup not blocked', () => {
    const result = telemetry.start();
    expect(result.mode).toBe('inert');
    expect(telemetry.getMode()).toBe('inert');
  });

  test('emitting spans / metrics / logs never throws', () => {
    expect(() =>
      withSpan('collab.operation', { 'document.guid': 'g1', 'collab.operation': 'markdown.sync' }, () => 42)
    ).not.toThrow();
    // withSpan returns the fn's value transparently.
    expect(withSpan('x', { 'document.guid': 'g' }, () => 99)).toBe(99);
    expect(() => metrics.recordRateLimitRejection('auth')).not.toThrow();
    expect(() => console.log('inert log line')).not.toThrow();
    expect(() => console.error('inert error line')).not.toThrow();
  });

  test('no export-error noise floods the logs while inert', () => {
    for (let i = 0; i < 20; i++) {
      withSpan('collab.operation', { 'document.guid': `g${i}` }, () => i);
      console.log(`work ${i}`);
    }
    const noisy = logCapture.filter((l) => {
      const s = JSON.stringify(l).toLowerCase();
      return s.includes('otlp') || s.includes('econnrefused') || s.includes('export failed');
    });
    expect(noisy).toHaveLength(0);
  });

  test('shutdown resolves (never hangs) with no Collector', async () => {
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });

  test('no unhandled rejections were produced', () => {
    expect(rejections).toHaveLength(0);
  });
});
