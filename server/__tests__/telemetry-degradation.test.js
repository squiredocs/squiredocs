/**
 * US4 / MEDIUM finding F1 — bounded degradation with an unreachable endpoint
 * (feature 014, FR-016, SC-006).
 *
 * With `OTEL_EXPORTER_OTLP_ENDPOINT` pointed at an unroutable host, export
 * failure MUST be contained: no thrown error, no unhandled rejection, and a
 * bounded shutdown that resolves regardless. We point at 127.0.0.1:1 (connection
 * REFUSED — deterministic and fast, not a network timeout) so the assertion is
 * reliable, not flaky.
 *
 * This file starts the SDK in real OTLP mode (own module registry), so it does
 * NOT use the capture harness.
 */
const telemetry = require('../telemetry');
const logger = require('../logger');
const { withSpan } = require('../telemetry/spans');
const metrics = require('../telemetry/metrics');

const rejections = [];
function onRejection(err) {
  rejections.push(err);
}

beforeAll(() => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1';
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/protobuf';
  process.on('unhandledRejection', onRejection);
  logger.__setSink(() => {}); // swallow noise; we only assert on stability
});

afterAll(async () => {
  process.removeListener('unhandledRejection', onRejection);
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
  logger.__resetSink();
  logger.uninstallConsoleShim();
  await telemetry.shutdown();
});

describe('unreachable endpoint degradation (F1)', () => {
  test('starts in OTLP mode without throwing', () => {
    const result = telemetry.start();
    expect(result.mode).toBe('otlp');
  });

  test('emitting spans + metrics against the unreachable endpoint never throws', () => {
    for (let i = 0; i < 25; i++) {
      expect(() =>
        withSpan('collab.operation', { 'document.guid': `g${i}`, 'collab.operation': 'markdown.sync' }, () => i)
      ).not.toThrow();
      expect(() => metrics.recordRateLimitRejection('auth')).not.toThrow();
    }
  });

  test('shutdown resolves within the bounded window despite the dead endpoint', async () => {
    const t0 = Date.now();
    await expect(telemetry.shutdown(4000)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  test('no unhandled rejection escaped from the export path', async () => {
    // Give any queued export attempt a moment to reject.
    await new Promise((r) => setTimeout(r, 200));
    expect(rejections).toHaveLength(0);
  });
});
