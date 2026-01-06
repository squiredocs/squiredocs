/**
 * Integration tests for Redis Pub/Sub with real Redis
 *
 * These tests reproduce the duplicate heading bug that occurs when:
 * 1. A server makes a change to a Y.Doc
 * 2. The change is published to Redis
 * 3. Redis echoes the change back to the same server
 * 4. The server applies the change again, creating duplicates
 *
 * To run these tests locally, you need Redis running:
 *   docker run -p 6379:6379 redis:7
 *
 * Or set REDIS_HOST=localhost in your environment.
 */

const Y = require('yjs');
const { isRedisEnabled } = require('../redis');
const redisPubSub = require('../redis-pubsub');

// Origin marker for Redis updates (same as in server/index.js)
const ORIGIN_REDIS = 'redis';

describe('Redis Pub/Sub Integration', () => {
  beforeAll(async () => {
    // Fail fast if Redis is not configured
    if (!isRedisEnabled()) {
      throw new Error(
        'Redis is not configured. Set REDIS_HOST environment variable.\n' +
        'For local development: docker run -p 6379:6379 redis:7\n' +
        'Then run: REDIS_HOST=localhost npm run test:server'
      );
    }

    // Initialize Redis pub/sub
    await redisPubSub.init();
  });

  afterAll(async () => {
    // Cleanup Redis connections
    await redisPubSub.cleanup();
  });

  afterEach(() => {
    // Reset subscriptions between tests
    redisPubSub._reset();
  });

  describe('duplicate update prevention', () => {
    test('applying same update twice should NOT create duplicates (Yjs idempotency)', async () => {
      // This test verifies basic Yjs idempotency - applying the same update twice
      // should result in the same document state
      const doc = new Y.Doc();
      const xmlFragment = doc.get('default', Y.XmlFragment);

      // Create a heading
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', 1);
      const text = new Y.XmlText();
      text.insert(0, 'Test Heading');
      heading.insert(0, [text]);

      // Capture the update
      let capturedUpdate = null;
      doc.on('update', (update) => {
        capturedUpdate = update;
      });

      // Insert the heading
      xmlFragment.insert(0, [heading]);

      expect(xmlFragment.toArray().length).toBe(1);

      // Apply the same update again - should be idempotent
      Y.applyUpdate(doc, capturedUpdate);

      // Should still have only 1 heading
      expect(xmlFragment.toArray().length).toBe(1);
    });

    test('REGRESSION: Redis pub/sub echo should NOT create duplicate blocks', async () => {
      // This is the actual bug we're trying to catch.
      // When we publish an update to Redis and it echoes back,
      // applying it should NOT create duplicates.

      const docId = `test-doc-${Date.now()}`;
      const doc = new Y.Doc();
      const xmlFragment = doc.get('default', Y.XmlFragment);

      // Track updates received from Redis
      const receivedUpdates = [];
      let resolveUpdateReceived;
      const updateReceivedPromise = new Promise((resolve) => {
        resolveUpdateReceived = resolve;
      });

      // Subscribe to Redis channel (simulating server setup)
      await redisPubSub.init();
      redisPubSub.subscribeToDocument(docId, {
        onAwareness: () => {},
        onUpdate: (buffer) => {
          receivedUpdates.push(buffer);

          // This is what the server does - apply the update from Redis
          const updateData = new Uint8Array(buffer);
          Y.applyUpdate(doc, updateData, ORIGIN_REDIS);

          resolveUpdateReceived();
        },
      });

      // Set up update handler to publish to Redis (simulating server behavior)
      doc.on('update', (update, origin) => {
        // Don't re-publish updates that came from Redis
        if (origin === ORIGIN_REDIS) {
          return;
        }
        // Publish to Redis
        redisPubSub.publishUpdate(docId, update);
      });

      // Create and insert a heading (this triggers the bug flow)
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', 1);
      const text = new Y.XmlText();
      text.insert(0, 'My Heading');
      heading.insert(0, [text]);
      xmlFragment.insert(0, [heading]);

      // Verify we have 1 heading initially
      expect(xmlFragment.toArray().length).toBe(1);

      // Wait for Redis to echo the update back
      await updateReceivedPromise;

      // Allow a small delay for any additional processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // THE BUG: This would fail with 2 headings if the bug exists
      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(1);
      expect(blocks[0].nodeName).toBe('heading');
      expect(blocks[0].getAttribute('level')).toBe(1);

      // Cleanup
      redisPubSub.unsubscribeFromDocument(docId);
    });

    test('REGRESSION: multiple sequential edits should not multiply blocks', async () => {
      const docId = `test-doc-multi-${Date.now()}`;
      const doc = new Y.Doc();
      const xmlFragment = doc.get('default', Y.XmlFragment);

      // Track received updates with a timeout fallback
      let updateCount = 0;
      let resolveAllUpdates;
      const allUpdatesPromise = new Promise((resolve) => {
        resolveAllUpdates = resolve;
        // Fallback timeout - resolve after 500ms even if not all updates received
        setTimeout(resolve, 500);
      });

      await redisPubSub.init();
      redisPubSub.subscribeToDocument(docId, {
        onAwareness: () => {},
        onUpdate: (buffer) => {
          Y.applyUpdate(doc, new Uint8Array(buffer), ORIGIN_REDIS);
          updateCount++;
          resolveAllUpdates();
        },
      });

      doc.on('update', (update, origin) => {
        if (origin === ORIGIN_REDIS) return;
        redisPubSub.publishUpdate(docId, update);
      });

      // Add 3 paragraphs sequentially
      for (let i = 0; i < 3; i++) {
        const para = new Y.XmlElement('paragraph');
        const text = new Y.XmlText();
        text.insert(0, `Paragraph ${i + 1}`);
        para.insert(0, [text]);
        xmlFragment.insert(i, [para]);
      }

      expect(xmlFragment.toArray().length).toBe(3);

      // Wait for all Redis echoes
      await allUpdatesPromise;
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should still have exactly 3 paragraphs
      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(3);

      redisPubSub.unsubscribeFromDocument(docId);
    });

    test('updates from different client IDs should be applied', async () => {
      // This test verifies that legitimate updates from OTHER servers
      // (different client IDs) are properly applied

      const docId = `test-doc-different-${Date.now()}`;

      // Simulate two different server instances with different Y.Docs
      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();

      const xmlFragment1 = doc1.get('default', Y.XmlFragment);
      const xmlFragment2 = doc2.get('default', Y.XmlFragment);

      let resolveDoc2Update;
      const doc2UpdatePromise = new Promise((resolve) => {
        resolveDoc2Update = resolve;
        // Timeout fallback
        setTimeout(resolve, 500);
      });

      await redisPubSub.init();

      // Doc2 subscribes to receive updates
      redisPubSub.subscribeToDocument(docId, {
        onAwareness: () => {},
        onUpdate: (buffer) => {
          Y.applyUpdate(doc2, new Uint8Array(buffer), ORIGIN_REDIS);
          resolveDoc2Update();
        },
      });

      // Doc1 publishes updates
      doc1.on('update', (update, origin) => {
        if (origin === ORIGIN_REDIS) return;
        redisPubSub.publishUpdate(docId, update);
      });

      // Make change on doc1
      const heading = new Y.XmlElement('heading');
      const text = new Y.XmlText();
      text.insert(0, 'From Doc1');
      heading.insert(0, [text]);
      xmlFragment1.insert(0, [heading]);

      // Wait for doc2 to receive the update
      await doc2UpdatePromise;
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Doc2 should now have the heading
      expect(xmlFragment2.toArray().length).toBe(1);
      expect(xmlFragment2.get(0).nodeName).toBe('heading');

      redisPubSub.unsubscribeFromDocument(docId);
    });
  });
});
