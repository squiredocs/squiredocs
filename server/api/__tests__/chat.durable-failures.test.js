/**
 * Durable turn-failure persistence + stream teardown (feature 025).
 *
 * Drives the real POST /api/chat handler with a scripted streamText/toUIMessageStream
 * mock and an in-memory chat store, so the stamp-durability invariant (FR-004), the
 * no-stamp-before-persistence rule (FR-006), and the immediate teardown (FR-005) are
 * exercised end-to-end through the actual classification + save + teardown code.
 * The taxonomy (chat-errors) is REAL — classification is not mocked. Assertions per
 * contracts/failure-record.md §C.
 */

jest.mock('../../auth', () => ({
  requireAuth: (req, res, next) => { req.user = { userId: 'u1', email: 'u1@example.com', name: 'U1' }; next(); },
}));
jest.mock('../../rate-limit', () => ({ perUser: () => (req, res, next) => next() }));

// In-memory chat store: loadChat/saveChat round-trip real objects so a stamp
// written by any path is observable via a subsequent loadChat (the "stored
// transcript" the contract asserts on).
const mockStore = new Map();
const mockClone = (v) => JSON.parse(JSON.stringify(v));
const mockSaveChat = jest.fn(async (id, uid, msgs) => { mockStore.set(id, mockClone(msgs)); });
jest.mock('../../chat-store', () => ({
  loadChat: jest.fn(async (id) => (mockStore.has(id) ? mockClone(mockStore.get(id)) : [])),
  saveChat: mockSaveChat,
}));

const mockCheckQuota = jest.fn(async () => ({ allowed: true, creditCents: 500, usedCents: 0 }));
jest.mock('../../ai-usage', () => ({
  checkQuota: mockCheckQuota,
  reserveCredits: jest.fn(async () => 'resv-1'),
  reconcileReservation: jest.fn(async () => {}),
  recordUsage: jest.fn(async () => {}),
  computeCostCents: jest.fn(() => 0),
}));
jest.mock('../byok-settings', () => ({ loadByokSettings: jest.fn(async () => null), isByokActive: jest.fn(() => false) }));
jest.mock('../../exception-notifier', () => ({ notifyException: jest.fn() }));
jest.mock('../../email', () => ({ notifyCreditLimitReached: jest.fn() }));
jest.mock('../chat-tools', () => ({ buildTools: jest.fn(() => ({})) }));
jest.mock('../app-settings', () => ({ getSharedDefaultModel: jest.fn(() => 'shared-default') }));
jest.mock('../../mcp/auth/agent-token-factory', () => ({ createAgentTokenPair: jest.fn(() => ({ token: 't' })) }));
jest.mock('../../url', () => ({ buildBaseUrl: jest.fn(() => 'http://test') }));
jest.mock('../../crypto', () => ({ decrypt: jest.fn() }));
jest.mock('../../s3-images', () => ({}));
jest.mock('../../documents', () => ({ getDocument: jest.fn(), hasAccess: jest.fn(async () => false) }));

// A resolved shared model (provider anthropic, vision-capable so no image swaps).
jest.mock('../chat-models', () => ({
  resolveChatModel: jest.fn(() => ({ model: {}, def: { key: 'test', modelId: 'm', provider: 'anthropic', supportsImages: true }, provider: {} })),
  buildProviderOptions: jest.fn(() => null),
  // Feature 039: chat.js strips UI-only diff data from replayed history on every
  // turn (unconditionally, unlike the capability-gated strips). This suite mocks
  // chat-models wholesale, so the new export has to be present here or the turn
  // dies with a TypeError and every failure is misclassified as 'internal'.
  stripUiOnlyDiffParts: jest.fn((m) => m),
  // Same hazard for the history-reasoning gate chat.js consults on every turn.
  shouldStripReasoningFromHistory: jest.fn(() => false),
}));
jest.mock('../ai-providers', () => ({
  ...jest.requireActual('../ai-providers'),
  getProviderConfig: jest.fn(() => ({ capabilities: {} })),
}));

// Scripted streamText: `mockStreamPlan` controls the emitted chunks and the onFinish
// `saved` array. A `{ __providerError }` marker calls the real classify seam
// (onError) then emits the resulting error chunk, exactly as toUIMessageStream does.
let mockStreamPlan = null;
jest.mock('ai', () => ({
  streamText: jest.fn(() => ({
    toUIMessageStream: ({ onError, onFinish }) => {
      const plan = mockStreamPlan;
      const stream = new ReadableStream({
        start(controller) {
          for (const ch of plan.chunks) {
            if (ch.__providerError) {
              const errorText = onError(ch.__providerError);
              controller.enqueue({ type: 'error', errorText });
            } else {
              controller.enqueue(ch);
            }
          }
          controller.close();
        },
      });
      if (plan.saved !== null) Promise.resolve().then(() => onFinish({ messages: JSON.parse(JSON.stringify(plan.saved)) }));
      return stream;
    },
  })),
  convertToModelMessages: jest.fn((m) => m),
  validateUIMessages: jest.fn(async ({ messages }) => messages),
  createIdGenerator: jest.fn(() => () => 'gen-id'),
  stepCountIs: jest.fn(() => 100),
}));

const request = require('supertest');
const express = require('express');
const chat = require('../chat');

const userMsg = { role: 'user', parts: [{ type: 'text', text: 'hi' }] };
const app = express();
app.use('/api/chat', express.json(), chat.router);

const post = (id) => request(app).post('/api/chat').send({ id, message: userMsg });
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockStore.clear();
  chat.activeStreams.clear();
  mockStreamPlan = null;
  jest.clearAllMocks();
  mockCheckQuota.mockResolvedValue({ allowed: true, creditCents: 500, usedCents: 0 });
});

describe('stamp durability (FR-004) + codes-only (FR-003)', () => {
  it('mid-stream failure folds the partial reply AND the stamp into one save (FR-004/T023)', async () => {
    mockStreamPlan = {
      chunks: [
        { type: 'start' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'partial answer' },
        { __providerError: { statusCode: 529 } }, // anthropic overloaded, mid-stream
      ],
      saved: [userMsg, { role: 'assistant', parts: [{ type: 'text', text: 'partial answer' }] }],
    };

    await post('chat-mid');
    await settle();

    const stored = mockStore.get('chat-mid');
    expect(stored[0].role).toBe('user');
    expect(stored[0].metadata.failure).toEqual({ code: 'provider_overloaded', provider: 'anthropic', at: expect.any(String) });
    // The partial reply is persisted in the SAME transcript (one fold save).
    expect(stored[1]).toMatchObject({ role: 'assistant' });
    expect(stored[1].parts[0].text).toBe('partial answer');
    // Codes only — no raw provider text anywhere in the record.
    expect(JSON.stringify(stored[0].metadata.failure)).not.toMatch(/529|overloaded_error/);
  });

  it('post-save early return (usage limit) stamps via an awaited RMW (FR-004/T015b)', async () => {
    mockCheckQuota.mockResolvedValueOnce({ allowed: false, creditCents: 100, usedCents: 100 });

    const res = await post('chat-usage');
    await settle();

    expect(res.status).toBe(402);
    const stored = mockStore.get('chat-usage');
    expect(stored).toHaveLength(1); // just the user turn, now stamped
    expect(stored[0].metadata.failure).toEqual({ code: 'app_usage_limit', at: expect.any(String) });
    expect(stored[0].metadata.failure.provider).toBeUndefined(); // provider-agnostic code
  });

  it('before-content outer-catch failure stamps via RMW (FR-004/T015c)', async () => {
    mockStreamPlan = {
      chunks: [{ type: 'start' }, { __providerError: { statusCode: 500 } }], // error before any content → throws → outer catch
      saved: null, // isolate the RMW path (onFinish not fired)
    };

    const res = await post('chat-precontent');
    await settle();

    expect(res.status).toBe(500);
    const stored = mockStore.get('chat-precontent');
    expect(stored).toHaveLength(1);
    expect(stored[0].metadata.failure).toMatchObject({ code: 'internal', at: expect.any(String) });
  });

  it('additive: the stamp never clobbers sibling metadata (refs/kind)', async () => {
    mockCheckQuota.mockResolvedValueOnce({ allowed: false, creditCents: 100, usedCents: 100 });
    const richMsg = { role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata: { refs: [{ text: 'q' }], kind: 'x' } };

    await request(app).post('/api/chat').send({ id: 'chat-additive', message: richMsg });
    await settle();

    const stored = mockStore.get('chat-additive');
    expect(stored[0].metadata.refs).toEqual([{ text: 'q' }]);
    expect(stored[0].metadata.kind).toBe('x');
    expect(stored[0].metadata.failure.code).toBe('app_usage_limit');
  });
});

describe('no stamp before the user message persists (FR-006 / F1)', () => {
  it('a pre-save loadChat throw reaches the outer catch WITHOUT stamping the prior, answered turn', async () => {
    const chatStore = require('../../chat-store');
    // Seed an already-answered prior turn (trailing user message at index 0).
    mockStore.set('chat-presave', [userMsg, { role: 'assistant', parts: [{ type: 'text', text: 'answered' }] }]);
    // The pre-save history load (before the user-message save) throws a transient DB
    // error → the outer catch classifies `internal`. Without the userTurnPersisted
    // gate this stamped the PREVIOUS turn (a durable false-failure banner, F1).
    chatStore.loadChat.mockImplementationOnce(async () => { throw new Error('transient DB error'); });

    const res = await post('chat-presave');
    await settle();

    expect(res.status).toBe(500); // internal, surfaced from the outer catch
    const stored = mockStore.get('chat-presave');
    expect(stored).toHaveLength(2);            // prior turn untouched — no third message
    expect(stored.some((m) => m?.metadata?.failure)).toBe(false); // and NO false stamp
    expect(stored[0].metadata).toBeUndefined();
  });

  it('a pre-save stream-cap rejection leaves no record and does not mutate a prior turn', async () => {
    // Seed an answered prior turn and saturate the per-user concurrent-stream cap.
    mockStore.set('chat-cap', [userMsg, { role: 'assistant', parts: [{ type: 'text', text: 'done' }] }]);
    for (let i = 0; i < 10; i += 1) chat.activeStreams.set(`other-${i}`, { chunks: [], done: false, userId: 'u1' });

    const res = await post('chat-cap');
    await settle();

    expect(res.status).toBe(429); // rate_limited, returned before the user-message save
    const stored = mockStore.get('chat-cap');
    expect(stored).toHaveLength(2); // untouched — no third (stamped) message, no mutation
    expect(stored[0].metadata).toBeUndefined();
    expect(stored[1].metadata).toBeUndefined();
  });
});

describe('immediate teardown / no failure replay (FR-005)', () => {
  it('after a mid-stream failure GET /:id/stream returns 204 (entry torn down, buffer cleared)', async () => {
    mockStreamPlan = {
      chunks: [
        { type: 'start' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'x' },
        { __providerError: { statusCode: 529 } },
      ],
      saved: [userMsg, { role: 'assistant', parts: [{ type: 'text', text: 'x' }] }],
    };
    await post('chat-td');
    await settle();

    expect(chat.activeStreams.has('chat-td')).toBe(false); // torn down immediately
    const res = await request(app).get('/api/chat/chat-td/stream');
    expect(res.status).toBe(204);
  });

  it('after a pre-content classified early return GET /:id/stream returns 204', async () => {
    mockCheckQuota.mockResolvedValueOnce({ allowed: false, creditCents: 100, usedCents: 100 });
    await post('chat-td2');
    await settle();

    expect(chat.activeStreams.has('chat-td2')).toBe(false);
    const res = await request(app).get('/api/chat/chat-td2/stream');
    expect(res.status).toBe(204);
  });

  it('a successful turn keeps the entry (30s replay window) and persists no failure', async () => {
    mockStreamPlan = {
      chunks: [
        { type: 'start' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'answer' },
        { type: 'text-end', id: 't' }, { type: 'finish' },
      ],
      saved: [userMsg, { role: 'assistant', parts: [{ type: 'text', text: 'answer' }] }],
    };
    await post('chat-ok');
    await settle();

    // Entry lingers (not torn down) — the post-success replay window is unchanged.
    expect(chat.activeStreams.has('chat-ok')).toBe(true);
    // No failure record on a clean turn.
    const stored = mockStore.get('chat-ok');
    expect(stored.some((m) => m?.metadata?.failure)).toBe(false);
  });
});
