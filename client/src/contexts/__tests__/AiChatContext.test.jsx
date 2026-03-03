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

  it('pendingAssistantResponse is not in context value', () => {
    const { result } = renderAiChat();
    expect(result.current).not.toHaveProperty('pendingAssistantResponse');
  });
});
