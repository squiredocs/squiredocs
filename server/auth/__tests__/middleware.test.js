/**
 * Auth middleware tests
 */

// Set test secrets before requiring modules
process.env.ACCESS_TOKEN_SECRET = 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';

const { requireAuth, optionalAuth } = require('../middleware');
const { generateAccessToken } = require('../jwt');

describe('Auth middleware', () => {
  const mockUser = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    email: 'test@example.com',
    name: 'Test User',
    picture: 'https://example.com/pic.jpg',
    token_version: 0,
  };

  // Helper to create mock request/response/next
  function createMocks(authHeader) {
    const req = {
      headers: authHeader !== undefined ? { authorization: authHeader } : {},
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();
    return { req, res, next };
  }

  describe('requireAuth', () => {
    test('calls next() with valid Bearer token', () => {
      const token = generateAccessToken(mockUser);
      const { req, res, next } = createMocks(`Bearer ${token}`);

      requireAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user.userId).toBe(mockUser.id);
      expect(req.user.email).toBe(mockUser.email);
    });

    test('returns 401 when no authorization header', () => {
      const { req, res, next } = createMocks(undefined);

      requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'No authorization header' });
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 for invalid header format (no Bearer prefix)', () => {
      const token = generateAccessToken(mockUser);
      const { req, res, next } = createMocks(token); // Missing "Bearer "

      requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid authorization header format' });
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 for invalid header format (wrong scheme)', () => {
      const token = generateAccessToken(mockUser);
      const { req, res, next } = createMocks(`Basic ${token}`);

      requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid authorization header format' });
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 for invalid token', () => {
      const { req, res, next } = createMocks('Bearer invalid-token');

      requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 with TOKEN_EXPIRED code for expired token', () => {
      // Create an expired token manually
      const jwt = require('jsonwebtoken');
      const expiredToken = jwt.sign(
        { userId: mockUser.id, email: mockUser.email },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: '-1h', issuer: 'collab-app' }
      );
      const { req, res, next } = createMocks(`Bearer ${expiredToken}`);

      requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ 
        error: 'Token expired', 
        code: 'TOKEN_EXPIRED' 
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('optionalAuth', () => {
    test('calls next() and sets req.user with valid token', () => {
      const token = generateAccessToken(mockUser);
      const { req, res, next } = createMocks(`Bearer ${token}`);

      optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user.userId).toBe(mockUser.id);
    });

    test('calls next() without req.user when no header', () => {
      const { req, res, next } = createMocks(undefined);

      optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    test('calls next() without req.user for invalid format', () => {
      const token = generateAccessToken(mockUser);
      const { req, res, next } = createMocks(`Basic ${token}`);

      optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    test('calls next() without req.user for invalid token', () => {
      const { req, res, next } = createMocks('Bearer invalid-token');

      optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    test('calls next() without req.user for expired token', () => {
      const jwt = require('jsonwebtoken');
      const expiredToken = jwt.sign(
        { userId: mockUser.id },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: '-1h', issuer: 'collab-app' }
      );
      const { req, res, next } = createMocks(`Bearer ${expiredToken}`);

      optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });
  });
});

