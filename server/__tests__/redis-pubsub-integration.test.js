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

  afterEach(async () => {
    // Reset subscriptions and close clients between tests
    await redisPubSub._reset();
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
      // This test verifies that the instance ID filtering prevents
      // a server from processing its own updates echoed back from Redis.
      //
      // With the fix in place:
      // 1. Server publishes update with its instance ID
      // 2. Redis echoes it back
      // 3. Server ignores the echo (same instance ID)
      // 4. No duplicate blocks created

      const docId = `test-doc-${Date.now()}`;
      const doc = new Y.Doc();
      const xmlFragment = doc.get('default', Y.XmlFragment);

      // Track updates received from Redis (should be zero with the fix)
      const receivedUpdates = [];

      // Subscribe to Redis channel (simulating server setup)
      await redisPubSub.init();
      await redisPubSub.subscribeToDocument(docId, {
        onAwareness: () => {},
        onUpdate: (buffer) => {
          // With the fix, this should NOT be called for our own updates
          receivedUpdates.push(buffer);
          Y.applyUpdate(doc, new Uint8Array(buffer), ORIGIN_REDIS);
        },
      });

      // Set up update handler to publish to Redis (simulating server behavior)
      doc.on('update', (update, origin) => {
        if (origin === ORIGIN_REDIS) {
          return;
        }
        redisPubSub.publishUpdate(docId, update);
      });

      // Create and insert a heading
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', 1);
      const text = new Y.XmlText();
      text.insert(0, 'My Heading');
      heading.insert(0, [text]);
      xmlFragment.insert(0, [heading]);

      // Verify we have 1 heading initially
      expect(xmlFragment.toArray().length).toBe(1);

      // Wait for Redis round-trip (the echo will be filtered)
      await new Promise((resolve) => setTimeout(resolve, 200));

      // With the fix: no updates should have been received (filtered by instance ID)
      expect(receivedUpdates.length).toBe(0);

      // Document should still have exactly 1 heading (no duplicates)
      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(1);
      expect(blocks[0].nodeName).toBe('heading');
      expect(blocks[0].getAttribute('level')).toBe(1);

      // Cleanup
      redisPubSub.unsubscribeFromDocument(docId);
    });

    test('REGRESSION: multiple sequential edits should not multiply blocks', async () => {
      // Verifies that multiple edits don't cause duplicates even with
      // Redis pub/sub enabled. With instance ID filtering, our own
      // updates are ignored when echoed back.

      const docId = `test-doc-multi-${Date.now()}`;
      const doc = new Y.Doc();
      const xmlFragment = doc.get('default', Y.XmlFragment);

      // Track received updates (should be zero with the fix)
      let updateCount = 0;

      await redisPubSub.init();
      await redisPubSub.subscribeToDocument(docId, {
        onAwareness: () => {},
        onUpdate: (buffer) => {
          // With the fix, this should NOT be called for our own updates
          Y.applyUpdate(doc, new Uint8Array(buffer), ORIGIN_REDIS);
          updateCount++;
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

      // Wait for Redis round-trips (all echoes will be filtered)
      await new Promise((resolve) => setTimeout(resolve, 200));

      // No updates should have been received (all filtered by instance ID)
      expect(updateCount).toBe(0);

      // Should still have exactly 3 paragraphs (no duplicates)
      const blocks = xmlFragment.toArray();
      expect(blocks.length).toBe(3);

      redisPubSub.unsubscribeFromDocument(docId);
    });

    test('updates from different server instances are applied', async () => {
      // This test verifies that updates from OTHER servers (different
      // instance IDs) are properly applied. We simulate this by manually
      // publishing a message with a fake instance ID.

      const docId = `test-doc-cross-${Date.now()}`;
      const doc = new Y.Doc();
      const xmlFragment = doc.get('default', Y.XmlFragment);

      let receivedUpdate = false;
      let resolveUpdate;
      const updatePromise = new Promise((resolve) => {
        resolveUpdate = resolve;
        setTimeout(() => resolve(), 500); // Timeout fallback
      });

      await redisPubSub.init();

      // Subscribe to receive updates (await ensures subscription is active before publishing)
      await redisPubSub.subscribeToDocument(docId, {
        onAwareness: () => {},
        onUpdate: (buffer) => {
          // This should be called because the update has a different instance ID
          Y.applyUpdate(doc, new Uint8Array(buffer), ORIGIN_REDIS);
          receivedUpdate = true;
          resolveUpdate();
        },
      });

      // Create an update from a "different server"
      const otherDoc = new Y.Doc();
      const otherFragment = otherDoc.get('default', Y.XmlFragment);
      const heading = new Y.XmlElement('heading');
      const text = new Y.XmlText();
      text.insert(0, 'From Other Server');
      heading.insert(0, [text]);
      otherFragment.insert(0, [heading]);

      // Get the Yjs update
      const update = Y.encodeStateAsUpdate(otherDoc);

      // Manually publish with a DIFFERENT instance ID (simulating another server)
      // We need to access Redis directly to bypass our own instance ID encoding
      const { createPubSubClient } = require('../redis');
      const tempPublisher = createPubSubClient();

      await new Promise((resolve) => {
        if (tempPublisher.status === 'ready') resolve();
        else tempPublisher.once('ready', resolve);
      });

      // Publish with a fake instance ID using the exported encodeMessage function
      const OTHER_SERVER_ID = '00000000-0000-0000-0000-000000000000';
      tempPublisher.publish(`updates:${docId}`, redisPubSub.encodeMessage(update, OTHER_SERVER_ID));

      // Wait for the update to be received
      await updatePromise;

      // Cleanup temp publisher
      await tempPublisher.quit().catch(() => {});

      // The update from "another server" should have been applied
      expect(receivedUpdate).toBe(true);
      expect(xmlFragment.toArray().length).toBe(1);
      expect(xmlFragment.get(0).nodeName).toBe('heading');

      redisPubSub.unsubscribeFromDocument(docId);
    });
  });
});
