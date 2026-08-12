/**
 * US3 — application metrics (feature 014, FR-011/012/013/023).
 *
 * In-process capture (no network exporter):
 *   • HTTP request count + duration by (http.route template, http.status_class);
 *   • ratelimit.rejections counter increments with the correct category label;
 *   • PG pool gauges report plausible total / idle / waiting.
 */
const capture = require('./helpers/telemetry-capture');
capture.installCapture();

const express = require('express');
const request = require('supertest');

const metrics = require('../telemetry/metrics');

let server;
const fakePool = { totalCount: 7, idleCount: 4, waitingCount: 2 };

beforeAll((done) => {
  metrics.init({ getPool: () => fakePool });
  const app = express();
  app.use(metrics.httpMetricsMiddleware());
  app.get('/api/docs/:docId', (req, res) => res.json({ ok: true }));
  app.get('/boom', (req, res) => res.status(500).json({ error: 'x' }));
  server = app.listen(0, done);
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await capture.shutdown();
});

beforeEach(() => capture.reset());

describe('HTTP request metrics (FR-011)', () => {
  test('count + duration recorded by (route template, status class)', async () => {
    await request(server).get('/api/docs/abc-123').expect(200);

    const collected = await capture.getMetrics();
    const count = capture.findMetric(collected, 'http.server.request.count');
    const duration = capture.findMetric(collected, 'http.server.request.duration');
    expect(count).toBeDefined();
    expect(duration).toBeDefined();

    const dp = count.dataPoints.find(
      (d) => d.attributes['http.route'] === '/api/docs/:docId'
    );
    expect(dp).toBeDefined();
    expect(dp.attributes['http.status_class']).toBe('2xx');
    expect(dp.value).toBeGreaterThanOrEqual(1);

    // No concrete path/id ever appears in a metric label.
    const labels = JSON.stringify(count.dataPoints.map((d) => d.attributes));
    expect(labels).not.toContain('abc-123');
  });

  test('5xx is derivable from the status class label', async () => {
    await request(server).get('/boom').expect(500);
    const collected = await capture.getMetrics();
    const count = capture.findMetric(collected, 'http.server.request.count');
    const dp = count.dataPoints.find((d) => d.attributes['http.route'] === '/boom');
    expect(dp.attributes['http.status_class']).toBe('5xx');
  });
});

describe('rate-limit rejection counter (FR-012)', () => {
  test('increments with the limiter category label', async () => {
    metrics.recordRateLimitRejection('auth');
    metrics.recordRateLimitRejection('auth');
    metrics.recordRateLimitRejection('search');

    const collected = await capture.getMetrics();
    const counter = capture.findMetric(collected, 'ratelimit.rejections');
    expect(counter).toBeDefined();
    const auth = counter.dataPoints.find((d) => d.attributes['ratelimit.category'] === 'auth');
    const search = counter.dataPoints.find((d) => d.attributes['ratelimit.category'] === 'search');
    expect(auth.value).toBe(2);
    expect(search.value).toBe(1);
  });

  test('never throws even with a bad category', () => {
    expect(() => metrics.recordRateLimitRejection(undefined)).not.toThrow();
    expect(() => metrics.recordRateLimitRejection(null)).not.toThrow();
  });
});

describe('PG pool gauges (FR-013)', () => {
  test('report plausible total / idle / waiting', async () => {
    const collected = await capture.getMetrics();
    const total = capture.findMetric(collected, 'db.pool.connections.total');
    const idle = capture.findMetric(collected, 'db.pool.connections.idle');
    const waiting = capture.findMetric(collected, 'db.pool.connections.waiting');
    expect(total.dataPoints[0].value).toBe(7);
    expect(idle.dataPoints[0].value).toBe(4);
    expect(waiting.dataPoints[0].value).toBe(2);
  });
});

// ── The 041-048 safety counters ───────────────────────────────────────────────
// These exist so the failure modes that train closed are OBSERVABLE after
// deploy rather than only greppable in pod logs. Two of the four are
// rate-suppressed at their source, so the counter is the only honest volume.
describe('collaboration safety counters', () => {
  test('bind refusals count, so a database-read outage is visible as a rate', async () => {
    metrics.recordBindRefusal();
    metrics.recordBindRefusal();

    const collected = await capture.getMetrics();
    const counter = capture.findMetric(collected, 'collab.bind.refusals');
    expect(counter).toBeDefined();
    expect(counter.dataPoints[0].value).toBe(2);
  });

  test('degraded editor closes count separately from ordinary permission denials', async () => {
    metrics.recordEditCapabilityDegraded();

    const collected = await capture.getMetrics();
    const counter = capture.findMetric(collected, 'collab.edit.degraded_closes');
    expect(counter).toBeDefined();
    expect(counter.dataPoints[0].value).toBe(1);
  });

  test('awareness blocks count DROPPED FRAMES, not log lines, and carry the reason', async () => {
    // The guard suppresses repeated logs per connection and reports the real
    // volume in `dropped`. Counting calls instead would undercount exactly
    // during a flood, which is when the number matters.
    metrics.recordAwarenessBlocked('foreign-id', 8);
    metrics.recordAwarenessBlocked('foreign-id', 3);
    metrics.recordAwarenessBlocked('oversized', 1);

    const collected = await capture.getMetrics();
    const counter = capture.findMetric(collected, 'collab.awareness.blocked');
    expect(counter).toBeDefined();
    const foreign = counter.dataPoints.find((d) => d.attributes['awareness.reason'] === 'foreign-id');
    const oversized = counter.dataPoints.find((d) => d.attributes['awareness.reason'] === 'oversized');
    expect(foreign.value).toBe(11);
    expect(oversized.value).toBe(1);
  });

  test('resupply resolutions split resolved from honestly-refused', async () => {
    metrics.recordResupplyResolution('resolved');
    metrics.recordResupplyResolution('unresolved');
    metrics.recordResupplyResolution('unresolved');

    const collected = await capture.getMetrics();
    const counter = capture.findMetric(collected, 'collab.resupply.resolutions');
    expect(counter).toBeDefined();
    const resolved = counter.dataPoints.find((d) => d.attributes['resupply.outcome'] === 'resolved');
    const unresolved = counter.dataPoints.find((d) => d.attributes['resupply.outcome'] === 'unresolved');
    expect(resolved.value).toBe(1);
    expect(unresolved.value).toBe(2);
  });

  test('a metrics fault never propagates into the path being measured', () => {
    // Every recorder is wrapped: an instrument failure must not add a failure
    // mode to a refusal, a close, or a resolution.
    const spy = jest.spyOn(metrics, 'recordBindRefusal');
    expect(() => metrics.recordAwarenessBlocked(undefined, NaN)).not.toThrow();
    expect(() => metrics.recordResupplyResolution(undefined)).not.toThrow();
    spy.mockRestore();
  });
});

// The counter above only proves the recorder adds what it is HANDED. That is
// not the property that matters: the caller reads its argument out of the
// suppressor's payload, and the payload carries two numbers that are easy to
// confuse. This drives the REAL suppressor and asserts the counter total equals
// the number of frames actually dropped — the bug it catches (passing the
// running total `dropped` instead of the per-emission delta `sinceLastLog`)
// shipped once and over-reported ~5x on a 1000-frame flood.
describe('awareness block counter counts frames, not cumulative totals', () => {
  const { createDropSuppressor } = require('../ws-awareness-guard');

  test('the counter total equals the frames dropped, across many suppression windows', async () => {
    let clock = 0;
    const suppressor = createDropSuppressor({ windowMs: 1000, now: () => clock });

    const FRAMES = 1000;
    for (let i = 0; i < FRAMES; i += 1) {
      clock += 100; // 10 frames per suppression window
      const payload = suppressor.record();
      // Exactly what server/index.js does with a non-null payload.
      if (payload) metrics.recordAwarenessBlocked('flood-probe', payload.sinceLastLog);
    }
    const flushed = suppressor.flush ? suppressor.flush() : null;
    if (flushed && flushed.sinceLastLog) {
      metrics.recordAwarenessBlocked('flood-probe', flushed.sinceLastLog);
    }

    const collected = await capture.getMetrics();
    const counter = capture.findMetric(collected, 'collab.awareness.blocked');
    const dp = counter.dataPoints.find((d) => d.attributes['awareness.reason'] === 'flood-probe');
    // Every frame is either reported in its own emission or folded into the
    // next one, so the total can never exceed the frames dropped.
    expect(dp.value).toBeLessThanOrEqual(FRAMES);
    // And with a flush it accounts for all of them.
    expect(dp.value).toBeGreaterThan(FRAMES * 0.9);
  });
});

// ── The 057 live-consistency counters ─────────────────────────────────────────
// The design amendment's telemetry bullet: each way a pod's memory can disagree
// with the durable log gets a counter, so the defect classes are measurable
// after deploy instead of inferable from pod logs.
describe('057 live-consistency counters', () => {
  /** Counter values are cumulative across this file, so assert on deltas. */
  async function counterValue(name, predicate = () => true) {
    const counter = capture.findMetric(await capture.getMetrics(), name);
    if (!counter) return 0;
    return counter.dataPoints
      .filter((d) => predicate(d.attributes))
      .reduce((sum, d) => sum + d.value, 0);
  }

  test('gapped serves count per incompleteness reason', async () => {
    const before = await counterValue('collab.read.gapped_serves');

    metrics.recordGappedServe('gap');
    metrics.recordGappedServe('gap');
    metrics.recordGappedServe('short-tail');
    metrics.recordGappedServe('gap+short-tail');

    const collected = await capture.getMetrics();
    const counter = capture.findMetric(collected, 'collab.read.gapped_serves');
    expect(counter).toBeDefined();
    const byReason = (r) => counter.dataPoints.find((d) => d.attributes['gap.reason'] === r);
    expect(byReason('gap').value).toBe(2);
    expect(byReason('short-tail').value).toBe(1);
    expect(byReason('gap+short-tail').value).toBe(1);
    expect(await counterValue('collab.read.gapped_serves')).toBe(before + 4);
  });

  test('an unrecognised gap reason is labelled, never dropped or passed through raw', async () => {
    metrics.recordGappedServe('something-new');

    const counter = capture.findMetric(await capture.getMetrics(), 'collab.read.gapped_serves');
    expect(counter.dataPoints.find((d) => d.attributes['gap.reason'] === 'unknown').value).toBe(1);
    // Bounded cardinality: the raw string never becomes a label value.
    expect(counter.dataPoints.some((d) => d.attributes['gap.reason'] === 'something-new')).toBe(false);
  });

  test('stale serves count', async () => {
    const before = await counterValue('collab.read.stale_serves');
    metrics.recordStaleServe();
    metrics.recordStaleServe();
    expect(await counterValue('collab.read.stale_serves')).toBe(before + 2);
  });

  test('reconcile repairs count', async () => {
    const before = await counterValue('collab.reconcile.repairs');
    metrics.recordReconcileRepair();
    expect(await counterValue('collab.reconcile.repairs')).toBe(before + 1);
  });

  test('bind refusals carry a reason, and the default is the unchanged 041 behavior', async () => {
    const loadErrorBefore = await counterValue(
      'collab.bind.refusals', (a) => a['refusal.reason'] === 'load-error'
    );
    const incompleteBefore = await counterValue(
      'collab.bind.refusals', (a) => a['refusal.reason'] === 'incomplete-load'
    );

    metrics.recordBindRefusal();                    // 041 call shape — unchanged
    metrics.recordBindRefusal('load-error');
    metrics.recordBindRefusal('incomplete-load');

    expect(await counterValue('collab.bind.refusals', (a) => a['refusal.reason'] === 'load-error'))
      .toBe(loadErrorBefore + 2);
    expect(await counterValue('collab.bind.refusals', (a) => a['refusal.reason'] === 'incomplete-load'))
      .toBe(incompleteBefore + 1);
  });

  test('an unknown refusal reason falls back to load-error rather than inventing a label', async () => {
    const before = await counterValue('collab.bind.refusals', (a) => a['refusal.reason'] === 'load-error');
    metrics.recordBindRefusal('who-knows');
    expect(await counterValue('collab.bind.refusals', (a) => a['refusal.reason'] === 'load-error'))
      .toBe(before + 1);
  });

  test('the new recorders swallow their own faults (metrics never break the measured path)', () => {
    // Force every instrument lookup to throw, exactly as a broken meter would.
    metrics._resetForTest();
    const telemetry = require('../telemetry');
    const spy = jest.spyOn(telemetry, 'getMeter').mockImplementation(() => {
      throw new Error('meter exploded');
    });
    try {
      expect(() => metrics.recordGappedServe('gap')).not.toThrow();
      expect(() => metrics.recordStaleServe()).not.toThrow();
      expect(() => metrics.recordReconcileRepair()).not.toThrow();
      expect(() => metrics.recordBindRefusal('incomplete-load')).not.toThrow();
    } finally {
      spy.mockRestore();
      metrics._resetForTest();
    }
  });
});
