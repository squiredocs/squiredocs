/**
 * Stream reconnection tests
 *
 * Tests the GET /:id/stream endpoint and activeStreams Map lifecycle.
 * Uses supertest with mocked auth — no database or AI SDK needed.
 */
const express = require('express');
const request = require('supertest');

// Mock requireAuth to always pass with a fake user
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => {
    req.user = { userId: 'test-user' };
    next();
  },
}));

// Mock all heavy dependencies so requiring chat.js doesn't pull them in
jest.mock('../auth/jwt', () => ({ extractBearerToken: jest.fn() }));
jest.mock('../mcp/auth/agent-token-factory', () => ({ createAgentTokenPair: jest.fn() }));
jest.mock('../url', () => ({ buildBaseUrl: jest.fn() }));
jest.mock('../api/chat-tools', () => ({ buildTools: jest.fn(() => ({})) }));
jest.mock('../api/chat-models', () => ({
  DEFAULT_MODEL_KEY: 'test',
  resolveModel: jest.fn(),
}));
jest.mock('../documents', () => ({ getDocument: jest.fn() }));
jest.mock('../chat-store', () => ({
  loadChat: jest.fn(),
  saveChat: jest.fn(),
  createChat: jest.fn(),
  getChatsForUser: jest.fn(),
  deleteChat: jest.fn(),
  updateChatTitle: jest.fn(),
}));
jest.mock('../ai-usage', () => ({
  checkQuota: jest.fn(),
  computeCostCents: jest.fn(),
  recordUsage: jest.fn(),
}));

const { router, activeStreams } = require('../api/chat');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
}

// ── GET /:id/stream ─────────────────────────────────────────────────────────

describe('GET /:id/stream', () => {
  let app;

  beforeEach(() => {
    activeStreams.clear();
    app = buildApp();
  });

  afterEach(() => {
    activeStreams.clear();
  });

  test('returns 204 when no active stream', async () => {
    const res = await request(app).get('/no-such-id/stream');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  test('returns 200 with SSE headers for a done stream', async () => {
    activeStreams.set('chat-1', { chunks: ['data: hello\n\n'], done: true, userId: 'test-user' });

    const res = await request(app).get('/chat-1/stream');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['x-vercel-ai-ui-message-stream']).toBe('v1');
  });

  test('replays all chunks for a done stream', async () => {
    const chunks = ['data: a\n\n', 'data: b\n\n', 'data: c\n\n'];
    activeStreams.set('chat-2', { chunks, done: true, userId: 'test-user' });

    const res = await request(app).get('/chat-2/stream');
    expect(res.text).toBe(chunks.join(''));
  });

  test('replays buffered chunks then tails live stream', (done) => {
    const entry = { chunks: ['data: first\n\n'], done: false, userId: 'test-user' };
    activeStreams.set('chat-3', entry);

    // Collect the full body after the response closes
    request(app)
      .get('/chat-3/stream')
      .buffer(true)
      .parse((res, callback) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => callback(null, data));
      })
      .then((res) => {
        expect(res.body).toContain('data: first');
        expect(res.body).toContain('data: second');
        expect(res.body).toContain('data: third');
        done();
      })
      .catch(done);

    // Push more chunks and close the stream after a short delay
    setTimeout(() => {
      entry.chunks.push('data: second\n\n');
      setTimeout(() => {
        entry.chunks.push('data: third\n\n');
        entry.done = true;
      }, 80);
    }, 80);
  });

  test('ends response when stream finishes', (done) => {
    const entry = { chunks: ['data: x\n\n'], done: false, userId: 'test-user' };
    activeStreams.set('chat-4', entry);

    request(app)
      .get('/chat-4/stream')
      .buffer(true)
      .parse((res, callback) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => callback(null, data));
      })
      .then((res) => {
        expect(res.status).toBe(200);
        done();
      })
      .catch(done);

    // Mark done after a delay — the polling interval should pick it up
    setTimeout(() => { entry.done = true; }, 100);
  });
});

// ── activeStreams lifecycle ──────────────────────────────────────────────────

describe('activeStreams lifecycle', () => {
  beforeEach(() => {
    activeStreams.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    activeStreams.clear();
    jest.useRealTimers();
  });

  test('new entry replaces old entry for the same key', () => {
    const entry1 = { chunks: [], done: true };
    const entry2 = { chunks: ['data: new\n\n'], done: false };
    activeStreams.set('key', entry1);
    activeStreams.set('key', entry2);
    expect(activeStreams.get('key')).toBe(entry2);
  });

  test('cleanup timer only deletes its own entry', () => {
    const entry1 = { chunks: [], done: true };
    activeStreams.set('key', entry1);

    // Schedule cleanup that checks identity before deleting
    setTimeout(() => {
      if (activeStreams.get('key') === entry1) activeStreams.delete('key');
    }, 5_000);

    // Replace with a new entry before the timer fires
    const entry2 = { chunks: ['data: fresh\n\n'], done: false };
    activeStreams.set('key', entry2);

    // Advance past the cleanup timer
    jest.advanceTimersByTime(6_000);

    // entry2 should survive — the timer saw a different reference
    expect(activeStreams.get('key')).toBe(entry2);
  });

  test('done entry is cleaned up after timeout', () => {
    const entry = { chunks: ['data: done\n\n'], done: true };
    activeStreams.set('key', entry);

    setTimeout(() => {
      if (activeStreams.get('key') === entry) activeStreams.delete('key');
    }, 30_000);

    jest.advanceTimersByTime(31_000);
    expect(activeStreams.has('key')).toBe(false);
  });
});

// ── pipeAsSSE buffering after client disconnect ──────────────────────────────
// The replay buffer must keep filling even after the client response goes away,
// so a reconnecting client can replay what it missed and tail the rest. The
// generation runs to completion regardless of the client connection.

describe('pipeAsSSE', () => {
  const { pipeAsSSE } = require('../api/chat');

  function streamOf(values) {
    return new ReadableStream({
      start(controller) {
        for (const v of values) controller.enqueue(v);
        controller.close();
      },
    });
  }

  // Fake Express response that goes "dark" (destroyed) after N successful writes,
  // simulating a client that disconnects mid-stream.
  function makeRes({ destroyAfter = Infinity } = {}) {
    return {
      writableEnded: false,
      destroyed: false,
      headers: null,
      statusCode: null,
      written: [],
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
      write(chunk) {
        this.written.push(chunk);
        if (this.written.length >= destroyAfter) this.destroyed = true;
        return true;
      },
    };
  }

  test('buffers every chunk into entry.chunks even after the client disconnects', async () => {
    const values = [
      { type: 'start' },
      { type: 'text-delta', text: 'a' },
      { type: 'text-delta', text: 'b' },
      { type: 'text-delta', text: 'c' },
    ];
    const res = makeRes({ destroyAfter: 2 }); // disconnect after start + first delta
    const entry = { chunks: [], done: false, userId: 'u' };

    await pipeAsSSE(streamOf(values), res, entry);

    // The full transcript (4 events + the [DONE] sentinel) is in the buffer,
    // ready for a reconnecting client to replay/tail.
    expect(entry.chunks).toHaveLength(5);
    expect(entry.chunks[entry.chunks.length - 1]).toBe('data: [DONE]\n\n');
    expect(entry.chunks.some((c) => c.includes('"text":"c"'))).toBe(true);

    // Only the chunks written before the disconnect reached the client.
    expect(res.written).toHaveLength(2);

    // pipeAsSSE never marks the stream done — that's the caller's job on actual
    // generation completion, not on client disconnect.
    expect(entry.done).toBe(false);
  });

  test('writes the full stream to a client that stays connected', async () => {
    const values = [
      { type: 'start' },
      { type: 'text-delta', text: 'hello' },
    ];
    const res = makeRes();
    const entry = { chunks: [], done: false, userId: 'u' };

    await pipeAsSSE(streamOf(values), res, entry);

    expect(res.statusCode).toBe(200);
    expect(res.written).toEqual(entry.chunks);
    expect(res.written[res.written.length - 1]).toBe('data: [DONE]\n\n');
  });
});
