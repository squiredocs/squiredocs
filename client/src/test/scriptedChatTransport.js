/**
 * Scripted fake ChatTransport for driving the REAL `@ai-sdk/react` Chat class
 * through its actual status transitions (feature 025, FR-017 / research.md R6).
 *
 * The bug this feature fixes shipped precisely because the old context tests fully
 * mocked the SDK and never modeled its status flips. These helpers instead let a
 * test script the exact UI-message-stream chunks the SDK consumes, so the SDK's
 * real transitions are exercised for real (verified against ai/dist/index.mjs
 * makeRequest):
 *   - reconnectToStream() → null  ⇒ resume early-returns, status UNTOUCHED (204);
 *   - reconnectToStream() → stream ⇒ setStatus('submitted', error cleared);
 *   - a stream that ends cleanly    ⇒ setStatus('ready');
 *   - an `error` chunk              ⇒ onError(new Error(errorText)) + status 'error'.
 *
 * Usage: mock `ai` with `importOriginal` and swap only DefaultChatTransport for
 * this class (keeping @ai-sdk/react REAL); the provider then builds one of these,
 * grabbable via `latestScriptedTransport()`.
 */

// Build a ReadableStream<UIMessageChunk> from an array of chunk objects, matching
// what toUIMessageStream yields. Chunks enqueue synchronously then the stream
// closes (clean end → 'ready') unless the array carries an `error` chunk.
export function chunkStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

// ── Chunk-sequence builders ────────────────────────────────────────────────

/** A complete assistant reply with visible text content, ending cleanly. */
export function replyChunks(text = 'here is your answer') {
  return [
    { type: 'start' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish' },
  ];
}

/**
 * A pre-content failure: an `error` chunk arrives before any text. The SDK throws,
 * fires onError(new Error(errorText)), and sets status 'error'. When `structured`
 * ({ code, provider }) is given, a transient data-chat-error part is emitted first
 * (delivered to onData before onError) so the context reads the taxonomy code.
 */
export function errorChunks(errorText = 'stream error', structured = null) {
  const chunks = [{ type: 'start' }];
  if (structured) {
    chunks.push({ type: 'data-chat-error', data: structured, transient: true });
  }
  chunks.push({ type: 'error', errorText });
  return chunks;
}

/**
 * A mid-stream failure: partial text content, then the transient structured part,
 * then the `error` chunk — the interrupted-partial shape (US5). The SDK keeps the
 * partial assistant message and ends in status 'error'.
 */
export function partialThenErrorChunks(partial = 'partial…', structured = null, errorText = 'honest stream error') {
  const chunks = [
    { type: 'start' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: partial },
  ];
  if (structured) chunks.push({ type: 'data-chat-error', data: structured, transient: true });
  chunks.push({ type: 'error', errorText });
  return chunks;
}

// Module-level capture of the most recently constructed transport, so a test can
// grab the instance the provider built inside its useMemo and script it.
const constructed = [];
export function latestScriptedTransport() {
  return constructed[constructed.length - 1] || null;
}
export function resetScriptedTransports() {
  constructed.length = 0;
}

export class ScriptedChatTransport {
  // The constructor mirrors DefaultChatTransport's signature but ignores the
  // config — these tests care only about the stream chunks → SDK transitions.
  constructor() {
    this.sendQueue = [];       // successive sendMessages() results (chunk arrays)
    this.reconnectQueue = [];  // successive reconnectToStream() results (chunk arrays or null)
    this.sendCalls = 0;
    this.reconnectCalls = 0;
    constructed.push(this);
  }

  /** Queue the chunk array the next sendMessages() call will stream. */
  scriptSend(chunks) { this.sendQueue.push(chunks); return this; }

  /** Queue the next reconnectToStream() result: a chunk array, or null (204). */
  scriptReconnect(chunksOrNull) { this.reconnectQueue.push(chunksOrNull); return this; }

  async sendMessages() {
    this.sendCalls += 1;
    const next = this.sendQueue.length ? this.sendQueue.shift() : replyChunks();
    return chunkStream(next);
  }

  async reconnectToStream() {
    this.reconnectCalls += 1;
    const next = this.reconnectQueue.length ? this.reconnectQueue.shift() : null;
    return next == null ? null : chunkStream(next);
  }
}
