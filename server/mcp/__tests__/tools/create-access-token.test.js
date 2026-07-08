/**
 * create_access_token MCP tool tests
 *
 * Drives the tool through toolRegistry.executeTool so TOOL_SCOPES gating and
 * validateToolArgs run, against a real test database. Covers both principal
 * shapes (OAuth-JWT delegation and PAT), scope capping, TTL bounds, the
 * no-chaining rule, the per-minter cap, and plaintext hygiene.
 */
const { createPool, createTestUser, cleanupTestUser } = require('../../../__tests__/helpers/db');
const apiTokens = require('../../auth/api-tokens');
const delegation = require('../../auth/delegation');
const toolRegistry = require('../../tools');

const pool = createPool();

describe('create_access_token tool', () => {
  let testUserId;
  let testDelegation;

  const mint = (args, agentToken) =>
    toolRegistry.executeTool('create_access_token', args, agentToken);

  const jwtPrincipal = (overrides = {}) => ({
    delegationId: testDelegation.id,
    userId: testUserId,
    agentId: 'test-agent',
    agentName: 'Test Agent',
    scopes: ['documents:read', 'documents:write'],
    isAgent: true,
    baseUrl: 'https://test.example.com',
    ...overrides,
  });

  const patPrincipal = (apiTokenId, overrides = {}) => ({
    userId: testUserId,
    agentId: `api-token:${apiTokenId}`,
    agentName: 'Test PAT',
    scopes: ['documents:read', 'documents:write'],
    isAgent: true,
    apiTokenId,
    ...overrides,
  });

  beforeAll(async () => {
    apiTokens.init(pool);
    delegation.init(pool);
    testUserId = await createTestUser(pool, 'create-access-token-test@example.com');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [testUserId]);
    await cleanupTestUser(pool, testUserId);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM agent_delegations WHERE user_id = $1', [testUserId]);
    testDelegation = await delegation.createDelegation(testUserId, 'test-agent', 'Test Agent');
  });

  describe('defaults', () => {
    test('mints a read-only 1h token with sk_sqd_ prefix', async () => {
      const before = Date.now();
      const result = await mint({}, jwtPrincipal());

      expect(result.token.startsWith('sk_sqd_')).toBe(true);
      expect(result.scopes).toEqual(['documents:read']);
      expect(result.ttlSeconds).toBe(3600);
      const expiresAt = new Date(result.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000);
      expect(result.curlExample).toContain('/api/docs/<docId>/export?format=markdown');
      expect(result.curlExample).toContain('https://test.example.com');
    });

    test('minted token verifies and carries delegation provenance', async () => {
      const result = await mint({}, jwtPrincipal());
      const record = await apiTokens.verifyToken(result.token);
      expect(record).not.toBeNull();
      expect(record.user_id).toBe(testUserId);

      const row = await apiTokens.getTokenById(record.id);
      expect(row.minted_by_delegation_id).toBe(testDelegation.id);
      expect(row.minted_by_api_token_id).toBeNull();
    });

    test('PAT principal records parent token provenance', async () => {
      const { record: parent } = await apiTokens.createToken(testUserId, 'Parent PAT');
      const result = await mint({}, patPrincipal(parent.id));

      const record = await apiTokens.verifyToken(result.token);
      const row = await apiTokens.getTokenById(record.id);
      expect(row.minted_by_api_token_id).toBe(parent.id);
      expect(row.minted_by_delegation_id).toBeNull();
    });

    test('auto-generates a provenance name visible in Settings', async () => {
      const result = await mint({}, jwtPrincipal());
      const record = await apiTokens.verifyToken(result.token);
      expect(record.name).toBe('Minted by Test Agent via MCP');
    });
  });

  describe('scope capping', () => {
    test('honors an explicit scopes request within the caller grant', async () => {
      const result = await mint({ scopes: ['documents:read', 'documents:write'] }, jwtPrincipal());
      expect(result.scopes).toEqual(['documents:read', 'documents:write']);
    });

    test('read-only caller cannot mint a write token', async () => {
      await expect(
        mint({ scopes: ['documents:write'] }, jwtPrincipal({ scopes: ['documents:read'] }))
      ).rejects.toThrow(/Insufficient scope: cannot mint a token with scope 'documents:write'/);
    });

    test('caller without documents:read is blocked by TOOL_SCOPES', async () => {
      await expect(mint({}, jwtPrincipal({ scopes: [] }))).rejects.toThrow(
        /Insufficient scope: 'documents:read' is required/
      );
    });

    test('rejects unknown scope values', async () => {
      await expect(mint({ scopes: ['documents:admin'] }, jwtPrincipal())).rejects.toThrow(
        /unknown scope 'documents:admin'/
      );
    });

    test('rejects empty or non-array scopes', async () => {
      await expect(mint({ scopes: [] }, jwtPrincipal())).rejects.toThrow(/non-empty array/);
      await expect(mint({ scopes: 'documents:read' }, jwtPrincipal())).rejects.toThrow(/non-empty array/);
    });
  });

  describe('ttlSeconds bounds', () => {
    test('accepts the bounds and rejects outside them', async () => {
      const min = await mint({ ttlSeconds: 60 }, jwtPrincipal());
      expect(min.ttlSeconds).toBe(60);
      const max = await mint({ ttlSeconds: 86400 }, jwtPrincipal());
      expect(max.ttlSeconds).toBe(86400);

      await expect(mint({ ttlSeconds: 59 }, jwtPrincipal())).rejects.toThrow(/between 60 and 86400/);
      await expect(mint({ ttlSeconds: 86401 }, jwtPrincipal())).rejects.toThrow(/between 60 and 86400/);
      await expect(mint({ ttlSeconds: 3600.5 }, jwtPrincipal())).rejects.toThrow(/between 60 and 86400/);
      await expect(mint({ ttlSeconds: 'soon' }, jwtPrincipal())).rejects.toThrow(/between 60 and 86400/);
    });
  });

  describe('no chaining', () => {
    test('a minted token cannot mint further tokens', async () => {
      const first = await mint({}, jwtPrincipal());
      const minted = await apiTokens.verifyToken(first.token);

      await expect(mint({}, patPrincipal(minted.id))).rejects.toThrow(
        /cannot mint further tokens/
      );
    });
  });

  describe('delegation liveness', () => {
    test('a revoked delegation cannot mint even with a live JWT', async () => {
      await delegation.revokeDelegation(testDelegation.id);
      await expect(mint({}, jwtPrincipal())).rejects.toThrow(/Cannot mint token: .*revoked/);
    });
  });

  describe('per-minter cap', () => {
    test('sixth mint from the same delegation revokes the oldest', async () => {
      const tokens = [];
      for (let i = 0; i < 6; i++) {
        tokens.push(await mint({}, jwtPrincipal()));
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(tokens[5].message).toContain('older minted token(s) were revoked');
      expect(await apiTokens.verifyToken(tokens[0].token)).toBeNull();
      expect(await apiTokens.verifyToken(tokens[5].token)).not.toBeNull();

      const active = await apiTokens.listUserTokens(testUserId);
      expect(active).toHaveLength(5);
    });
  });

  describe('global cap passthrough', () => {
    test('the 25-token user cap still applies', async () => {
      for (let i = 0; i < 25; i++) {
        await apiTokens.createToken(testUserId, `Filler ${i}`);
      }
      await expect(mint({}, jwtPrincipal())).rejects.toThrow(/Maximum of 25 active tokens/);
    });
  });

  describe('plaintext hygiene', () => {
    test('DB stores only the hash; nothing is console-logged during mint', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await mint({}, jwtPrincipal());

        const dbResult = await pool.query(
          'SELECT token_hash FROM mcp_api_tokens WHERE user_id = $1',
          [testUserId]
        );
        for (const row of dbResult.rows) {
          expect(row.token_hash).not.toBe(result.token);
          expect(row.token_hash).not.toContain(result.token);
        }

        const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ');
        expect(logged).not.toContain(result.token);
        // The curl example must not embed the raw secret either
        expect(result.curlExample).not.toContain(result.token);
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
});
