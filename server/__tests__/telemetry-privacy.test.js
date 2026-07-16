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
    // Sweep the FULL span record (attributes + status + events), not just
    // attributes — content can hide in status.message / exception events too.
    expect(containsSentinel(capture.serializeSpan(span))).toBe(false);
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
    expect(containsSentinel(capture.serializeSpan(captured))).toBe(false);
  });

  test('error-path span: sentinel in Error message/stack + status appears NOWHERE, exception.type + ERROR code survive', () => {
    // withSpan wraps a fn that throws an Error whose message quotes document-text-
    // like content (the MCP-modify-error / raw-PG-error smuggling channel). The
    // sentinel must not survive in ANY channel — attributes, status.message, or
    // exception-event attributes — while status.code stays ERROR and the
    // content-free exception.type survives for triage.
    const boom = `content=${SENTINEL_TEXT} title=${SENTINEL_TITLE}`;
    expect(() =>
      withSpan('collab.operation', { 'document.guid': 'doc-err-1' }, () => {
        throw new TypeError(boom);
      })
    ).toThrow();

    const span = capture.getSpans().find((s) => s.name === 'collab.operation');
    expect(span).toBeDefined();

    // Sentinel present NOWHERE in the full span record.
    expect(containsSentinel(capture.serializeSpan(span))).toBe(false);
    expect(containsSentinel(span.status.message || '')).toBe(false);

    // status.code preserved as ERROR (2) so error-rate dashboards still fire.
    expect(span.status.code).toBe(api.SpanStatusCode.ERROR);
    expect(span.attributes.outcome).toBe('error');

    // exception.type survives (content-free), message/stacktrace are gone.
    const exEvent = (span.events || []).find((e) => e.name === 'exception');
    expect(exEvent).toBeDefined();
    expect(exEvent.attributes['exception.type']).toBe('TypeError');
    expect(exEvent.attributes['exception.message']).toBeUndefined();
    expect(exEvent.attributes['exception.stacktrace']).toBeUndefined();
  });

  test('redaction backstop scrubs a RAW auto-instrumentation-style error span (pg status.message + recordException)', () => {
    // Simulates what instrumentation-pg / ioredis produce directly on a tracer
    // span (bypassing withSpan): a raw status.message embedding user values and a
    // recordException carrying the full error. The processor must scrub both.
    const tracer = telemetry.getTracer();
    const span = tracer.startSpan('pg.query', { attributes: { 'db.system': 'postgresql' } });
    span.recordException(new Error(`duplicate key value violates ... Detail: Key=(${SENTINEL_TEXT})`));
    span.setStatus({
      code: api.SpanStatusCode.ERROR,
      message: `error: invalid input value "${SENTINEL_QUERY}"`,
    });
    span.end();

    const captured = capture.getSpans().find((s) => s.name === 'pg.query');
    expect(captured).toBeDefined();
    expect(containsSentinel(capture.serializeSpan(captured))).toBe(false);
    expect(captured.status.code).toBe(api.SpanStatusCode.ERROR); // outcome preserved
    const exEvent = (captured.events || []).find((e) => e.name === 'exception');
    expect(exEvent.attributes['exception.type']).toBe('Error'); // triage id kept
    expect(exEvent.attributes['exception.message']).toBeUndefined();
    expect(exEvent.attributes['exception.stacktrace']).toBeUndefined();
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
