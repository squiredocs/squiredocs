/**
 * API Token Routes tests
 *
 * Tests the API token endpoints using supertest.
 */
const express = require('express');
const request = require('supertest');
const apiTokens = require('../../auth/api-tokens');

// Mock api-tokens module
jest.mock('../../auth/api-tokens', () => ({
  createToken: jest.fn(),
  listUserTokens: jest.fn(),
  revokeToken: jest.fn(),
  init: jest.fn(),
}));

// Mock auth middleware to inject test user
jest.mock('../../../auth/middleware', () => ({
  requireAuth: (req, res, next) => {
    req.user = { userId: 'test-user-id-123' };
    next();
  },
  optionalAuth: (req, res, next) => next(),
}));

// Mock oauth-flow and registered-agents to prevent initialization errors
jest.mock('../../auth/oauth-flow', () => ({
  handleAuthorize: (req, res) => res.json({}),
  handleToken: (req, res) => res.json({}),
  handleRevoke: (req, res) => res.json({}),
  handleRegister: (req, res) => res.json({}),
  handleApprove: (req, res) => res.json({}),
  handleListDelegations: (req, res) => res.json({}),
  handleDeleteDelegation: (req, res) => res.json({}),
}));
jest.mock('../../auth/registered-agents', () => ({
  getRegisteredAgent: jest.fn(),
}));

const oauthRouter = require('../../auth/oauth-router');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/mcp/auth', oauthRouter);
  return app;
}

describe('API Token Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /mcp/auth/api-tokens', () => {
    test('creates token and returns plaintext + metadata', async () => {
      apiTokens.createToken.mockResolvedValue({
        token: 'sqd_abcdefghij1234567890abcdefghij12345678',
        record: {
          id: 'token-id-1',
          name: 'My Token',
          token_prefix: 'sqd_abcd',
          scopes: ['documents:read', 'documents:write'],
          created_at: '2024-01-01T00:00:00Z',
        },
      });

      const app = createApp();
      const res = await request(app)
        .post('/mcp/auth/api-tokens')
        .send({ name: 'My Token' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBe('sqd_abcdefghij1234567890abcdefghij12345678');
      expect(res.body.id).toBe('token-id-1');
      expect(res.body.name).toBe('My Token');
      expect(res.body.tokenPrefix).toBe('sqd_abcd');
      expect(res.body.scopes).toEqual(['documents:read', 'documents:write']);
      expect(apiTokens.createToken).toHaveBeenCalledWith('test-user-id-123', 'My Token', {});
    });

    test('returns 400 for missing name', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/mcp/auth/api-tokens')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name/i);
    });

    test('returns 400 for empty name', async () => {
      const app = createApp();
      const res = await request(app)
        .post('/mcp/auth/api-tokens')
        .send({ name: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name/i);
    });

    test('accepts custom scopes', async () => {
      apiTokens.createToken.mockResolvedValue({
        token: 'sqd_test',
        record: {
          id: 'token-id-2',
          name: 'Read Only',
          token_prefix: 'sqd_test',
          scopes: ['documents:read'],
          created_at: '2024-01-01T00:00:00Z',
        },
      });

      const app = createApp();
      const res = await request(app)
        .post('/mcp/auth/api-tokens')
        .send({ name: 'Read Only', scopes: ['documents:read'] });

      expect(res.status).toBe(200);
      expect(apiTokens.createToken).toHaveBeenCalledWith(
        'test-user-id-123',
        'Read Only',
        { scopes: ['documents:read'] }
      );
    });

    test('uses default scopes when none provided', async () => {
      apiTokens.createToken.mockResolvedValue({
        token: 'sqd_test',
        record: {
          id: 'token-id-3',
          name: 'Default Scopes',
          token_prefix: 'sqd_test',
          scopes: ['documents:read', 'documents:write'],
          created_at: '2024-01-01T00:00:00Z',
        },
      });

      const app = createApp();
      const res = await request(app)
        .post('/mcp/auth/api-tokens')
        .send({ name: 'Default Scopes' });

      expect(res.status).toBe(200);
      expect(apiTokens.createToken).toHaveBeenCalledWith('test-user-id-123', 'Default Scopes', {});
    });

    test('returns 400 when max tokens exceeded', async () => {
      apiTokens.createToken.mockRejectedValue(new Error('Maximum of 25 active tokens per user'));

      const app = createApp();
      const res = await request(app)
        .post('/mcp/auth/api-tokens')
        .send({ name: 'Too Many' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Maximum/);
    });
  });

  describe('GET /mcp/auth/api-tokens', () => {
    test('returns list of user tokens', async () => {
      apiTokens.listUserTokens.mockResolvedValue([
        {
          id: 'token-1',
          name: 'Token A',
          token_prefix: 'sqd_aaaa',
          scopes: ['documents:read', 'documents:write'],
          created_at: '2024-01-01T00:00:00Z',
          last_used_at: '2024-01-02T00:00:00Z',
          expires_at: null,
        },
      ]);

      const app = createApp();
      const res = await request(app).get('/mcp/auth/api-tokens');

      expect(res.status).toBe(200);
      expect(res.body.tokens).toHaveLength(1);
      expect(res.body.tokens[0].name).toBe('Token A');
      expect(res.body.tokens[0].tokenPrefix).toBe('sqd_aaaa');
      expect(res.body.tokens[0].lastUsedAt).toBe('2024-01-02T00:00:00Z');
    });

    test('returns empty array when no tokens', async () => {
      apiTokens.listUserTokens.mockResolvedValue([]);

      const app = createApp();
      const res = await request(app).get('/mcp/auth/api-tokens');

      expect(res.status).toBe(200);
      expect(res.body.tokens).toEqual([]);
    });

    test('never includes token hash in response', async () => {
      apiTokens.listUserTokens.mockResolvedValue([
        {
          id: 'token-1',
          name: 'Token',
          token_prefix: 'sqd_aaaa',
          scopes: ['documents:read'],
          created_at: '2024-01-01T00:00:00Z',
          last_used_at: null,
          expires_at: null,
        },
      ]);

      const app = createApp();
      const res = await request(app).get('/mcp/auth/api-tokens');

      expect(res.body.tokens[0].tokenHash).toBeUndefined();
      expect(res.body.tokens[0].token_hash).toBeUndefined();
    });
  });

  describe('DELETE /mcp/auth/api-tokens/:id', () => {
    test('revokes token and returns success', async () => {
      apiTokens.revokeToken.mockResolvedValue(true);

      const app = createApp();
      const res = await request(app).delete('/mcp/auth/api-tokens/token-id-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(apiTokens.revokeToken).toHaveBeenCalledWith('token-id-1', 'test-user-id-123');
    });

    test('returns 404 for non-existent token', async () => {
      apiTokens.revokeToken.mockResolvedValue(false);

      const app = createApp();
      const res = await request(app).delete('/mcp/auth/api-tokens/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    test('only allows revoking own tokens (userId enforcement)', async () => {
      apiTokens.revokeToken.mockResolvedValue(true);

      const app = createApp();
      await request(app).delete('/mcp/auth/api-tokens/some-token-id');

      // Verify userId was passed to revokeToken
      expect(apiTokens.revokeToken).toHaveBeenCalledWith('some-token-id', 'test-user-id-123');
    });
  });
});
