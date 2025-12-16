/**
 * Tests for PKCE (Proof Key for Code Exchange) utilities
 */
const {
  validateCodeChallenge,
  generateAuthCode,
  hashAuthCode,
  validateCodeVerifier,
} = require('../../auth/pkce');
const crypto = require('crypto');

describe('PKCE Utilities', () => {
  describe('validateCodeChallenge', () => {
    test('accepts valid base64url challenge', () => {
      const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      const result = validateCodeChallenge(challenge);
      expect(result.valid).toBe(true);
    });

    test('rejects challenge that is too short', () => {
      const challenge = 'tooshort';
      const result = validateCodeChallenge(challenge);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at least 43 characters');
    });

    test('rejects challenge that is too long', () => {
      const challenge = 'a'.repeat(129);
      const result = validateCodeChallenge(challenge);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('at most 128 characters');
    });

    test('rejects challenge with invalid characters', () => {
      const challenge = 'invalid@#$%^&*()' + 'a'.repeat(30);
      const result = validateCodeChallenge(challenge);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid characters');
    });

    test('accepts challenge with base64url characters', () => {
      const challenge = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const result = validateCodeChallenge(challenge);
      expect(result.valid).toBe(true);
    });
  });

  describe('generateAuthCode', () => {
    test('generates a code', () => {
      const code = generateAuthCode();
      expect(code).toBeTruthy();
      expect(typeof code).toBe('string');
    });

    test('generates unique codes', () => {
      const code1 = generateAuthCode();
      const code2 = generateAuthCode();
      expect(code1).not.toBe(code2);
    });

    test('generates codes of reasonable length', () => {
      const code = generateAuthCode();
      expect(code.length).toBeGreaterThan(20);
      expect(code.length).toBeLessThan(100);
    });
  });

  describe('hashAuthCode', () => {
    test('hashes a code', () => {
      const code = 'test-auth-code-123';
      const hash = hashAuthCode(code);
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
      expect(hash).not.toBe(code);
    });

    test('produces consistent hashes', () => {
      const code = 'test-auth-code-123';
      const hash1 = hashAuthCode(code);
      const hash2 = hashAuthCode(code);
      expect(hash1).toBe(hash2);
    });

    test('produces different hashes for different codes', () => {
      const hash1 = hashAuthCode('code-1');
      const hash2 = hashAuthCode('code-2');
      expect(hash1).not.toBe(hash2);
    });

    test('produces SHA-256 hashes', () => {
      const code = 'test-code';
      const hash = hashAuthCode(code);
      const expectedHash = crypto.createHash('sha256').update(code).digest('hex');
      expect(hash).toBe(expectedHash);
    });
  });

  describe('validateCodeVerifier', () => {
    test('validates correct S256 verifier/challenge pair', () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      // This is the S256 hash of the verifier above
      const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

      const result = validateCodeVerifier(verifier, challenge, 'S256');
      expect(result.valid).toBe(true);
    });

    test('rejects plain method (not supported)', () => {
      const verifier = 'my-plain-text-verifier-that-is-long-enough-12345';
      const challenge = verifier; // Plain method uses verifier as challenge

      const result = validateCodeVerifier(verifier, challenge, 'plain');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Only S256');
    });

    test('rejects mismatched verifier/challenge for S256', () => {
      const verifier = 'correct-verifier-that-is-definitely-long-enough';
      const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'; // Wrong challenge

      const result = validateCodeVerifier(verifier, challenge, 'S256');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('does not match');
    });

    test('rejects unsupported challenge method', () => {
      const verifier = 'test-verifier-that-is-long-enough-to-be-valid';
      const challenge = 'test-challenge';

      const result = validateCodeVerifier(verifier, challenge, 'unsupported');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Only S256');
    });

    test('defaults to S256 method', () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

      const result = validateCodeVerifier(verifier, challenge);
      expect(result.valid).toBe(true);
    });

    test('rejects verifier that is too short', () => {
      const verifier = 'short';
      const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');

      const result = validateCodeVerifier(verifier, challenge, 'S256');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid code_verifier length');
    });

    test('rejects verifier that is too long', () => {
      const verifier = 'a'.repeat(129);
      const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');

      const result = validateCodeVerifier(verifier, challenge, 'S256');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid code_verifier length');
    });

    test('handles empty verifier', () => {
      const result = validateCodeVerifier('', 'challenge', 'S256');
      expect(result.valid).toBe(false);
    });

    test('handles empty challenge', () => {
      const result = validateCodeVerifier('verifier', '', 'S256');
      expect(result.valid).toBe(false);
    });
  });

  describe('PKCE flow integration', () => {
    test('complete PKCE flow works correctly', () => {
      // 1. Generate code verifier (client)
      const codeVerifier = crypto.randomBytes(32).toString('base64url');

      // 2. Generate code challenge (client)
      const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');

      // 3. Validate challenge format (server)
      const challengeValidation = validateCodeChallenge(codeChallenge);
      expect(challengeValidation.valid).toBe(true);

      // 4. Generate and store auth code (server)
      const authCode = generateAuthCode();
      const codeHash = hashAuthCode(authCode);
      expect(codeHash).toBeTruthy();

      // 5. Validate verifier when exchanging code (server)
      const verifierValidation = validateCodeVerifier(
        codeVerifier,
        codeChallenge,
        'S256'
      );
      expect(verifierValidation.valid).toBe(true);
    });
  });
});
