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

  describe('keyring rotation', () => {
    // A second key, id "2", distinct from the legacy 'a'*64 set in beforeAll.
    const KEY2 = 'b'.repeat(64);

    afterEach(() => {
      delete process.env.API_KEY_ENCRYPTION_KEYS;
      delete process.env.API_KEY_ENCRYPTION_PRIMARY;
    });

    test('default primary (legacy) still writes untagged, 3-part values', () => {
      expect(crypto.encrypt('x').split(':').length).toBe(3);
      expect(crypto.primaryKeyId()).toBe('legacy');
      expect(crypto.keyIdOf(crypto.encrypt('x'))).toBe('legacy');
    });

    test('keyed primary writes tagged values and round-trips', () => {
      process.env.API_KEY_ENCRYPTION_KEYS = `2:${KEY2}`;
      process.env.API_KEY_ENCRYPTION_PRIMARY = '2';
      const enc = crypto.encrypt('secret-key');
      const parts = enc.split(':');
      expect(parts.length).toBe(4);
      expect(parts[0]).toBe('k2');
      expect(crypto.keyIdOf(enc)).toBe('2');
      expect(crypto.decrypt(enc)).toBe('secret-key');
    });

    test('legacy untagged values still decrypt after a keyed primary is added', () => {
      // Written under the legacy key (default primary)...
      const legacyVal = crypto.encrypt('old-secret');
      expect(legacyVal.split(':').length).toBe(3);
      // ...still readable once the primary moves to a keyed id (legacy stays in the ring).
      process.env.API_KEY_ENCRYPTION_KEYS = `2:${KEY2}`;
      process.env.API_KEY_ENCRYPTION_PRIMARY = '2';
      expect(crypto.decrypt(legacyVal)).toBe('old-secret');
    });

    test('reencrypt migrates a legacy value onto the primary; no-op when already primary', () => {
      const legacyVal = crypto.encrypt('rotate-me');
      process.env.API_KEY_ENCRYPTION_KEYS = `2:${KEY2}`;
      process.env.API_KEY_ENCRYPTION_PRIMARY = '2';
      expect(crypto.isUnderPrimary(legacyVal)).toBe(false);
      const migrated = crypto.reencrypt(legacyVal);
      expect(crypto.keyIdOf(migrated)).toBe('2');
      expect(crypto.isUnderPrimary(migrated)).toBe(true);
      expect(crypto.decrypt(migrated)).toBe('rotate-me');
      // Already on the primary → returned unchanged.
      expect(crypto.reencrypt(migrated)).toBe(migrated);
    });

    test('decrypt throws a helpful error when the tagged key id is not in the ring', () => {
      process.env.API_KEY_ENCRYPTION_KEYS = `2:${KEY2}`;
      process.env.API_KEY_ENCRYPTION_PRIMARY = '2';
      const enc = crypto.encrypt('x');
      // Drop key 2 from the ring (as if retired too early).
      delete process.env.API_KEY_ENCRYPTION_KEYS;
      delete process.env.API_KEY_ENCRYPTION_PRIMARY;
      expect(() => crypto.decrypt(enc)).toThrow(/No encryption key configured for id "2"/);
    });

    test('throws when the primary id is absent from the keyring', () => {
      process.env.API_KEY_ENCRYPTION_PRIMARY = 'nope';
      expect(() => crypto.encrypt('x')).toThrow(/API_KEY_ENCRYPTION_PRIMARY "nope" is not present/);
    });

    test('rejects a reserved or malformed keyring id', () => {
      process.env.API_KEY_ENCRYPTION_KEYS = `legacy:${KEY2}`;
      expect(() => crypto.encrypt('x')).toThrow(/invalid key id/);
    });
  });
});
