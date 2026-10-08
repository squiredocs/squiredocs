/**
 * The assistant with no usable key (self-hosted v1.0.0 first-user finding).
 *
 * A self-hosted instance started without ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or
 * GOOGLE_GENERATIVE_AI_API_KEY, for a user without a BYOK key, used to resolve the
 * Anthropic default anyway, call the provider without a key, and fail as `internal`
 * (paging the operator). Now:
 *   - the chat route rejects with `assistant_not_configured` BEFORE any provider
 *     call, releases the credit reservation, stamps the turn, and pages no one;
 *   - an instance with only an OpenRouter or only a Gemini server key resolves a
 *     usable shared model;
 *   - an instance with an Anthropic key (the hosted service) resolves exactly as before;
 *   - GET /api/settings/byok reports `assistantAvailable` so the client can show a
 *     setup state instead of sending a doomed turn.
 *
 * chat-models is REAL here (unlike the other route suites) so the eligibility rule
 * itself is exercised end to end.
 */

jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => { req.user = { userId: 'u1', email: 'u1@example.com', name: 'U1' }; next(); },
}));
jest.mock('../rate-limit', () => ({ perUser: () => (req, res, next) => next() }));

const mockStore = new Map();
const mockClone = (v) => JSON.parse(JSON.stringify(v));
jest.mock('../chat-store', () => ({
  loadChat: jest.fn(async (id) => (mockStore.has(id) ? mockClone(mockStore.get(id)) : [])),
  saveChat: jest.fn(async (id, uid, msgs) => { mockStore.set(id, mockClone(msgs)); }),
}));

const mockReconcileReservation = jest.fn(async () => {});
jest.mock('../ai-usage', () => ({
  checkQuota: jest.fn(async () => ({ allowed: true, creditCents: 500, usedCents: 0 })),
  reserveCredits: jest.fn(async () => 'resv-1'),
  reconcileReservation: mockReconcileReservation,
  recordUsage: jest.fn(async () => {}),
  computeCostCents: jest.fn(() => 0),
}));

// The chat route's BYOK seam: off for this user unless a test overrides it.
jest.mock('../api/byok-settings', () => {
  const actual = jest.requireActual('../api/byok-settings');
  return { ...actual, loadByokSettings: jest.fn(async () => null) };
});

const mockNotifyException = jest.fn();
jest.mock('../exception-notifier', () => ({ notifyException: mockNotifyException }));
jest.mock('../email', () => ({ notifyCreditLimitReached: jest.fn() }));
jest.mock('../api/chat-tools', () => ({ buildTools: jest.fn(() => ({})) }));
jest.mock('../api/app-settings', () => ({ getSharedDefaultModel: jest.fn(() => null) }));
jest.mock('../mcp/auth/agent-token-factory', () => ({ createAgentTokenPair: jest.fn(() => ({ token: 't' })) }));
jest.mock('../url', () => ({ buildBaseUrl: jest.fn(() => 'http://test') }));
jest.mock('../crypto', () => ({ decrypt: jest.fn((ct) => ct), encrypt: jest.fn((pt) => pt) }));
jest.mock('../image-storage', () => ({}));
jest.mock('../documents', () => ({ getDocument: jest.fn(), hasAccess: jest.fn(async () => false) }));

// Any provider call goes through streamText; it must never run on this path.
const mockStreamText = jest.fn(() => { throw new Error('provider must not be called'); });
jest.mock('ai', () => ({
  streamText: mockStreamText,
  convertToModelMessages: jest.fn((m) => m),
  validateUIMessages: jest.fn(async ({ messages }) => messages),
  createIdGenerator: jest.fn(() => () => 'gen-id'),
  stepCountIs: jest.fn(() => 100),
}));

const request = require('supertest');
const express = require('express');
const chat = require('../api/chat');
const byokSettings = require('../api/byok-settings');
const {
  resolveChatModel, resolveSharedDefaultKey, hasUsableSharedModel, DEFAULT_MODEL_KEY,
} = require('../api/chat-models');
const { listProviders } = require('../api/ai-providers');

// Every env var that gives a provider a shared server key, plus the model override.
const SERVER_KEY_ENVS = listProviders().map((p) => p.serverKeyEnv).filter(Boolean);
const TOUCHED_ENVS = [...SERVER_KEY_ENVS, 'AI_CHAT_MODEL'];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(TOUCHED_ENVS.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED_ENVS) delete process.env[k];
  mockStore.clear();
  chat.activeStreams.clear();
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of TOUCHED_ENVS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  console.warn.mockRestore();
  console.log.mockRestore();
});

const userMsg = { role: 'user', parts: [{ type: 'text', text: 'hi' }] };

function chatApp() {
  const app = express();
  app.use('/api/chat', express.json(), chat.router);
  return app;
}

describe('chat route with no server key and no BYOK', () => {
  it('rejects with assistant_not_configured before any provider call', async () => {
    const res = await request(chatApp()).post('/api/chat').send({ id: 'chat-nokey', message: userMsg });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('assistant_not_configured');
    expect(res.body.error).toMatch(/Squire Docs assistant needs an AI key/);
    expect(mockStreamText).not.toHaveBeenCalled();
  });

  it('releases the credit reservation and pages no one', async () => {
    await request(chatApp()).post('/api/chat').send({ id: 'chat-nokey-2', message: userMsg });

    expect(mockReconcileReservation).toHaveBeenCalledTimes(1);
    expect(mockReconcileReservation).toHaveBeenCalledWith('resv-1', { failed: true });
    expect(mockNotifyException).not.toHaveBeenCalled();
  });

  it('stamps the failed turn with the code, like the other early rejections', async () => {
    await request(chatApp()).post('/api/chat').send({ id: 'chat-nokey-3', message: userMsg });
    await new Promise((r) => setImmediate(r));

    const stored = mockStore.get('chat-nokey-3');
    expect(stored[stored.length - 1].role).toBe('user');
    expect(stored[stored.length - 1].metadata.failure).toEqual({ code: 'assistant_not_configured', at: expect.any(String) });
  });
});

describe('resolveChatModel / resolveSharedDefaultKey eligibility', () => {
  const shared = (extra = {}) => resolveChatModel({
    isByok: false, byokSettings: null, decryptKey: () => { throw new Error('no decrypt on the shared path'); }, ...extra,
  });

  it('no server key at all: assistant_not_configured, no client built', () => {
    expect(shared()).toEqual({ error: 'assistant_not_configured' });
    // A stored default or per-user pin can't rescue it: no provider has a key.
    expect(shared({ sharedDefaultKey: 'or-kimi-k3', userOverrideKey: 'gemini-3.5-flash' }))
      .toEqual({ error: 'assistant_not_configured' });
  });

  it('only OPENROUTER_API_KEY: resolves a usable gateway model', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    expect(resolveSharedDefaultKey(null)).toBe('or-kimi-k3');
    const resolved = shared();
    expect(resolved.error).toBeUndefined();
    expect(resolved.def.provider).toBe('openrouter');
    expect(resolved.model).toBeTruthy();
  });

  it('only the Gemini key: resolves a usable Gemini model', () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test';
    const resolved = shared();
    expect(resolved.error).toBeUndefined();
    expect(resolved.def.provider).toBe('google');
  });

  it('OpenRouter is preferred over Gemini when both are set and Anthropic is not', () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    expect(resolveSharedDefaultKey(null)).toBe('or-kimi-k3');
  });

  it('hosted-like env (all keys): resolution is unchanged', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'g-test';
    expect(resolveSharedDefaultKey(null)).toBe(DEFAULT_MODEL_KEY);
    expect(shared().def.key).toBe(DEFAULT_MODEL_KEY);
    // Stored default and per-user override keep their precedence.
    expect(shared({ sharedDefaultKey: 'or-qwen3.7-plus' }).def.key).toBe('or-qwen3.7-plus');
    expect(shared({ sharedDefaultKey: 'or-qwen3.7-plus', userOverrideKey: 'claude-opus' }).def.key).toBe('claude-opus');
  });

  it('BYOK is untouched: a configured BYOK user resolves with no server key', () => {
    const resolved = resolveChatModel({
      isByok: true,
      byokSettings: { byok_enabled: true, byok_model_key: 'claude-sonnet', byok_anthropic_key: 'sk-ant-user' },
      decryptKey: (ct) => ct,
    });
    expect(resolved.error).toBeUndefined();
    expect(resolved.def.key).toBe('claude-sonnet');
  });

  it('hasUsableSharedModel tracks whether any provider has a server key', () => {
    expect(hasUsableSharedModel()).toBe(false);
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    expect(hasUsableSharedModel()).toBe(true);
  });
});

describe('GET /api/settings/byok assistantAvailable', () => {
  const baseRow = {
    byok_enabled: false, byok_model_key: null, chat_model_override: null,
    byok_anthropic_key: null, byok_google_key: null, byok_openai_key: null, byok_zai_key: null, byok_openrouter_key: null,
  };

  function settingsApp(row) {
    byokSettings.init({ query: jest.fn(async () => ({ rows: [row] })) });
    const app = express();
    app.use('/api/settings/byok', express.json(), byokSettings.router);
    return app;
  }

  it('false with no server key and no BYOK', async () => {
    const res = await request(settingsApp(baseRow)).get('/api/settings/byok');
    expect(res.status).toBe(200);
    expect(res.body.assistantAvailable).toBe(false);
  });

  it('false when a key is saved but BYOK is not turned on', async () => {
    const res = await request(settingsApp({ ...baseRow, byok_anthropic_key: 'enc' })).get('/api/settings/byok');
    expect(res.body.assistantAvailable).toBe(false);
  });

  it('true once BYOK is enabled with a key and a model', async () => {
    const row = { ...baseRow, byok_enabled: true, byok_model_key: 'claude-sonnet', byok_anthropic_key: 'enc' };
    const res = await request(settingsApp(row)).get('/api/settings/byok');
    expect(res.body.assistantAvailable).toBe(true);
  });

  it('true when the instance has a shared server key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const res = await request(settingsApp(baseRow)).get('/api/settings/byok');
    expect(res.body.assistantAvailable).toBe(true);
  });
});
