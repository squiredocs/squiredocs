/**
 * Feature 035 — the chat.js → resolveChatModel seam (FR-012 wiring).
 *
 * The resolution logic itself is unit-tested in
 * server/api/__tests__/chat-model-override.test.js. What can't be proven there
 * is that the serving path actually READS the stored column and passes it in —
 * the one line that makes "next turn, no cache, no re-login" true. So: mock
 * loadByokSettings to return a per-turn row carrying chat_model_override, POST a
 * message, and inspect the arguments resolveChatModel was called with.
 *
 * Mock harness copied from chat-reservation-release.test.js (resolveChatModel
 * returns null, which takes the classified early return before any provider or
 * stream work happens).
 */

// Bypass JWT — fixed test user.
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => { req.user = { userId: 'u1', email: 'u1@example.com', name: 'U1' }; next(); },
}));

jest.mock('../ai-usage', () => ({
  checkQuota: jest.fn(async () => ({ allowed: true, creditCents: 500, usedCents: 0 })),
  reserveCredits: jest.fn(async () => 'resv-1'),
  reconcileReservation: jest.fn(async () => {}),
  recordUsage: jest.fn(async () => {}),
  computeCostCents: jest.fn(() => 0),
}));

// The spy under test. Returning null takes the "no model resolves" early return.
jest.mock('../api/chat-models', () => ({
  resolveChatModel: jest.fn(() => null),
}));

// BYOK off; the row carries the 035 column (set per test below).
const mockLoadByokSettings = jest.fn(async () => null);
jest.mock('../api/byok-settings', () => ({
  loadByokSettings: (...args) => mockLoadByokSettings(...args),
  isByokActive: jest.fn(() => false),
}));

jest.mock('../exception-notifier', () => ({ notifyException: jest.fn() }));
jest.mock('../email', () => ({ notifyCreditLimitReached: jest.fn() }));
jest.mock('../chat-store', () => ({
  loadChat: jest.fn(async () => []),
  saveChat: jest.fn(async () => {}),
}));
jest.mock('../api/chat-tools', () => ({ buildTools: jest.fn(() => ({})) }));
jest.mock('../api/app-settings', () => ({ getSharedDefaultModel: jest.fn(() => 'claude-sonnet') }));
jest.mock('../mcp/auth/agent-token-factory', () => ({ createAgentTokenPair: jest.fn(() => ({ token: 't' })) }));
jest.mock('../url', () => ({ buildBaseUrl: jest.fn(() => 'http://test') }));
jest.mock('../crypto', () => ({ decrypt: jest.fn() }));
jest.mock('../documents', () => ({ getDocument: jest.fn(), hasAccess: jest.fn(async () => false) }));
jest.mock('ai', () => ({}));

const request = require('supertest');
const express = require('express');
const chat = require('../api/chat');
const chatModels = require('../api/chat-models');

describe('035 FR-012 — chat.js passes the stored override into resolveChatModel', () => {
  // chat.js only reads the per-turn settings row when it has a pool
  // (`pool ? await loadByokSettings(...) : null`), and the pool is handed in by
  // index.js at boot. The exemplar harness never needed one; this suite does,
  // because the row IS what it is asserting on. A stub with getPool() is enough:
  // resolveChatModel returns null, so the early return fires long before any query.
  beforeAll(() => {
    chat.init({ getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }) });
  });

  const postOneMessage = async (id) => {
    const app = express();
    app.use('/api/chat', express.json(), chat.router);
    return request(app)
      .post('/api/chat')
      .send({ id, message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } });
  };

  afterEach(() => {
    chat.activeStreams.clear();
    jest.clearAllMocks();
  });

  it('passes the pinned key from the per-turn settings row', async () => {
    mockLoadByokSettings.mockResolvedValueOnce({
      byok_enabled: false,
      byok_model_key: null,
      chat_model_override: 'claude-haiku',
    });

    await postOneMessage('chat-override');

    expect(chatModels.resolveChatModel).toHaveBeenCalledTimes(1);
    expect(chatModels.resolveChatModel).toHaveBeenCalledWith(
      expect.objectContaining({ userOverrideKey: 'claude-haiku' })
    );
  });

  it('passes null when the column is null (the universal default)', async () => {
    mockLoadByokSettings.mockResolvedValueOnce({
      byok_enabled: false,
      byok_model_key: null,
      chat_model_override: null,
    });

    await postOneMessage('chat-no-override');

    expect(chatModels.resolveChatModel).toHaveBeenCalledWith(
      expect.objectContaining({ userOverrideKey: null })
    );
  });

  it('passes null when there is no settings row at all (no pool / missing user)', async () => {
    mockLoadByokSettings.mockResolvedValueOnce(null);

    await postOneMessage('chat-no-row');

    expect(chatModels.resolveChatModel).toHaveBeenCalledWith(
      expect.objectContaining({ userOverrideKey: null })
    );
  });
});
