/**
 * Feature 010 review F5: POST /api/chat/attachments was unmetered (no rate-limit
 * class). It now has a per-user `upload` budget so a single authenticated user
 * cannot hammer 25MB S3 PUTs. Over budget ⇒ the uniform 429.
 *
 * Env is set BEFORE requiring the modules so the `upload` class picks up the
 * small test budget and the memory limiter is used (deterministic, no Redis).
 */
process.env.RL_TEST_ENABLE = '1';   // activate limiting under NODE_ENV=test
process.env.RL_FORCE_MEMORY = '1';  // per-process memory limiter (no Redis dep)
process.env.RL_UPLOAD_PER_MIN = '2'; // tiny budget so the 3rd request is over

// Mock S3 so no bucket is touched.
jest.mock('../image-storage', () => ({
  kind: 's3',
  isEnabled: () => true,
  putObject: jest.fn(async () => {}),
  getObject: jest.fn(async (key) => Buffer.from('BYTES::' + key)),
  cspImageSources: () => [],
}));

// Fake auth keyed off a header so we can vary the principal.
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => { req.user = { userId: req.get('x-test-user') || 'user-a' }; next(); },
}));

const request = require('supertest');
const express = require('express');
const rateLimit = require('../rate-limit');
const { createChatAttachmentsRouter } = require('../api/chat-attachments');

const PNG = 'data:image/png;base64,' + Buffer.from('hello-png').toString('base64');

function buildApp() {
  const app = express();
  app.use(createChatAttachmentsRouter());
  return app;
}

function upload(app, user) {
  return request(app)
    .post('/api/chat/attachments')
    .set('x-test-user', user)
    .send({ data: PNG, mediaType: 'image/png' });
}

describe('chat attachments — per-user upload budget (review F5)', () => {
  beforeEach(() => rateLimit._reset());

  it('has an `upload` rate-limit class', () => {
    expect(rateLimit.CLASSES.upload).toBeDefined();
    expect(rateLimit.CLASSES.upload.points).toBe(2); // from RL_UPLOAD_PER_MIN
  });

  it('returns 429 once the per-user budget is exceeded', async () => {
    const app = buildApp();
    const u = 'user-budget-1';

    expect((await upload(app, u)).status).toBe(201);
    expect((await upload(app, u)).status).toBe(201);

    const third = await upload(app, u);
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: 'Rate limit exceeded. Retry later.' });
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('the budget is per-user (a different user is unaffected)', async () => {
    const app = buildApp();
    // Exhaust user-x's budget.
    await upload(app, 'user-x');
    await upload(app, 'user-x');
    expect((await upload(app, 'user-x')).status).toBe(429);

    // A different user still has their full budget.
    expect((await upload(app, 'user-y')).status).toBe(201);
  });
});
