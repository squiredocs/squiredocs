/**
 * US4 — privacy invariant (feature 014, FR-019/020/024, SC-005, RBD-6).
 *
 * The trust-level invariant "document content never enters telemetry" is proven
 * by flowing SENTINEL strings (document text, title, search query, chat content)
 * through the instrumented surfaces and asserting they appear in NO captured
 * span, metric, or log-field addition — while the permitted identifiers (doc
 * GUID, user id, route template) ARE present. Enforcement is by construction
 * (safeAttributes) PLUS the RedactionSpanProcessor backstop, not convention.
 */
const capture = require('./helpers/telemetry-capture');
capture.installCapture();

const express = require('express');
const request = require('supertest');
const api = require('@opentelemetry/api');

const telemetry = require('../telemetry');
const metrics = require('../telemetry/metrics');
const { withSpan } = require('../telemetry/spans');
const { safeAttributes } = require('../telemetry/privacy');

const SENTINEL_TEXT = 'SENTINEL_DOCUMENT_BODY_TEXT_9f3a';
const SENTINEL_TITLE = 'SENTINEL_TITLE_c71b';
const SENTINEL_QUERY = 'SENTINEL_SEARCH_QUERY_44de';
const SENTINEL_CHAT = 'SENTINEL_CHAT_MESSAGE_2b90';
const SENTINELS = [SENTINEL_TEXT, SENTINEL_TITLE, SENTINEL_QUERY, SENTINEL_CHAT];

let server;

beforeAll((done) => {
  const app = express();
  app.use(metrics.httpMetricsMiddleware());
  app.get('/api/docs/:docId', (req, res) => res.json({ ok: true }));
  server = app.listen(0, done);
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await capture.shutdown();
});

beforeEach(() => capture.reset());

function containsSentinel(str) {
  return SENTINELS.some((s) => str.includes(s));
}

describe('construction-time allowlist (safeAttributes)', () => {
  test('drops content keys, keeps permitted identifiers', () => {
    const filtered = safeAttributes({
      'document.guid': 'doc-123',
      'user.id': 'user-9',
      'document.text': SENTINEL_TEXT,
      'document.title': SENTINEL_TITLE,
      'search.query': SENTINEL_QUERY,
      'chat.message': SENTINEL_CHAT,
      'db.statement': `INSERT ... ${SENTINEL_TEXT}`,
    });
    expect(filtered['document.guid']).toBe('doc-123');
    expect(filtered['user.id']).toBe('user-9');
    expect(JSON.stringify(filtered)).not.toContain('SENTINEL');
  });
});

describe('redaction backstop on emitted spans', () => {
  test('content-bearing attributes are stripped from a captured span', () => {
    // Even if a caller tried to attach content, the span carries only permitted
    // identifiers after construction filtering + the redaction processor.
    withSpan(
      'collab.operation',
      {
        'document.guid': 'doc-guid-abc',
        'collab.operation': 'markdown.sync',
        'document.text': SENTINEL_TEXT,
        'document.title': SENTINEL_TITLE,
      },
      () => 'ok'
    );
    const span = capture.getSpans().find((s) => s.name === 'collab.operation');
    expect(span.attributes['document.guid']).toBe('doc-guid-abc'); // permitted present
    expect(containsSentinel(JSON.stringify(span.attributes))).toBe(false);
    expect(span.attributes['document.text']).toBeUndefined();
    expect(span.attributes['document.title']).toBeUndefined();
  });

  test('redaction strips concrete URL / db.statement keys from a raw span (FR-003)', () => {
    const tracer = telemetry.getTracer();
    const span = tracer.startSpan('manual-http', {
      attributes: {
        'http.route': '/api/docs/:docId',
        'http.target': `/api/docs/real-id?q=${SENTINEL_QUERY}`,
        'url.full': `http://x/api/docs/real-id?q=${SENTINEL_QUERY}`,
        'db.statement': `SELECT * WHERE body = '${SENTINEL_TEXT}'`,
      },
    });
    span.end();
    const captured = capture.getSpans().find((s) => s.name === 'manual-http');
    expect(captured.attributes['http.route']).toBe('/api/docs/:docId'); // template kept
    expect(captured.attributes['http.target']).toBeUndefined();
    expect(captured.attributes['url.full']).toBeUndefined();
    expect(captured.attributes['db.statement']).toBeUndefined();
    expect(containsSentinel(JSON.stringify(captured.attributes))).toBe(false);
  });
});

describe('metric labels carry no content', () => {
  test('a request to a sentinel-bearing path labels by route TEMPLATE only', async () => {
    await request(server).get(`/api/docs/${SENTINEL_TEXT}?q=${SENTINEL_QUERY}`).expect(200);
    const collected = await capture.getMetrics();
    const serialized = JSON.stringify(collected);
    expect(containsSentinel(serialized)).toBe(false);
    const count = capture.findMetric(collected, 'http.server.request.count');
    expect(count.dataPoints.some((d) => d.attributes['http.route'] === '/api/docs/:docId')).toBe(true);
  });
});

describe('log lines add only correlation, never content', () => {
  test('the shim injects only trace_id/span_id, no content fields', () => {
    const tracer = telemetry.getTracer();
    tracer.startActiveSpan('log-span', (span) => {
      // The app-supplied message may contain anything; the shim does not ADD
      // content — it only adds correlation fields. Assert the field set.
      console.log('doc operation complete');
      span.end();
    });
    const line = capture.getLogLines().find((l) => l.msg === 'doc operation complete');
    expect(line).toBeDefined();
    expect(line.trace_id).toBeDefined();
    expect(line.span_id).toBeDefined();
    // Only these keys are added by the shim.
    expect(Object.keys(line).sort()).toEqual(['level', 'msg', 'span_id', 'time', 'trace_id']);
  });
});
