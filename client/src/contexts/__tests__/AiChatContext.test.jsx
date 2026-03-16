/**
 * AiChatContext tests
 *
 * Tests stream reconnection logic, chat switching, and transport config.
 * Uses vitest + renderHook with mocked dependencies.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

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

// Mock auth — provide a stable token
vi.mock('../AuthContext', () => ({
  useAuth: () => ({ accessToken: 'test-token' }),
}));

// Mock global fetch for apiFetch calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks are established
const { AiChatProvider, useAiChat } = await import('../AiChatContext');

// ── Helpers ──────────────────────────────────────────────────────────────────

function wrapper({ children }) {
  return <AiChatProvider>{children}</AiChatProvider>;
}

function renderAiChat() {
  return renderHook(() => useAiChat(), { wrapper });
}

// Mock a fetch response
function mockFetchResponse(body, ok = true) {
  mockFetch.mockResolvedValueOnce({
    ok,
    json: () => Promise.resolve(body),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AiChatContext', () => {
  beforeEach(() => {
    capturedTransportArgs = null;
    mockMessages = [];
    mockStatus = 'ready';
    stopSpy.mockClear();
    setMessagesSpy.mockClear();
    resumeStreamSpy.mockClear();
    sendMessageSpy.mockClear();
    mockFetch.mockReset();
    // Default: chat list returns empty (called on mount)
    mockFetchResponse([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls chat.stop() when switching chats', async () => {
    const { result } = renderAiChat();

    // Wait for initial mount effects
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    stopSpy.mockClear();

    // Switch to chat A
    mockFetchResponse({ messages: [] }); // fetchChatMessages
    act(() => { result.current.selectChat('chat-a'); });

    await waitFor(() => expect(stopSpy).toHaveBeenCalled());
    stopSpy.mockClear();

    // Switch to chat B — should stop again
    mockFetchResponse({ messages: [] }); // fetchChatMessages
    act(() => { result.current.selectChat('chat-b'); });

    await waitFor(() => expect(stopSpy).toHaveBeenCalled());
  });

  it('calls resumeStream() when last loaded message is from user', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const userMsg = { role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    mockFetchResponse({ messages: [userMsg] });

    act(() => { result.current.selectChat('chat-resume'); });

    await waitFor(() => expect(resumeStreamSpy).toHaveBeenCalled());
  });

  it('does NOT call resumeStream() when last message is from assistant', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const userMsg = { role: 'user', parts: [{ type: 'text', text: 'hi' }] };
    const assistantMsg = { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] };
    mockFetchResponse({ messages: [userMsg, assistantMsg] });

    act(() => { result.current.selectChat('chat-no-resume'); });

    // Wait for messages to load
    await waitFor(() => expect(setMessagesSpy).toHaveBeenCalledWith([userMsg, assistantMsg]));

    expect(resumeStreamSpy).not.toHaveBeenCalled();
  });

  it('does NOT call resumeStream() for empty chat', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    mockFetchResponse({ messages: [] });

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
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    // Create a chat — returns { id }
    mockFetchResponse({ id: 'new-chat-1' }); // createChat POST
    mockFetchResponse([]); // refreshChatList after create
    mockFetchResponse({ ok: true }); // PATCH title
    mockFetchResponse([]); // refreshChatList after title

    await act(async () => { await result.current.sendMessage('Hello world'); });

    // Find the PATCH call that sets the title
    const patchCall = mockFetch.mock.calls.find(
      ([url, opts]) => url.includes('/api/chat/chats/new-chat-1') && opts?.method === 'PATCH'
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall[1].body);
    expect(body.title).toBe('Hello world');
  });

  // --------------- Image file forwarding ---------------

  it('forwards files to chat.sendMessage', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const files = [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc' }];

    mockFetchResponse({ id: 'chat-img' }); // createChat
    mockFetchResponse([]); // refreshChatList
    mockFetchResponse({ ok: true }); // PATCH title
    mockFetchResponse([]); // refreshChatList

    await act(async () => { await result.current.sendMessage('Look at this', files); });

    expect(sendMessageSpy).toHaveBeenCalledWith({ text: 'Look at this', files });
  });

  it('uses fallback title for image-only messages', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const files = [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc' }];

    mockFetchResponse({ id: 'chat-img2' }); // createChat
    mockFetchResponse([]); // refreshChatList
    mockFetchResponse({ ok: true }); // PATCH title
    mockFetchResponse([]); // refreshChatList

    await act(async () => { await result.current.sendMessage('', files); });

    const patchCall = mockFetch.mock.calls.find(
      ([url, opts]) => url.includes('/api/chat/chats/chat-img2') && opts?.method === 'PATCH'
    );
    expect(patchCall).toBeDefined();
    const body = JSON.parse(patchCall[1].body);
    expect(body.title).toBe('Image');
  });

  it('sends text as space for image-only messages', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    const files = [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,abc' }];

    mockFetchResponse({ id: 'chat-img3' }); // createChat
    mockFetchResponse([]); // refreshChatList
    mockFetchResponse({ ok: true }); // PATCH title
    mockFetchResponse([]); // refreshChatList

    await act(async () => { await result.current.sendMessage('', files); });

    expect(sendMessageSpy).toHaveBeenCalledWith({ text: ' ', files });
  });

  it('does not pass files when none provided', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    mockFetchResponse({ id: 'chat-nf' }); // createChat
    mockFetchResponse([]); // refreshChatList
    mockFetchResponse({ ok: true }); // PATCH title
    mockFetchResponse([]); // refreshChatList

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
      await waitFor(() => expect(mockFetch).toHaveBeenCalled());

      // Clear any calls from initial mount
      stopSpy.mockClear();
      setMessagesSpy.mockClear();

      mockFetchResponse({ id: 'new-chat-a' }); // createChat POST
      mockFetchResponse([]); // refreshChatList after create
      mockFetchResponse({ ok: true }); // PATCH title
      mockFetchResponse([]); // refreshChatList after title

      await act(async () => { await result.current.sendMessage('First message'); });

      // The creatingChatRef flag should skip the useEffect's stop/clear cycle
      expect(stopSpy).not.toHaveBeenCalled();
    });

    it('does not clear messages when creating a new chat', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockFetch).toHaveBeenCalled());

      stopSpy.mockClear();
      setMessagesSpy.mockClear();

      mockFetchResponse({ id: 'new-chat-b' }); // createChat POST
      mockFetchResponse([]); // refreshChatList after create
      mockFetchResponse({ ok: true }); // PATCH title
      mockFetchResponse([]); // refreshChatList after title

      await act(async () => { await result.current.sendMessage('First message'); });

      // setMessages([]) should NOT be called — that would wipe the just-sent message
      expect(setMessagesSpy).not.toHaveBeenCalledWith([]);
    });

    it('transport gets the new chat ID, not null', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockFetch).toHaveBeenCalled());

      mockFetchResponse({ id: 'fresh-42' }); // createChat POST
      mockFetchResponse([]); // refreshChatList after create
      mockFetchResponse({ ok: true }); // PATCH title
      mockFetchResponse([]); // refreshChatList after title

      await act(async () => { await result.current.sendMessage('Hello'); });

      // The transport reads chatIdRef — verify it has the new chat ID
      const config = capturedTransportArgs.prepareSendMessagesRequest({
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
      });
      expect(config.body.id).toBe('fresh-42');
    });

    it('reconnect URL uses the new chat ID', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockFetch).toHaveBeenCalled());

      mockFetchResponse({ id: 'reconnect-99' }); // createChat POST
      mockFetchResponse([]); // refreshChatList after create
      mockFetchResponse({ ok: true }); // PATCH title
      mockFetchResponse([]); // refreshChatList after title

      await act(async () => { await result.current.sendMessage('Test'); });

      const reconnect = capturedTransportArgs.prepareReconnectToStreamRequest();
      expect(reconnect.api).toBe('/api/chat/reconnect-99/stream');
    });

    it('sends the message to chat.sendMessage', async () => {
      const { result } = renderAiChat();
      await waitFor(() => expect(mockFetch).toHaveBeenCalled());
      sendMessageSpy.mockClear();

      mockFetchResponse({ id: 'new-chat-c' }); // createChat POST
      mockFetchResponse([]); // refreshChatList after create
      mockFetchResponse({ ok: true }); // PATCH title
      mockFetchResponse([]); // refreshChatList after title

      await act(async () => { await result.current.sendMessage('My first msg'); });

      expect(sendMessageSpy).toHaveBeenCalledWith({ text: 'My first msg', files: undefined });
    });
  });
});
