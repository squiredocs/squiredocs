/**
 * JWT utilities tests
 */
const jwt = require('jsonwebtoken');

// Set test secrets before requiring the module
process.env.ACCESS_TOKEN_SECRET = 'test-access-secret';
process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';

const {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  getCookieOptions,
  getClearCookieOptions,
} = require('../jwt');

describe('JWT utilities', () => {
  const mockUser = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    email: 'test@example.com',
    name: 'Test User',
    picture: 'https://example.com/pic.jpg',
    token_version: 0,
  };

  describe('generateAccessToken', () => {
    test('generates a valid JWT token', () => {
      const token = generateAccessToken(mockUser);
      
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });

    test('includes correct user claims', () => {
      const token = generateAccessToken(mockUser);
      const decoded = jwt.decode(token);
      
      expect(decoded.userId).toBe(mockUser.id);
      expect(decoded.email).toBe(mockUser.email);
      expect(decoded.name).toBe(mockUser.name);
      expect(decoded.picture).toBe(mockUser.picture);
      expect(decoded.iss).toBe('collab-app');
    });

    test('sets correct expiration', () => {
      const token = generateAccessToken(mockUser);
      const decoded = jwt.decode(token);
      
      // Token should expire in ~15 minutes (900 seconds)
      const expDiff = decoded.exp - decoded.iat;
      expect(expDiff).toBe(15 * 60); // 15 minutes in seconds
    });
  });

  describe('generateRefreshToken', () => {
    test('generates a valid JWT token', () => {
      const token = generateRefreshToken(mockUser);
      
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    test('includes userId and tokenVersion', () => {
      const token = generateRefreshToken(mockUser);
      const decoded = jwt.decode(token);
      
      expect(decoded.userId).toBe(mockUser.id);
      expect(decoded.tokenVersion).toBe(mockUser.token_version);
      expect(decoded.iss).toBe('collab-app');
    });

    test('sets correct expiration (7 days)', () => {
      const token = generateRefreshToken(mockUser);
      const decoded = jwt.decode(token);
      
      // Token should expire in 7 days
      const expDiff = decoded.exp - decoded.iat;
      expect(expDiff).toBe(7 * 24 * 60 * 60); // 7 days in seconds
    });
  });

  describe('verifyAccessToken', () => {
    test('verifies valid access token', () => {
      const token = generateAccessToken(mockUser);
      const decoded = verifyAccessToken(token);
      
      expect(decoded.userId).toBe(mockUser.id);
      expect(decoded.email).toBe(mockUser.email);
    });

    test('throws on invalid token', () => {
      expect(() => verifyAccessToken('invalid-token')).toThrow();
    });

    test('throws on expired token', () => {
      // Create a token that's already expired
      const token = jwt.sign(
        { userId: mockUser.id },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: '-1h', issuer: 'collab-app' }
      );
      
      expect(() => verifyAccessToken(token)).toThrow();
    });

    test('throws on wrong issuer', () => {
      const token = jwt.sign(
        { userId: mockUser.id },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: '15m', issuer: 'wrong-issuer' }
      );
      
      expect(() => verifyAccessToken(token)).toThrow();
    });
  });

  describe('verifyRefreshToken', () => {
    test('verifies valid refresh token', () => {
      const token = generateRefreshToken(mockUser);
      const decoded = verifyRefreshToken(token);
      
      expect(decoded.userId).toBe(mockUser.id);
      expect(decoded.tokenVersion).toBe(mockUser.token_version);
    });

    test('throws on invalid token', () => {
      expect(() => verifyRefreshToken('invalid-token')).toThrow();
    });

    test('throws on token signed with wrong secret', () => {
      const token = jwt.sign(
        { userId: mockUser.id },
        'wrong-secret',
        { expiresIn: '7d', issuer: 'collab-app' }
      );
      
      expect(() => verifyRefreshToken(token)).toThrow();
    });
  });

  describe('getCookieOptions', () => {
    test('returns httpOnly cookie options', () => {
      const options = getCookieOptions();
      
      expect(options.httpOnly).toBe(true);
      expect(options.path).toBe('/');
      expect(options.maxAge).toBe(7 * 24 * 60 * 60 * 1000); // 7 days in ms
    });

    test('returns a copy (not original object)', () => {
      const options1 = getCookieOptions();
      const options2 = getCookieOptions();
      
      options1.modified = true;
      expect(options2.modified).toBeUndefined();
    });
  });

  describe('getClearCookieOptions', () => {
    test('returns options for clearing cookie', () => {
      const options = getClearCookieOptions();
      
      expect(options.httpOnly).toBe(true);
      expect(options.path).toBe('/');
      // maxAge should not be set for clear options
      expect(options.maxAge).toBeUndefined();
    });
  });
});

