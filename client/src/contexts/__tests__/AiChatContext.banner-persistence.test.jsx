/**
 * Durable banner-persistence tests against the REAL @ai-sdk/react Chat class
 * (feature 025, FR-017 / ledger D8 / research.md R6).
 *
 * The original flash-then-clear bug shipped because the context tests fully mocked
 * the SDK and never modeled its status flips. These tests drive the real Chat with
 * a scripted transport so the SDK's ACTUAL transitions run — a resume clears the
 * SDK error (error → submitted → ready), a clean replay ends at 'ready', an error
 * chunk lands the SDK in 'error' — and assert the DERIVED banner is governed by the
 * durable turn-error state alone, never by SDK status (contracts/failure-record.md
 * §D). Only `ai`'s DefaultChatTransport is swapped; @ai-sdk/react stays REAL.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import {
  ScriptedChatTransport, latestScriptedTransport, resetScriptedTransports,
  errorChunks, replyChunks, partialThenErrorChunks,
} from '../../test/scriptedChatTransport';

// Swap ONLY DefaultChatTransport; keep the rest of `ai` (AbstractChat, generateId,
// stream utilities) real so the real Chat class runs unmodified.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, DefaultChatTransport: ScriptedChatTransport };
});

const mockApi = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() };
const refreshAccessTokenSpy = vi.fn().mockResolvedValue('refreshed-token');
let mockAccessToken = 'test-token';
vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    get accessToken() { return mockAccessToken; },
    refreshAccessToken: refreshAccessTokenSpy,
    api: mockApi,
    user: { name: 'Test User' },
  }),
}));

const { AiChatProvider, useAiChat } = await import('../AiChatContext');

function wrapper({ children }) { return <AiChatProvider>{children}</AiChatProvider>; }
function renderAiChat() { return renderHook(() => useAiChat(), { wrapper }); }

// Let time pass by `ms`. Under real timers this is the plain sleep these tests
// always used; under fake timers (the two recovery tests below) it advances the
// single fake clock that also drives RECONNECT_ESTABLISH_MS and the tests' own
// scheduled stream deliveries. Timer-agnostic so the eight real-timer tests keep
// byte-identical behavior.
const settle = async (ms) => (
  vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(ms) : new Promise((r) => setTimeout(r, ms))
);

// Queue the create-chat → refreshList → title → refreshList api sequence.
function mockNewChatFlow(chatId) {
  mockApi.post.mockResolvedValueOnce({ data: { id: chatId } });
  mockApi.get.mockResolvedValueOnce({ data: [] });
  mockApi.patch.mockResolvedValueOnce({ data: {} });
  mockApi.get.mockResolvedValueOnce({ data: [] });
}

const userText = { role: 'user', parts: [{ type: 'text', text: 'hi' }] };
const stampedUser = (code, provider) => ({ role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata: { failure: { code, ...(provider ? { provider } : {}), at: 'T' } } });
const assistantReply = { role: 'assistant', parts: [{ type: 'text', text: 'done' }] };

// Send on a fresh chat whose scripted stream is `chunks`; returns after onError/
// onFinish has settled.
async function sendWith(result, chatId, chunks, text = 'hi') {
  mockNewChatFlow(chatId);
  latestScriptedTransport().scriptSend(chunks);
  await act(async () => {
    await result.current.sendMessage(text);
    await settle(30);
  });
}

describe('durable banner persistence (real Chat + scripted transport)', () => {
  beforeEach(() => {
    resetScriptedTransports();
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.patch.mockReset();
    mockApi.delete.mockReset();
    refreshAccessTokenSpy.mockClear().mockResolvedValue('refreshed-token');
    mockAccessToken = 'test-token';
    sessionStorage.clear();
    mockApi.get.mockResolvedValueOnce({ data: [] }); // chat-list on mount
  });
  // useRealTimers is unconditional so a test that fails mid-way under a fake
  // clock can never leak it into the next test.
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  // ── T012 / US1: a failed turn stays visibly failed ────────────────────────

  it('a live-error banner stays across the SDK clearing its error (error → submitted → ready)', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    // A fatal classified failure lands the SDK in status 'error' and sets the
    // durable banner.
    await sendWith(result, 'chat-a', errorChunks('busy', { code: 'provider_overloaded', provider: 'anthropic' }));
    expect(result.current.status).toBe('error');
    expect(result.current.errorInfo).toMatchObject({ code: 'provider_overloaded' });

    // Drive a real resume that returns a clean (content-free) stream: the SDK flips
    // error → submitted (error cleared) → ready. The durable banner must NOT vanish
    // — SDK status is not a render gate (FR-008).
    latestScriptedTransport().scriptReconnect([{ type: 'start' }, { type: 'finish' }]);
    await act(async () => { await result.current.resumeStream(); await settle(20); });

    expect(result.current.status).toBe('ready');   // SDK cleared its error and ended clean
    expect(result.current.error).toBeUndefined();
    expect(result.current.errorInfo).toMatchObject({ code: 'provider_overloaded' }); // banner stays
  });

  it('keeps turn-error state per chat (fail A, a fresh chat B shows none)', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    await sendWith(result, 'chat-A', errorChunks('busy', { code: 'provider_overloaded', provider: 'anthropic' }));
    expect(result.current.errorInfo).toMatchObject({ code: 'provider_overloaded' });

    // Switch to a brand-new draft chat — no error bleeds across.
    await act(async () => { await result.current.createChat(); await settle(10); });
    expect(result.current.errorInfo).toBeNull();
    expect(result.current.usageLimitReached).toBe(false);
  });

  // ── T016 / US2: failures survive reloads / re-syncs ───────────────────────

  it('populates the banner from a loaded transcript bearing a trailing failure record', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    // A reload/select loads a transcript whose trailing user turn is stamped.
    mockApi.get.mockResolvedValueOnce({ data: { messages: [stampedUser('app_usage_limit')] } });
    await act(async () => { result.current.selectChat('chat-reload'); await settle(20); });

    // Derived purely from the transcript — identical copy/action to a live banner.
    expect(result.current.errorInfo).toMatchObject({ code: 'app_usage_limit' });
    expect(result.current.usageLimitReached).toBe(true);
    expect(result.current.status).not.toBe('error'); // proves status is not the gate
  });

  it('shows no banner for a legacy/answered transcript (additive-safe, FR-016)', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    mockApi.get.mockResolvedValueOnce({ data: { messages: [userText, assistantReply] } });
    await act(async () => { result.current.selectChat('chat-legacy'); await settle(20); });

    expect(result.current.errorInfo).toBeNull();
  });

  // ── T018 / US3: recovery is honest ────────────────────────────────────────

  it('a failed recovery (resume opens, no reply lands) leaves the banner', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    // Fake timers go in only AFTER the opening waitFor: RTL v14 detects Jest fake
    // timers, not Vitest's, so a waitFor under a fake clock would hang. Everything
    // below is driven by settle(), never waitFor.
    vi.useFakeTimers();

    // A non-fatal internal failure enters recovery (no immediate banner).
    await sendWith(result, 'chat-int', errorChunks('Bad Gateway'));

    // Recovery refetches: still awaiting the assistant. The reconnect opens a stream
    // that ends clean with NO content — waitForReply times out → banner stays.
    mockApi.get.mockResolvedValue({ data: { messages: [userText] } });
    latestScriptedTransport().scriptReconnect([{ type: 'start' }, { type: 'finish' }]);
    await act(async () => { await settle(5600); });

    expect(result.current.errorInfo).toMatchObject({ code: 'internal' });
    expect(result.current.reconnecting).toBe(false); // attempt concluded…
  });

  it('a reply that lands LATE (past the establish window) clears the stale banner + untouched draft (F2)', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    // Fake timers go in after the opening waitFor (RTL v14 does not detect Vitest
    // fake timers) but BEFORE the reconnectToStream patch below, so the 6500ms
    // delivery is armed on the same clock as RECONNECT_ESTABLISH_MS — otherwise the
    // "late" reply could arrive un-late.
    vi.useFakeTimers();

    // The resumed stream opens immediately but its first CONTENT arrives only AFTER
    // the establish window — a slow-TTFT reconnect. Model it with a delayed stream
    // (the scripted transport streams synchronously, so patch reconnectToStream here).
    const t = latestScriptedTransport();
    t.reconnectToStream = () => Promise.resolve(new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'start' }); // opens with no content yet
        setTimeout(() => {
          controller.enqueue({ type: 'text-start', id: 't1' });
          controller.enqueue({ type: 'text-delta', id: 't1', delta: 'late answer' });
          controller.enqueue({ type: 'text-end', id: 't1' });
          controller.enqueue({ type: 'finish' });
          controller.close();
        }, 6500); // past RECONNECT_ESTABLISH_MS (5s)
      },
    }));

    // A non-fatal internal failure enters recovery; the DB refetch shows the turn
    // still awaiting the assistant, so recovery reattaches to the (slow) stream.
    mockNewChatFlow('chat-late');
    mockApi.get.mockResolvedValueOnce({ data: { messages: [userText] } }); // recovery refetch
    t.scriptSend(errorChunks('Bad Gateway'));
    await act(async () => { await result.current.sendMessage('my draft'); await settle(30); });

    // waitForReply times out (no content within 5s) → fallback: banner + restored draft.
    // 5500 crosses the 5000ms establish window but stops short of the 6500ms delivery,
    // so this first stage is observed before the late reply lands.
    await act(async () => { await settle(5500); });
    expect(result.current.errorInfo).toMatchObject({ code: 'internal' });
    expect(result.current.draftText).toBe('my draft');
    expect(result.current.reconnecting).toBe(false); // attempt concluded

    // The reply lands late on that same instance → the background late-reply watcher
    // retires the now-stale banner and withdraws the untouched draft (no duplicate send).
    await act(async () => { await settle(3200); });
    expect(result.current.errorInfo).toBeNull();
    expect(result.current.draftText).toBe('');
  });

  it('a fatal code is not recovered — banner renders immediately, no reconnect', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    await sendWith(result, 'chat-fatal', errorChunks('nope', { code: 'byok_invalid_key', provider: 'anthropic' }));

    expect(result.current.errorInfo).toMatchObject({ code: 'byok_invalid_key' });
    expect(latestScriptedTransport().reconnectCalls).toBe(0); // no recovery attempted
  });

  // ── T020 / US4: derived lifecycle (supersede + neutralize) ────────────────

  it('the next send clears the banner immediately (supersession)', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    await sendWith(result, 'chat-sup', errorChunks('busy', { code: 'provider_overloaded', provider: 'anthropic' }));
    expect(result.current.errorInfo).toMatchObject({ code: 'provider_overloaded' });

    // Next send on the SAME chat supersedes: the banner clears on send. Script the
    // resend to succeed so it doesn't re-trip.
    latestScriptedTransport().scriptSend(replyChunks('recovered'));
    mockApi.get.mockResolvedValue({ data: [] });
    await act(async () => { await result.current.sendMessage('try again'); await settle(30); });

    expect(result.current.errorInfo).toBeNull();
  });

  // ── T022 / US5: durable interruption notice ───────────────────────────────

  it('a mid-stream failure shows the interruption notice + banner, derived from partial content', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    // Partial assistant content, then a fatal classified error mid-stream.
    await sendWith(result, 'chat-mid', partialThenErrorChunks('partial…', { code: 'provider_overloaded', provider: 'anthropic' }));

    expect(result.current.errorInfo).toMatchObject({ code: 'provider_overloaded' });
    expect(result.current.interruptionReason).toBeTruthy();
    expect(result.current.interruptionReason).toContain('busy');
  });

  it('a reloaded interrupted transcript re-derives the notice + banner (SC-006)', async () => {
    const { result } = renderAiChat();
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    // Reload a transcript: stamped user turn followed by a partial assistant reply.
    const partial = { role: 'assistant', parts: [{ type: 'text', text: 'partial…' }] };
    mockApi.get.mockResolvedValueOnce({ data: { messages: [stampedUser('provider_overloaded', 'anthropic'), partial] } });
    await act(async () => { result.current.selectChat('chat-mid-reload'); await settle(20); });

    expect(result.current.errorInfo).toMatchObject({ code: 'provider_overloaded' });
    expect(result.current.interruptionReason).toBeTruthy();
  });
});
