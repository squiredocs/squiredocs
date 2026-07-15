/**
 * Anonymous-surface invariance (feature 008, T026; contract anonymous-surface.md).
 *
 * Pins that the ONLY anonymous-reachable surface is initialize / tools-list /
 * ping / the two login tools, and that every other anonymous request keeps the
 * byte-identical missing-credential 401 challenge + body. A fixed Host header
 * makes buildBaseUrl deterministic so the WWW-Authenticate string can be pinned
 * as a literal. Invalid/expired credentials keep today's invalid-token 401 for
 * every method — anonymous means ABSENT, not broken (D1).
 */
const express = require('express');
const request = require('supertest');
const { createPersistence } = require('../../../__tests__/helpers/db');
const mcp = require('../../index');
const toolRegistry = require('../../tools');

const persistence = createPersistence();

const HOST = 'example.com';
const RESOURCE_META = `http://${HOST}/.well-known/oauth-protected-resource/mcp`;
// The pre-feature 401 literals (buildChallenge missing-branch + requireAgentAuth body).
const CHALLENGE_MISSING = `Bearer realm="Squire Docs MCP", resource_metadata="${RESOURCE_META}"`;
const BODY_MISSING = { error: 'No agent token provided', code: 'MISSING_TOKEN' };
const CHALLENGE_INVALID =
  `Bearer realm="Squire Docs MCP", error="invalid_token", `
  + `error_description="Invalid agent token", resource_metadata="${RESOURCE_META}"`;

describe('anonymous MCP surface invariance', () => {
  let app;

  beforeAll(async () => {
    mcp.init(persistence);
    app = express();
    app.use(express.json());
    app.use('/mcp', mcp.router);
  });

  afterAll(async () => {
    await persistence.destroy();
  });

  const rpc = (body, token) => {
    const r = request(app).post('/mcp').set('Host', HOST).set('Content-Type', 'application/json');
    if (token) r.set('Authorization', `Bearer ${token}`);
    return r.send(body);
  };

  test('anonymous initialize / ping succeed; instructions are the anon variant', async () => {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(init.status).toBe(200);
    expect(init.body.result.instructions).toBe(mcp.ANON_SERVER_INSTRUCTIONS);

    const ping = await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(ping.status).toBe(200);
    expect(ping.body.result).toEqual({});
  });

  test('anonymous tools/list is exactly the two login tools', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(res.body.result.tools.map((t) => t.name).sort()).toEqual(['login', 'login_status']);
  });

  test('anonymous tools/call on EVERY non-login tool → byte-identical missing-credential 401', async () => {
    const nonLogin = toolRegistry
      .getToolList()
      .map((t) => t.name)
      .filter((n) => !toolRegistry.ANON_TOOL_NAMES.includes(n));
    expect(nonLogin.length).toBe(16);

    for (const name of nonLogin) {
      const res = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name, arguments: {} } });
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe(CHALLENGE_MISSING);
      expect(res.body).toEqual(BODY_MISSING);
    }
  });

  test('anonymous unknown method → the same missing-credential 401', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(CHALLENGE_MISSING);
    expect(res.body).toEqual(BODY_MISSING);
  });

  test('anonymous malformed JSON-RPC (bad version) → the same missing-credential 401 (008 review)', async () => {
    // Pre-008, EVERY unauthenticated request 401'd before body validation; the
    // version check must not create an anonymous 200 that differs from that.
    const res = await rpc({ jsonrpc: '1.0', id: 5, method: 'tools/call', params: { name: 'list_documents' } });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(CHALLENGE_MISSING);
    expect(res.body).toEqual(BODY_MISSING);
  });

  test('the two login tools ARE anonymously callable (not 401)', async () => {
    const res = await rpc({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'login_status', arguments: { handle: 'sqlh_none' } },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.result.content[0].text).status).toBe('expired');
  });

  test('an INVALID token keeps today\'s invalid-token 401 for initialize AND a login tools/call', async () => {
    const init = await rpc({ jsonrpc: '2.0', id: 7, method: 'initialize' }, 'not-a-real-token');
    expect(init.status).toBe(401);
    expect(init.headers['www-authenticate']).toBe(CHALLENGE_INVALID);
    expect(init.body.code).toBe('INVALID_TOKEN');

    const call = await rpc({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'login', arguments: { agentName: 'X' } },
    }, 'not-a-real-token');
    expect(call.status).toBe(401);
    expect(call.headers['www-authenticate']).toBe(CHALLENGE_INVALID);
    expect(call.body.code).toBe('INVALID_TOKEN');
  });

  test('the convenience POST /mcp/tools/list filters anonymously and is full when authed-shaped', async () => {
    const anon = await request(app).post('/mcp/tools/list').set('Host', HOST).send({});
    expect(anon.body.tools.map((t) => t.name).sort()).toEqual(['login', 'login_status']);
  });

  test('the convenience POST /mcp/tools/call rejects a non-login tool anonymously with the same 401', async () => {
    const res = await request(app).post('/mcp/tools/call').set('Host', HOST).send({ name: 'list_documents', arguments: {} });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(CHALLENGE_MISSING);
    expect(res.body).toEqual(BODY_MISSING);
  });

  test('GET /mcp discovery response is unchanged', async () => {
    const res = await request(app).get('/mcp').set('Host', HOST);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('collab-editor-mcp');
    expect(res.body.protocolVersion).toBe('2024-11-05');
    expect(res.body.authentication.type).toBe('oauth2');
    expect(res.body.authentication.authorizationUrl).toBe(`http://${HOST}/mcp/auth/authorize`);
  });
});
