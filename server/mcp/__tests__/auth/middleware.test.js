/**
 * MCP Auth middleware tests
 *
 * Tests the middleware for authenticating and authorizing AI agents.
 */

// Set test secrets before requiring modules
process.env.MCP_JWT_SECRET = 'test-mcp-secret';

const { generateAgentToken } = require('../../auth/jwt');
const { requireAgentAuth, requireScope } = require('../../auth/middleware');

describe('MCP Auth Middleware', () => {
  const mockDelegation = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    user_id: '123e4567-e89b-12d3-a456-426614174001',
    agent_id: 'claude-code:test123',
    agent_name: 'Claude Code',
    scopes: ['documents:read', 'documents:write'],
  };

  // Helper to create mock request/response/next
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

  describe('requireAgentAuth', () => {
    test('calls next() with valid Bearer token', () => {
      const token = generateAgentToken(mockDelegation);
      const { req, res, next } = createMocks(`Bearer ${token}`);

      requireAgentAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.agentToken).toBeDefined();
      expect(req.agentToken.delegationId).toBe(mockDelegation.id);
      expect(req.agentToken.userId).toBe(mockDelegation.user_id);
      expect(req.agentToken.agentId).toBe(mockDelegation.agent_id);
      expect(req.agentToken.isAgent).toBe(true);
    });

    test('calls next() with valid query token', () => {
      const token = generateAgentToken(mockDelegation);
      const { req, res, next } = createMocks(undefined, token);

      requireAgentAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.agentToken).toBeDefined();
      expect(req.agentToken.agentId).toBe(mockDelegation.agent_id);
    });

    test('prefers Bearer token over query token', () => {
      const headerToken = generateAgentToken(mockDelegation);
      const queryToken = generateAgentToken({
        ...mockDelegation,
        agent_id: 'different-agent',
      });
      const { req, res, next } = createMocks(`Bearer ${headerToken}`, queryToken);

      requireAgentAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.agentToken.agentId).toBe(mockDelegation.agent_id);
    });

    test('returns 401 when no token provided', () => {
      const { req, res, next } = createMocks();

      requireAgentAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'No agent token provided',
        code: 'MISSING_TOKEN',
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 for invalid header format', () => {
      const token = generateAgentToken(mockDelegation);
      const { req, res, next } = createMocks(token); // Missing "Bearer "

      requireAgentAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'No agent token provided',
        code: 'MISSING_TOKEN',
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 for invalid token', () => {
      const { req, res, next } = createMocks('Bearer invalid-token');

      requireAgentAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid agent token',
        code: 'INVALID_TOKEN',
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 with TOKEN_EXPIRED code for expired token', () => {
      const jwt = require('jsonwebtoken');
      const expiredToken = jwt.sign(
        {
          delegationId: mockDelegation.id,
          userId: mockDelegation.user_id,
          agentId: mockDelegation.agent_id,
          isAgent: true,
        },
        process.env.MCP_JWT_SECRET,
        { expiresIn: '-1h', issuer: 'collab-app-mcp' }
      );
      const { req, res, next } = createMocks(`Bearer ${expiredToken}`);

      requireAgentAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Agent token expired',
        code: 'TOKEN_EXPIRED',
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requireScope', () => {
    test('calls next() when agent has required scope', () => {
      const token = generateAgentToken(mockDelegation);
      const { req, res, next } = createMocks(`Bearer ${token}`);

      // First authenticate
      requireAgentAuth(req, res, next);
      next.mockClear();

      // Then check scope
      const scopeMiddleware = requireScope('documents:read');
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('returns 403 when agent lacks required scope', () => {
      const limitedDelegation = {
        ...mockDelegation,
        scopes: ['documents:read'], // No write scope
      };
      const token = generateAgentToken(limitedDelegation);
      const { req, res, next } = createMocks(`Bearer ${token}`);

      // First authenticate
      requireAgentAuth(req, res, next);
      next.mockClear();
      res.status.mockClear();
      res.json.mockClear();

      // Then check scope
      const scopeMiddleware = requireScope('documents:write');
      scopeMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Insufficient scope',
        code: 'INSUFFICIENT_SCOPE',
        required: 'documents:write',
        granted: ['documents:read'],
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 when called without prior authentication', () => {
      const { req, res, next } = createMocks();

      const scopeMiddleware = requireScope('documents:read');
      scopeMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Agent authentication required',
        code: 'NOT_AUTHENTICATED',
      });
      expect(next).not.toHaveBeenCalled();
    });

    test('supports multiple scopes (any match)', () => {
      const token = generateAgentToken(mockDelegation);
      const { req, res, next } = createMocks(`Bearer ${token}`);

      requireAgentAuth(req, res, next);
      next.mockClear();

      // Check if agent has ANY of the required scopes
      const scopeMiddleware = requireScope(['documents:read', 'admin:full']);
      scopeMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('returns 403 when agent has none of the required scopes', () => {
      const limitedDelegation = {
        ...mockDelegation,
        scopes: ['documents:read'],
      };
      const token = generateAgentToken(limitedDelegation);
      const { req, res, next } = createMocks(`Bearer ${token}`);

      requireAgentAuth(req, res, next);
      next.mockClear();
      res.status.mockClear();
      res.json.mockClear();

      const scopeMiddleware = requireScope(['documents:write', 'admin:full']);
      scopeMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
