/**
 * Feature 010, US3 (FR-017, SC-005/009): the /api/chat inline body is bounded by
 * CHAT_BODY_LIMIT; an over-limit body (including legacy inline base64) is
 * rejected 413 with an actionable message pointing at the attachment path, while
 * a realistic text-only conversation under the limit is accepted.
 *
 * The mount + body-parse error branch mirror server/index.js exactly (the JSON
 * limit reads CHAT_BODY_LIMIT; the 413 message is chat-specific by originalUrl).
 */
process.env.CHAT_BODY_LIMIT = '1kb'; // small so "over limit" needs no huge payload

const request = require('supertest');
const express = require('express');

const CHAT_413_MESSAGE =
  'Request body too large. Upload attachments via POST /api/chat/attachments and send references instead of inline image data.';

function buildApp() {
  const app = express();
  // Mirror index.js: /api/chat parses JSON at CHAT_BODY_LIMIT.
  app.use('/api/chat', express.json({ limit: process.env.CHAT_BODY_LIMIT || '10mb' }), (req, res) => {
    res.json({ ok: true, bytes: JSON.stringify(req.body).length });
  });
  // Mirror index.js body-parse error branch.
  app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      if (!res.headersSent) {
        const tooLarge = err.type === 'entity.too.large';
        const isChat = typeof req.originalUrl === 'string' && req.originalUrl.startsWith('/api/chat');
        const tooLargeMessage = isChat ? CHAT_413_MESSAGE : 'Request body too large';
        res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? tooLargeMessage : 'Malformed request body' });
      }
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

describe('chat body limit (FR-017)', () => {
  const app = buildApp();

  it('rejects an over-limit body with a 413 pointing at the attachment path', async () => {
    const big = { id: 'c1', message: { parts: [{ type: 'text', text: 'x'.repeat(4000) }] } };
    const res = await request(app).post('/api/chat').send(big);
    expect(res.status).toBe(413);
    expect(res.body.error).toBe(CHAT_413_MESSAGE);
  });

  it('rejects a legacy inline-base64 image body over the limit with the same 413', async () => {
    const base64 = 'data:image/png;base64,' + 'A'.repeat(4000);
    const res = await request(app)
      .post('/api/chat')
      .send({ id: 'c2', message: { parts: [{ type: 'file', mediaType: 'image/png', url: base64 }] } });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe(CHAT_413_MESSAGE);
  });

  it('accepts a realistic text-only conversation under the limit', async () => {
    const convo = { id: 'c3', message: { parts: [{ type: 'text', text: 'Summarize the meeting notes please.' }] } };
    const res = await request(app).post('/api/chat').send(convo);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
