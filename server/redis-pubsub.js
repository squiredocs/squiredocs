/**
 * Redis Pub/Sub Manager for Cross-Instance State Synchronization
 *
 * Provides real-time synchronization of Yjs document updates and awareness
 * (user presence/cursors) across multiple server instances via Redis pub/sub.
 *
 * Architecture:
 * - Each server instance subscribes to channels for documents it has open
 * - When local changes occur, they are published to Redis
 * - Other instances receive and apply the changes
 * - Origin tracking prevents feedback loops
 */

const { createPubSubClient, isRedisEnabled } = require('./redis');

// Channel prefixes
const AWARENESS_PREFIX = 'awareness:';
const UPDATES_PREFIX = 'updates:';

// Separate Redis clients for pub/sub (required by Redis - can't mix pub/sub with commands)
let subscriberClient = null;
let publisherClient = null;

// Track subscribed documents: docId -> { awarenessHandler, updateHandler }
const documentSubscriptions = new Map();

// Track initialization state
let initialized = false;

/**
 * Initialize Redis pub/sub clients
 * Call this once when the server starts
 */
async function init() {
  if (!isRedisEnabled()) {
    console.log('[RedisPubSub] Redis not enabled, skipping initialization');
    return;
  }

  if (initialized) {
    console.log('[RedisPubSub] Already initialized');
    return;
  }

  console.log('[RedisPubSub] Initializing pub/sub clients...');

  subscriberClient = createPubSubClient();
  publisherClient = createPubSubClient();

  if (!subscriberClient || !publisherClient) {
    console.error('[RedisPubSub] Failed to create Redis clients');
    return;
  }

  // Handle incoming messages from Redis
  subscriberClient.on('message', (channel, message) => {
    try {
      const buffer = Buffer.from(message, 'binary');

      // Route to appropriate handler based on channel prefix
      if (channel.startsWith(AWARENESS_PREFIX)) {
        const docId = channel.slice(AWARENESS_PREFIX.length);
        const sub = documentSubscriptions.get(docId);
        if (sub?.awarenessHandler) {
          sub.awarenessHandler(buffer);
        }
      } else if (channel.startsWith(UPDATES_PREFIX)) {
        const docId = channel.slice(UPDATES_PREFIX.length);
        const sub = documentSubscriptions.get(docId);
        if (sub?.updateHandler) {
          sub.updateHandler(buffer);
        }
      }
    } catch (err) {
      console.error('[RedisPubSub] Error handling message:', err.message);
    }
  });

  // Wait for both clients to be ready
  await Promise.all([
    new Promise((resolve) => {
      if (subscriberClient.status === 'ready') {
        resolve();
      } else {
        subscriberClient.once('ready', resolve);
      }
    }),
    new Promise((resolve) => {
      if (publisherClient.status === 'ready') {
        resolve();
      } else {
        publisherClient.once('ready', resolve);
      }
    }),
  ]);

  initialized = true;
  console.log('[RedisPubSub] Initialized successfully');
}

/**
 * Check if pub/sub is enabled and ready
 * @returns {boolean}
 */
function isEnabled() {
  return initialized && isRedisEnabled();
}

/**
 * Subscribe to Redis channels for a document
 * @param {string} docId - Document ID
 * @param {Object} handlers - Message handlers
 * @param {Function} handlers.onAwareness - Handler for awareness updates
 * @param {Function} handlers.onUpdate - Handler for document updates
 */
function subscribeToDocument(docId, { onAwareness, onUpdate }) {
  if (!isEnabled()) {
    return;
  }

  // Don't duplicate subscriptions
  if (documentSubscriptions.has(docId)) {
    console.log(`[RedisPubSub] Already subscribed to doc ${docId}`);
    return;
  }

  console.log(`[RedisPubSub] Subscribing to doc ${docId}`);

  documentSubscriptions.set(docId, {
    awarenessHandler: onAwareness,
    updateHandler: onUpdate,
  });

  // Subscribe to both channels
  subscriberClient.subscribe(AWARENESS_PREFIX + docId);
  subscriberClient.subscribe(UPDATES_PREFIX + docId);
}

/**
 * Unsubscribe from Redis channels for a document
 * @param {string} docId - Document ID
 */
function unsubscribeFromDocument(docId) {
  if (!documentSubscriptions.has(docId)) {
    return;
  }

  console.log(`[RedisPubSub] Unsubscribing from doc ${docId}`);

  subscriberClient?.unsubscribe(AWARENESS_PREFIX + docId);
  subscriberClient?.unsubscribe(UPDATES_PREFIX + docId);
  documentSubscriptions.delete(docId);
}

/**
 * Publish an awareness update to Redis
 * @param {string} docId - Document ID
 * @param {Uint8Array|Buffer} update - Encoded awareness update
 */
function publishAwareness(docId, update) {
  if (!isEnabled()) {
    return;
  }

  try {
    publisherClient.publish(AWARENESS_PREFIX + docId, Buffer.from(update));
  } catch (err) {
    console.error(`[RedisPubSub] Error publishing awareness for ${docId}:`, err.message);
  }
}

/**
 * Publish a document update to Redis
 * @param {string} docId - Document ID
 * @param {Uint8Array|Buffer} update - Encoded Yjs update
 */
function publishUpdate(docId, update) {
  if (!isEnabled()) {
    return;
  }

  try {
    publisherClient.publish(UPDATES_PREFIX + docId, Buffer.from(update));
  } catch (err) {
    console.error(`[RedisPubSub] Error publishing update for ${docId}:`, err.message);
  }
}

/**
 * Get the number of active document subscriptions
 * @returns {number}
 */
function getSubscriptionCount() {
  return documentSubscriptions.size;
}

/**
 * Check if a document is currently subscribed
 * @param {string} docId - Document ID
 * @returns {boolean}
 */
function isSubscribed(docId) {
  return documentSubscriptions.has(docId);
}

/**
 * Cleanup all subscriptions and close connections
 */
async function cleanup() {
  console.log('[RedisPubSub] Cleaning up...');

  // Unsubscribe from all documents
  for (const docId of documentSubscriptions.keys()) {
    unsubscribeFromDocument(docId);
  }

  // Close clients
  if (subscriberClient) {
    await subscriberClient.quit().catch(() => {});
    subscriberClient = null;
  }

  if (publisherClient) {
    await publisherClient.quit().catch(() => {});
    publisherClient = null;
  }

  initialized = false;
  console.log('[RedisPubSub] Cleanup complete');
}

module.exports = {
  init,
  isEnabled,
  subscribeToDocument,
  unsubscribeFromDocument,
  publishAwareness,
  publishUpdate,
  getSubscriptionCount,
  isSubscribed,
  cleanup,
  // Expose for testing
  _reset: () => {
    documentSubscriptions.clear();
    initialized = false;
    subscriberClient = null;
    publisherClient = null;
  },
};
