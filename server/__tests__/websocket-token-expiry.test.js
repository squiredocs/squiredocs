/**
 * Tests for WebSocket token expiry validation
 *
 * The server validates token expiry on every WebSocket message (not just at connection).
 * This prevents "ghost sessions" where WebSocket works but REST API fails.
 */
const jwt = require('jsonwebtoken');

// Mock the token expiry check logic from server/index.js
// This tests the core logic without needing full WebSocket integration
describe('WebSocket token expiry validation', () => {
  const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'dev-access-secret-change-in-production';

  /**
   * Generate a token with custom expiry for testing
   */
  function generateTestToken(userId, expiresInSeconds) {
    return jwt.sign(
      { userId, email: 'test@example.com', name: 'Test User' },
      ACCESS_TOKEN_SECRET,
      { expiresIn: expiresInSeconds, issuer: 'collab-app' }
    );
  }

  /**
   * Simulate the message handler's expiry check
   * This mirrors the logic in server/index.js wss.on('connection') handler
   */
  function isTokenExpiredForMessage(tokenExp) {
    if (!tokenExp) return false; // null tokenExp means agent token, skip check
    return Date.now() / 1000 > tokenExp;
  }

  describe('token expiry check logic', () => {
    test('returns false for token that expires in the future', () => {
      const token = generateTestToken('user-1', 3600); // 1 hour from now
      const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);

      expect(isTokenExpiredForMessage(decoded.exp)).toBe(false);
    });

    test('returns true for token that already expired', () => {
      // Create a token that expired 1 second ago
      const expiredTime = Math.floor(Date.now() / 1000) - 1;

      expect(isTokenExpiredForMessage(expiredTime)).toBe(true);
    });

    test('returns false for null tokenExp (agent tokens)', () => {
      // Agent tokens don't have standard exp, so tokenExp is null
      expect(isTokenExpiredForMessage(null)).toBe(false);
    });

    test('returns true for token that expired in the past', () => {
      // Token that expired 10 seconds ago
      const pastExp = Math.floor(Date.now() / 1000) - 10;
      expect(isTokenExpiredForMessage(pastExp)).toBe(true);

      // Token that expired 1 second ago
      const recentPastExp = Math.floor(Date.now() / 1000) - 1;
      expect(isTokenExpiredForMessage(recentPastExp)).toBe(true);
    });
  });

  describe('token decode and expiry extraction', () => {
    test('extracts exp from valid access token', () => {
      const token = generateTestToken('user-1', 900); // 15 min
      const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);

      expect(decoded.exp).toBeDefined();
      expect(typeof decoded.exp).toBe('number');
      expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
    });

    test('handles token verification failure gracefully', () => {
      // Invalid token should throw, which server handles by setting tokenExp to null
      expect(() => jwt.verify('invalid-token', ACCESS_TOKEN_SECRET)).toThrow();
    });

    test('short-lived token expires quickly', async () => {
      // This test verifies the timing behavior
      const token = generateTestToken('user-1', 1); // 1 second
      const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);

      expect(isTokenExpiredForMessage(decoded.exp)).toBe(false);

      // Wait for token to expire
      await new Promise(resolve => setTimeout(resolve, 1100));

      expect(isTokenExpiredForMessage(decoded.exp)).toBe(true);
    });
  });

  describe('integration scenario: message interception', () => {
    /**
     * Simulates the full message interception flow
     */
    function simulateMessageHandler(tokenExp, canEdit, isEditMsg) {
      // Check token expiry first (same order as server/index.js)
      if (tokenExp && Date.now() / 1000 > tokenExp) {
        return { action: 'close', code: 4401, reason: 'Token expired' };
      }

      // Then check edit permissions
      if (!canEdit && isEditMsg) {
        return { action: 'block', reason: 'Edit blocked for viewer' };
      }

      return { action: 'allow' };
    }

    test('allows message when token valid and user can edit', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const result = simulateMessageHandler(futureExp, true, true);

      expect(result.action).toBe('allow');
    });

    test('closes connection when token expired', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 60;
      const result = simulateMessageHandler(pastExp, true, true);

      expect(result.action).toBe('close');
      expect(result.code).toBe(4401);
    });

    test('blocks edit message for viewer even with valid token', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const result = simulateMessageHandler(futureExp, false, true);

      expect(result.action).toBe('block');
    });

    test('allows non-edit message for viewer with valid token', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const result = simulateMessageHandler(futureExp, false, false);

      expect(result.action).toBe('allow');
    });

    test('token expiry check takes precedence over edit blocking', () => {
      // Even if user is a viewer trying to edit, expired token closes first
      const pastExp = Math.floor(Date.now() / 1000) - 60;
      const result = simulateMessageHandler(pastExp, false, true);

      expect(result.action).toBe('close');
      expect(result.code).toBe(4401);
    });

    test('skips expiry check for agent tokens (null exp)', () => {
      const result = simulateMessageHandler(null, true, true);

      expect(result.action).toBe('allow');
    });
  });
});
