/**
 * MCP tool-call budget (2026-08-03 review M1).
 *
 * `/mcp` (JSON-RPC `tools/call`) and `/mcp/tools/call` reach the SAME tool
 * dispatch by two doors, and neither was metered while every comparable REST
 * surface was. They must share one budget, keyed on the token's USER — MCP
 * authenticates to `req.agentToken` and never sets `req.user`, so the ordinary
 * per-user helper would key on `undefined` and enforce nothing.
 *
 * Handshake methods stay free: a client that cannot `initialize` or list tools
 * cannot back off intelligently either.
 *
 * Deterministic: forces the per-process memory limiter with a small budget set
 * before the module loads, and opts limiting in under test.
 */
process.env.RL_TEST_ENABLE = '1';
process.env.RL_FORCE_MEMORY = '1';
process.env.RL_MCP_PER_MIN = '3';

const request = require('supertest');
const express = require('express');
const rateLimit = require('../rate-limit');

/** Mirrors the two dispatch shapes in server/mcp/index.js. */
function buildApp() {
  const app = express();
  app.use(express.json());

  // Stands in for requireAgentAuth: sets agentToken, NEVER req.user.
  const fakeAgentAuth = (req, res, next) => {
    req.agentToken = { userId: req.get('x-token-user') || 'user-a', agentId: req.get('x-agent') || 'agent-1' };
    next();
  };

  app.post('/mcp', fakeAgentAuth, async (req, res) => {
    const { method } = req.body || {};
    if (method === 'tools/call') {
      if (!(await rateLimit.enforceKey('mcp', req.agentToken?.userId, res))) return;
    }
    res.json({ jsonrpc: '2.0', result: { ok: true, method } });
  });

  app.post('/mcp/tools/call', fakeAgentAuth, async (req, res) => {
    if (!(await rateLimit.enforceKey('mcp', req.agentToken?.userId, res))) return;
    res.json({ content: [{ type: 'text', text: 'ok' }] });
  });

  return app;
}

describe('MCP tool-call budget', () => {
  let app;
  beforeEach(() => { rateLimit._reset(); app = buildApp(); });

  it('charges tool calls and answers the 4th with a 429 that says what to do', async () => {
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).post('/mcp/tools/call').send({ name: 'modify' });
      expect(ok.status).toBe(200);
    }

    const limited = await request(app).post('/mcp/tools/call').send({ name: 'modify' });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    // The reader is a model: the body must direct the next action, or the
    // obvious behavior is an immediate retry — the thing that spent the budget.
    expect(limited.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.body.guidance).toMatch(/batch/i);
  });

  it('shares ONE budget across both doors to the same dispatch', async () => {
    // Two calls through the JSON-RPC door...
    for (let i = 0; i < 2; i++) {
      const r = await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/call' });
      expect(r.status).toBe(200);
    }
    // ...one through the convenience door exhausts the shared budget of 3...
    expect((await request(app).post('/mcp/tools/call').send({ name: 'x' })).status).toBe(200);

    // ...and now BOTH doors are closed. A per-route budget would leave the
    // other one open as a free path around the limit.
    expect((await request(app).post('/mcp/tools/call').send({ name: 'x' })).status).toBe(429);
    expect((await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/call' })).status).toBe(429);
  });

  it('never charges the handshake, however much of it a client does', async () => {
    for (const method of ['initialize', 'tools/list', 'ping', 'initialize', 'tools/list']) {
      const r = await request(app).post('/mcp').send({ jsonrpc: '2.0', method });
      expect(r.status).toBe(200);
    }
    // The full tool budget is still there afterwards.
    for (let i = 0; i < 3; i++) {
      expect((await request(app).post('/mcp/tools/call').send({ name: 'x' })).status).toBe(200);
    }
    expect((await request(app).post('/mcp/tools/call').send({ name: 'x' })).status).toBe(429);
  });

  it('keys on the USER, so a second token buys no extra budget', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).post('/mcp/tools/call').set('x-agent', 'agent-1').send({ name: 'x' });
    }
    // Same user, different agent/token: still over budget.
    const other = await request(app).post('/mcp/tools/call').set('x-agent', 'agent-2').send({ name: 'x' });
    expect(other.status).toBe(429);

    // A DIFFERENT user is unaffected.
    const stranger = await request(app).post('/mcp/tools/call').set('x-token-user', 'user-b').send({ name: 'x' });
    expect(stranger.status).toBe(200);
  });

  it('fails open when the caller cannot be identified, rather than blocking every agent', async () => {
    const anon = express();
    anon.use(express.json());
    anon.post('/mcp/tools/call', async (req, res) => {
      req.agentToken = {}; // no userId
      if (!(await rateLimit.enforceKey('mcp', req.agentToken?.userId, res))) return;
      res.json({ ok: true });
    });
    for (let i = 0; i < 5; i++) {
      expect((await request(anon).post('/mcp/tools/call').send({})).status).toBe(200);
    }
  });
});
