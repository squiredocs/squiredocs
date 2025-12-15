import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateUUID } from '../DocList';

describe('generateUUID', () => {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  describe('when crypto.randomUUID is available', () => {
    let originalCrypto;

    beforeEach(() => {
      originalCrypto = global.crypto;
      global.crypto = {
        randomUUID: vi.fn(() => '550e8400-e29b-41d4-a716-446655440000'),
      };
    });

    afterEach(() => {
      global.crypto = originalCrypto;
    });

    it('uses native crypto.randomUUID', () => {
      const uuid = generateUUID();
      expect(crypto.randomUUID).toHaveBeenCalled();
      expect(uuid).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('returns valid UUID format', () => {
      crypto.randomUUID.mockReturnValue('123e4567-e89b-42d3-a456-426614174000');
      const uuid = generateUUID();
      expect(uuid).toMatch(UUID_REGEX);
    });
  });

  describe('when crypto.randomUUID is not available (fallback)', () => {
    let originalCrypto;

    beforeEach(() => {
      originalCrypto = global.crypto;
      // Simulate non-secure context where crypto.randomUUID doesn't exist
      global.crypto = undefined;
    });

    afterEach(() => {
      global.crypto = originalCrypto;
    });

    it('generates valid UUID v4 format', () => {
      const uuid = generateUUID();
      expect(uuid).toMatch(UUID_REGEX);
    });

    it('generates UUID with correct version field (4)', () => {
      const uuid = generateUUID();
      // 13th character should be '4' (version 4)
      expect(uuid[14]).toBe('4');
    });

    it('generates UUID with correct variant field', () => {
      const uuid = generateUUID();
      // 17th character should be 8, 9, a, or b (variant bits)
      const variantChar = uuid[19].toLowerCase();
      expect(['8', '9', 'a', 'b']).toContain(variantChar);
    });

    it('generates unique UUIDs', () => {
      const uuid1 = generateUUID();
      const uuid2 = generateUUID();
      const uuid3 = generateUUID();

      expect(uuid1).not.toBe(uuid2);
      expect(uuid2).not.toBe(uuid3);
      expect(uuid1).not.toBe(uuid3);
    });

    it('generates UUIDs with correct length', () => {
      const uuid = generateUUID();
      expect(uuid).toHaveLength(36); // 32 hex chars + 4 hyphens
    });

    it('generates UUIDs with hyphens in correct positions', () => {
      const uuid = generateUUID();
      expect(uuid[8]).toBe('-');
      expect(uuid[13]).toBe('-');
      expect(uuid[18]).toBe('-');
      expect(uuid[23]).toBe('-');
    });

    it('generates different UUIDs on multiple calls', () => {
      const uuids = new Set();
      for (let i = 0; i < 100; i++) {
        uuids.add(generateUUID());
      }
      // Should have 100 unique UUIDs
      expect(uuids.size).toBe(100);
    });
  });

  describe('when crypto exists but randomUUID is not available', () => {
    let originalCrypto;

    beforeEach(() => {
      originalCrypto = global.crypto;
      // Simulate crypto exists but randomUUID doesn't (older browsers)
      global.crypto = { subtle: {} };
    });

    afterEach(() => {
      global.crypto = originalCrypto;
    });

    it('falls back to manual UUID generation', () => {
      const uuid = generateUUID();
      expect(uuid).toMatch(UUID_REGEX);
      expect(uuid[14]).toBe('4'); // version 4
    });
  });
});
