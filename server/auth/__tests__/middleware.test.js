/**
 * Auth middleware tests
 */

// Set test secrets before requiring modules
process.env.ACCESS_TOKEN_SECRET = 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';

const { requireAuth, optionalAuth, requiredScopeForMethod, checkScopes } = require('../middleware');
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

  describe('scope enforcement', () => {
    test('maps read methods to documents:read and mutations to documents:write', () => {
      expect(requiredScopeForMethod('GET')).toBe('documents:read');
      expect(requiredScopeForMethod('HEAD')).toBe('documents:read');
      expect(requiredScopeForMethod('OPTIONS')).toBe('documents:read');
      expect(requiredScopeForMethod('POST')).toBe('documents:write');
      expect(requiredScopeForMethod('PUT')).toBe('documents:write');
      expect(requiredScopeForMethod('PATCH')).toBe('documents:write');
      expect(requiredScopeForMethod('DELETE')).toBe('documents:write');
    });

    test('allows scope-less principals (browser session JWTs) for all methods', () => {
      const sessionUser = { userId: mockUser.id, email: mockUser.email };
      expect(checkScopes(sessionUser, 'GET')).toBeNull();
      expect(checkScopes(sessionUser, 'DELETE')).toBeNull();
    });

    test('allows scoped principals holding the required scope', () => {
      const readWrite = { userId: mockUser.id, scopes: ['documents:read', 'documents:write'] };
      expect(checkScopes(readWrite, 'GET')).toBeNull();
      expect(checkScopes(readWrite, 'POST')).toBeNull();
    });

    test('rejects a read-only principal on a mutating method with the MCP error shape', () => {
      const readOnly = { userId: mockUser.id, scopes: ['documents:read'] };
      const result = checkScopes(readOnly, 'POST');
      expect(result).toMatchObject({
        error: 'Insufficient scope',
        code: 'INSUFFICIENT_SCOPE',
        required: 'documents:write',
        granted: ['documents:read'],
      });
      // The remedy hint names the missing scope and the re-mint path (a
      // read-only default mint hitting the import route is the likely case).
      expect(result.hint).toContain('documents:write');
      expect(result.hint).toContain('create_access_token');
      expect(checkScopes(readOnly, 'GET')).toBeNull();
    });

    test('rejects a write-only principal on a read method', () => {
      const writeOnly = { userId: mockUser.id, scopes: ['documents:write'] };
      const result = checkScopes(writeOnly, 'GET');
      expect(result.code).toBe('INSUFFICIENT_SCOPE');
      expect(result.required).toBe('documents:read');
      expect(checkScopes(writeOnly, 'POST')).toBeNull();
    });

    test('requireAuth passes browser-session JWTs unaffected on mutating requests', async () => {
      const token = generateAccessToken(mockUser);
      const { req, res, next } = createMocks(`Bearer ${token}`);
      req.method = 'POST';

      await requireAuth(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
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
