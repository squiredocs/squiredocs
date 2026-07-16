/**
 * Chat error transport (feature 012, US1).
 *
 * The classification decisions (which upstream failure → which code / status /
 * notification) are pinned in chat-errors.test.js and ai-providers.classify.test.js
 * at the single classification seam. This file pins the TRANSPORT behavior that
 * carries a classified failure to the client over the two channels, exercising the
 * real pipeAsSSE (no brittle full-handler streamText mock):
 *   - mid-stream (after content) errors ride the SSE error event, with the
 *     structured code/provider on an ADJACENT transient data-chat-error part, and
 *     neither is written to the reconnection replay buffer (FR-010);
 *   - pre-content errors throw so the caller returns HTTP JSON (Channel A);
 *   - token-limit error chunks are still intercepted before classification (FR-004).
 */
const { pipeAsSSE } = require('../chat');

// A minimal ReadableStream of UI-message-stream chunks (objects), matching what
// toUIMessageStream yields. tee() is used by pipeAsSSE.
function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const ch of chunks) controller.enqueue(ch);
      controller.close();
    },
  });
}

// A fake Express response capturing raw SSE writes.
function fakeRes() {
  return {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writes: [],
    writeHead() { this.headersSent = true; },
    write(chunk) { this.writes.push(chunk); return true; },
    set() {},
    end() { this.writableEnded = true; },
    body() { return this.writes.join(''); },
  };
}

describe('pipeAsSSE error transport (feature 012)', () => {
  test('mid-stream error: structured code rides a transient data-chat-error part + honest error event', async () => {
    const res = fakeRes();
    const entry = { chunks: [], done: false, userId: 'u' };
    const onStreamError = () => ({ errorText: 'The AI provider is busy right now.', code: 'provider_overloaded', provider: 'anthropic' });

    const stream = streamOf([
      { type: 'start' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'partial answer' },
      { type: 'error', errorText: 'raw provider blah' },
    ]);

    await pipeAsSSE(stream, res, entry, { onStreamError });

    const body = res.body();
    // The transient structured part carries the taxonomy code + provider…
    expect(body).toContain('"type":"data-chat-error"');
    expect(body).toContain('"code":"provider_overloaded"');
    expect(body).toContain('"provider":"anthropic"');
    // …and the error event carries the honest string, never the raw provider text.
    expect(body).toContain('"type":"error"');
    expect(body).toContain('The AI provider is busy right now.');
    expect(body).not.toContain('raw provider blah');
  });

  test('mid-stream error is NOT written to the reconnection replay buffer (FR-010)', async () => {
    const res = fakeRes();
    const entry = { chunks: [], done: false, userId: 'u' };
    const onStreamError = () => ({ errorText: 'honest', code: 'byok_invalid_key', provider: 'openai' });

    await pipeAsSSE(streamOf([
      { type: 'start' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'hi' },
      { type: 'error', errorText: 'x' },
    ]), res, entry, { onStreamError });

    const buffered = entry.chunks.join('');
    // The content delta IS buffered (a reconnecting client replays it)…
    expect(buffered).toContain('text-delta');
    // …but neither the error nor the structured part is (would re-trigger onError
    // on a resumeStream replay).
    expect(buffered).not.toContain('"type":"error"');
    expect(buffered).not.toContain('data-chat-error');
  });

  test('pre-content error throws (→ caller returns HTTP JSON, Channel A)', async () => {
    const res = fakeRes();
    const entry = { chunks: [], done: false, userId: 'u' };
    const onStreamError = () => ({ errorText: 'honest', code: 'internal' });

    await expect(
      pipeAsSSE(streamOf([
        { type: 'start' },
        { type: 'error', errorText: 'honest' },
      ]), res, entry, { onStreamError }),
    ).rejects.toThrow();
    // Nothing was committed to the client (headers not sent) — the caller replies JSON.
    expect(res.headersSent).toBe(false);
  });

  test('token-limit error chunk is intercepted before classification (FR-004)', async () => {
    const res = fakeRes();
    const entry = { chunks: [], done: false, userId: 'u' };
    let classified = false;
    const onStreamError = () => { classified = true; return { errorText: 'x', code: 'internal' }; };

    await expect(
      pipeAsSSE(streamOf([
        { type: 'start' },
        { type: 'error', errorText: 'prompt is too long: 250000 tokens > 200000 maximum' },
      ]), res, entry, { onStreamError }),
    ).rejects.toThrow(/prompt is too long/);
    // Token-limit errors never reach the taxonomy classifier — they trigger the
    // compaction/retry path in the caller instead.
    expect(classified).toBe(false);
  });
});
