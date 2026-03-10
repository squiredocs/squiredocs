/**
 * API Tokens module tests
 *
 * Tests the API token CRUD operations using a real test database.
 */
const { createPool, createTestUser, cleanupTestUser } = require('../../../__tests__/helpers/db');
const apiTokens = require('../../auth/api-tokens');
const crypto = require('crypto');

const pool = createPool();

describe('API Tokens module', () => {
  let testUserId;

  beforeAll(async () => {
    apiTokens.init(pool);
    testUserId = await createTestUser(pool, 'api-tokens-test@example.com');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [testUserId]);
    await cleanupTestUser(pool, testUserId);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM mcp_api_tokens WHERE user_id = $1', [testUserId]);
  });

  describe('createToken', () => {
    test('creates token and returns plaintext + record', async () => {
      const { token, record } = await apiTokens.createToken(testUserId, 'Test Token');

      expect(token).toBeDefined();
      expect(record).toBeDefined();
      expect(record.id).toBeDefined();
      expect(record.name).toBe('Test Token');
    });

    test('token starts with sqd_ prefix', async () => {
      const { token } = await apiTokens.createToken(testUserId, 'Prefix Test');
      expect(token.startsWith('sqd_')).toBe(true);
    });

    test('stores SHA-256 hash (not plaintext) in DB', async () => {
      const { token, record } = await apiTokens.createToken(testUserId, 'Hash Test');

      const dbResult = await pool.query(
        'SELECT token_hash FROM mcp_api_tokens WHERE id = $1',
        [record.id]
      );

      const expectedHash = crypto.createHash('sha256').update(token).digest('hex');
      expect(dbResult.rows[0].token_hash).toBe(expectedHash);
      // Hash should not equal plaintext
      expect(dbResult.rows[0].token_hash).not.toBe(token);
    });

    test('record includes name, prefix, scopes, created_at', async () => {
      const { record } = await apiTokens.createToken(testUserId, 'Fields Test');

      expect(record.name).toBe('Fields Test');
      expect(record.token_prefix).toBeDefined();
      expect(record.token_prefix.startsWith('sqd_')).toBe(true);
      expect(record.scopes).toEqual(['documents:read', 'documents:write']);
      expect(record.created_at).toBeDefined();
    });

    test('default scopes are documents:read and documents:write', async () => {
      const { record } = await apiTokens.createToken(testUserId, 'Default Scopes');
      expect(record.scopes).toEqual(['documents:read', 'documents:write']);
    });

    test('accepts custom scopes', async () => {
      const { record } = await apiTokens.createToken(testUserId, 'Custom Scopes', {
        scopes: ['documents:read'],
      });
      expect(record.scopes).toEqual(['documents:read']);
    });

    test('enforces max 25 active tokens per user', async () => {
      // Create 25 tokens
      for (let i = 0; i < 25; i++) {
        await apiTokens.createToken(testUserId, `Token ${i}`);
      }

      await expect(
        apiTokens.createToken(testUserId, 'Token 26')
      ).rejects.toThrow('Maximum of 25 active tokens per user');
    });

    test('rejects empty name', async () => {
      await expect(apiTokens.createToken(testUserId, '')).rejects.toThrow('Token name is required');
      await expect(apiTokens.createToken(testUserId, '   ')).rejects.toThrow('Token name is required');
    });

    test('rejects name longer than 255 chars', async () => {
      const longName = 'a'.repeat(256);
      await expect(apiTokens.createToken(testUserId, longName)).rejects.toThrow('255 characters or less');
    });
  });

  describe('verifyToken', () => {
    test('returns record for valid active token', async () => {
      const { token } = await apiTokens.createToken(testUserId, 'Verify Test');

      const record = await apiTokens.verifyToken(token);

      expect(record).toBeDefined();
      expect(record.name).toBe('Verify Test');
      expect(record.user_id).toBe(testUserId);
    });

    test('updates last_used_at on successful verification', async () => {
      const { token, record } = await apiTokens.createToken(testUserId, 'LastUsed Test');
      expect(record.last_used_at).toBeNull();

      await apiTokens.verifyToken(token);

      // Wait briefly for fire-and-forget update
      await new Promise(resolve => setTimeout(resolve, 100));

      const dbResult = await pool.query(
        'SELECT last_used_at FROM mcp_api_tokens WHERE id = $1',
        [record.id]
      );
      expect(dbResult.rows[0].last_used_at).not.toBeNull();
    });

    test('returns null for invalid/unknown token', async () => {
      const result = await apiTokens.verifyToken('sqd_unknowntoken123456789012345678901234');
      expect(result).toBeNull();
    });

    test('returns null for revoked token', async () => {
      const { token, record } = await apiTokens.createToken(testUserId, 'Revoked Test');
      await apiTokens.revokeToken(record.id, testUserId);

      const result = await apiTokens.verifyToken(token);
      expect(result).toBeNull();
    });

    test('returns null for expired token', async () => {
      const { token, record } = await apiTokens.createToken(testUserId, 'Expired Test');

      // Manually set expiry to past
      await pool.query(
        "UPDATE mcp_api_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
        [record.id]
      );

      const result = await apiTokens.verifyToken(token);
      expect(result).toBeNull();
    });

    test('returns null for empty string', async () => {
      const result = await apiTokens.verifyToken('');
      expect(result).toBeNull();
    });
  });

  describe('listUserTokens', () => {
    test('returns all active tokens for a user', async () => {
      await apiTokens.createToken(testUserId, 'Token A');
      await apiTokens.createToken(testUserId, 'Token B');

      const tokens = await apiTokens.listUserTokens(testUserId);

      expect(tokens).toHaveLength(2);
      const names = tokens.map(t => t.name);
      expect(names).toContain('Token A');
      expect(names).toContain('Token B');
    });

    test('excludes revoked tokens', async () => {
      const { record } = await apiTokens.createToken(testUserId, 'Active');
      const { record: revoked } = await apiTokens.createToken(testUserId, 'Revoked');
      await apiTokens.revokeToken(revoked.id, testUserId);

      const tokens = await apiTokens.listUserTokens(testUserId);

      expect(tokens).toHaveLength(1);
      expect(tokens[0].name).toBe('Active');
    });

    test('excludes expired tokens', async () => {
      const { record } = await apiTokens.createToken(testUserId, 'Active');
      const { record: expired } = await apiTokens.createToken(testUserId, 'Expired');

      await pool.query(
        "UPDATE mcp_api_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
        [expired.id]
      );

      const tokens = await apiTokens.listUserTokens(testUserId);

      expect(tokens).toHaveLength(1);
      expect(tokens[0].name).toBe('Active');
    });

    test('returns empty array for user with no tokens', async () => {
      const tokens = await apiTokens.listUserTokens(testUserId);
      expect(tokens).toEqual([]);
    });

    test('never returns token_hash field', async () => {
      await apiTokens.createToken(testUserId, 'Hash Check');
      const tokens = await apiTokens.listUserTokens(testUserId);

      expect(tokens[0].token_hash).toBeUndefined();
    });
  });

  describe('revokeToken', () => {
    test('revokes token by setting revoked_at', async () => {
      const { record } = await apiTokens.createToken(testUserId, 'To Revoke');

      const result = await apiTokens.revokeToken(record.id, testUserId);
      expect(result).toBe(true);

      const dbResult = await pool.query(
        'SELECT revoked_at FROM mcp_api_tokens WHERE id = $1',
        [record.id]
      );
      expect(dbResult.rows[0].revoked_at).not.toBeNull();
    });

    test('returns true on success', async () => {
      const { record } = await apiTokens.createToken(testUserId, 'Success Test');
      const result = await apiTokens.revokeToken(record.id, testUserId);
      expect(result).toBe(true);
    });

    test('returns false for non-existent token', async () => {
      const result = await apiTokens.revokeToken('00000000-0000-0000-0000-000000000000', testUserId);
      expect(result).toBe(false);
    });

    test('only revokes tokens owned by the specified user', async () => {
      const { record } = await apiTokens.createToken(testUserId, 'Owned Token');
      const otherUserId = '00000000-0000-0000-0000-000000000000';

      const result = await apiTokens.revokeToken(record.id, otherUserId);
      expect(result).toBe(false);

      // Token should still be active
      const tokens = await apiTokens.listUserTokens(testUserId);
      expect(tokens).toHaveLength(1);
    });

    test('revoked token fails verifyToken', async () => {
      const { token, record } = await apiTokens.createToken(testUserId, 'Revoke Verify');
      await apiTokens.revokeToken(record.id, testUserId);

      const result = await apiTokens.verifyToken(token);
      expect(result).toBeNull();
    });
  });
});
