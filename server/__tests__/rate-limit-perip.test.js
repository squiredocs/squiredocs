/**
 * Feature 010, US2 (FR-005/006/009/012, SC-003): per-IP and per-user budgets
 * emit a uniform 429 + Retry-After, are keyed correctly (IP vs user), and
 * /health + /ready are exempt.
 *
 * Deterministic: forces the per-process memory limiter with small budgets set
 * before the module loads, and opts limiting in under test.
 */
process.env.RL_TEST_ENABLE = '1';
process.env.RL_FORCE_MEMORY = '1';
process.env.RL_AUTH_PER_MIN = '3';
process.env.RL_CHAT_PER_MIN = '2';
process.env.RL_VERSION_HISTORY_PER_MIN = '3';
process.env.RL_IMPORT_PER_MIN = '2';

const request = require('supertest');
const express = require('express');
const rateLimit = require('../rate-limit');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);

  // Exempt endpoints — mounted with no limiter.
  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));
  app.get('/ready', (req, res) => res.status(200).json({ status: 'ready' }));

  // Per-IP limited route.
  app.get('/auth/thing', rateLimit.perIp('auth'), (req, res) => res.json({ ok: true }));

  // Per-user limited route (fake auth sets req.user).
  const fakeAuth = (req, res, next) => { req.user = { userId: req.get('x-user') || 'user-a' }; next(); };
  app.post('/api/chat', fakeAuth, rateLimit.perUser('chat'), (req, res) => res.json({ ok: true }));

  // Version-history class (F8): the /history* and /versions* routes mount this.
  app.get('/api/docs/:docId/history', fakeAuth, rateLimit.perUser('versionHistory'), (req, res) => res.json({ ok: true }));

  // Import class: agent-facing, so its 429 carries retry guidance.
  app.put('/api/docs/:docId/import', fakeAuth, rateLimit.perUser('import'), (req, res) => res.json({ ok: true }));

  return app;
}

describe('rate limit — per-IP & per-user (FR-005/006/009)', () => {
  let app;
  beforeEach(() => { rateLimit._reset(); app = buildApp(); });

  it('per-IP: 4th request from one IP → 429 with Retry-After; another IP unaffected', async () => {
    const ipA = '9.9.9.9';
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).get('/auth/thing').set('X-Forwarded-For', ipA);
      expect(ok.status).toBe(200);
    }
    const limited = await request(app).get('/auth/thing').set('X-Forwarded-For', ipA);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Rate limit exceeded. Retry later.' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // A different IP still has its full budget.
    const otherIp = await request(app).get('/auth/thing').set('X-Forwarded-For', '8.8.8.8');
    expect(otherIp.status).toBe(200);
  });

  it('per-user: budget keyed on user id, shared across IPs', async () => {
    // user-a exhausts a 2/min budget from two different IPs.
    await request(app).post('/api/chat').set('x-user', 'user-a').set('X-Forwarded-For', '1.1.1.1');
    await request(app).post('/api/chat').set('x-user', 'user-a').set('X-Forwarded-For', '2.2.2.2');
    const limited = await request(app).post('/api/chat').set('x-user', 'user-a').set('X-Forwarded-For', '3.3.3.3');
    expect(limited.status).toBe(429);

    // A different user is unaffected.
    const other = await request(app).post('/api/chat').set('x-user', 'user-b');
    expect(other.status).toBe(200);
  });

  it('version-history class: over-budget per user → 429; a different user is unaffected (F8)', async () => {
    // Budget is 3/min per user.
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).get('/api/docs/doc-1/history').set('x-user', 'vh-user');
      expect(ok.status).toBe(200);
    }
    const limited = await request(app).get('/api/docs/doc-1/history').set('x-user', 'vh-user');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'Rate limit exceeded. Retry later.' });

    // A different user still has full budget.
    const other = await request(app).get('/api/docs/doc-1/history').set('x-user', 'vh-user-2');
    expect(other.status).toBe(200);
  });

  it('import class: 429 tells the caller how long to wait', async () => {
    for (let i = 0; i < 2; i++) {
      const ok = await request(app).put('/api/docs/doc-1/import').set('x-user', 'imp-user');
      expect(ok.status).toBe(200);
    }
    const limited = await request(app).put('/api/docs/doc-1/import').set('x-user', 'imp-user');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('Rate limit exceeded for markdown import.');
    expect(limited.body.retryAfterSeconds).toBe(Number(limited.headers['retry-after']));
    expect(limited.body.guidance).toContain(`Wait ${limited.body.retryAfterSeconds}s`);
  });

  it('import and export default to 240/min when not overridden', () => {
    expect(rateLimit.CLASSES.export.points).toBe(240);
    const saved = process.env.RL_IMPORT_PER_MIN;
    delete process.env.RL_IMPORT_PER_MIN;
    jest.isolateModules(() => {
      expect(require('../rate-limit').CLASSES.import.points).toBe(240);
    });
    process.env.RL_IMPORT_PER_MIN = saved;
  });

  it('/health and /ready are never rate-limited (FR-012)', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await request(app).get('/health')).status).toBe(200);
      expect((await request(app).get('/ready')).status).toBe(200);
    }
  });
});
