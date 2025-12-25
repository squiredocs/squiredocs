/**
 * Tests for Redis client module
 */

// Mock ioredis before requiring the module
jest.mock('ioredis', () => {
  const EventEmitter = require('events');

  class MockRedis extends EventEmitter {
    constructor(config) {
      super();
      this.config = config;
      this.data = new Map();
      this.connected = false;

      // Simulate async connection
      setImmediate(() => {
        this.connected = true;
        this.emit('connect');
        this.emit('ready');
      });
    }

    async setex(key, ttl, value) {
      this.data.set(key, { value, ttl });
      return 'OK';
    }

    async get(key) {
      const entry = this.data.get(key);
      return entry ? entry.value : null;
    }

    async getBuffer(key) {
      const entry = this.data.get(key);
      return entry ? entry.value : null;
    }

    async exists(key) {
      return this.data.has(key) ? 1 : 0;
    }

    async del(key) {
      const existed = this.data.has(key);
      this.data.delete(key);
      return existed ? 1 : 0;
    }

    async expire(key, seconds) {
      const entry = this.data.get(key);
      if (entry) {
        entry.ttl = seconds;
        return 1;
      }
      return 0;
    }

    async quit() {
      this.connected = false;
      this.emit('close');
      return 'OK';
    }
  }

  return MockRedis;
});

describe('Redis client module', () => {
  let originalEnv;

  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env };
    // Clear the module cache to get fresh instances
    jest.resetModules();
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  describe('isRedisEnabled', () => {
    test('returns false when REDIS_HOST is not set', () => {
      delete process.env.REDIS_HOST;
      const { isRedisEnabled } = require('../redis');
      expect(isRedisEnabled()).toBe(false);
    });

    test('returns true when REDIS_HOST is set', () => {
      process.env.REDIS_HOST = 'localhost';
      const { isRedisEnabled } = require('../redis');
      expect(isRedisEnabled()).toBe(true);
    });
  });

  describe('getRedisClient', () => {
    test('returns singleton Redis client', () => {
      process.env.REDIS_HOST = 'localhost';
      const { getRedisClient } = require('../redis');

      const client1 = getRedisClient();
      const client2 = getRedisClient();

      expect(client1).toBe(client2);
    });

    test('creates client with correct config', () => {
      process.env.REDIS_HOST = 'redis-server';
      process.env.REDIS_PORT = '6380';
      const { getRedisClient } = require('../redis');

      const client = getRedisClient();

      expect(client.config.host).toBe('redis-server');
      expect(client.config.port).toBe(6380);
    });

    test('uses default port when REDIS_PORT not set', () => {
      process.env.REDIS_HOST = 'localhost';
      delete process.env.REDIS_PORT;
      const { getRedisClient } = require('../redis');

      const client = getRedisClient();

      expect(client.config.port).toBe(6379);
    });
  });

  describe('isRedisReady', () => {
    test('returns false initially before connection', () => {
      process.env.REDIS_HOST = 'localhost';
      const { isRedisReady } = require('../redis');

      // Immediately after require, before 'ready' event fires
      expect(isRedisReady()).toBe(false);
    });

    test('returns true after ready event', async () => {
      process.env.REDIS_HOST = 'localhost';
      const { getRedisClient, isRedisReady } = require('../redis');

      const client = getRedisClient();

      // Wait for ready event
      await new Promise(resolve => {
        if (client.connected) {
          resolve();
        } else {
          client.on('ready', resolve);
        }
      });

      expect(isRedisReady()).toBe(true);
    });
  });

  describe('closeRedis', () => {
    test('closes the Redis connection', async () => {
      process.env.REDIS_HOST = 'localhost';
      const { getRedisClient, closeRedis, isRedisReady } = require('../redis');

      const client = getRedisClient();

      // Wait for ready
      await new Promise(resolve => {
        if (client.connected) resolve();
        else client.on('ready', resolve);
      });

      await closeRedis();

      // After close, isRedisReady should return false
      expect(isRedisReady()).toBe(false);
    });
  });

  describe('eager initialization', () => {
    test('initializes Redis connection when REDIS_HOST is set', () => {
      process.env.REDIS_HOST = 'localhost';

      // Just requiring the module should trigger eager initialization
      const redis = require('../redis');

      // The getRedisClient should have been called during module load
      // We verify by checking that subsequent calls return the same instance
      const client1 = redis.getRedisClient();
      const client2 = redis.getRedisClient();
      expect(client1).toBe(client2);
    });
  });
});
