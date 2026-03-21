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
    test('calls next() with valid Bearer token', async () => {
      const token = generateAccessToken(mockUser);
      const { req, res, next } = createMocks(`Bearer ${token}`);

      await requireAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user.userId).toBe(mockUser.id);
      expect(req.user.email).toBe(mockUser.email);
    });

    test('returns 401 when no authorization header', async () => {
      const { req, res, next } = createMocks(undefined);

      await requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'No authorization header' });
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 for invalid header format (no Bearer prefix)', async () => {
      const token = generateAccessToken(mockUser);
      const { req, res, next } = createMocks(token); // Missing "Bearer "

      await requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 for invalid header format (wrong scheme)', async () => {
      const token = generateAccessToken(mockUser);
      const { req, res, next } = createMocks(`Basic ${token}`);

      await requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 for invalid token', async () => {
      const { req, res, next } = createMocks('Bearer invalid-token');

      await requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    test('returns 401 for expired token', async () => {
      const jwt = require('jsonwebtoken');
      const expiredToken = jwt.sign(
        { userId: mockUser.id, email: mockUser.email },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: '-1h', issuer: 'collab-app' }
      );
      const { req, res, next } = createMocks(`Bearer ${expiredToken}`);

      await requireAuth(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('optionalAuth', () => {
    test('calls next() and sets req.user with valid token', async () => {
      const token = generateAccessToken(mockUser);
      const { req, res, next } = createMocks(`Bearer ${token}`);

      await optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user.userId).toBe(mockUser.id);
    });

    test('calls next() without req.user when no header', async () => {
      const { req, res, next } = createMocks(undefined);

      await optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    test('calls next() without req.user for invalid format', async () => {
      const token = generateAccessToken(mockUser);
      const { req, res, next } = createMocks(`Basic ${token}`);

      await optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    test('calls next() without req.user for invalid token', async () => {
      const { req, res, next } = createMocks('Bearer invalid-token');

      await optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    test('calls next() without req.user for expired token', async () => {
      const jwt = require('jsonwebtoken');
      const expiredToken = jwt.sign(
        { userId: mockUser.id },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: '-1h', issuer: 'collab-app' }
      );
      const { req, res, next } = createMocks(`Bearer ${expiredToken}`);

      await optionalAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });
  });

  describe('requireAdmin', () => {
    // requireAdmin composes with requireAuth and then checks admin status
    // It needs a DB lookup, so we mock the users module
    let requireAdmin;

    beforeEach(() => {
      jest.resetModules();
      // Re-require to get fresh module with mock
      process.env.ACCESS_TOKEN_SECRET = 'test-access-secret';
      process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';
    });

    test('returns 401 when no authorization header', (done) => {
      const { requireAdmin: ra } = require('../middleware');
      const { req, res, next } = createMocks(undefined);

      // Spy on res.json to detect when the response is sent
      res.json.mockImplementation(() => {
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
        done();
        return res;
      });

      ra(req, res, next);
    });

    test('returns 403 when JWT does not have isAdmin claim', (done) => {
      const { generateAccessToken } = require('../jwt');
      const nonAdminUser = { ...mockUser, is_admin: false };
      const token = generateAccessToken(nonAdminUser);
      const { requireAdmin: ra } = require('../middleware');
      const { req, res, next } = createMocks(`Bearer ${token}`);

      res.json.mockImplementation(() => {
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: 'Admin access required' });
        expect(next).not.toHaveBeenCalled();
        done();
        return res;
      });

      ra(req, res, next);
    });

    test('returns 403 when JWT has isAdmin but DB says not admin', (done) => {
      // Mock users.findById to return a non-admin user
      jest.doMock('../users', () => ({
        findById: jest.fn().mockResolvedValue({ id: mockUser.id, is_admin: false }),
      }));

      const { generateAccessToken } = require('../jwt');
      const adminUser = { ...mockUser, is_admin: true };
      const token = generateAccessToken(adminUser);

      // Clear middleware module cache so it picks up the mocked users
      delete require.cache[require.resolve('../middleware')];
      const { requireAdmin: ra } = require('../middleware');

      const { req, res, next } = createMocks(`Bearer ${token}`);

      res.json.mockImplementation(() => {
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: 'Admin access required' });
        expect(next).not.toHaveBeenCalled();
        done();
        return res;
      });

      ra(req, res, next);
    });

    test('calls next() when JWT and DB both confirm admin', (done) => {
      // Mock users.findById to return an admin user
      jest.doMock('../users', () => ({
        findById: jest.fn().mockResolvedValue({ id: mockUser.id, is_admin: true }),
      }));

      const { generateAccessToken } = require('../jwt');
      const adminUser = { ...mockUser, is_admin: true };
      const token = generateAccessToken(adminUser);

      delete require.cache[require.resolve('../middleware')];
      const { requireAdmin: ra } = require('../middleware');

      const { req, res, next } = createMocks(`Bearer ${token}`);

      next.mockImplementation(() => {
        expect(res.status).not.toHaveBeenCalled();
        done();
      });

      ra(req, res, next);
    });
  });
});
