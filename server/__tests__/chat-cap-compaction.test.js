/**
 * Feature 010, US3 finding G1: the concurrent-stream cap (MAX_STREAMS_PER_USER)
 * and conversation compaction must still trigger under the new reference-based
 * chat-attachment transport (both live in api/chat.js alongside the changed
 * resolution path). This pins that neither regressed.
 */

// Lazy 'ai' import is stubbed so compactMessages runs without a live model.
jest.mock('ai', () => ({
  generateText: jest.fn(async () => ({ text: 'CONcise SUMMARY of the earlier turns' })),
  tool: (x) => x,
  jsonSchema: (x) => x,
}));
// Compaction model factory returns a dummy — the mocked generateText ignores it.
jest.mock('../api/chat-models', () => ({
  ...jest.requireActual('../api/chat-models'),
  getCompactionModel: () => ({ id: 'stub-compaction-model' }),
}));
// Bypass JWT for the stream-cap route test.
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => { req.user = { userId: req.get('x-test-user') || 'u1' }; next(); },
}));

const request = require('supertest');
const express = require('express');
const chat = require('../api/chat');

describe('G1 — concurrent-stream cap still triggers (MAX_STREAMS_PER_USER)', () => {
  function buildApp() {
    const app = express();
    app.use('/api/chat', express.json(), chat.router);
    return app;
  }

  afterEach(() => chat.activeStreams.clear());

  it('rejects a new stream with 429 once the per-user cap is reached', async () => {
    // Saturate the cap for user u1 with live (not-done) streams.
    for (let i = 0; i < chat.MAX_STREAMS_PER_USER; i++) {
      chat.activeStreams.set(`u1-stream-${i}`, { chunks: [], done: false, userId: 'u1' });
    }
    const res = await request(buildApp())
      .post('/api/chat')
      .set('x-test-user', 'u1')
      .send({ id: 'brand-new-chat', message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } });

    // Feature 012: the per-user concurrency cap now surfaces the structured
    // rate_limited taxonomy payload (429), distinct from the usage limit.
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(typeof res.body.error).toBe('string');
  });

  it('a different user with no active streams is not capped', async () => {
    for (let i = 0; i < chat.MAX_STREAMS_PER_USER; i++) {
      chat.activeStreams.set(`u1-stream-${i}`, { chunks: [], done: false, userId: 'u1' });
    }
    // user u2 has 0 streams — the cap loop counts only its own, so it passes the
    // cap check (it then proceeds into the handler; we only assert it's NOT 429).
    const res = await request(buildApp())
      .post('/api/chat')
      .set('x-test-user', 'u2')
      .send({ id: 'u2-chat', message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } });
    expect(res.status).not.toBe(429);
  });
});

describe('G1 — conversation compaction still triggers', () => {
  it('isTokenLimitError detects provider context-length errors (the trigger)', () => {
    expect(chat.isTokenLimitError('prompt is too long: 250000 tokens')).toBe(true);
    expect(chat.isTokenLimitError({ message: 'context_length_exceeded' })).toBe(true);
    expect(chat.isTokenLimitError('exceeds the maximum number of tokens')).toBe(true);
    expect(chat.isTokenLimitError('some unrelated 500 error')).toBe(false);
  });

  it('compactMessages summarizes the older turns and keeps the recent ones', async () => {
    // 15 messages → older 5 compacted into 1 summary, recent 10 kept verbatim.
    const messages = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `turn ${i}` }],
    }));

    const out = await chat.compactMessages(messages);

    expect(out).toHaveLength(11); // 1 summary + 10 recent
    expect(out[0].content[0].text).toContain('Earlier conversation summary');
    expect(out[0].content[0].text).toContain('CONcise SUMMARY');
    // The 10 most-recent turns are preserved verbatim after the summary.
    expect(out[10].content[0].text).toBe('turn 14');
  });
});
