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

    test('token starts with sk_sqd_ prefix', async () => {
      const { token } = await apiTokens.createToken(testUserId, 'Prefix Test');
      expect(token.startsWith('sk_sqd_')).toBe(true);
    });

    test('token_prefix is the prefix plus 4 random chars (11 chars)', async () => {
      const { token, record } = await apiTokens.createToken(testUserId, 'Prefix Len');
      expect(record.token_prefix).toBe(token.substring(0, 11));
      expect(record.token_prefix).toHaveLength(11);
    });

    test('accepts expiresAt and persists it', async () => {
      const expiresAt = new Date(Date.now() + 60_000);
      const { record } = await apiTokens.createToken(testUserId, 'Expiring', { expiresAt });
      expect(new Date(record.expires_at).getTime()).toBe(expiresAt.getTime());
    });

    test('rejects expiresAt in the past', async () => {
      await expect(
        apiTokens.createToken(testUserId, 'Past Expiry', { expiresAt: new Date(Date.now() - 1000) })
      ).rejects.toThrow('expiresAt must be a valid timestamp in the future');
    });

    test('persists minted_by provenance columns', async () => {
      const { record: parent } = await apiTokens.createToken(testUserId, 'Parent');
      const { record: child } = await apiTokens.createToken(testUserId, 'Child', {
        expiresAt: new Date(Date.now() + 60_000),
        mintedByApiTokenId: parent.id,
      });
      expect(child.minted_by_api_token_id).toBe(parent.id);
      expect(child.minted_by_delegation_id).toBeNull();
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
      expect(record.token_prefix.startsWith('sk_sqd_')).toBe(true);
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

    test('revoking a parent token cascades to its minted children', async () => {
      const { record: parent } = await apiTokens.createToken(testUserId, 'Cascade Parent');
      const { token: childToken } = await apiTokens.createToken(testUserId, 'Cascade Child', {
        expiresAt: new Date(Date.now() + 60_000),
        mintedByApiTokenId: parent.id,
      });
      expect(await apiTokens.verifyToken(childToken)).not.toBeNull();

      await apiTokens.revokeToken(parent.id, testUserId);

      expect(await apiTokens.verifyToken(childToken)).toBeNull();
    });
  });

  describe('isApiToken', () => {
    test('matches current and legacy prefixes, rejects others', () => {
      expect(apiTokens.isApiToken('sk_sqd_abc123')).toBe(true);
      expect(apiTokens.isApiToken('sqd_abc123')).toBe(true);
      expect(apiTokens.isApiToken('eyJhbGciOi')).toBe(false);
      expect(apiTokens.isApiToken('')).toBe(false);
      expect(apiTokens.isApiToken(null)).toBe(false);
      expect(apiTokens.isApiToken(undefined)).toBe(false);
    });
  });

  describe('legacy sqd_ tokens', () => {
    test('a pre-rename sqd_ token still verifies by hash', async () => {
      // Simulate a token created before the prefix change: old prefix, old
      // 8-char token_prefix, hash computed the same way.
      const legacyToken = 'sqd_' + crypto.randomBytes(30).toString('base64url');
      const legacyHash = crypto.createHash('sha256').update(legacyToken).digest('hex');
      await pool.query(
        `INSERT INTO mcp_api_tokens (user_id, name, token_prefix, token_hash, scopes)
         VALUES ($1, 'Legacy Token', $2, $3, ARRAY['documents:read','documents:write'])`,
        [testUserId, legacyToken.substring(0, 8), legacyHash]
      );

      const record = await apiTokens.verifyToken(legacyToken);
      expect(record).not.toBeNull();
      expect(record.name).toBe('Legacy Token');
    });
  });

  describe('revokeMintedTokens', () => {
    test('revokes all active children of a parent token and returns count', async () => {
      const { record: parent } = await apiTokens.createToken(testUserId, 'Minter');
      const children = [];
      for (let i = 0; i < 3; i++) {
        const { record } = await apiTokens.createToken(testUserId, `Minted ${i}`, {
          expiresAt: new Date(Date.now() + 60_000),
          mintedByApiTokenId: parent.id,
        });
        children.push(record);
      }
      // One already revoked — should not be counted again
      await pool.query('UPDATE mcp_api_tokens SET revoked_at = NOW() WHERE id = $1', [children[0].id]);

      const count = await apiTokens.revokeMintedTokens({ apiTokenId: parent.id });
      expect(count).toBe(2);

      const active = await apiTokens.listUserTokens(testUserId);
      expect(active.map((t) => t.name)).toEqual(['Minter']);
    });

    test('returns 0 when called without a minter', async () => {
      expect(await apiTokens.revokeMintedTokens({})).toBe(0);
    });
  });

  describe('enforceMinterCap', () => {
    test('revokes oldest minted tokens beyond max - 1', async () => {
      const { record: parent } = await apiTokens.createToken(testUserId, 'Cap Minter');
      const minted = [];
      for (let i = 0; i < 5; i++) {
        const { record } = await apiTokens.createToken(testUserId, `Cap Minted ${i}`, {
          expiresAt: new Date(Date.now() + 60_000),
          mintedByApiTokenId: parent.id,
        });
        minted.push(record);
        // created_at ordering needs distinct timestamps
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const displaced = await apiTokens.enforceMinterCap({ apiTokenId: parent.id }, 5);
      expect(displaced).toBe(1);

      const active = await apiTokens.listUserTokens(testUserId);
      const activeNames = active.map((t) => t.name);
      expect(activeNames).not.toContain('Cap Minted 0'); // oldest revoked
      expect(activeNames).toContain('Cap Minted 4');
      // 4 minted survive; the next mint lands at exactly 5
      expect(activeNames.filter((n) => n.startsWith('Cap Minted'))).toHaveLength(4);
    });

    test('no-op below the cap', async () => {
      const { record: parent } = await apiTokens.createToken(testUserId, 'Small Minter');
      await apiTokens.createToken(testUserId, 'Only Child', {
        expiresAt: new Date(Date.now() + 60_000),
        mintedByApiTokenId: parent.id,
      });
      expect(await apiTokens.enforceMinterCap({ apiTokenId: parent.id }, 5)).toBe(0);
    });
  });

  describe('getTokenById', () => {
    test('returns provenance columns', async () => {
      const { record: parent } = await apiTokens.createToken(testUserId, 'GTBI Parent');
      const { record: child } = await apiTokens.createToken(testUserId, 'GTBI Child', {
        expiresAt: new Date(Date.now() + 60_000),
        mintedByApiTokenId: parent.id,
      });

      const fetched = await apiTokens.getTokenById(child.id);
      expect(fetched.minted_by_api_token_id).toBe(parent.id);

      expect(await apiTokens.getTokenById('00000000-0000-0000-0000-000000000000')).toBeNull();
    });
  });
});
