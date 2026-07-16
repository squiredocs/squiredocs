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
