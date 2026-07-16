/**
 * Feature 012 finding L4: a classified early return that happens AFTER
 * reserveCredits but BEFORE the stream starts must release the credit
 * reservation. On those paths onFinish (which normally reconciles the
 * reservation) never fires, so without an explicit release the 'reserved' row
 * lingers forever, permanently debiting the user's monthly quota.
 *
 * The concrete leak: the shared-key "no model resolves" path (resolveChatModel
 * → null) reserves credits, then classified-500s and returns.
 */

// Bypass JWT — fixed test user.
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => { req.user = { userId: 'u1', email: 'u1@example.com', name: 'U1' }; next(); },
}));

// aiUsage: quota allowed, reservation succeeds, reconcile is the spy under test.
const mockReconcileReservation = jest.fn(async () => {});
jest.mock('../ai-usage', () => ({
  checkQuota: jest.fn(async () => ({ allowed: true, creditCents: 500, usedCents: 0 })),
  reserveCredits: jest.fn(async () => 'resv-1'),
  reconcileReservation: mockReconcileReservation,
  recordUsage: jest.fn(async () => {}),
  computeCostCents: jest.fn(() => 0),
}));

// No shared model configured → resolveChatModel returns null (the leak path).
jest.mock('../api/chat-models', () => ({
  resolveChatModel: jest.fn(() => null),
}));

// BYOK off for this user.
jest.mock('../api/byok-settings', () => ({
  loadByokSettings: jest.fn(async () => null),
  isByokActive: jest.fn(() => false),
}));

// Silence the operator page fired by the classified internal 500.
jest.mock('../exception-notifier', () => ({ notifyException: jest.fn() }));
jest.mock('../email', () => ({ notifyCreditLimitReached: jest.fn() }));

// Heavy / IO deps the handler touches before the early return.
jest.mock('../chat-store', () => ({
  loadChat: jest.fn(async () => []),
  saveChat: jest.fn(async () => {}),
}));
jest.mock('../api/chat-tools', () => ({ buildTools: jest.fn(() => ({})) }));
jest.mock('../api/app-settings', () => ({ getSharedDefaultModel: jest.fn(() => null) }));
jest.mock('../mcp/auth/agent-token-factory', () => ({ createAgentTokenPair: jest.fn(() => ({ token: 't' })) }));
jest.mock('../url', () => ({ buildBaseUrl: jest.fn(() => 'http://test') }));
jest.mock('../crypto', () => ({ decrypt: jest.fn() }));
jest.mock('../documents', () => ({ getDocument: jest.fn(), hasAccess: jest.fn(async () => false) }));
// getAI() is called before the early return; nothing on it is invoked though.
jest.mock('ai', () => ({}));

const request = require('supertest');
const express = require('express');
const chat = require('../api/chat');

describe('L4 — credit reservation is released on the classified "no model" early return', () => {
  afterEach(() => {
    chat.activeStreams.clear();
    jest.clearAllMocks();
  });

  it('reconciles the reservation with { failed: true } and returns a classified 500', async () => {
    const app = express();
    app.use('/api/chat', express.json(), chat.router);

    const res = await request(app)
      .post('/api/chat')
      .send({ id: 'chat-noModel', message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } });

    // Classified internal failure (no shared model configured) — never a raw 500 body.
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('internal');

    // The reservation taken upfront must be released, not left dangling.
    expect(mockReconcileReservation).toHaveBeenCalledTimes(1);
    expect(mockReconcileReservation).toHaveBeenCalledWith('resv-1', { failed: true });
  });
});
