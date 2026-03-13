/**
 * Encryption utility tests
 * Tests AES-256-GCM encrypt/decrypt round-trips.
 */
const crypto = require('../crypto');

// Set a test encryption key (64-char hex = 32 bytes)
beforeAll(() => {
  process.env.API_KEY_ENCRYPTION_KEY = 'a'.repeat(64);
});

afterAll(() => {
  delete process.env.API_KEY_ENCRYPTION_KEY;
});

describe('crypto', () => {
  describe('encrypt / decrypt', () => {
    test('round-trips a simple string', () => {
      const plaintext = 'sk-ant-api03-test-key';
      const encrypted = crypto.encrypt(plaintext);
      expect(crypto.decrypt(encrypted)).toBe(plaintext);
    });

    test('round-trips an empty string', () => {
      const encrypted = crypto.encrypt('');
      expect(crypto.decrypt(encrypted)).toBe('');
    });

    test('round-trips a long key', () => {
      const plaintext = 'x'.repeat(1000);
      const encrypted = crypto.encrypt(plaintext);
      expect(crypto.decrypt(encrypted)).toBe(plaintext);
    });

    test('round-trips unicode content', () => {
      const plaintext = 'key-with-émojis-🔑';
      const encrypted = crypto.encrypt(plaintext);
      expect(crypto.decrypt(encrypted)).toBe(plaintext);
    });

    test('produces iv:authTag:ciphertext format', () => {
      const encrypted = crypto.encrypt('test');
      const parts = encrypted.split(':');
      expect(parts.length).toBe(3);
      // Each part should be valid base64
      for (const part of parts) {
        expect(() => Buffer.from(part, 'base64')).not.toThrow();
      }
    });

    test('produces different ciphertext each time (random IV)', () => {
      const plaintext = 'same-input';
      const a = crypto.encrypt(plaintext);
      const b = crypto.encrypt(plaintext);
      expect(a).not.toBe(b);
      // But both decrypt to the same value
      expect(crypto.decrypt(a)).toBe(plaintext);
      expect(crypto.decrypt(b)).toBe(plaintext);
    });

    test('fails to decrypt with tampered ciphertext', () => {
      const encrypted = crypto.encrypt('test');
      const parts = encrypted.split(':');
      // Tamper with the ciphertext
      parts[2] = Buffer.from('tampered').toString('base64');
      expect(() => crypto.decrypt(parts.join(':'))).toThrow();
    });

    test('fails to decrypt with tampered auth tag', () => {
      const encrypted = crypto.encrypt('test');
      const parts = encrypted.split(':');
      // Tamper with the auth tag
      parts[1] = Buffer.from('0000000000000000').toString('base64');
      expect(() => crypto.decrypt(parts.join(':'))).toThrow();
    });
  });

  describe('getEncryptionKey validation', () => {
    test('throws in production without env var', () => {
      const original = process.env.API_KEY_ENCRYPTION_KEY;
      const originalEnv = process.env.NODE_ENV;
      delete process.env.API_KEY_ENCRYPTION_KEY;
      process.env.NODE_ENV = 'production';
      expect(() => crypto.encrypt('test')).toThrow('must be set in production');
      process.env.API_KEY_ENCRYPTION_KEY = original;
      process.env.NODE_ENV = originalEnv;
    });

    test('throws for wrong-length key', () => {
      const original = process.env.API_KEY_ENCRYPTION_KEY;
      process.env.API_KEY_ENCRYPTION_KEY = 'tooshort';
      expect(() => crypto.encrypt('test')).toThrow('64-character hex string');
      process.env.API_KEY_ENCRYPTION_KEY = original;
    });
  });
});
