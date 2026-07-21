/**
 * AiChatContext tests
 *
 * Tests stream reconnection logic, chat switching, and transport config.
 * Uses vitest + renderHook with mocked dependencies.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Capture the DefaultChatTransport constructor args
let capturedTransportArgs = null;

vi.mock('ai', () => ({
  DefaultChatTransport: class MockTransport {
    constructor(args) {
      capturedTransportArgs = args;
    }
  },
}));

// Controllable useChat spy functions
const stopSpy = vi.fn();
const setMessagesSpy = vi.fn();
const resumeStreamSpy = vi.fn();
const sendMessageSpy = vi.fn();
const clearErrorSpy = vi.fn();
// Tracks assignments to the raw Chat instance's `messages` setter — distinct
// from setMessagesSpy (the useChat() helper). The real Chat class exposes only
// this setter, NOT a setMessages() method.
const messagesSetterSpy = vi.fn();
let mockMessages = [];
let mockStatus = 'ready';
let capturedUseChatOptions = null;

vi.mock('@ai-sdk/react', () => {
  // Mirror the real API surface: a raw Chat instance (AbstractChat) has a
  // `messages` getter/setter and NO setMessages() method — setMessages() lives
  // only on the useChat() return value. Keeping the mock faithful means calling
  // setMessages() on a raw instance throws here exactly as it does in prod.
  class MockChat {
    // Capture onError + onData so tests can simulate a stream error (and a
    // mid-stream data-chat-error part) by invoking the bound handlers, exactly as
    // the real SDK does.
    constructor({ id, onError, onData } = {}) { this.id = id; this.onError = onError; this.onData = onData; }
    get messages() { return mockMessages; }
    set messages(next) { messagesSetterSpy(next); mockMessages = next; }
    get status() { return mockStatus; }
    stop = stopSpy;
    resumeStream = resumeStreamSpy;
    sendMessage = sendMessageSpy;
    clearError = clearErrorSpy;
  }
  return {
    Chat: MockChat,
    useChat: (opts) => {
      capturedUseChatOptions = opts;
      return {
        messages: mockMessages,
        status: mockStatus,
        stop: stopSpy,
        setMessages: setMessagesSpy,
        resumeStream: resumeStreamSpy,
        sendMessage: sendMessageSpy,
      };
    },
  };
});

// Mock axios api instance — chat CRUD calls use api.get/post/patch/delete
const mockApi = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

// Mock auth — provide a stable token, refreshAccessToken, and axios api instance
const refreshAccessTokenSpy = vi.fn().mockResolvedValue('refreshed-token');
let mockAccessToken = 'test-token';
vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    get accessToken() { return mockAccessToken; },
    refreshAccessToken: refreshAccessTokenSpy,
    api: mockApi,
  }),
}));

// Import after mocks are established
const { AiChatProvider, useAiChat } = await import('../AiChatContext');

// ── Helpers ──────────────────────────────────────────────────────────────────

function wrapper({ children }) {
  return <AiChatProvider>{children}</AiChatProvider>;
}

function renderAiChat() {
  return renderHook(() => useAiChat(), { wrapper });
}

// Mock the full create-chat → refresh → title → refresh sequence
function mockNewChatFlow(chatId) {
  mockApi.post.mockResolvedValueOnce({ data: { id: chatId } });
  mockApi.get.mockResolvedValueOnce({ data: [] });
  mockApi.patch.mockResolvedValueOnce({ data: {} });
  mockApi.get.mockResolvedValueOnce({ data: [] });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AiChatContext', () => {
  beforeEach(() => {
    capturedTransportArgs = null;
    capturedUseChatOptions = null;
    mockMessages = [];
    mockStatus = 'ready';
    mockAccessToken = 'test-token';
    stopSpy.mockClear();
    setMessagesSpy.mockClear();
    messagesSetterSpy.mockClear();
    resumeStreamSpy.mockClear().mockResolvedValue(undefined);
    sendMessageSpy.mockClear();
    clearErrorSpy.mockClear();
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.patch.mockReset();
    mockApi.delete.mockReset();
    refreshAccessTokenSpy.mockClear().mockResolvedValue('refreshed-token');
    sessionStorage.clear();
    // Default: chat list returns empty (called on mount)
    mockApi.get.mockResolvedValueOnce({ data: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('gives each chat its own Chat instance so streams are isolated per chat', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    // No chat selected yet → the draft instance (undefined id).
    expect(capturedUseChatOptions).toHaveProperty('chat');
    const draftInstance = capturedUseChatOptions.chat;

    mockApi.get.mockResolvedValueOnce({ data: { messages: [] } });
    act(() => { result.current.selectChat('chat-iso'); });

    await waitFor(() => expect(capturedUseChatOptions.chat.id).toBe('chat-iso'));
    // A different chat is a different instance — streams can't cross.
    expect(capturedUseChatOptions.chat).not.toBe(draftInstance);
  });

  it('does NOT stop the outgoing stream when switching chats (keeps it alive to resume)', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    mockApi.get.mockResolvedValueOnce({ data: { messages: [] } });
    act(() => { result.current.selectChat('chat-a'); });
    await waitFor(() => expect(setMessagesSpy).toHaveBeenCalled());
    stopSpy.mockClear();

    // Switching to B must not abort A's instance — it keeps streaming in the
    // background so switching back re-attaches to the live message.
    mockApi.get.mockResolvedValueOnce({ data: { messages: [] } });
    act(() => { result.current.selectChat('chat-b'); });
    await waitFor(() => expect(setMessagesSpy).toHaveBeenCalled());
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('reuses a cached instance that already has messages instead of refetching', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    // Simulate the chat's instance already holding messages (cached/streamed).
    mockMessages = [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
    setMessagesSpy.mockClear();
    resumeStreamSpy.mockClear();

    act(() => { result.current.selectChat('chat-cached'); });

    // No reload — the live instance is re-attached as-is.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(setMessagesSpy).not.toHaveBeenCalled();
    expect(resumeStreamSpy).not.toHaveBeenCalled();
  });

  it('does NOT stop/reload an in-flight stream when the access token refreshes mid-chat', async () => {
    const { result, rerender } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    // Open a chat
    mockApi.get.mockResolvedValueOnce({ data: { messages: [] } });
    act(() => { result.current.selectChat('chat-stream'); });
    await waitFor(() => expect(setMessagesSpy).toHaveBeenCalled());

    // Simulate an active stream + a mid-session token refresh (e.g. the 5s
    // chat-list poll hit a 401 and the interceptor rotated the token).
    stopSpy.mockClear();
    setMessagesSpy.mockClear();
    mockStatus = 'streaming';
    mockAccessToken = 'refreshed-token';
    rerender();

    // Give any effects a chance to fire.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

    // The same chat is loaded — a token-only change must not abort the stream
    // or wipe the messages.
    expect(stopSpy).not.toHaveBeenCalled();
    expect(setMessagesSpy).not.toHaveBeenCalledWith([]);
  });

  it('calls resumeStream() when last loaded message is from user', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    const userMsg = { role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    mockApi.get.mockResolvedValueOnce({ data: { messages: [userMsg] } });

    act(() => { result.current.selectChat('chat-resume'); });

    await waitFor(() => expect(resumeStreamSpy).toHaveBeenCalled());
  });

  it('does NOT call resumeStream() when last message is from assistant', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    const userMsg = { role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    const assistantMsg = { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] };
    mockApi.get.mockResolvedValueOnce({ data: { messages: [userMsg, assistantMsg] } });

    act(() => { result.current.selectChat('chat-no-resume'); });

    // Wait for messages to load
    await waitFor(() => expect(setMessagesSpy).toHaveBeenCalledWith([userMsg, assistantMsg]));

    expect(resumeStreamSpy).not.toHaveBeenCalled();
  });

  it('does NOT call resumeStream() for empty chat', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    mockApi.get.mockResolvedValueOnce({ data: { messages: [] } });

    act(() => { result.current.selectChat('chat-empty'); });

    // Wait for messages to load
    await waitFor(() => expect(setMessagesSpy).toHaveBeenCalledWith([]));

    expect(resumeStreamSpy).not.toHaveBeenCalled();
  });

  it('does NOT report reconnecting for a brand-new chat (null currentChatId)', async () => {
    // Regression: `reconnecting` was `reconnectingChatId === currentChatId`, and
    // both are null on a fresh chat, so null === null falsely showed the
    // "Reconnecting…" banner until the first message gave the chat a real id.
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    expect(result.current.currentChatId).toBeNull();
    expect(result.current.reconnecting).toBe(false);
  });

  it('transport configures prepareReconnectToStreamRequest', () => {
    renderAiChat();

    expect(capturedTransportArgs).not.toBeNull();
    expect(typeof capturedTransportArgs.prepareReconnectToStreamRequest).toBe('function');

    const result = capturedTransportArgs.prepareReconnectToStreamRequest();
    // The function reads chatIdRef.current — which is null initially
    expect(result).toEqual({ api: '/api/chat/null/stream' });
  });

  it('sets chat title immediately on first sendMessage', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    // Create a chat — returns { id }
    mockNewChatFlow('new-chat-1');

    await act(async () => { await result.current.sendMessage('Hello world'); });

    // Verify PATCH was called with the title
    expect(mockApi.patch).toHaveBeenCalledWith(
      '/api/chat/chats/new-chat-1',
      { title: 'Hello world' },
    );
  });

  // --------------- Markdown attachment forwarding (byte channel) --------------

  it('uploads a markdown file as an attachment reference and keeps it as a file part', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    // First post is the attachment upload; then the new-chat flow.
    mockApi.post.mockResolvedValueOnce({
      data: { reference: 'attachment:chat-attachments/u1/md-key', mediaType: 'text/markdown', filename: 'spec.md' },
    });
    mockNewChatFlow('chat-md');

    await act(async () => {
      await result.current.sendMessage('please import this', [
        { type: 'file', mediaType: 'text/markdown', url: 'data:text/markdown;base64,IyBTcGVj', filename: 'spec.md' },
      ]);
    });

    // The bytes went to the attachment store, not into the message body —
    // server-side the assistant imports the reference via import_markdown.
    expect(mockApi.post).toHaveBeenCalledWith('/api/chat/attachments', {
      data: 'data:text/markdown;base64,IyBTcGVj',
      mediaType: 'text/markdown',
      filename: 'spec.md',
    });
    expect(sendMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
      text: 'please import this',
      files: [expect.objectContaining({
        type: 'file',
        mediaType: 'text/markdown',
        url: 'attachment:chat-attachments/u1/md-key',
        filename: 'spec.md',
      })],
    }));
  });

  // --------------- Image file forwarding (feature 010: S3 references) ---------

  // Attachments upload to /api/chat/attachments first (feature 010, US3); the
  // chat body then carries the returned `attachment:` reference instead of the
  // inline base64 data URL. mockUploadThenNewChat queues the upload response
  // ahead of the create-chat flow (upload runs before createChatOnServer).
  function mockUploadThenNewChat(reference, chatId) {
    mockApi.post.mockResolvedValueOnce({ data: { reference, mediaType: 'image/png', filename: null } });
    mockNewChatFlow(chatId);
  }

  it('uploads files to /api/chat/attachments and forwards references, not base64', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    const files = [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc' }];
    const reference = 'attachment:chat-attachments/user-1/uuid-1';
    mockUploadThenNewChat(reference, 'chat-img');

    await act(async () => { await result.current.sendMessage('Look at this', files); });

    // The upload happened with the data URL…
    expect(mockApi.post).toHaveBeenCalledWith('/api/chat/attachments', {
      data: 'data:image/png;base64,abc',
      mediaType: 'image/png',
      filename: null,
    });
    // …and the chat send carries the reference, never the inline base64.
    expect(sendMessageSpy).toHaveBeenCalledWith({
      text: 'Look at this',
      files: [{ type: 'file', mediaType: 'image/png', url: reference }],
    });
    const sentFiles = sendMessageSpy.mock.calls[0][0].files;
    expect(JSON.stringify(sentFiles)).not.toContain('data:image/png;base64');
  });

  it('uses fallback title for image-only messages', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    const files = [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc' }];
    mockUploadThenNewChat('attachment:chat-attachments/user-1/uuid-2', 'chat-img2');

    await act(async () => { await result.current.sendMessage('', files); });

    expect(mockApi.patch).toHaveBeenCalledWith(
      '/api/chat/chats/chat-img2',
      { title: 'Image' },
    );
  });

  it('sends text as space for image-only messages', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    const files = [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc' }];
    const reference = 'attachment:chat-attachments/user-1/uuid-3';
    mockUploadThenNewChat(reference, 'chat-img3');

    await act(async () => { await result.current.sendMessage('', files); });

    expect(sendMessageSpy).toHaveBeenCalledWith({
      text: ' ',
      files: [{ type: 'file', mediaType: 'image/png', url: reference }],
    });
  });

  it('does not pass files when none provided', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    mockNewChatFlow('chat-nf');

    await act(async () => { await result.current.sendMessage('No files'); });

    expect(sendMessageSpy).toHaveBeenCalledWith({ text: 'No files', files: undefined });
  });

  it('exposes draftFiles and clearDraftFiles in context value', () => {
    const { result } = renderAiChat();
    expect(result.current).toHaveProperty('draftFiles');
    expect(result.current).toHaveProperty('clearDraftFiles');
    expect(typeof result.current.clearDraftFiles).toBe('function');
  });

  it('persists and retrieves per-chat input drafts', () => {
    const { result } = renderAiChat();

    // Unknown chat → no draft.
    expect(result.current.getChatDraft('chat-a')).toBeNull();

    // Saving a draft is retrievable per chat id, isolated from other chats.
    act(() => { result.current.saveChatDraft('chat-a', 'half-typed', null); });
    expect(result.current.getChatDraft('chat-a')).toEqual({ text: 'half-typed', files: null });
    expect(result.current.getChatDraft('chat-b')).toBeNull();

    // The not-yet-created chat (null id) gets its own slot.
    act(() => { result.current.saveChatDraft(null, 'new chat text', null); });
    expect(result.current.getChatDraft(null)).toEqual({ text: 'new chat text', files: null });
    expect(result.current.getChatDraft('chat-a')).toEqual({ text: 'half-typed', files: null });

    // An empty draft is forgotten (sending clears the input → empty draft).
    act(() => { result.current.saveChatDraft('chat-a', '   ', null); });
    expect(result.current.getChatDraft('chat-a')).toBeNull();
  });

  // ── Transient streaming error recovery ────────────────────────────────────

  describe('transient error recovery', () => {
    const userMsg = { role: 'user', parts: [{ type: 'text', text: 'please reply' }] };
    const assistantMsg = { role: 'assistant', parts: [{ type: 'text', text: 'done' }] };

    // Send a message so a chat instance exists, lastSent refs are populated, and
    // the attempt counter is reset; return the active (erred-able) instance.
    async function sendAndGetInstance(result, id, text = 'please reply') {
      mockNewChatFlow(id);
      await act(async () => { await result.current.sendMessage(text); });
      await waitFor(() => expect(capturedUseChatOptions.chat.id).toBe(id));
      sendMessageSpy.mockClear();
      messagesSetterSpy.mockClear();
      resumeStreamSpy.mockClear();
      return capturedUseChatOptions.chat;
    }

    it('recovers when the resumed stream actually lands a reply (not on a bare status flip, FR-012)', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendAndGetInstance(result, 'chat-resume');

      // DB shows only the user turn (assistant not yet saved). Honest recovery
      // (feature 025): a mere status flip to 'streaming' is NOT success — a reply
      // with content must actually land. Simulate the reattached stream delivering
      // that reply by having resumeStream populate the assistant message.
      mockApi.get.mockResolvedValueOnce({ data: { messages: [userMsg] } });
      mockStatus = 'streaming';
      resumeStreamSpy.mockImplementation(() => { mockMessages = [userMsg, assistantMsg]; return Promise.resolve(); });

      await act(async () => {
        inst.onError(new Error('anthropic overloaded'));
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(messagesSetterSpy).toHaveBeenCalledWith([userMsg]);
      expect(resumeStreamSpy).toHaveBeenCalled();
      expect(result.current.draftText).toBe('');   // draft NOT restored — recovered
      await waitFor(() => expect(result.current.reconnecting).toBe(false)); // cleared once the reply landed
      expect(result.current.errorInfo).toBeNull(); // durable banner neutralized by the landed reply
    });

    it('shows the persisted assistant message without resuming when it is already saved', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendAndGetInstance(result, 'chat-saved');

      mockApi.get.mockResolvedValueOnce({ data: { messages: [userMsg, assistantMsg] } });
      clearErrorSpy.mockClear();

      await act(async () => {
        inst.onError(new Error('network error'));
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(messagesSetterSpy).toHaveBeenCalledWith([userMsg, assistantMsg]);
      expect(resumeStreamSpy).not.toHaveBeenCalled();
      expect(clearErrorSpy).toHaveBeenCalled();
      expect(result.current.draftText).toBe('');
    });

    it('falls back to draft + error when the DB fetch fails', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendAndGetInstance(result, 'chat-fetchfail');

      mockApi.get.mockRejectedValueOnce(new Error('500'));

      await act(async () => {
        inst.onError(new Error('anthropic error'));
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(resumeStreamSpy).not.toHaveBeenCalled();
      expect(result.current.draftText).toBe('please reply'); // draft restored
    });

    it('does not wipe the visible turn when the DB has no messages (new chat)', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendAndGetInstance(result, 'chat-empty');

      mockApi.get.mockResolvedValueOnce({ data: { messages: [] } });

      await act(async () => {
        inst.onError(new Error('anthropic error'));
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(messagesSetterSpy).not.toHaveBeenCalledWith([]); // visible turn preserved
      expect(resumeStreamSpy).not.toHaveBeenCalled();
      expect(result.current.draftText).toBe('please reply');
    });

    it('does not start a second recovery while one is in flight (re-entry guard)', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendAndGetInstance(result, 'chat-reentry');

      // Make the recovery fetch hang so the first recovery stays in flight.
      mockApi.get.mockReset();
      let getCalls = 0;
      mockApi.get.mockImplementation(() => { getCalls += 1; return new Promise(() => {}); });

      await act(async () => {
        inst.onError(new Error('err one'));
        inst.onError(new Error('err two'));
        await Promise.resolve();
      });

      expect(getCalls).toBe(1); // the 2nd error was short-circuited by the guard
    });

    it('gives up to the error banner after the establish window (no live stream / 204)', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendAndGetInstance(result, 'chat-204');

      mockApi.get.mockResolvedValueOnce({ data: { messages: [userMsg] } });
      mockStatus = 'error'; // resume never establishes

      vi.useFakeTimers();
      await act(async () => {
        inst.onError(new Error('anthropic error'));
        await vi.advanceTimersByTimeAsync(6000); // past RECONNECT_ESTABLISH_MS
      });
      vi.useRealTimers();

      expect(resumeStreamSpy).toHaveBeenCalled(); // it tried
      expect(result.current.draftText).toBe('please reply'); // then fell back
    });

    it('stops recovering after MAX_RECOVERY_ATTEMPTS and surfaces the error', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendAndGetInstance(result, 'chat-cap');
      mockStatus = 'error';

      vi.useFakeTimers();
      // Two failed recoveries (each fetch resolves user-last, resume never establishes).
      for (let i = 0; i < 2; i += 1) {
        mockApi.get.mockResolvedValueOnce({ data: { messages: [userMsg] } });
        await act(async () => {
          inst.onError(new Error('anthropic error'));
          await vi.advanceTimersByTimeAsync(6000);
        });
      }
      resumeStreamSpy.mockClear();
      // Third error: attempts exhausted → straight to fallback, no resume attempt.
      await act(async () => {
        inst.onError(new Error('anthropic error'));
        await vi.advanceTimersByTimeAsync(100);
      });
      vi.useRealTimers();

      expect(resumeStreamSpy).not.toHaveBeenCalled();
    });

    it('auth errors take precedence over recovery (refresh + resend, no resume)', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendAndGetInstance(result, 'chat-auth');

      await act(async () => {
        // App-auth is keyed on HTTP status 401, NOT body text (feature 012, D7).
        inst.onError(Object.assign(new Error('unauthorized'), { status: 401 }));
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(refreshAccessTokenSpy).toHaveBeenCalled();
      expect(resumeStreamSpy).not.toHaveBeenCalled();
    });

    it('usage-limit errors surface immediately without recovery (structured code)', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendAndGetInstance(result, 'chat-usage');

      await act(async () => {
        // The structured app_usage_limit payload (402) — no body-sniffing.
        inst.onError(Object.assign(new Error(JSON.stringify({ error: 'AI usage limit reached', code: 'app_usage_limit' })), { status: 402 }));
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(result.current.usageLimitReached).toBe(true);
      expect(resumeStreamSpy).not.toHaveBeenCalled();
    });
  });

  // ── Feature 012: classified error surfacing, fatality gating, derived limit ──

  describe('classified error surfacing (feature 012)', () => {
    async function sendOn(result, id, text = 'please reply') {
      mockNewChatFlow(id);
      await act(async () => { await result.current.sendMessage(text); });
      await waitFor(() => expect(capturedUseChatOptions.chat.id).toBe(id));
      sendMessageSpy.mockClear();
      resumeStreamSpy.mockClear();
      return capturedUseChatOptions.chat;
    }

    it('handleChatError selects behavior from the parsed code, not body text (T016)', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendOn(result, 'chat-code');

      await act(async () => {
        inst.onError(Object.assign(new Error(JSON.stringify({ error: 'x', code: 'byok_invalid_key', provider: 'anthropic' })), { status: 400 }));
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(result.current.errorInfo).toMatchObject({ code: 'byok_invalid_key', provider: 'anthropic' });
      expect(result.current.errorInfo.text).toContain('Anthropic');
      expect(resumeStreamSpy).not.toHaveBeenCalled(); // fatal → no recovery
    });

    it('an unknown/absent code falls back to internal and enters recovery (T016/T024)', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendOn(result, 'chat-unknown');

      mockApi.get.mockResolvedValueOnce({ data: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] } });
      mockStatus = 'streaming';

      await act(async () => {
        inst.onError(new Error('Bad Gateway')); // no structured code, no status
        await new Promise((r) => setTimeout(r, 50));
      });

      // internal is NOT fatal → the existing reconnect-recovery path runs.
      expect(resumeStreamSpy).toHaveBeenCalled();
    });

    it('a fatal code bypasses reconnect-recovery entirely (T024)', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendOn(result, 'chat-fatal');
      mockApi.get.mockClear();

      await act(async () => {
        inst.onError(Object.assign(new Error(JSON.stringify({ error: 'busy', code: 'provider_overloaded', provider: 'anthropic' })), { status: 429 }));
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(resumeStreamSpy).not.toHaveBeenCalled();
      expect(mockApi.get).not.toHaveBeenCalled(); // no DB re-fetch (recoverChat skipped)
      expect(result.current.errorInfo.code).toBe('provider_overloaded');
      expect(result.current.draftText).toBe('please reply'); // draft restored (FR-018)
    });

    it('mid-stream fatal error leaving a partial reply shows a session interruption notice (T025)', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendOn(result, 'chat-interrupt');
      // A partial assistant reply already streamed into the transcript.
      mockMessages = [
        { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'partial…' }] },
      ];

      await act(async () => {
        // The transient data-chat-error part lands (onData) before the error event.
        inst.onData({ type: 'data-chat-error', data: { code: 'provider_overloaded', provider: 'anthropic' } });
        inst.onError(new Error('honest stream error'));
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(result.current.interruptionReason).toBeTruthy();
      expect(result.current.interruptionReason).toContain('busy');
      expect(resumeStreamSpy).not.toHaveBeenCalled();
      // L5: the user turn is already persisted, so the composer draft must NOT be
      // restored — restoring it would duplicate the turn on resend. (Contrast the
      // pre-stream fatal case above, which does restore.)
      expect(result.current.draftText).toBe('');
    });

    it('usage-limit is derived: cleared on the next send, re-set only by a fresh rejection (T029)', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      const inst = await sendOn(result, 'chat-derived');

      await act(async () => {
        inst.onError(Object.assign(new Error(JSON.stringify({ code: 'app_usage_limit' })), { status: 402 }));
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(result.current.usageLimitReached).toBe(true);

      // The next send attempt clears the latch (no reload needed).
      mockApi.get.mockResolvedValue({ data: [] });
      await act(async () => { await result.current.sendMessage('try again'); });
      expect(result.current.usageLimitReached).toBe(false);
    });
  });

  // ── bfcache restore (Cmd+Shift+T) ─────────────────────────────────────────

  describe('bfcache restore (persisted pageshow)', () => {
    function firePageShow(persisted) {
      const evt = new Event('pageshow');
      Object.defineProperty(evt, 'persisted', { value: persisted });
      window.dispatchEvent(evt);
    }

    it('re-syncs and resumes the active chat when restored mid-stream', async () => {
      sessionStorage.setItem('ai_chat_id', 'chat-bfcache');
      mockApi.get.mockReset();
      // Initial mount load for the restored chat (user-last → resumes once).
      mockApi.get.mockResolvedValueOnce({ data: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] } });
      mockApi.get.mockResolvedValueOnce({ data: [] }); // chat list

      const { result } = renderAiChat();
      await waitFor(() => expect(result.current.currentChatId).toBe('chat-bfcache'));
      await waitFor(() => expect(resumeStreamSpy).toHaveBeenCalled());

      // Simulate the stale-but-streaming in-memory state a bfcache restore brings back.
      mockStatus = 'streaming';
      resumeStreamSpy.mockClear();
      messagesSetterSpy.mockClear();
      const userMsg = { role: 'user', parts: [{ type: 'text', text: 'hi' }] };
      mockApi.get.mockResolvedValueOnce({ data: { messages: [userMsg] } });

      await act(async () => {
        firePageShow(true);
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(messagesSetterSpy).toHaveBeenCalledWith([userMsg]);
      expect(resumeStreamSpy).toHaveBeenCalled(); // re-attached to the live stream
    });

    it('ignores a non-persisted pageshow (a real reload handles itself)', async () => {
      sessionStorage.setItem('ai_chat_id', 'chat-reload');
      mockApi.get.mockReset();
      mockApi.get.mockResolvedValueOnce({ data: { messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'done' }] }] } });
      mockApi.get.mockResolvedValueOnce({ data: [] });

      const { result } = renderAiChat();
      await waitFor(() => expect(result.current.currentChatId).toBe('chat-reload'));
      mockStatus = 'streaming';
      resumeStreamSpy.mockClear();

      await act(async () => {
        firePageShow(false);
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(resumeStreamSpy).not.toHaveBeenCalled();
    });

    it('does nothing on restore when the chat is not mid-stream', async () => {
      sessionStorage.setItem('ai_chat_id', 'chat-idle');
      mockApi.get.mockReset();
      mockApi.get.mockResolvedValueOnce({ data: { messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'done' }] }] } });
      mockApi.get.mockResolvedValueOnce({ data: [] });

      const { result } = renderAiChat();
      await waitFor(() => expect(result.current.currentChatId).toBe('chat-idle'));
      mockStatus = 'ready';
      resumeStreamSpy.mockClear();
      messagesSetterSpy.mockClear();

      await act(async () => {
        firePageShow(true);
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(resumeStreamSpy).not.toHaveBeenCalled();
      expect(messagesSetterSpy).not.toHaveBeenCalled();
    });
  });

  it('pendingAssistantResponse is not in context value', () => {
    const { result } = renderAiChat();
    expect(result.current).not.toHaveProperty('pendingAssistantResponse');
  });

  // ── "Add to Chat" selection references ────────────────────────────────────

  describe('selection references', () => {
    it('addSelectionRef appends a ref with a generated id; removeSelectionRef drops it', () => {
      const { result } = renderAiChat();

      act(() => { result.current.addSelectionRef({ text: 'a passage', heading: 'Intro' }); });
      expect(result.current.pendingRefs).toHaveLength(1);
      expect(result.current.pendingRefs[0]).toMatchObject({ text: 'a passage', heading: 'Intro' });
      expect(result.current.pendingRefs[0].id).toBeTruthy();

      const id = result.current.pendingRefs[0].id;
      act(() => { result.current.addSelectionRef({ text: 'second' }); });
      expect(result.current.pendingRefs).toHaveLength(2);

      act(() => { result.current.removeSelectionRef(id); });
      expect(result.current.pendingRefs).toHaveLength(1);
      expect(result.current.pendingRefs[0].text).toBe('second');
    });

    it('addSelectionRef ignores a ref with no text', () => {
      const { result } = renderAiChat();
      act(() => { result.current.addSelectionRef({ text: '' }); });
      expect(result.current.pendingRefs).toHaveLength(0);
    });

    it('folds pending refs into the sent message (delimited block + metadata) and clears them', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

      act(() => { result.current.addSelectionRef({ text: 'the auth service', heading: 'Objectives', docId: 'doc-7', docTitle: 'Launch Plan' }); });
      mockNewChatFlow('chat-ref');

      await act(async () => { await result.current.sendMessage('explain this'); });

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const payload = sendMessageSpy.mock.calls[0][0];
      expect(payload.text).toContain('<referenced_passages>');
      // Names the source document (so the assistant can tell docs apart) and the heading.
      expect(payload.text).toContain('(from document "Launch Plan" (id doc-7), under heading "Objectives") "the auth service"');
      expect(payload.text).toContain('explain this');
      expect(payload.metadata).toEqual({ refs: [{ text: 'the auth service', heading: 'Objectives', docTitle: 'Launch Plan', docId: 'doc-7' }] });

      // Consumed by the send.
      expect(result.current.pendingRefs).toHaveLength(0);
    });

    it('allows a refs-only send with empty text', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

      act(() => { result.current.addSelectionRef({ text: 'just this passage' }); });
      mockNewChatFlow('chat-refonly');

      await act(async () => { await result.current.sendMessage(''); });

      const payload = sendMessageSpy.mock.calls[0][0];
      expect(payload.text).toContain('just this passage');
      expect(payload.metadata.refs).toHaveLength(1);
    });

    it('does not attach metadata when there are no refs', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

      mockNewChatFlow('chat-noref');
      await act(async () => { await result.current.sendMessage('plain message'); });

      expect(sendMessageSpy).toHaveBeenCalledWith({ text: 'plain message', files: undefined });
    });
  });

  // ── New-chat creation: first message should not be swallowed ──────────

  describe('new chat first message', () => {
    it('does not call stop() when creating a new chat', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

      // Clear any calls from initial mount
      stopSpy.mockClear();
      setMessagesSpy.mockClear();

      mockNewChatFlow('new-chat-a');

      await act(async () => { await result.current.sendMessage('First message'); });

      // The creatingChatRef flag should skip the useEffect's stop/clear cycle
      expect(stopSpy).not.toHaveBeenCalled();
    });

    it('does not clear messages when creating a new chat', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

      stopSpy.mockClear();
      setMessagesSpy.mockClear();

      mockNewChatFlow('new-chat-b');

      await act(async () => { await result.current.sendMessage('First message'); });

      // setMessages([]) should NOT be called — that would wipe the just-sent message
      expect(setMessagesSpy).not.toHaveBeenCalledWith([]);
    });

    it('transport gets the new chat ID, not null', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

      mockNewChatFlow('fresh-42');

      await act(async () => { await result.current.sendMessage('Hello'); });

      // The transport reads chatIdRef — verify it has the new chat ID
      const config = capturedTransportArgs.prepareSendMessagesRequest({
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      });
      expect(config.body.id).toBe('fresh-42');
    });

    it('reconnect URL uses the new chat ID', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

      mockNewChatFlow('reconnect-99');

      await act(async () => { await result.current.sendMessage('Test'); });

      const reconnect = capturedTransportArgs.prepareReconnectToStreamRequest();
      expect(reconnect.api).toBe('/api/chat/reconnect-99/stream');
    });

    it('sends the message to chat.sendMessage', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      sendMessageSpy.mockClear();

      mockNewChatFlow('new-chat-c');

      await act(async () => { await result.current.sendMessage('My first msg'); });

      expect(sendMessageSpy).toHaveBeenCalledWith({ text: 'My first msg', files: undefined });
    });
  });

  // ── New Chat button (createChat) ───────────────────────────────────────────

  describe('createChat (New Chat button)', () => {
    it('clears the draft instance and resets to a blank chat without throwing', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

      messagesSetterSpy.mockClear();

      // Regression: createChat used to call getChatInstance(null).setMessages([]),
      // but a raw Chat instance has no setMessages() — only a `messages` setter —
      // so the New Chat button threw "setMessages is not a function". This must
      // resolve without throwing and clear the draft instance via the setter.
      await act(async () => { await result.current.createChat(); });

      expect(messagesSetterSpy).toHaveBeenCalledWith([]);
      expect(result.current.currentChatId).toBeNull();
    });
  });

  // ── Proactive token refresh before streaming ──────────────────────────────

  describe('proactive token refresh before sendMessage', () => {
    it('refreshes token before sending when token is expiring soon', async () => {
      // 'test-token' is not a valid JWT, so isTokenExpiringSoon returns true (fail-secure)
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

      mockNewChatFlow('chat-refresh');

      await act(async () => { await result.current.sendMessage('Hello'); });

      // 'test-token' is not a valid JWT → isTokenExpiringSoon returns true →
      // refreshAccessToken should be called before sendMessage
      expect(refreshAccessTokenSpy).toHaveBeenCalled();
      expect(sendMessageSpy).toHaveBeenCalled();
    });

    it('still sends the message even if proactive refresh fails', async () => {
      refreshAccessTokenSpy.mockRejectedValueOnce(new Error('network error'));

      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

      mockNewChatFlow('chat-fail-refresh');

      await act(async () => { await result.current.sendMessage('Still sends'); });

      expect(sendMessageSpy).toHaveBeenCalledWith({ text: 'Still sends', files: undefined });
    });
  });

  // ── Session restore & token handling on refresh ───────────────────────────

  describe('session restore on refresh', () => {
    it('restores chat ID from sessionStorage and loads its messages', async () => {
      sessionStorage.setItem('ai_chat_id', 'saved-chat-99');
      const savedMessages = [
        { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'hi back' }] },
      ];
      // Messages effect fires before chat-list effect (declaration order),
      // so fetchChatMessages mock must come first.
      mockApi.get.mockReset();
      mockApi.get.mockResolvedValueOnce({ data: { messages: savedMessages } });
      mockApi.get.mockResolvedValueOnce({ data: [{ id: 'saved-chat-99', title: 'Old chat', updatedAt: new Date().toISOString() }] });

      const { result } = renderAiChat();

      await waitFor(() => expect(result.current.currentChatId).toBe('saved-chat-99'));
      await waitFor(() => expect(setMessagesSpy).toHaveBeenCalledWith(savedMessages));
    });

    it('preserves saved chat ID even if not in first page of chat list', async () => {
      sessionStorage.setItem('ai_chat_id', 'older-chat');
      // Messages effect fires first, then chat list effect
      mockApi.get.mockReset();
      mockApi.get.mockResolvedValueOnce({ data: { messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }] } });
      mockApi.get.mockResolvedValueOnce({ data: [{ id: 'other-chat', title: 'Other', updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }] });

      const { result } = renderAiChat();

      await waitFor(() => expect(result.current.currentChatId).toBe('older-chat'));
      expect(sessionStorage.getItem('ai_chat_id')).toBe('older-chat');
    });

    it('preserves saved chat ID when chat list fetch fails', async () => {
      sessionStorage.setItem('ai_chat_id', 'my-chat');
      const savedMessages = [{ role: 'user', parts: [{ type: 'text', text: 'hey' }] }];
      // Messages effect fires first, then chat list effect
      mockApi.get.mockReset();
      mockApi.get.mockResolvedValueOnce({ data: { messages: savedMessages } });
      // Chat list fetch fails (e.g. 401 during interceptor race)
      mockApi.get.mockRejectedValueOnce(new Error('401 Unauthorized'));

      const { result } = renderAiChat();

      await waitFor(() => expect(result.current.currentChatId).toBe('my-chat'));
      await waitFor(() => expect(setMessagesSpy).toHaveBeenCalledWith(savedMessages));
      expect(sessionStorage.getItem('ai_chat_id')).toBe('my-chat');
    });

    it('auto-selects most recent chat when no saved ID and recently active', async () => {
      // No saved chat in sessionStorage
      mockApi.get.mockReset();
      mockApi.get.mockResolvedValueOnce({ data: [
        { id: 'recent-chat', title: 'Recent', updatedAt: new Date().toISOString() },
      ] });
      mockApi.get.mockResolvedValueOnce({ data: { messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }] } });

      const { result } = renderAiChat();

      await waitFor(() => expect(result.current.currentChatId).toBe('recent-chat'));
    });

    it('does not auto-select most recent chat when it is stale', async () => {
      // No saved chat in sessionStorage
      mockApi.get.mockReset();
      mockApi.get.mockResolvedValueOnce({ data: [
        { id: 'stale-chat', title: 'Stale', updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
      ] });

      const { result } = renderAiChat();

      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
      // Give the .then() handler time to run
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(result.current.currentChatId).toBeNull();
    });

    it('does not fetch messages when accessToken is null', async () => {
      sessionStorage.setItem('ai_chat_id', 'saved-chat');
      mockAccessToken = null;
      mockApi.get.mockReset();

      renderAiChat();

      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

      expect(mockApi.get).not.toHaveBeenCalled();
    });

    it('refreshChatList passes explicit auth headers to avoid interceptor race', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

      expect(mockApi.get).toHaveBeenCalledWith(
        '/api/chat/chats?limit=50',
        { headers: { Authorization: 'Bearer test-token' } },
      );
    });

    it('fetchChatMessages passes explicit auth headers to avoid interceptor race', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

      mockApi.get.mockResolvedValueOnce({ data: { messages: [] } });
      act(() => { result.current.selectChat('chat-x'); });

      await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith(
        '/api/chat/chats/chat-x',
        { headers: { Authorization: 'Bearer test-token' } },
      ));
    });
  });
});
