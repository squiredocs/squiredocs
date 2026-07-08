/**
 * API Token Middleware tests
 *
 * Tests the updated middleware with API token fallback.
 */

process.env.MCP_JWT_SECRET = 'test-mcp-secret';

const { generateAgentToken } = require('../../auth/jwt');
const apiTokens = require('../../auth/api-tokens');

// Mock api-tokens module (keep the real isApiToken prefix check — the
// middleware gates on it before hitting verifyToken)
jest.mock('../../auth/api-tokens', () => ({
  ...jest.requireActual('../../auth/api-tokens'),
  verifyToken: jest.fn(),
  init: jest.fn(),
}));

const { requireAgentAuth, optionalAgentAuth } = require('../../auth/middleware');

function createMocks(authHeader, queryToken) {
  const req = {
    headers: authHeader !== undefined ? { authorization: authHeader } : {},
    query: queryToken !== undefined ? { token: queryToken } : {},
  };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

const mockDelegation = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  user_id: '123e4567-e89b-12d3-a456-426614174001',
  agent_id: 'claude-code:test123',
  agent_name: 'Claude Code',
  scopes: ['documents:read', 'documents:write'],
};

const mockApiTokenRecord = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  user_id: '123e4567-e89b-12d3-a456-426614174001',
  name: 'My CLI Token',
  token_prefix: 'sk_sqd_abcd',
  scopes: ['documents:read', 'documents:write'],
  created_at: new Date(),
  last_used_at: null,
};

describe('requireAgentAuth with API tokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('existing JWT auth still works (no regression)', async () => {
    const token = generateAgentToken(mockDelegation);
    const { req, res, next } = createMocks(`Bearer ${token}`);

    await requireAgentAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.agentToken).toBeDefined();
    expect(req.agentToken.delegationId).toBe(mockDelegation.id);
    expect(req.agentToken.userId).toBe(mockDelegation.user_id);
    // Should not attempt API token lookup for valid JWT
    expect(apiTokens.verifyToken).not.toHaveBeenCalled();
  });

  test('accepts valid API token as Bearer token', async () => {
    apiTokens.verifyToken.mockResolvedValue(mockApiTokenRecord);
    const { req, res, next } = createMocks('Bearer sk_sqd_abcdefghij1234567890abcdefghij12345678');

    await requireAgentAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.agentToken).toBeDefined();
    expect(apiTokens.verifyToken).toHaveBeenCalledWith('sk_sqd_abcdefghij1234567890abcdefghij12345678');
  });

  test('sets req.agentToken with correct shape', async () => {
    apiTokens.verifyToken.mockResolvedValue(mockApiTokenRecord);
    const { req, res, next } = createMocks('Bearer sk_sqd_abcdefghij1234567890abcdefghij12345678');

    await requireAgentAuth(req, res, next);

    expect(req.agentToken).toEqual({
      userId: mockApiTokenRecord.user_id,
      agentId: `api-token:${mockApiTokenRecord.id}`,
      agentName: mockApiTokenRecord.name,
      scopes: mockApiTokenRecord.scopes,
      isAgent: true,
      rawToken: 'sk_sqd_abcdefghij1234567890abcdefghij12345678',
      apiTokenId: mockApiTokenRecord.id,
    });
  });

  test('agentId is formatted as "api-token:{id}"', async () => {
    apiTokens.verifyToken.mockResolvedValue(mockApiTokenRecord);
    const { req, res, next } = createMocks('Bearer sk_sqd_abcdefghij1234567890abcdefghij12345678');

    await requireAgentAuth(req, res, next);

    expect(req.agentToken.agentId).toBe(`api-token:${mockApiTokenRecord.id}`);
  });

  test('returns 401 for revoked API token', async () => {
    apiTokens.verifyToken.mockResolvedValue(null);
    const { req, res, next } = createMocks('Bearer sk_sqd_revokedtoken1234567890abcdefghij12345');

    await requireAgentAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Invalid agent token',
      code: 'INVALID_TOKEN',
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 for unknown token (neither JWT nor API token)', async () => {
    apiTokens.verifyToken.mockResolvedValue(null);
    const { req, res, next } = createMocks('Bearer sk_sqd_unknown1234567890abcdefghij12345678');

    await requireAgentAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('tries JWT first, falls back to API token lookup', async () => {
    apiTokens.verifyToken.mockResolvedValue(mockApiTokenRecord);
    const { req, res, next } = createMocks('Bearer sk_sqd_fallback1234567890abcdefghij12345678');

    await requireAgentAuth(req, res, next);

    // JWT should fail silently, then API token should be tried
    expect(apiTokens.verifyToken).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  test('does not attempt DB lookup for JWT-shaped tokens (starts with eyJ)', async () => {
    const { req, res, next } = createMocks('Bearer eyJinvalid-but-jwt-shaped');

    await requireAgentAuth(req, res, next);

    expect(apiTokens.verifyToken).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('legacy sqd_-prefixed tokens are still accepted (dual-prefix)', async () => {
    apiTokens.verifyToken.mockResolvedValue(mockApiTokenRecord);
    const { req, res, next } = createMocks('Bearer sqd_legacytoken1234567890abcdefghij123456');

    await requireAgentAuth(req, res, next);

    expect(apiTokens.verifyToken).toHaveBeenCalledWith('sqd_legacytoken1234567890abcdefghij123456');
    expect(next).toHaveBeenCalled();
  });
});

describe('optionalAgentAuth with API tokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sets req.agentToken for valid API token', async () => {
    apiTokens.verifyToken.mockResolvedValue(mockApiTokenRecord);
    const { req, res, next } = createMocks('Bearer sk_sqd_optional1234567890abcdefghij12345678');

    await optionalAgentAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.agentToken).toBeDefined();
    expect(req.agentToken.userId).toBe(mockApiTokenRecord.user_id);
  });

  test('continues without error for invalid token', async () => {
    apiTokens.verifyToken.mockResolvedValue(null);
    const { req, res, next } = createMocks('Bearer sk_sqd_invalid1234567890abcdefghij1234567');

    await optionalAgentAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.agentToken).toBeUndefined();
  });

  test('continues without error when no token provided', async () => {
    const { req, res, next } = createMocks();

    await optionalAgentAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.agentToken).toBeUndefined();
  });
});
