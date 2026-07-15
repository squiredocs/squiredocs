/**
 * Tests for RFC 9728 discovery documents and the WWW-Authenticate challenge
 * on every MCP 401/403 (feature 005-agent-onboarding, US1).
 *
 * Pattern mirrors api-docs-export.test.js: build a minimal express app with
 * the real routes and real requireAgentAuth middleware, exercise via
 * supertest. No external network. All cases serial-only.
 */
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const mcp = require('../mcp');
const { buildBaseUrl } = require('../url');
const { requireAgentAuth, requireScope } = require('../mcp/auth/middleware');
const { generateAgentToken } = require('../mcp/auth/jwt');
const { createPool, createPersistence } = require('./helpers/db');

const MCP_JWT_SECRET =
  process.env.MCP_JWT_SECRET || 'dev-mcp-secret-change-in-production';

describe('OAuth discovery + WWW-Authenticate challenge', () => {
  let app;
  let pool;
  let persistence;

  beforeAll(async () => {
    pool = createPool();
    persistence = createPersistence();
    await persistence._init();
    mcp.init(persistence);

    app = express();
    app.use(express.json());

    // Mirror the well-known handlers from server/index.js.
    function buildProtectedResourceDoc(req) {
      const baseUrl = buildBaseUrl(req);
      return {
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        scopes_supported: ['documents:read', 'documents:write'],
        bearer_methods_supported: ['header'],
        resource_name: 'Squire Docs MCP',
      };
    }
    app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
      res.json(buildProtectedResourceDoc(req));
    });
    app.get('/.well-known/oauth-protected-resource', (req, res) => {
      res.json(buildProtectedResourceDoc(req));
    });
    app.get('/.well-known/oauth-authorization-server', (req, res) => {
      const baseUrl = buildBaseUrl(req);
      res.json({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/mcp/auth/authorize`,
        token_endpoint: `${baseUrl}/mcp/auth/token`,
        revocation_endpoint: `${baseUrl}/mcp/auth/revoke`,
        registration_endpoint: `${baseUrl}/mcp/auth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['documents:read', 'documents:write'],
      });
    });

    // Wire the real MCP router (has GET /mcp + POST /mcp with requireAgentAuth).
    app.use('/mcp', mcp.router);

    // A scope-guarded stub so we can hit the requireScope 403 branch cleanly
    // without touching real MCP tool code paths.
    app.get('/mcp-scope-check', requireAgentAuth, requireScope('documents:write'), (req, res) => {
      res.json({ ok: true });
    });
  });

  afterAll(async () => {
    if (persistence) await persistence.destroy();
    if (pool) await pool.end();
  });

  test('(a) GET /.well-known/oauth-protected-resource/mcp returns expected shape', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        resource: expect.stringMatching(/\/mcp$/),
        authorization_servers: expect.any(Array),
        scopes_supported: ['documents:read', 'documents:write'],
        bearer_methods_supported: ['header'],
        resource_name: 'Squire Docs MCP',
      })
    );
    expect(res.body.resource.endsWith('/mcp')).toBe(true);
    expect(res.body.authorization_servers).toHaveLength(1);
    // resource base equals authorization_servers[0]
    const authServer = res.body.authorization_servers[0];
    expect(res.body.resource).toBe(`${authServer}/mcp`);
  });

  test('(b) GET /.well-known/oauth-protected-resource is byte-identical to /mcp variant', async () => {
    // Force the same Host header on both requests so buildBaseUrl returns the
    // same base URL (supertest allocates fresh ephemeral ports otherwise).
    const HOST = 'squiredocs.test:8080';
    const pathSuffix = await request(app)
      .get('/.well-known/oauth-protected-resource/mcp')
      .set('Host', HOST);
    const rootFallback = await request(app)
      .get('/.well-known/oauth-protected-resource')
      .set('Host', HOST);
    expect(rootFallback.status).toBe(200);
    // Same JSON body (parsed) — Host identical, so buildBaseUrl matches.
    expect(rootFallback.body).toEqual(pathSuffix.body);
    // And byte-identical serialized JSON.
    expect(JSON.stringify(rootFallback.body)).toBe(JSON.stringify(pathSuffix.body));
  });

  test('(c) POST /mcp without Authorization → 401, WWW-Authenticate present, no error attr', async () => {
    // Feature 008: the anonymous handshake methods (initialize/tools-list/ping)
    // and the two login tools now succeed unauthenticated, so this challenge
    // assertion uses a data-touching tools/call — every non-login anonymous
    // request keeps the byte-identical missing-credential 401.
    const res = await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_documents', arguments: {} } });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers['www-authenticate'];
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toMatch(/^Bearer /);
    expect(wwwAuth).toContain('realm="Squire Docs MCP"');
    expect(wwwAuth).toMatch(/resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/);
    // Missing-credentials branch omits error= per RFC 6750 §3
    expect(wwwAuth).not.toContain('error=');
    // JSON body unchanged
    expect(res.body).toEqual(expect.objectContaining({
      error: 'No agent token provided',
      code: 'MISSING_TOKEN',
    }));
  });

  test('(d) POST /mcp with malformed token → 401 + error="invalid_token"', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers['www-authenticate'];
    expect(wwwAuth).toContain('error="invalid_token"');
    expect(wwwAuth).toMatch(/error_description="[^"]+"/);
    expect(wwwAuth).toMatch(/resource_metadata="[^"]+"/);
    expect(res.body).toEqual(expect.objectContaining({
      error: 'Invalid agent token',
      code: 'INVALID_TOKEN',
    }));
  });

  test('(e) POST /mcp with expired JWT → 401 + error="invalid_token", "expired" description', async () => {
    // Mint an already-expired agent token by hand (bypasses generateAgentToken's
    // positive-expiresIn constraint).
    const expiredToken = jwt.sign(
      {
        delegationId: 'exp-delegation',
        userId: 'exp-user',
        agentId: 'exp-agent',
        agentName: 'expired',
        scopes: ['documents:read', 'documents:write'],
        isAgent: true,
      },
      MCP_JWT_SECRET,
      { expiresIn: '-1h', issuer: 'collab-app-mcp' }
    );
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${expiredToken}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers['www-authenticate'];
    expect(wwwAuth).toContain('error="invalid_token"');
    expect(wwwAuth).toContain('error_description="The access token expired"');
    expect(wwwAuth).toMatch(/resource_metadata="[^"]+"/);
    expect(res.body).toEqual(expect.objectContaining({
      error: 'Agent token expired',
      code: 'TOKEN_EXPIRED',
    }));
  });

  test('(f) valid token missing required scope → 403 + error="insufficient_scope"', async () => {
    // Mint a valid token scoped documents:read only; hit the write-scope route.
    const readOnlyToken = generateAgentToken({
      id: 'read-only-delegation',
      user_id: 'read-only-user',
      agent_id: 'read-only-agent',
      agent_name: 'read only',
      scopes: ['documents:read'],
    });
    const res = await request(app)
      .get('/mcp-scope-check')
      .set('Authorization', `Bearer ${readOnlyToken}`);
    expect(res.status).toBe(403);
    const wwwAuth = res.headers['www-authenticate'];
    expect(wwwAuth).toContain('error="insufficient_scope"');
    expect(wwwAuth).toContain('scope="documents:write"');
    expect(wwwAuth).toMatch(/resource_metadata="[^"]+"/);
    expect(res.body).toEqual(expect.objectContaining({
      error: 'Insufficient scope',
      code: 'INSUFFICIENT_SCOPE',
    }));
  });

  test('(g) valid in-scope token → 200 and NO WWW-Authenticate header', async () => {
    const writeToken = generateAgentToken({
      id: 'write-delegation',
      user_id: 'write-user',
      agent_id: 'write-agent',
      agent_name: 'writer',
      scopes: ['documents:read', 'documents:write'],
    });
    const res = await request(app)
      .get('/mcp-scope-check')
      .set('Authorization', `Bearer ${writeToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  test('(h) GET /mcp advertises authentication.resource_metadata', async () => {
    const res = await request(app).get('/mcp');
    expect(res.status).toBe(200);
    expect(res.body.authentication).toBeDefined();
    expect(res.body.authentication.resource_metadata).toMatch(
      /\/\.well-known\/oauth-protected-resource\/mcp$/
    );
    // Sanity: the URL is on the same origin as the metadata URL.
    const metadataUrl = res.body.authentication.metadataUrl;
    const resourceMetadataUrl = res.body.authentication.resource_metadata;
    expect(new URL(metadataUrl).origin).toBe(new URL(resourceMetadataUrl).origin);
  });

  test('(C1) POST /mcp/auth/token accepts and ignores RFC 8707 resource parameter', async () => {
    // Even without a valid grant, the token endpoint must not error on an
    // unknown parameter — RFC 8707 conformance is "accepted and ignored".
    // We just need to see that adding resource= to the body doesn't produce a
    // resource-specific error (a well-formed OAuth error for the missing
    // grant is fine — it means the parameter was tolerated).
    const res = await request(app)
      .post('/mcp/auth/token')
      .type('form')
      .send('grant_type=authorization_code&code=nope&code_verifier=x&client_id=x&resource=https%3A%2F%2Fexample.com%2Fmcp');
    // Should be a client error (400/401), but NOT one that mentions "resource".
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const bodyText = JSON.stringify(res.body || {}).toLowerCase();
    // Fail if the server complained about the resource param specifically.
    expect(bodyText).not.toMatch(/unsupported.*resource|invalid.*resource_parameter|unknown parameter.*resource/);
  });
});
