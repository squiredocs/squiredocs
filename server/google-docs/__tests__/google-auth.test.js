/**
 * Tests for Google Drive OAuth token management.
 *
 * Covers token lifecycle: encryption via storeTokens, decryption + access token
 * retrieval via getValidToken (with expiry/error/revocation states),
 * connection status checks, and revocation.
 *
 * External OAuth calls (getAccessToken, revokeToken) are mocked.
 */
const { createPool, createTestUser, cleanupTestUser } = require('../../__tests__/helpers/db');

// Mock google-auth-library so tests don't make real OAuth calls
jest.mock('google-auth-library', () => {
  const mockClient = {
    setCredentials: jest.fn(),
    getAccessToken: jest.fn(),
    revokeToken: jest.fn(),
    getToken: jest.fn(),
    verifyIdToken: jest.fn(),
    generateAuthUrl: jest.fn(() => 'https://accounts.google.com/mock-auth-url'),
  };
  return {
    OAuth2Client: jest.fn(() => mockClient),
    __mockClient: mockClient,
  };
});

// Ensure Google OAuth env vars are set so the OAuth2Client can initialize
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';

const { __mockClient } = require('google-auth-library');
const googleAuth = require('../google-auth');
const { encrypt } = require('../../crypto');

const pool = createPool();

describe('google-docs/google-auth', () => {
  let userId;

  beforeAll(async () => {
    userId = await createTestUser(pool, `google-auth-test-${Date.now()}@example.com`);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM connected_services WHERE user_id = $1', [userId]);
    await cleanupTestUser(pool, userId);
    await pool.end();
  });

  beforeEach(async () => {
    // Reset mocks and clean up connection state between tests
    __mockClient.setCredentials.mockClear();
    __mockClient.getAccessToken.mockReset();
    __mockClient.revokeToken.mockReset();
    await pool.query('DELETE FROM connected_services WHERE user_id = $1', [userId]);
  });

  describe('generateDriveAuthUrl', () => {
    test('generates URL with drive scope', () => {
      const url = googleAuth.generateDriveAuthUrl('csrf-state', 'user@example.com');
      expect(url).toBe('https://accounts.google.com/mock-auth-url');

      const call = __mockClient.generateAuthUrl.mock.calls[0][0];
      expect(call.scope).toContain('https://www.googleapis.com/auth/drive');
      expect(call.state).toBe('csrf-state');
      expect(call.login_hint).toBe('user@example.com');
      expect(call.access_type).toBe('offline');
    });
  });

  describe('storeTokens', () => {
    test('encrypts and stores a refresh token', async () => {
      await googleAuth.storeTokens(pool, userId, 'plaintext-refresh-token', 'test@example.com');

      const { rows } = await pool.query(
        `SELECT refresh_token, service_email, token_status, expires_at
         FROM connected_services WHERE user_id = $1`,
        [userId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].refresh_token).not.toBe('plaintext-refresh-token');
      expect(rows[0].refresh_token).toMatch(/^.+:.+:.+$/); // iv:authTag:ciphertext format
      expect(rows[0].service_email).toBe('test@example.com');
      expect(rows[0].token_status).toBe('active');
      expect(rows[0].expires_at).not.toBeNull();
    });

    test('upsert overwrites existing token and resets error state', async () => {
      // Insert a connection in error state
      await pool.query(
        `INSERT INTO connected_services (user_id, service, refresh_token, token_status, error_message)
         VALUES ($1, 'google_drive', $2, 'error', 'stale error')`,
        [userId, encrypt('old-token')]
      );

      await googleAuth.storeTokens(pool, userId, 'new-token', 'new@example.com');

      const { rows } = await pool.query(
        `SELECT token_status, error_message, service_email FROM connected_services WHERE user_id = $1`,
        [userId]
      );
      expect(rows[0].token_status).toBe('active');
      expect(rows[0].error_message).toBeNull();
      expect(rows[0].service_email).toBe('new@example.com');
    });

    test('expires_at is set ~30 days in the future', async () => {
      const before = Date.now();
      await googleAuth.storeTokens(pool, userId, 'token', 'email@example.com');
      const { rows } = await pool.query(
        `SELECT expires_at FROM connected_services WHERE user_id = $1`,
        [userId]
      );
      const expiresMs = new Date(rows[0].expires_at).getTime();
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      expect(expiresMs).toBeGreaterThanOrEqual(before + thirtyDaysMs - 60_000);
      expect(expiresMs).toBeLessThanOrEqual(Date.now() + thirtyDaysMs + 60_000);
    });
  });

  describe('hasGoogleDriveAuth', () => {
    test('returns false when no connection exists', async () => {
      const result = await googleAuth.hasGoogleDriveAuth(pool, userId);
      expect(result).toBe(false);
    });

    test('returns true for an active connection', async () => {
      await googleAuth.storeTokens(pool, userId, 'token', 'email@example.com');
      const result = await googleAuth.hasGoogleDriveAuth(pool, userId);
      expect(result).toBe(true);
    });

    test('returns false for a connection in error state', async () => {
      await googleAuth.storeTokens(pool, userId, 'token', 'email@example.com');
      await pool.query(
        `UPDATE connected_services SET token_status = 'error' WHERE user_id = $1`,
        [userId]
      );
      const result = await googleAuth.hasGoogleDriveAuth(pool, userId);
      expect(result).toBe(false);
    });

    test('returns false for a revoked connection', async () => {
      await googleAuth.storeTokens(pool, userId, 'token', 'email@example.com');
      await pool.query(
        `UPDATE connected_services SET revoked_at = now() WHERE user_id = $1`,
        [userId]
      );
      const result = await googleAuth.hasGoogleDriveAuth(pool, userId);
      expect(result).toBe(false);
    });

    test('returns false for an expired connection', async () => {
      await googleAuth.storeTokens(pool, userId, 'token', 'email@example.com');
      await pool.query(
        `UPDATE connected_services SET expires_at = now() - interval '1 day' WHERE user_id = $1`,
        [userId]
      );
      const result = await googleAuth.hasGoogleDriveAuth(pool, userId);
      expect(result).toBe(false);
    });
  });

  describe('getValidToken', () => {
    test('throws NOT_CONNECTED when no connection exists', async () => {
      await expect(googleAuth.getValidToken(pool, userId)).rejects.toMatchObject({
        code: 'NOT_CONNECTED',
      });
    });

    test('returns access token for active connection', async () => {
      __mockClient.getAccessToken.mockResolvedValue({ token: 'fresh-access-token' });
      await googleAuth.storeTokens(pool, userId, 'refresh-xyz', 'email@example.com');

      const token = await googleAuth.getValidToken(pool, userId);
      expect(token).toBe('fresh-access-token');

      // Verify refresh token was decrypted before being passed to OAuth client
      expect(__mockClient.setCredentials).toHaveBeenCalledWith({
        refresh_token: 'refresh-xyz',
      });
    });

    test('updates last_used_at on successful retrieval', async () => {
      __mockClient.getAccessToken.mockResolvedValue({ token: 'token' });
      await googleAuth.storeTokens(pool, userId, 'refresh', 'email@example.com');

      const before = (
        await pool.query(`SELECT last_used_at FROM connected_services WHERE user_id = $1`, [userId])
      ).rows[0].last_used_at;
      expect(before).toBeNull();

      await googleAuth.getValidToken(pool, userId);

      // Give the fire-and-forget update a moment to land
      await new Promise((r) => setTimeout(r, 50));

      const after = (
        await pool.query(`SELECT last_used_at FROM connected_services WHERE user_id = $1`, [userId])
      ).rows[0].last_used_at;
      expect(after).not.toBeNull();
    });

    test('throws TOKEN_ERROR when token_status is error', async () => {
      await googleAuth.storeTokens(pool, userId, 'refresh', 'email@example.com');
      await pool.query(
        `UPDATE connected_services SET token_status = 'error', error_message = 'Access revoked'
         WHERE user_id = $1`,
        [userId]
      );

      await expect(googleAuth.getValidToken(pool, userId)).rejects.toMatchObject({
        code: 'TOKEN_ERROR',
        message: expect.stringContaining('Access revoked'),
      });
    });

    test('throws EXPIRED when expires_at is past', async () => {
      await googleAuth.storeTokens(pool, userId, 'refresh', 'email@example.com');
      await pool.query(
        `UPDATE connected_services SET expires_at = now() - interval '1 day' WHERE user_id = $1`,
        [userId]
      );

      await expect(googleAuth.getValidToken(pool, userId)).rejects.toMatchObject({
        code: 'EXPIRED',
      });
    });

    test('handles invalid_grant by marking token as errored', async () => {
      __mockClient.getAccessToken.mockRejectedValue(
        new Error('invalid_grant: Token has been revoked')
      );
      await googleAuth.storeTokens(pool, userId, 'refresh', 'email@example.com');

      await expect(googleAuth.getValidToken(pool, userId)).rejects.toMatchObject({
        code: 'TOKEN_ERROR',
      });

      const { rows } = await pool.query(
        `SELECT token_status, error_message FROM connected_services WHERE user_id = $1`,
        [userId]
      );
      expect(rows[0].token_status).toBe('error');
      expect(rows[0].error_message).toMatch(/revoked/i);
    });

    test('marks token as error when decryption fails', async () => {
      // Insert a corrupted token directly (not a valid encrypted blob)
      await pool.query(
        `INSERT INTO connected_services (user_id, service, refresh_token, token_status, expires_at)
         VALUES ($1, 'google_drive', 'not-a-valid-encrypted-blob', 'active', now() + interval '30 days')`,
        [userId]
      );

      await expect(googleAuth.getValidToken(pool, userId)).rejects.toMatchObject({
        code: 'TOKEN_ERROR',
      });

      const { rows } = await pool.query(
        `SELECT token_status FROM connected_services WHERE user_id = $1`,
        [userId]
      );
      expect(rows[0].token_status).toBe('error');
    });

    test('ignores revoked connections', async () => {
      await googleAuth.storeTokens(pool, userId, 'refresh', 'email@example.com');
      await pool.query(
        `UPDATE connected_services SET revoked_at = now() WHERE user_id = $1`,
        [userId]
      );

      await expect(googleAuth.getValidToken(pool, userId)).rejects.toMatchObject({
        code: 'NOT_CONNECTED',
      });
    });
  });

  describe('revokeTokens', () => {
    test('calls Google revocation endpoint and marks as revoked locally', async () => {
      __mockClient.revokeToken.mockResolvedValue({});
      await googleAuth.storeTokens(pool, userId, 'refresh-token', 'email@example.com');

      await googleAuth.revokeTokens(pool, userId);

      // Verify Google revocation was called with the plaintext refresh token
      expect(__mockClient.revokeToken).toHaveBeenCalledWith('refresh-token');

      const { rows } = await pool.query(
        `SELECT revoked_at, refresh_token FROM connected_services WHERE user_id = $1`,
        [userId]
      );
      expect(rows[0].revoked_at).not.toBeNull();
      // Token should be cleared so it's no longer usable
      expect(rows[0].refresh_token).toBe('revoked');
    });

    test('still clears locally when Google revocation fails', async () => {
      __mockClient.revokeToken.mockRejectedValue(new Error('Google API down'));
      await googleAuth.storeTokens(pool, userId, 'refresh', 'email@example.com');

      // Should not throw
      await expect(googleAuth.revokeTokens(pool, userId)).resolves.not.toThrow();

      const { rows } = await pool.query(
        `SELECT revoked_at FROM connected_services WHERE user_id = $1`,
        [userId]
      );
      expect(rows[0].revoked_at).not.toBeNull();
    });

    test('is a no-op when no connection exists', async () => {
      await expect(googleAuth.revokeTokens(pool, userId)).resolves.not.toThrow();
      expect(__mockClient.revokeToken).not.toHaveBeenCalled();
    });
  });
});
