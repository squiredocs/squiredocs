/**
 * Feature 021 (DR-3) — POST /api/collab/render-skip-report.
 *
 * The beacon is an untrusted-input boundary (Constitution V): auth required,
 * 8 KB body cap, shape-validated and content-free by construction,
 * rate-limited per user. Valid reports emit one structured log line and
 * increment the collab.render_skip.reports OTel counter; malformed input is
 * rejected 400 with zero side effects.
 *
 * The mount mirrors server/index.js exactly (same middleware chain, same
 * handler body) — the repo's established pattern for index.js-mounted routes
 * (cf. chat-body-limit.test.js, client-config.test.js).
 */
const request = require('supertest');
const express = require('express');

const rateLimit = require('../rate-limit');
const telemetryMetrics = require('../telemetry/metrics');
const { requireAuth } = require('../auth');
const { generateAccessToken } = require('../auth/jwt');

describe('021 render-skip beacon: POST /api/collab/render-skip-report', () => {
  let app;
  let authToken;
  let logSpy;
  let skipCounterSpy;

  beforeAll(() => {
    authToken = generateAccessToken({
      id: '00000000-0000-4000-8000-000000000022',
      email: 'skip-report-test@example.com',
      name: 'Skip Report Test',
    });

    app = express();
    // Mirror server/index.js exactly:
    app.post(
      '/api/collab/render-skip-report',
      requireAuth,
      rateLimit.perUser('collabSkip'),
      express.json({ limit: '8kb' }),
      (req, res) => {
        const bad = (msg) => res.status(400).json({ error: msg });
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Malformed report');
        const { docId, bindingVersion, events } = body;
        if (Object.keys(body).length !== 3) return bad('Unexpected report fields');
        if (typeof docId !== 'string' || docId.length === 0 || docId.length > 64) return bad('Invalid docId');
        if (typeof bindingVersion !== 'string' || bindingVersion.length === 0 || bindingVersion.length > 64) {
          return bad('Invalid bindingVersion');
        }
        if (!Array.isArray(events) || events.length === 0 || events.length > 20) return bad('Invalid events');
        for (const ev of events) {
          if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return bad('Invalid event');
          if (Object.keys(ev).length !== 3) return bad('Unexpected event fields');
          if (typeof ev.nodeType !== 'string' || ev.nodeType.length === 0 || ev.nodeType.length > 64) {
            return bad('Invalid event nodeType');
          }
          if (typeof ev.errorName !== 'string' || ev.errorName.length === 0 || ev.errorName.length > 64) {
            return bad('Invalid event errorName');
          }
          if (!Number.isInteger(ev.count) || ev.count < 1 || ev.count > 1000000) {
            return bad('Invalid event count');
          }
        }
        console.log(
          `[CollabSkipReport] doc=${docId} user=${req.user.userId} bindingVersion=${bindingVersion} events=${JSON.stringify(events)}`
        );
        for (const ev of events) {
          telemetryMetrics.recordCollabRenderSkip(ev.nodeType, ev.errorName, ev.count);
        }
        res.sendStatus(204);
      }
    );
    // Mirror index.js body-parse error branch (oversize -> 413).
    app.use((err, req, res, next) => {
      if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
        if (!res.headersSent) {
          res.status(err.type === 'entity.too.large' ? 413 : 400).json({
            error: err.type === 'entity.too.large' ? 'Request body too large' : 'Malformed request body',
          });
        }
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    });
  });

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    skipCounterSpy = jest.spyOn(telemetryMetrics, 'recordCollabRenderSkip');
  });

  afterEach(() => {
    logSpy.mockRestore();
    skipCounterSpy.mockRestore();
  });

  const validReport = () => ({
    docId: '60c46c15-0000-4000-8000-000000000000',
    bindingVersion: '3.0.7+squire021',
    events: [
      { nodeType: 'squireUnknownNode021', errorName: 'RangeError', count: 1 },
      { nodeType: '#text', errorName: 'TypeError', count: 3 },
    ],
  });

  test('valid report: 204, one structured log line, counter per event', async () => {
    const res = await request(app)
      .post('/api/collab/render-skip-report')
      .set('Authorization', `Bearer ${authToken}`)
      .send(validReport());

    expect(res.status).toBe(204);

    const lines = logSpy.mock.calls.filter((c) => String(c[0]).startsWith('[CollabSkipReport]'));
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toContain('doc=60c46c15-0000-4000-8000-000000000000');
    expect(lines[0][0]).toContain('bindingVersion=3.0.7+squire021');
    expect(lines[0][0]).toContain('squireUnknownNode021');

    expect(skipCounterSpy).toHaveBeenCalledTimes(2);
    expect(skipCounterSpy).toHaveBeenCalledWith('squireUnknownNode021', 'RangeError', 1);
    expect(skipCounterSpy).toHaveBeenCalledWith('#text', 'TypeError', 3);
  });

  test.each([
    ['missing docId', () => { const r = validReport(); delete r.docId; return r; }],
    ['empty events', () => ({ ...validReport(), events: [] })],
    ['too many events', () => ({ ...validReport(), events: Array.from({ length: 21 }, () => ({ nodeType: 'x', errorName: 'E', count: 1 })) })],
    ['non-integer count', () => { const r = validReport(); r.events[0].count = 1.5; return r; }],
    ['zero count', () => { const r = validReport(); r.events[0].count = 0; return r; }],
    ['oversize nodeType', () => { const r = validReport(); r.events[0].nodeType = 'x'.repeat(65); return r; }],
    ['content smuggling: extra event field', () => { const r = validReport(); r.events[0].documentText = 'secret'; return r; }],
    ['content smuggling: extra report field', () => ({ ...validReport(), body: 'secret' })],
    ['array body', () => [1, 2, 3]],
  ])('malformed report (%s): 400 with no side effects', async (_name, make) => {
    const res = await request(app)
      .post('/api/collab/render-skip-report')
      .set('Authorization', `Bearer ${authToken}`)
      .send(make());

    expect(res.status).toBe(400);
    expect(logSpy.mock.calls.filter((c) => String(c[0]).startsWith('[CollabSkipReport]'))).toHaveLength(0);
    expect(skipCounterSpy).not.toHaveBeenCalled();
  });

  test('oversize body (>8kb): 413 with no side effects', async () => {
    const r = validReport();
    r.events = [{ nodeType: 'x'.repeat(60), errorName: 'E', count: 1 }];
    // Pad via many max-size events? No — keep shape small but body big:
    const big = JSON.stringify(r).replace('"3.0.7+squire021"', `"${'v'.repeat(9000)}"`);
    const res = await request(app)
      .post('/api/collab/render-skip-report')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Content-Type', 'application/json')
      .send(big);

    expect(res.status).toBe(413);
    expect(skipCounterSpy).not.toHaveBeenCalled();
  });

  test('unauthenticated: 401', async () => {
    const res = await request(app).post('/api/collab/render-skip-report').send(validReport());
    expect(res.status).toBe(401);
    expect(skipCounterSpy).not.toHaveBeenCalled();
  });
});
