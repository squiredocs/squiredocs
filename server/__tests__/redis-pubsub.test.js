/**
 * Unit tests for Redis Pub/Sub module
 * Tests cross-instance synchronization of awareness and document updates
 */

const EventEmitter = require('events');

// Mock Redis with pub/sub support
class MockRedis extends EventEmitter {
  constructor() {
    super();
    this.subscriptions = new Set();
    this.published = [];
    this.status = 'connecting';
    MockRedis.instances.push(this);

    // Simulate async connection
    setImmediate(() => {
      this.status = 'ready';
      this.emit('ready');
    });
  }

  subscribe(channel) {
    this.subscriptions.add(channel);
    return Promise.resolve();
  }

  unsubscribe(channel) {
    this.subscriptions.delete(channel);
    return Promise.resolve();
  }

  publish(channel, message) {
    this.published.push({ channel, message });
    // Deliver to all subscribers (simulates Redis pub/sub)
    MockRedis.instances.forEach((instance) => {
      if (instance.subscriptions.has(channel) && instance !== this) {
        setImmediate(() => instance.emit('message', channel, message));
      }
    });
    return Promise.resolve(1);
  }

  quit() {
    this.status = 'end';
    return Promise.resolve('OK');
  }

  static instances = [];
  static reset() {
    MockRedis.instances = [];
  }
}

// Mock the redis module
jest.mock('../redis', () => {
  let enabled = true;

  return {
    createPubSubClient: jest.fn(() => new MockRedis()),
    isRedisEnabled: jest.fn(() => enabled),
    __setEnabled: (val) => {
      enabled = val;
    },
    __reset: () => {
      enabled = true;
    },
  };
});

const redisPubSub = require('../redis-pubsub');
const redisMock = require('../redis');

// Helper to wait for async operations
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe('redis-pubsub', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MockRedis.reset();
    redisMock.__reset();
    redisPubSub._reset();
  });

  afterEach(async () => {
    await redisPubSub.cleanup();
  });

  describe('init', () => {
    test('creates subscriber and publisher clients when Redis is enabled', async () => {
      await redisPubSub.init();

      expect(redisMock.createPubSubClient).toHaveBeenCalledTimes(2);
      expect(MockRedis.instances.length).toBe(2);
    });

    test('does nothing when Redis is disabled', async () => {
      redisMock.__setEnabled(false);

      await redisPubSub.init();

      expect(redisMock.createPubSubClient).not.toHaveBeenCalled();
      expect(redisPubSub.isEnabled()).toBe(false);
    });

    test('does not reinitialize if already initialized', async () => {
      await redisPubSub.init();
      await redisPubSub.init();

      expect(redisMock.createPubSubClient).toHaveBeenCalledTimes(2);
    });
  });

  describe('isEnabled', () => {
    test('returns false before initialization', () => {
      expect(redisPubSub.isEnabled()).toBe(false);
    });

    test('returns true after successful initialization', async () => {
      await redisPubSub.init();
      expect(redisPubSub.isEnabled()).toBe(true);
    });

    test('returns false when Redis is disabled', async () => {
      redisMock.__setEnabled(false);
      await redisPubSub.init();
      expect(redisPubSub.isEnabled()).toBe(false);
    });
  });

  describe('subscribeToDocument', () => {
    test('subscribes to both awareness and updates channels', async () => {
      await redisPubSub.init();

      redisPubSub.subscribeToDocument('doc-123', {
        onAwareness: jest.fn(),
        onUpdate: jest.fn(),
      });

      await tick();

      const subscriber = MockRedis.instances[0];
      expect(subscriber.subscriptions.has('awareness:doc-123')).toBe(true);
      expect(subscriber.subscriptions.has('updates:doc-123')).toBe(true);
    });

    test('does not duplicate subscriptions for the same document', async () => {
      await redisPubSub.init();

      redisPubSub.subscribeToDocument('doc-123', {
        onAwareness: jest.fn(),
        onUpdate: jest.fn(),
      });
      redisPubSub.subscribeToDocument('doc-123', {
        onAwareness: jest.fn(),
        onUpdate: jest.fn(),
      });

      await tick();

      const subscriber = MockRedis.instances[0];
      // Should only have 2 subscriptions (awareness + updates), not 4
      expect(subscriber.subscriptions.size).toBe(2);
      expect(redisPubSub.getSubscriptionCount()).toBe(1);
    });

    test('does nothing when not initialized', () => {
      redisPubSub.subscribeToDocument('doc-123', {
        onAwareness: jest.fn(),
        onUpdate: jest.fn(),
      });

      expect(redisPubSub.getSubscriptionCount()).toBe(0);
    });
  });

  describe('unsubscribeFromDocument', () => {
    test('removes subscriptions for document', async () => {
      await redisPubSub.init();

      redisPubSub.subscribeToDocument('doc-123', {
        onAwareness: jest.fn(),
        onUpdate: jest.fn(),
      });
      await tick();

      redisPubSub.unsubscribeFromDocument('doc-123');
      await tick();

      const subscriber = MockRedis.instances[0];
      expect(subscriber.subscriptions.has('awareness:doc-123')).toBe(false);
      expect(subscriber.subscriptions.has('updates:doc-123')).toBe(false);
      expect(redisPubSub.getSubscriptionCount()).toBe(0);
    });

    test('does nothing for non-subscribed document', async () => {
      await redisPubSub.init();

      // Should not throw
      redisPubSub.unsubscribeFromDocument('non-existent');

      expect(redisPubSub.getSubscriptionCount()).toBe(0);
    });
  });

  describe('publishAwareness', () => {
    test('publishes to correct channel', async () => {
      await redisPubSub.init();
      const update = new Uint8Array([1, 2, 3]);

      redisPubSub.publishAwareness('doc-123', update);

      await tick();

      const publisher = MockRedis.instances[1];
      expect(publisher.published.length).toBe(1);
      expect(publisher.published[0].channel).toBe('awareness:doc-123');
    });

    test('does nothing when not initialized', () => {
      const update = new Uint8Array([1, 2, 3]);

      // Should not throw
      redisPubSub.publishAwareness('doc-123', update);
    });
  });

  describe('publishUpdate', () => {
    test('publishes to correct channel', async () => {
      await redisPubSub.init();
      const update = new Uint8Array([1, 2, 3]);

      redisPubSub.publishUpdate('doc-123', update);

      await tick();

      const publisher = MockRedis.instances[1];
      expect(publisher.published.length).toBe(1);
      expect(publisher.published[0].channel).toBe('updates:doc-123');
    });

    test('does nothing when not initialized', () => {
      const update = new Uint8Array([1, 2, 3]);

      // Should not throw
      redisPubSub.publishUpdate('doc-123', update);
    });
  });

  describe('message routing', () => {
    test('routes awareness messages to correct handler', async () => {
      await redisPubSub.init();

      const onAwareness = jest.fn();
      const onUpdate = jest.fn();

      redisPubSub.subscribeToDocument('doc-123', { onAwareness, onUpdate });
      await tick();

      // Simulate receiving a message from Redis
      const subscriber = MockRedis.instances[0];
      const testMessage = Buffer.from([1, 2, 3]);
      subscriber.emit('message', 'awareness:doc-123', testMessage);

      await tick();

      expect(onAwareness).toHaveBeenCalledWith(expect.any(Buffer));
      expect(onUpdate).not.toHaveBeenCalled();
    });

    test('routes update messages to correct handler', async () => {
      await redisPubSub.init();

      const onAwareness = jest.fn();
      const onUpdate = jest.fn();

      redisPubSub.subscribeToDocument('doc-123', { onAwareness, onUpdate });
      await tick();

      // Simulate receiving a message from Redis
      const subscriber = MockRedis.instances[0];
      const testMessage = Buffer.from([4, 5, 6]);
      subscriber.emit('message', 'updates:doc-123', testMessage);

      await tick();

      expect(onUpdate).toHaveBeenCalledWith(expect.any(Buffer));
      expect(onAwareness).not.toHaveBeenCalled();
    });

    test('ignores messages for unsubscribed documents', async () => {
      await redisPubSub.init();

      const onAwareness = jest.fn();
      const onUpdate = jest.fn();

      redisPubSub.subscribeToDocument('doc-123', { onAwareness, onUpdate });
      await tick();

      // Simulate receiving a message for different document
      const subscriber = MockRedis.instances[0];
      subscriber.emit('message', 'awareness:doc-456', Buffer.from([1, 2, 3]));

      await tick();

      expect(onAwareness).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });
  });

  describe('isSubscribed', () => {
    test('returns true for subscribed documents', async () => {
      await redisPubSub.init();

      redisPubSub.subscribeToDocument('doc-123', {
        onAwareness: jest.fn(),
        onUpdate: jest.fn(),
      });

      expect(redisPubSub.isSubscribed('doc-123')).toBe(true);
    });

    test('returns false for non-subscribed documents', async () => {
      await redisPubSub.init();

      expect(redisPubSub.isSubscribed('doc-123')).toBe(false);
    });
  });

  describe('cleanup', () => {
    test('unsubscribes from all documents and closes clients', async () => {
      await redisPubSub.init();

      redisPubSub.subscribeToDocument('doc-1', {
        onAwareness: jest.fn(),
        onUpdate: jest.fn(),
      });
      redisPubSub.subscribeToDocument('doc-2', {
        onAwareness: jest.fn(),
        onUpdate: jest.fn(),
      });

      await redisPubSub.cleanup();

      expect(redisPubSub.getSubscriptionCount()).toBe(0);
      expect(redisPubSub.isEnabled()).toBe(false);
    });
  });

  describe('cross-instance communication', () => {
    test('messages published by one instance are received by subscribers', async () => {
      // This simulates two server instances sharing Redis
      await redisPubSub.init();

      const receivedMessages = [];
      redisPubSub.subscribeToDocument('doc-123', {
        onAwareness: (buffer) => receivedMessages.push({ type: 'awareness', buffer }),
        onUpdate: (buffer) => receivedMessages.push({ type: 'update', buffer }),
      });
      await tick();

      // Simulate another instance publishing (via the same mock Redis)
      const publisher = MockRedis.instances[1];
      publisher.publish('awareness:doc-123', Buffer.from('test-awareness'));
      publisher.publish('updates:doc-123', Buffer.from('test-update'));

      await tick(100);

      // The subscriber should receive messages from the "other instance"
      expect(receivedMessages.length).toBe(2);
      expect(receivedMessages[0].type).toBe('awareness');
      expect(receivedMessages[1].type).toBe('update');
    });
  });
});
