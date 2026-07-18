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
    // Use messageBuffer event like real ioredis for binary data
    MockRedis.instances.forEach((instance) => {
      if (instance.subscriptions.has(channel) && instance !== this) {
        const channelBuffer = Buffer.from(channel);
        const messageBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
        setImmediate(() => instance.emit('messageBuffer', channelBuffer, messageBuffer));
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
  beforeEach(async () => {
    jest.clearAllMocks();
    MockRedis.reset();
    redisMock.__reset();
    await redisPubSub._reset();
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
    // Use a fake instance ID for simulating messages from other servers
    const OTHER_SERVER_ID = '00000000-0000-0000-0000-000000000000';

    test('routes awareness messages to correct handler', async () => {
      await redisPubSub.init();

      const onAwareness = jest.fn();
      const onUpdate = jest.fn();

      redisPubSub.subscribeToDocument('doc-123', { onAwareness, onUpdate });
      await tick();

      // Simulate receiving a message from another server
      const subscriber = MockRedis.instances[0];
      const testMessage = redisPubSub.encodeMessage(Buffer.from([1, 2, 3]), OTHER_SERVER_ID);
      subscriber.emit('messageBuffer', Buffer.from('awareness:doc-123'), testMessage);

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

      // Simulate receiving a message from another server
      const subscriber = MockRedis.instances[0];
      const testMessage = redisPubSub.encodeMessage(Buffer.from([4, 5, 6]), OTHER_SERVER_ID);
      subscriber.emit('messageBuffer', Buffer.from('updates:doc-123'), testMessage);

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
      subscriber.emit('messageBuffer', Buffer.from('awareness:doc-456'), Buffer.from([1, 2, 3]));

      await tick();

      expect(onAwareness).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });
  });

  describe('presence-claim channel (feature 015)', () => {
    const OTHER_SERVER_ID = '00000000-0000-0000-0000-000000000000';

    test('publishPresenceClaimTakeover publishes on presence-claim with instance-ID framing', async () => {
      await redisPubSub.init();

      redisPubSub.publishPresenceClaimTakeover('agent-presence:u1:default:doc-1');
      await tick();

      const publisher = MockRedis.instances[1];
      expect(publisher.published.length).toBe(1);
      expect(publisher.published[0].channel).toBe('presence-claim');

      const decoded = redisPubSub.decodeMessage(publisher.published[0].message);
      expect(decoded.instanceId).toBe(redisPubSub.getInstanceId());
      expect(JSON.parse(decoded.data.toString())).toEqual({
        claimKey: 'agent-presence:u1:default:doc-1',
      });
    });

    test('subscribed handler receives decoded { claimKey } from a foreign instance', async () => {
      await redisPubSub.init();

      const handler = jest.fn();
      redisPubSub.subscribeToPresenceClaims(handler);
      await tick();

      const subscriber = MockRedis.instances[0];
      expect(subscriber.subscriptions.has('presence-claim')).toBe(true);

      const message = redisPubSub.encodeMessage(
        Buffer.from(JSON.stringify({ claimKey: 'agent-presence:u1:default:doc-9' })),
        OTHER_SERVER_ID
      );
      subscriber.emit('messageBuffer', Buffer.from('presence-claim'), message);
      await tick();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ claimKey: 'agent-presence:u1:default:doc-9' });
    });

    test('self-messages are dropped', async () => {
      await redisPubSub.init();

      const handler = jest.fn();
      redisPubSub.subscribeToPresenceClaims(handler);
      await tick();

      const subscriber = MockRedis.instances[0];
      // Encoded with OUR instance ID (default) — must be filtered out
      const message = redisPubSub.encodeMessage(
        Buffer.from(JSON.stringify({ claimKey: 'agent-presence:u1:default:doc-9' }))
      );
      subscriber.emit('messageBuffer', Buffer.from('presence-claim'), message);
      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    test('malformed payloads are dropped without throwing', async () => {
      await redisPubSub.init();

      const handler = jest.fn();
      redisPubSub.subscribeToPresenceClaims(handler);
      await tick();

      const subscriber = MockRedis.instances[0];
      const malformed = redisPubSub.encodeMessage(Buffer.from('this is not json'), OTHER_SERVER_ID);
      expect(() => {
        subscriber.emit('messageBuffer', Buffer.from('presence-claim'), malformed);
      }).not.toThrow();
      await tick();

      expect(handler).not.toHaveBeenCalled();
    });

    test('handler registered BEFORE init() still receives nudges after init() completes', async () => {
      // Init-ordering rule (contract C): agentPresence.init runs before
      // redisPubSub.init(), so pre-init registrations must not be dropped.
      const handler = jest.fn();
      redisPubSub.subscribeToPresenceClaims(handler);

      // Not initialized yet: nothing subscribed, nothing delivered
      expect(MockRedis.instances.length).toBe(0);

      await redisPubSub.init();
      await tick();

      const subscriber = MockRedis.instances[0];
      expect(subscriber.subscriptions.has('presence-claim')).toBe(true);

      const message = redisPubSub.encodeMessage(
        Buffer.from(JSON.stringify({ claimKey: 'agent-presence:u2:default:doc-2' })),
        OTHER_SERVER_ID
      );
      subscriber.emit('messageBuffer', Buffer.from('presence-claim'), message);
      await tick();

      expect(handler).toHaveBeenCalledWith({ claimKey: 'agent-presence:u2:default:doc-2' });
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
    const OTHER_SERVER_ID = '00000000-0000-0000-0000-000000000000';

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
      publisher.publish('awareness:doc-123', redisPubSub.encodeMessage(Buffer.from('test-awareness'), OTHER_SERVER_ID));
      publisher.publish('updates:doc-123', redisPubSub.encodeMessage(Buffer.from('test-update'), OTHER_SERVER_ID));

      await tick(100);

      // The subscriber should receive messages from the "other instance"
      expect(receivedMessages.length).toBe(2);
      expect(receivedMessages[0].type).toBe('awareness');
      expect(receivedMessages[1].type).toBe('update');
    });

    test('messages from same instance are ignored', async () => {
      await redisPubSub.init();

      const receivedMessages = [];
      redisPubSub.subscribeToDocument('doc-123', {
        onAwareness: (buffer) => receivedMessages.push({ type: 'awareness', buffer }),
        onUpdate: (buffer) => receivedMessages.push({ type: 'update', buffer }),
      });
      await tick();

      // Simulate receiving our OWN message back (same instance ID)
      const subscriber = MockRedis.instances[0];
      subscriber.emit('messageBuffer', Buffer.from('awareness:doc-123'), redisPubSub.encodeMessage(Buffer.from('self-awareness')));
      subscriber.emit('messageBuffer', Buffer.from('updates:doc-123'), redisPubSub.encodeMessage(Buffer.from('self-update')));

      await tick(100);

      // Messages from self should be ignored
      expect(receivedMessages.length).toBe(0);
    });
  });
});
