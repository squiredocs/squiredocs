/**
 * Tests for Redis persistence module for Yjs documents
 */
const Y = require('yjs');

// Mock redis module
jest.mock('../redis', () => {
  const mockData = new Map();
  let enabled = true;
  let ready = true;

  const mockClient = {
    setex: jest.fn(async (key, ttl, value) => {
      mockData.set(key, { value, ttl });
      return 'OK';
    }),
    getBuffer: jest.fn(async (key) => {
      const entry = mockData.get(key);
      return entry ? entry.value : null;
    }),
    exists: jest.fn(async (key) => {
      return mockData.has(key) ? 1 : 0;
    }),
    del: jest.fn(async (key) => {
      const existed = mockData.has(key);
      mockData.delete(key);
      return existed ? 1 : 0;
    }),
    expire: jest.fn(async (key, seconds) => {
      const entry = mockData.get(key);
      if (entry) {
        entry.ttl = seconds;
        return 1;
      }
      return 0;
    }),
  };

  return {
    getRedisClient: jest.fn(() => mockClient),
    isRedisEnabled: jest.fn(() => enabled),
    isRedisReady: jest.fn(() => ready),
    // Test helpers
    __mockData: mockData,
    __mockClient: mockClient,
    __setEnabled: (val) => { enabled = val; },
    __setReady: (val) => { ready = val; },
    __reset: () => {
      mockData.clear();
      enabled = true;
      ready = true;
      Object.values(mockClient).forEach(fn => fn.mockClear && fn.mockClear());
    },
  };
});

const redisMock = require('../redis');
const { RedisPersistence, redisPersistence } = require('../redis-persistence');

describe('RedisPersistence', () => {
  const testDocGuid = 'test-doc-123';

  beforeEach(() => {
    redisMock.__reset();
  });

  describe('constructor', () => {
    test('sets enabled based on isRedisEnabled', () => {
      redisMock.__setEnabled(true);
      const persistence = new RedisPersistence();
      expect(persistence.enabled).toBe(true);
    });

    test('sets enabled to false when Redis is not enabled', () => {
      redisMock.__setEnabled(false);
      const persistence = new RedisPersistence();
      expect(persistence.enabled).toBe(false);
    });
  });

  describe('_getDocKey', () => {
    test('returns correct Redis key format', () => {
      const persistence = new RedisPersistence();
      const key = persistence._getDocKey(testDocGuid);
      expect(key).toBe('yjs:doc:test-doc-123');
    });
  });

  describe('storeDoc', () => {
    test('stores Y.Doc state in Redis with TTL', async () => {
      const persistence = new RedisPersistence();
      const ydoc = new Y.Doc();
      const text = ydoc.getText('content');
      text.insert(0, 'Hello, World!');

      await persistence.storeDoc(testDocGuid, ydoc);

      expect(redisMock.__mockClient.setex).toHaveBeenCalledWith(
        'yjs:doc:test-doc-123',
        24 * 60 * 60, // 24 hours
        expect.any(Buffer)
      );
    });

    test('does nothing when Redis is disabled', async () => {
      redisMock.__setEnabled(false);
      const persistence = new RedisPersistence();
      const ydoc = new Y.Doc();

      await persistence.storeDoc(testDocGuid, ydoc);

      expect(redisMock.__mockClient.setex).not.toHaveBeenCalled();
    });

    test('handles Redis errors gracefully', async () => {
      const persistence = new RedisPersistence();
      const ydoc = new Y.Doc();

      redisMock.__mockClient.setex.mockRejectedValueOnce(new Error('Redis error'));

      // Should not throw
      await expect(persistence.storeDoc(testDocGuid, ydoc)).resolves.toBeUndefined();
    });
  });

  describe('storeDocState', () => {
    test('stores encoded state directly in Redis', async () => {
      const persistence = new RedisPersistence();
      const ydoc = new Y.Doc();
      ydoc.getText('content').insert(0, 'Test');
      const state = Y.encodeStateAsUpdate(ydoc);

      await persistence.storeDocState(testDocGuid, state);

      expect(redisMock.__mockClient.setex).toHaveBeenCalledWith(
        'yjs:doc:test-doc-123',
        24 * 60 * 60,
        expect.any(Buffer)
      );
    });

    test('does nothing when Redis is disabled', async () => {
      redisMock.__setEnabled(false);
      const persistence = new RedisPersistence();

      await persistence.storeDocState(testDocGuid, new Uint8Array([1, 2, 3]));

      expect(redisMock.__mockClient.setex).not.toHaveBeenCalled();
    });
  });

  describe('getDoc', () => {
    test('retrieves and reconstructs Y.Doc from Redis', async () => {
      // First, store a document
      const originalDoc = new Y.Doc();
      originalDoc.getText('content').insert(0, 'Hello from Redis!');
      const state = Y.encodeStateAsUpdate(originalDoc);

      // Manually set in mock storage
      redisMock.__mockData.set('yjs:doc:test-doc-123', {
        value: Buffer.from(state),
        ttl: 86400,
      });

      const persistence = new RedisPersistence();
      const retrievedDoc = await persistence.getDoc(testDocGuid);

      expect(retrievedDoc).toBeInstanceOf(Y.Doc);
      expect(retrievedDoc.getText('content').toString()).toBe('Hello from Redis!');
    });

    test('returns null when document not found', async () => {
      const persistence = new RedisPersistence();
      const result = await persistence.getDoc('non-existent-doc');

      expect(result).toBeNull();
    });

    test('returns null when Redis is disabled', async () => {
      redisMock.__setEnabled(false);
      const persistence = new RedisPersistence();

      const result = await persistence.getDoc(testDocGuid);

      expect(result).toBeNull();
    });

    test('refreshes TTL on access', async () => {
      const ydoc = new Y.Doc();
      const state = Y.encodeStateAsUpdate(ydoc);
      redisMock.__mockData.set('yjs:doc:test-doc-123', {
        value: Buffer.from(state),
        ttl: 1000,
      });

      const persistence = new RedisPersistence();
      await persistence.getDoc(testDocGuid);

      expect(redisMock.__mockClient.expire).toHaveBeenCalledWith(
        'yjs:doc:test-doc-123',
        24 * 60 * 60
      );
    });

    test('handles Redis errors gracefully', async () => {
      const persistence = new RedisPersistence();
      redisMock.__mockClient.getBuffer.mockRejectedValueOnce(new Error('Redis error'));

      const result = await persistence.getDoc(testDocGuid);

      expect(result).toBeNull();
    });
  });

  describe('hasDoc', () => {
    test('returns true when document exists', async () => {
      redisMock.__mockData.set('yjs:doc:test-doc-123', {
        value: Buffer.from([1, 2, 3]),
        ttl: 86400,
      });

      const persistence = new RedisPersistence();
      const exists = await persistence.hasDoc(testDocGuid);

      expect(exists).toBe(true);
    });

    test('returns false when document does not exist', async () => {
      const persistence = new RedisPersistence();
      const exists = await persistence.hasDoc('non-existent');

      expect(exists).toBe(false);
    });

    test('returns false when Redis is disabled', async () => {
      redisMock.__setEnabled(false);
      const persistence = new RedisPersistence();

      const exists = await persistence.hasDoc(testDocGuid);

      expect(exists).toBe(false);
    });
  });

  describe('deleteDoc', () => {
    test('deletes document from Redis', async () => {
      redisMock.__mockData.set('yjs:doc:test-doc-123', {
        value: Buffer.from([1, 2, 3]),
        ttl: 86400,
      });

      const persistence = new RedisPersistence();
      await persistence.deleteDoc(testDocGuid);

      expect(redisMock.__mockClient.del).toHaveBeenCalledWith('yjs:doc:test-doc-123');
    });

    test('does nothing when Redis is disabled', async () => {
      redisMock.__setEnabled(false);
      const persistence = new RedisPersistence();

      await persistence.deleteDoc(testDocGuid);

      expect(redisMock.__mockClient.del).not.toHaveBeenCalled();
    });
  });

  describe('isEnabled', () => {
    test('returns true when Redis is enabled and ready', () => {
      redisMock.__setEnabled(true);
      redisMock.__setReady(true);
      const persistence = new RedisPersistence();

      expect(persistence.isEnabled()).toBe(true);
    });

    test('returns false when Redis is enabled but not ready', () => {
      redisMock.__setEnabled(true);
      redisMock.__setReady(false);
      const persistence = new RedisPersistence();

      expect(persistence.isEnabled()).toBe(false);
    });

    test('returns false when Redis is not enabled', () => {
      redisMock.__setEnabled(false);
      const persistence = new RedisPersistence();

      expect(persistence.isEnabled()).toBe(false);
    });
  });

  describe('singleton instance', () => {
    test('exports a singleton instance', () => {
      expect(redisPersistence).toBeInstanceOf(RedisPersistence);
    });
  });

  describe('Y.Doc round-trip', () => {
    test('preserves complex document structure through store/retrieve cycle', async () => {
      // Create a complex document
      const originalDoc = new Y.Doc();
      const text = originalDoc.getText('content');
      text.insert(0, 'Hello');
      text.insert(5, ' World');

      const meta = originalDoc.getMap('meta');
      meta.set('title', 'Test Document');
      meta.set('version', 1);

      const array = originalDoc.getArray('items');
      array.push(['item1', 'item2', 'item3']);

      // Store it
      const persistence = new RedisPersistence();
      await persistence.storeDoc(testDocGuid, originalDoc);

      // Retrieve it
      const retrievedDoc = await persistence.getDoc(testDocGuid);

      // Verify content preserved
      expect(retrievedDoc.getText('content').toString()).toBe('Hello World');
      expect(retrievedDoc.getMap('meta').get('title')).toBe('Test Document');
      expect(retrievedDoc.getMap('meta').get('version')).toBe(1);
      expect(retrievedDoc.getArray('items').toArray()).toEqual(['item1', 'item2', 'item3']);
    });
  });
});
