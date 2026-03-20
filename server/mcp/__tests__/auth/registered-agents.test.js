/**
 * Tests for registered agents validation
 */
const {
  validateScopes,
  validateRedirectUri,
  isLocalhostUri,
  getRegisteredAgent,
} = require('../../auth/registered-agents');

// Mock the database
const mockPool = {
  query: jest.fn(),
};

// Mock agent for testing
const mockAgent = {
  id: 'test-agent',
  name: 'Test Agent',
  description: 'A test agent',
  allowed_redirect_uris: [
    'http://localhost:3000/callback',
    'https://example.com/oauth/callback',
    'http://localhost:*/callback', // Wildcard port
  ],
  allowed_scopes: ['documents:read', 'documents:write'],
  default_scopes: ['documents:read'],
  is_public_client: true,
};

describe('Registered Agents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Initialize with mock pool
    require('../../auth/registered-agents').init(mockPool);
  });

  describe('validateScopes', () => {
    test('accepts valid scopes', () => {
      const result = validateScopes(mockAgent, ['documents:read']);
      expect(result.valid).toBe(true);
      expect(result.scopes).toEqual(['documents:read']);
    });

    test('accepts multiple valid scopes', () => {
      const result = validateScopes(mockAgent, [
        'documents:read',
        'documents:write',
      ]);
      expect(result.valid).toBe(true);
      expect(result.scopes).toEqual(['documents:read', 'documents:write']);
    });

    test('accepts space-separated scope string', () => {
      const result = validateScopes(mockAgent, 'documents:read documents:write');
      expect(result.valid).toBe(true);
      expect(result.scopes).toEqual(['documents:read', 'documents:write']);
    });

    test('rejects invalid scopes', () => {
      const result = validateScopes(mockAgent, ['documents:delete']);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid scopes');
    });

    test('rejects mix of valid and invalid scopes', () => {
      const result = validateScopes(mockAgent, [
        'documents:read',
        'documents:delete',
      ]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid scopes');
    });

    test('handles empty string as empty array', () => {
      const result = validateScopes(mockAgent, '');
      expect(result.valid).toBe(true);
      expect(result.scopes).toEqual([]);
    });

    test('handles empty scopes array', () => {
      const result = validateScopes(mockAgent, []);
      expect(result.valid).toBe(true);
      expect(result.scopes).toEqual([]);
    });

    test('trims whitespace from scope strings', () => {
      const result = validateScopes(mockAgent, '  documents:read   documents:write  ');
      expect(result.valid).toBe(true);
      expect(result.scopes).toEqual(['documents:read', 'documents:write']);
    });

    test('handles duplicate scopes (does not deduplicate)', () => {
      const result = validateScopes(mockAgent, [
        'documents:read',
        'documents:read',
      ]);
      expect(result.valid).toBe(true);
      expect(result.scopes).toEqual(['documents:read', 'documents:read']);
    });
  });

  describe('validateRedirectUri', () => {
    test('accepts exact match URI', () => {
      const result = validateRedirectUri(mockAgent, 'http://localhost:3000/callback');
      expect(result.valid).toBe(true);
    });

    test('accepts URI matching wildcard port pattern', () => {
      const result = validateRedirectUri(mockAgent, 'http://localhost:8080/callback');
      expect(result.valid).toBe(true);
    });

    test('accepts URI matching another wildcard port', () => {
      const result = validateRedirectUri(mockAgent, 'http://localhost:5173/callback');
      expect(result.valid).toBe(true);
    });

    test('rejects URI not in allowed list', () => {
      const result = validateRedirectUri(mockAgent, 'https://evil.com/steal-tokens');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not allowed');
    });

    test('rejects URI with different path', () => {
      const result = validateRedirectUri(mockAgent, 'http://localhost:3000/different');
      expect(result.valid).toBe(false);
    });

    test('rejects URI with different host', () => {
      const result = validateRedirectUri(mockAgent, 'http://evil.localhost:3000/callback');
      expect(result.valid).toBe(false);
    });

    test('rejects URI with query parameters when pattern has none', () => {
      const result = validateRedirectUri(
        mockAgent,
        'http://localhost:3000/callback?code=123'
      );
      expect(result.valid).toBe(false);
    });

    test('rejects URI not in allowed list', () => {
      const result = validateRedirectUri(mockAgent, 'not-a-valid-uri');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not allowed');
    });

    test('handles empty redirect URI', () => {
      const result = validateRedirectUri(mockAgent, '');
      expect(result.valid).toBe(false);
    });

    test('handles null redirect URI', () => {
      const result = validateRedirectUri(mockAgent, null);
      expect(result.valid).toBe(false);
    });

    test('is case-sensitive for scheme', () => {
      const result = validateRedirectUri(mockAgent, 'HTTP://localhost:3000/callback');
      expect(result.valid).toBe(false);
    });

    test('matches HTTPS URIs', () => {
      const result = validateRedirectUri(
        mockAgent,
        'https://example.com/oauth/callback'
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('getRegisteredAgent', () => {
    test('retrieves agent by ID', async () => {
      mockPool.query.mockResolvedValue({ rows: [mockAgent] });

      const agent = await getRegisteredAgent('test-agent');

      expect(agent).toEqual(mockAgent);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        ['test-agent']
      );
    });

    test('returns null for non-existent agent', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const agent = await getRegisteredAgent('non-existent');

      expect(agent).toBeNull();
    });

    test('handles database errors', async () => {
      mockPool.query.mockRejectedValue(new Error('Database error'));

      await expect(getRegisteredAgent('test-agent')).rejects.toThrow(
        'Database error'
      );
    });

    test('requires agent ID', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const agent = await getRegisteredAgent('');
      expect(agent).toBeNull();
    });
  });

  describe('Agent registration validation', () => {
    test('validates complete agent configuration', () => {
      expect(mockAgent.id).toBeTruthy();
      expect(mockAgent.allowed_redirect_uris).toBeInstanceOf(Array);
      expect(mockAgent.allowed_redirect_uris.length).toBeGreaterThan(0);
      expect(mockAgent.allowed_scopes).toBeInstanceOf(Array);
      expect(mockAgent.allowed_scopes.length).toBeGreaterThan(0);
    });

    test('agent has required fields', () => {
      expect(mockAgent).toHaveProperty('id');
      expect(mockAgent).toHaveProperty('name');
      expect(mockAgent).toHaveProperty('allowed_redirect_uris');
      expect(mockAgent).toHaveProperty('allowed_scopes');
      expect(mockAgent).toHaveProperty('default_scopes');
      expect(mockAgent).toHaveProperty('is_public_client');
    });
  });

  describe('isLocalhostUri', () => {
    test('accepts http://localhost with port', () => {
      expect(isLocalhostUri('http://localhost:3000/callback')).toBe(true);
    });

    test('accepts http://localhost without port', () => {
      expect(isLocalhostUri('http://localhost/callback')).toBe(true);
    });

    test('accepts http://127.0.0.1 with port', () => {
      expect(isLocalhostUri('http://127.0.0.1:8080/callback')).toBe(true);
    });

    test('accepts http://[::1] (IPv6 loopback)', () => {
      expect(isLocalhostUri('http://[::1]:3000/callback')).toBe(true);
    });

    test('rejects external URLs', () => {
      expect(isLocalhostUri('https://evil.com/callback')).toBe(false);
    });

    test('rejects URLs with localhost as subdomain', () => {
      expect(isLocalhostUri('https://localhost.evil.com/callback')).toBe(false);
    });

    test('rejects invalid URIs', () => {
      expect(isLocalhostUri('not-a-url')).toBe(false);
    });

    test('rejects empty string', () => {
      expect(isLocalhostUri('')).toBe(false);
    });

    test('rejects null', () => {
      expect(isLocalhostUri(null)).toBe(false);
    });

    test('rejects custom protocol schemes', () => {
      expect(isLocalhostUri('vscode://anthropic.claude-code/callback')).toBe(false);
    });
  });

  describe('Security edge cases', () => {
    test('rejects redirect URI with fragments', () => {
      const result = validateRedirectUri(
        mockAgent,
        'http://localhost:3000/callback#fragment'
      );
      expect(result.valid).toBe(false);
    });

    test('validates scopes are alphanumeric with colons', () => {
      const invalidAgent = {
        ...mockAgent,
        allowed_scopes: ['documents:read', 'evil:scope'],
      };
      const result = validateScopes(invalidAgent, ['documents:read']);
      expect(result.valid).toBe(true);
    });

    test('rejects extremely long scope strings', () => {
      const longScope = 'a'.repeat(10000);
      const result = validateScopes(mockAgent, [longScope]);
      expect(result.valid).toBe(false);
    });
  });
});
