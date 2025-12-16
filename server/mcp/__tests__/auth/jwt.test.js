/**
 * Agent JWT tests
 *
 * Tests the agent JWT module which generates and verifies tokens
 * for AI agents acting on behalf of users via OAuth delegation.
 */
const jwt = require('jsonwebtoken');

// Set test secrets before requiring the module
process.env.MCP_JWT_SECRET = 'test-mcp-secret';

const {
  generateAgentToken,
  verifyAgentToken,
  AGENT_TOKEN_EXPIRY,
} = require('../../auth/jwt');

describe('Agent JWT Module', () => {
  const mockDelegation = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    user_id: '123e4567-e89b-12d3-a456-426614174001',
    agent_id: 'claude-code:test123',
    agent_name: 'Claude Code',
    scopes: ['documents:read', 'documents:write'],
  };

  describe('generateAgentToken', () => {
    test('generates a valid JWT token', () => {
      const token = generateAgentToken(mockDelegation);

      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });

    test('includes correct delegation claims', () => {
      const token = generateAgentToken(mockDelegation);
      const decoded = jwt.decode(token);

      expect(decoded.delegationId).toBe(mockDelegation.id);
      expect(decoded.userId).toBe(mockDelegation.user_id);
      expect(decoded.agentId).toBe(mockDelegation.agent_id);
      expect(decoded.agentName).toBe(mockDelegation.agent_name);
      expect(decoded.scopes).toEqual(mockDelegation.scopes);
      expect(decoded.iss).toBe('collab-app-mcp');
    });

    test('sets correct expiration', () => {
      const token = generateAgentToken(mockDelegation);
      const decoded = jwt.decode(token);

      // Token should expire in 1 hour (3600 seconds)
      const expDiff = decoded.exp - decoded.iat;
      expect(expDiff).toBe(60 * 60); // 1 hour in seconds
    });

    test('includes isAgent flag', () => {
      const token = generateAgentToken(mockDelegation);
      const decoded = jwt.decode(token);

      expect(decoded.isAgent).toBe(true);
    });
  });

  describe('verifyAgentToken', () => {
    test('verifies valid agent token', () => {
      const token = generateAgentToken(mockDelegation);
      const decoded = verifyAgentToken(token);

      expect(decoded.delegationId).toBe(mockDelegation.id);
      expect(decoded.userId).toBe(mockDelegation.user_id);
      expect(decoded.agentId).toBe(mockDelegation.agent_id);
      expect(decoded.isAgent).toBe(true);
    });

    test('throws on invalid token', () => {
      expect(() => verifyAgentToken('invalid-token')).toThrow();
    });

    test('throws on expired token', () => {
      // Create a token that's already expired
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

      expect(() => verifyAgentToken(expiredToken)).toThrow();
    });

    test('throws on wrong issuer', () => {
      const token = jwt.sign(
        {
          delegationId: mockDelegation.id,
          userId: mockDelegation.user_id,
          agentId: mockDelegation.agent_id,
          isAgent: true,
        },
        process.env.MCP_JWT_SECRET,
        { expiresIn: '1h', issuer: 'wrong-issuer' }
      );

      expect(() => verifyAgentToken(token)).toThrow();
    });

    test('throws on token signed with wrong secret', () => {
      const token = jwt.sign(
        {
          delegationId: mockDelegation.id,
          userId: mockDelegation.user_id,
          agentId: mockDelegation.agent_id,
          isAgent: true,
        },
        'wrong-secret',
        { expiresIn: '1h', issuer: 'collab-app-mcp' }
      );

      expect(() => verifyAgentToken(token)).toThrow();
    });

    test('returns error object instead of throwing when options.throwOnError is false', () => {
      const result = verifyAgentToken('invalid-token', { throwOnError: false });

      expect(result).toBeNull();
    });
  });

  describe('AGENT_TOKEN_EXPIRY', () => {
    test('is 1 hour', () => {
      expect(AGENT_TOKEN_EXPIRY).toBe('1h');
    });
  });

  describe('token extraction helpers', () => {
    const { extractAgentToken } = require('../../auth/jwt');

    test('extracts token from Authorization header', () => {
      const token = generateAgentToken(mockDelegation);
      const authHeader = `Bearer ${token}`;

      const extracted = extractAgentToken({ authHeader });

      expect(extracted).toBe(token);
    });

    test('extracts token from query parameter', () => {
      const token = generateAgentToken(mockDelegation);

      const extracted = extractAgentToken({ queryToken: token });

      expect(extracted).toBe(token);
    });

    test('prefers Authorization header over query parameter', () => {
      const headerToken = generateAgentToken(mockDelegation);
      const queryToken = generateAgentToken({
        ...mockDelegation,
        agent_id: 'different-agent',
      });

      const extracted = extractAgentToken({
        authHeader: `Bearer ${headerToken}`,
        queryToken,
      });

      expect(extracted).toBe(headerToken);
    });

    test('returns null for missing token', () => {
      const extracted = extractAgentToken({});

      expect(extracted).toBeNull();
    });

    test('returns null for invalid header format', () => {
      const token = generateAgentToken(mockDelegation);

      const extracted = extractAgentToken({ authHeader: token }); // Missing "Bearer "

      expect(extracted).toBeNull();
    });

    test('returns null for wrong auth scheme', () => {
      const token = generateAgentToken(mockDelegation);

      const extracted = extractAgentToken({ authHeader: `Basic ${token}` });

      expect(extracted).toBeNull();
    });
  });
});
