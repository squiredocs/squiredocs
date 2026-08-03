/**
 * Integration tests for Redis Pub/Sub Cross-Instance Synchronization
 *
 * These tests verify that awareness and document updates propagate correctly
 * via Redis pub/sub. Since we can't easily simulate multiple server instances
 * in a single process, these tests verify the core pub/sub behavior:
 * - Messages published to Redis are received by subscribers
 * - Yjs documents sync correctly through the pub/sub mechanism
 * - Feedback loops are prevented via origin tracking
 */

const Y = require('yjs');
const awarenessProtocol = require('y-protocols/dist/awareness.cjs');
const EventEmitter = require('events');
const crypto = require('crypto');

// Shared message bus to simulate Redis pub/sub across "instances"
const sharedMessageBus = new EventEmitter();

// Mock Redis with full pub/sub simulation via shared message bus
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

    // Listen to shared message bus for cross-instance messages
    this._busHandler = (channel, message, sender) => {
      // Don't receive messages from self
      if (sender !== this && this.subscriptions.has(channel)) {
        // Use messageBuffer event with Buffer arguments for binary data (ioredis behavior)
        const channelBuffer = Buffer.isBuffer(channel) ? channel : Buffer.from(channel);
        const messageBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
        setImmediate(() => this.emit('messageBuffer', channelBuffer, messageBuffer));
      }
    };
    sharedMessageBus.on('publish', this._busHandler);
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
    // Broadcast to shared bus (other instances will receive via _busHandler)
    sharedMessageBus.emit('publish', channel, message, this);
    return Promise.resolve(1);
  }

  quit() {
    sharedMessageBus.off('publish', this._busHandler);
    this.status = 'end';
    return Promise.resolve('OK');
  }

  static instances = [];
  static reset() {
    MockRedis.instances.forEach((instance) => {
      sharedMessageBus.off('publish', instance._busHandler);
    });
    MockRedis.instances = [];
    sharedMessageBus.removeAllListeners();
  }
}

// Mock the redis module
jest.mock('../../server/redis', () => {
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

const redisPubSub = require('../../server/redis-pubsub');
const redisMock = require('../../server/redis');

// Origin marker for Redis updates (same as in server/index.js)
const ORIGIN_REDIS = 'redis';

// Helper to wait for async operations
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

/**
 * Creates a test document that syncs via Redis
 * Each "instance" simulates a separate server's view of a document
 */
function createSyncedDoc(docId, instanceName) {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);

  // Track received updates for testing
  const receivedUpdates = [];
  const receivedAwareness = [];

  // Create dedicated Redis clients for this "instance"
  const subClient = new MockRedis();
  const pubClient = new MockRedis();

  // Subscribe to channels
  subClient.subscribe(`awareness:${docId}`);
  subClient.subscribe(`updates:${docId}`);

  // Handle incoming messages (use messageBuffer for binary data like real ioredis)
  subClient.on('messageBuffer', (channelBuffer, messageBuffer) => {
    const channel = channelBuffer.toString();
    const buffer = Buffer.isBuffer(messageBuffer) ? messageBuffer : Buffer.from(messageBuffer);

    if (channel === `awareness:${docId}`) {
      receivedAwareness.push(buffer);
      try {
        awarenessProtocol.applyAwarenessUpdate(
          awareness,
          new Uint8Array(buffer),
          ORIGIN_REDIS
        );
      } catch (err) {
        console.error(`[${instanceName}] Error applying awareness:`, err.message);
      }
    } else if (channel === `updates:${docId}`) {
      receivedUpdates.push(buffer);
      try {
        Y.applyUpdate(ydoc, new Uint8Array(buffer), ORIGIN_REDIS);
      } catch (err) {
        console.error(`[${instanceName}] Error applying update:`, err.message);
      }
    }
  });

  // Publish local awareness changes
  awareness.on('update', ({ added, updated }, origin) => {
    if (origin === ORIGIN_REDIS) return;

    const changedClients = added.concat(updated);
    if (changedClients.length > 0) {
      const update = awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients);
      pubClient.publish(`awareness:${docId}`, Buffer.from(update));
    }
  });

  // Publish local document updates
  ydoc.on('update', (update, origin) => {
    if (origin === ORIGIN_REDIS) return;
    pubClient.publish(`updates:${docId}`, Buffer.from(update));
  });

  return {
    ydoc,
    awareness,
    receivedUpdates,
    receivedAwareness,
    cleanup: () => {
      subClient.quit();
      pubClient.quit();
    },
  };
}

describe('Redis Cross-Instance Synchronization', () => {
  beforeEach(async () => {
    MockRedis.reset();
    redisMock.__reset();
    await redisPubSub._reset();
  });

  afterEach(async () => {
    MockRedis.reset();
  });

  describe('Awareness Synchronization', () => {
    test('user presence propagates between instances', async () => {
      const docId = 'test-doc-' + Date.now();

      const instance1 = createSyncedDoc(docId, 'Instance1');
      const instance2 = createSyncedDoc(docId, 'Instance2');

      await tick();

      // Set user awareness on instance 1
      instance1.awareness.setLocalStateField('user', {
        name: 'User 1',
        color: '#ff0000',
      });

      await tick(100);

      // Verify instance 2 received the awareness update
      expect(instance2.receivedAwareness.length).toBeGreaterThan(0);

      const states = Array.from(instance2.awareness.getStates().values());
      const user1State = states.find((s) => s.user?.name === 'User 1');

      expect(user1State).toBeDefined();
      expect(user1State.user.color).toBe('#ff0000');

      instance1.cleanup();
      instance2.cleanup();
    });

    test('cursor positions sync between instances', async () => {
      const docId = 'test-doc-cursor-' + Date.now();

      const instance1 = createSyncedDoc(docId, 'Instance1');
      const instance2 = createSyncedDoc(docId, 'Instance2');

      await tick();

      // Set cursor position on instance 1
      instance1.awareness.setLocalStateField('cursor', {
        index: 42,
        length: 5,
      });

      await tick(100);

      // Verify instance 2 received the cursor
      const states = Array.from(instance2.awareness.getStates().values());
      const cursorState = states.find((s) => s.cursor?.index === 42);

      expect(cursorState).toBeDefined();
      expect(cursorState.cursor.length).toBe(5);

      instance1.cleanup();
      instance2.cleanup();
    });

    test('multiple users appear on all instances', async () => {
      const docId = 'test-doc-multi-' + Date.now();

      const instance1 = createSyncedDoc(docId, 'Instance1');
      const instance2 = createSyncedDoc(docId, 'Instance2');
      const instance3 = createSyncedDoc(docId, 'Instance3');

      await tick();

      // Each instance sets a different user
      instance1.awareness.setLocalStateField('user', { name: 'Alice' });
      instance2.awareness.setLocalStateField('user', { name: 'Bob' });
      instance3.awareness.setLocalStateField('user', { name: 'Charlie' });

      await tick(200);

      // Each instance should see all three users
      const getNames = (instance) =>
        Array.from(instance.awareness.getStates().values())
          .map((s) => s.user?.name)
          .filter(Boolean)
          .sort();

      expect(getNames(instance1)).toEqual(['Alice', 'Bob', 'Charlie']);
      expect(getNames(instance2)).toEqual(['Alice', 'Bob', 'Charlie']);
      expect(getNames(instance3)).toEqual(['Alice', 'Bob', 'Charlie']);

      instance1.cleanup();
      instance2.cleanup();
      instance3.cleanup();
    });
  });

  describe('Document Update Synchronization', () => {
    test('text edits propagate between instances', async () => {
      const docId = 'test-doc-edit-' + Date.now();

      const instance1 = createSyncedDoc(docId, 'Instance1');
      const instance2 = createSyncedDoc(docId, 'Instance2');

      await tick();

      // Make edit on instance 1
      instance1.ydoc.getText('content').insert(0, 'Hello World');

      await tick(100);

      // Verify instance 2 received the update
      expect(instance2.receivedUpdates.length).toBeGreaterThan(0);
      expect(instance2.ydoc.getText('content').toString()).toBe('Hello World');

      instance1.cleanup();
      instance2.cleanup();
    });

    test('sequential edits maintain order', async () => {
      const docId = 'test-doc-seq-' + Date.now();

      const instance1 = createSyncedDoc(docId, 'Instance1');
      const instance2 = createSyncedDoc(docId, 'Instance2');

      await tick();

      // Sequential edits on instance 1
      instance1.ydoc.getText('content').insert(0, 'First');
      await tick(50);
      instance1.ydoc.getText('content').insert(5, ' Second');
      await tick(50);
      instance1.ydoc.getText('content').insert(12, ' Third');

      await tick(100);

      // Verify instance 2 has all edits in order
      expect(instance2.ydoc.getText('content').toString()).toBe('First Second Third');

      instance1.cleanup();
      instance2.cleanup();
    });

    test('concurrent edits merge correctly (CRDT)', async () => {
      const docId = 'test-doc-concurrent-' + Date.now();

      const instance1 = createSyncedDoc(docId, 'Instance1');
      const instance2 = createSyncedDoc(docId, 'Instance2');

      await tick();

      // Concurrent edits at the same position
      instance1.ydoc.getText('content').insert(0, 'A');
      instance2.ydoc.getText('content').insert(0, 'B');

      await tick(200);

      // Both should converge to the same content
      const content1 = instance1.ydoc.getText('content').toString();
      const content2 = instance2.ydoc.getText('content').toString();

      expect(content1).toBe(content2);
      expect(content1.length).toBe(2);
      expect(content1).toMatch(/^(AB|BA)$/);

      instance1.cleanup();
      instance2.cleanup();
    });

    test('map operations sync correctly', async () => {
      const docId = 'test-doc-map-' + Date.now();

      const instance1 = createSyncedDoc(docId, 'Instance1');
      const instance2 = createSyncedDoc(docId, 'Instance2');

      await tick();

      // Set map values on instance 1
      const meta1 = instance1.ydoc.getMap('meta');
      meta1.set('title', 'Test Document');
      meta1.set('version', 1);

      await tick(100);

      // Verify instance 2 has the map values
      const meta2 = instance2.ydoc.getMap('meta');
      expect(meta2.get('title')).toBe('Test Document');
      expect(meta2.get('version')).toBe(1);

      instance1.cleanup();
      instance2.cleanup();
    });
  });

  describe('Feedback Loop Prevention', () => {
    test('updates with ORIGIN_REDIS are not re-published', async () => {
      const docId = 'test-doc-loop-' + Date.now();

      const instance1 = createSyncedDoc(docId, 'Instance1');
      const instance2 = createSyncedDoc(docId, 'Instance2');

      await tick();

      // Get the initial publish count
      const publisher = MockRedis.instances.find(
        (i) => i.published.some((p) => p.channel.includes(docId))
      );

      // Make edit on instance 1
      instance1.ydoc.getText('content').insert(0, 'Test');
      await tick(50);

      // Count updates published to this doc's channel
      const getUpdateCount = () =>
        MockRedis.instances.reduce(
          (count, i) =>
            count + i.published.filter((p) => p.channel === `updates:${docId}`).length,
          0
        );

      const countAfterFirstEdit = getUpdateCount();

      // Wait for round-trip
      await tick(200);

      const countAfterRoundTrip = getUpdateCount();

      // Instance 2 should NOT have re-published the update it received
      // (only the original update from instance 1 should be published)
      expect(countAfterRoundTrip).toBe(countAfterFirstEdit);

      instance1.cleanup();
      instance2.cleanup();
    });
  });

  describe('Bidirectional Sync', () => {
    test('both instances can send and receive updates', async () => {
      const docId = 'test-doc-bidir-' + Date.now();

      const instance1 = createSyncedDoc(docId, 'Instance1');
      const instance2 = createSyncedDoc(docId, 'Instance2');

      await tick();

      // Instance 1 makes first edit
      instance1.ydoc.getText('content').insert(0, 'From1');
      await tick(100);

      expect(instance2.ydoc.getText('content').toString()).toBe('From1');

      // Instance 2 makes second edit
      instance2.ydoc.getText('content').insert(5, '-From2');
      await tick(100);

      // Both should have both edits
      expect(instance1.ydoc.getText('content').toString()).toBe('From1-From2');
      expect(instance2.ydoc.getText('content').toString()).toBe('From1-From2');

      instance1.cleanup();
      instance2.cleanup();
    });
  });

  describe('Error Handling', () => {
    test('malformed updates are handled gracefully', async () => {
      const docId = 'test-doc-error-' + Date.now();

      const instance1 = createSyncedDoc(docId, 'Instance1');

      await tick();

      // Get the subscriber client
      const subClient = MockRedis.instances.find((i) =>
        i.subscriptions.has(`updates:${docId}`)
      );

      // Simulate receiving malformed data (should not throw)
      expect(() => {
        subClient.emit('message', `updates:${docId}`, Buffer.from('invalid-yjs-data'));
      }).not.toThrow();

      await tick();

      instance1.cleanup();
    });
  });
});

describe('redisPubSub module', () => {
  beforeEach(async () => {
    MockRedis.reset();
    redisMock.__reset();
    redisPubSub._reset();
    await redisPubSub.init();
  });

  afterEach(async () => {
    await redisPubSub.cleanup();
  });

  test('publishes awareness to correct channel', async () => {
    const update = new Uint8Array([1, 2, 3]);

    redisPubSub.publishAwareness('doc-123', update);
    await tick();

    const publisher = MockRedis.instances.find((i) => i.published.length > 0);
    expect(publisher.published[0].channel).toBe('awareness:doc-123');
  });

  test('publishes updates to correct channel', async () => {
    const update = new Uint8Array([4, 5, 6]);

    redisPubSub.publishUpdate('doc-123', update);
    await tick();

    const publisher = MockRedis.instances.find((i) => i.published.length > 0);
    expect(publisher.published[0].channel).toBe('updates:doc-123');
  });

  test('subscribes to both channels for a document', async () => {
    redisPubSub.subscribeToDocument('doc-456', {
      onAwareness: jest.fn(),
      onUpdate: jest.fn(),
    });

    await tick();

    const subscriber = MockRedis.instances.find((i) => i.subscriptions.size > 0);
    expect(subscriber.subscriptions.has('awareness:doc-456')).toBe(true);
    expect(subscriber.subscriptions.has('updates:doc-456')).toBe(true);
  });

  // ── M3: the subscription must follow the LIVE document instance ────────────
  //
  // A document is rebuilt under the same id while the process runs: a refused
  // bind (feature 041) evicts and destroys it, its clients reconnect, and
  // y-websocket builds a fresh one. Handlers close over ONE doc instance, so a
  // duplicate subscribe that KEPT the old ones left the channels wired to the
  // dead doc while the live one — already flagged `_redisSyncInitialized` —
  // never re-subscribed. Reproduced against two real instances: that instance
  // silently stopped applying every other instance's edits, while still
  // publishing its own, so the divergence was one-way and invisible from the
  // editing side.

  /** Publish as if another instance had, so the routing is the real one. */
  const publishAsPeer = (channel, payload) => {
    const peer = new MockRedis();
    peer.publish(channel, redisPubSub.encodeMessage(payload, crypto.randomUUID()));
  };

  test('M3: a duplicate subscribe REBINDS the handlers to the newest document', async () => {
    const docId = 'doc-rebound';
    const deadDoc = { onAwareness: jest.fn(), onUpdate: jest.fn() };
    const liveDoc = { onAwareness: jest.fn(), onUpdate: jest.fn() };

    await redisPubSub.subscribeToDocument(docId, deadDoc);
    await redisPubSub.subscribeToDocument(docId, liveDoc);   // the rebuilt doc
    await tick();

    publishAsPeer(`updates:${docId}`, Buffer.from([1, 2, 3]));
    publishAsPeer(`awareness:${docId}`, Buffer.from([4, 5, 6]));
    await tick();

    expect(liveDoc.onUpdate).toHaveBeenCalledTimes(1);
    expect(liveDoc.onAwareness).toHaveBeenCalledTimes(1);
    // The evicted document must receive NOTHING: it is destroyed, and anything
    // applied to it is applied nowhere.
    expect(deadDoc.onUpdate).not.toHaveBeenCalled();
    expect(deadDoc.onAwareness).not.toHaveBeenCalled();
  });

  test('M3: rebinding does not disturb the channel subscriptions', async () => {
    const docId = 'doc-rebound-channels';
    await redisPubSub.subscribeToDocument(docId, { onAwareness: jest.fn(), onUpdate: jest.fn() });
    await redisPubSub.subscribeToDocument(docId, { onAwareness: jest.fn(), onUpdate: jest.fn() });
    await tick();

    const subscriber = MockRedis.instances.find((i) => i.subscriptions.has(`updates:${docId}`));
    expect(subscriber.subscriptions.has(`awareness:${docId}`)).toBe(true);
    expect(redisPubSub.isSubscribed(docId)).toBe(true);
  });

  // ── M4: the awareness ownership trailer ───────────────────────────────────

  test('M4: an awareness relay carries the publishing instance\'s owner map', async () => {
    const docId = 'doc-owners';
    const onAwareness = jest.fn();
    await redisPubSub.subscribeToDocument(docId, { onAwareness, onUpdate: jest.fn() });
    await tick();

    const peer = new MockRedis();
    const update = Buffer.from([9, 8, 7]);
    peer.publish(
      `awareness:${docId}`,
      Buffer.concat([
        Buffer.from(crypto.randomUUID() + ':'),
        redisPubSub.encodeAwarenessMessage(update, { 4242: 'u-alice' }).slice(37),
      ])
    );
    await tick();

    const [receivedUpdate, owners] = onAwareness.mock.calls[0];
    expect(Buffer.from(receivedUpdate)).toEqual(update);   // the bytes are untouched
    expect(owners).toEqual({ 4242: 'u-alice' });
  });

  test('M4: a relay with no trailer still arrives, with no owners (old instance)', async () => {
    const docId = 'doc-no-owners';
    const onAwareness = jest.fn();
    await redisPubSub.subscribeToDocument(docId, { onAwareness, onUpdate: jest.fn() });
    await tick();

    publishAsPeer(`awareness:${docId}`, Buffer.from([1, 1, 1]));
    await tick();

    const [receivedUpdate, owners] = onAwareness.mock.calls[0];
    expect(Buffer.from(receivedUpdate)).toEqual(Buffer.from([1, 1, 1]));
    expect(owners).toBe(null);
  });

  test('M4: an instance that knows nothing of the trailer still reads the awareness', async () => {
    // The rolling-deploy half of the contract, and the reason the owner map is
    // a TRAILER: `applyAwarenessUpdate` reads exactly the entries the update
    // declares and ignores whatever follows, so the previous build applies a
    // trailered message byte-identically.
    const source = new awarenessProtocol.Awareness(new Y.Doc());
    source.setLocalState({ user: { name: 'Alice' } });
    const update = awarenessProtocol.encodeAwarenessUpdate(source, [source.clientID]);

    const message = redisPubSub.encodeAwarenessMessage(update, { [source.clientID]: 'u-alice' });
    const oldReaderPayload = redisPubSub.decodeMessage(message).data;   // pre-M4 decoding

    const target = new awarenessProtocol.Awareness(new Y.Doc());
    awarenessProtocol.applyAwarenessUpdate(target, new Uint8Array(oldReaderPayload), ORIGIN_REDIS);
    expect(target.getStates().get(source.clientID)).toEqual({ user: { name: 'Alice' } });

    source.destroy();
    target.destroy();
  });

  test('M4: a payload that merely looks like a trailer is read as awareness bytes', () => {
    for (const payload of [
      Buffer.from('sqdOWNR1'),                                    // magic only
      Buffer.concat([Buffer.from([1, 2]), Buffer.from('sqdOWNR1')]), // no length
      Buffer.concat([                                              // absurd length
        Buffer.from([1, 2]), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('sqdOWNR1'),
      ]),
    ]) {
      expect(redisPubSub.splitAwarenessPayload(payload)).toEqual({ update: payload, owners: null });
    }
  });
});
