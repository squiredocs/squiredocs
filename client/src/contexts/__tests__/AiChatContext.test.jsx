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
let mockMessages = [];
let mockStatus = 'ready';

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: mockMessages,
    status: mockStatus,
    stop: stopSpy,
    setMessages: setMessagesSpy,
    resumeStream: resumeStreamSpy,
    sendMessage: sendMessageSpy,
  }),
}));

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
    mockMessages = [];
    mockStatus = 'ready';
    mockAccessToken = 'test-token';
    stopSpy.mockClear();
    setMessagesSpy.mockClear();
    resumeStreamSpy.mockClear();
    sendMessageSpy.mockClear();
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
    vi.restoreAllMocks();
  });

  it('calls chat.stop() when switching chats', async () => {
    const { result } = renderAiChat();

    // Wait for initial mount effects
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    stopSpy.mockClear();

    // Switch to chat A
    mockApi.get.mockResolvedValueOnce({ data: { messages: [] } }); // fetchChatMessages
    act(() => { result.current.selectChat('chat-a'); });

    await waitFor(() => expect(stopSpy).toHaveBeenCalled());
    stopSpy.mockClear();

    // Switch to chat B — should stop again
    mockApi.get.mockResolvedValueOnce({ data: { messages: [] } }); // fetchChatMessages
    act(() => { result.current.selectChat('chat-b'); });

    await waitFor(() => expect(stopSpy).toHaveBeenCalled());
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

  // --------------- Image file forwarding ---------------

  it('forwards files to chat.sendMessage', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    const files = [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc' }];

    mockNewChatFlow('chat-img');

    await act(async () => { await result.current.sendMessage('Look at this', files); });

    expect(sendMessageSpy).toHaveBeenCalledWith({ text: 'Look at this', files });
  });

  it('uses fallback title for image-only messages', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    const files = [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc' }];

    mockNewChatFlow('chat-img2');

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

    mockNewChatFlow('chat-img3');

    await act(async () => { await result.current.sendMessage('', files); });

    expect(sendMessageSpy).toHaveBeenCalledWith({ text: ' ', files });
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

  it('pendingAssistantResponse is not in context value', () => {
    const { result } = renderAiChat();
    expect(result.current).not.toHaveProperty('pendingAssistantResponse');
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
