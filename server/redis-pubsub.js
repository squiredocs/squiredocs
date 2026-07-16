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

const crypto = require('crypto');
const { createPubSubClient, isRedisEnabled } = require('./redis');
const { withSpan } = require('./telemetry/spans');

// Unique identifier for this server instance (prevents processing own messages)
const INSTANCE_ID = crypto.randomUUID();

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

// Track warning state to avoid spamming logs
let disabledWarningLogged = false;
let disabledWarningInterval = null;

/**
 * Resolve once an ioredis client reaches 'ready' (or immediately if it already
 * has). Never rejects — a client that never connects simply never resolves, so
 * callers MUST bound this with a timeout (see init()).
 * @param {object} client - ioredis client
 * @returns {Promise<void>}
 */
function whenReady(client) {
  return new Promise((resolve) => {
    if (client.status === 'ready') {
      resolve();
    } else {
      client.once('ready', resolve);
    }
  });
}

/**
 * Encode a message with instance ID prefix
 * Format: [36-byte UUID]:[data]
 * @param {Buffer|Uint8Array} data - The message data
 * @param {string} [instanceId] - Optional instance ID (defaults to this server's ID)
 */
function encodeMessage(data, instanceId = INSTANCE_ID) {
  const prefix = Buffer.from(instanceId + ':');
  return Buffer.concat([prefix, Buffer.from(data)]);
}

/**
 * Decode a message, extracting instance ID and data
 * @returns {{ instanceId: string, data: Buffer } | null}
 */
function decodeMessage(buffer) {
  // UUID is 36 chars + 1 colon = 37 bytes prefix
  if (buffer.length < 37) {
    return null;
  }
  const instanceId = buffer.slice(0, 36).toString();
  const data = buffer.slice(37);
  return { instanceId, data };
}

/**
 * Initialize Redis pub/sub clients
 * Call this once when the server starts
 */
async function init() {
  if (!isRedisEnabled()) {
    console.warn('');
    console.warn('╔══════════════════════════════════════════════════════════════════════════════╗');
    console.warn('║  ⚠️  WARNING: REDIS PUB/SUB DISABLED - CROSS-INSTANCE SYNC NOT AVAILABLE ⚠️   ║');
    console.warn('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.warn('║  REDIS_HOST environment variable is not set.                                 ║');
    console.warn('║                                                                              ║');
    console.warn('║  CONSEQUENCES:                                                               ║');
    console.warn('║  • User presence/cursors will NOT sync across server instances               ║');
    console.warn('║  • Document edits will NOT propagate in real-time across instances           ║');
    console.warn('║  • Users on different servers will see stale/inconsistent data               ║');
    console.warn('║                                                                              ║');
    console.warn('║  TO FIX: Set REDIS_HOST environment variable (e.g., REDIS_HOST=localhost)    ║');
    console.warn('╚══════════════════════════════════════════════════════════════════════════════╝');
    console.warn('');

    // Log periodic reminders every 5 minutes while disabled
    if (!disabledWarningInterval) {
      disabledWarningInterval = setInterval(() => {
        console.warn('[RedisPubSub] ⚠️  REMINDER: Cross-instance sync DISABLED - REDIS_HOST not configured. User presence and edits will NOT sync between server instances.');
      }, 5 * 60 * 1000);
      disabledWarningInterval.unref(); // Don't prevent process exit
    }

    return;
  }

  if (initialized) {
    console.log('[RedisPubSub] Already initialized');
    return;
  }

  console.log('[RedisPubSub] Initializing pub/sub clients for cross-instance sync...');

  subscriberClient = createPubSubClient();
  publisherClient = createPubSubClient();

  if (!subscriberClient || !publisherClient) {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════════════════════════════╗');
    console.error('║  ❌ ERROR: FAILED TO CREATE REDIS PUB/SUB CLIENTS                            ║');
    console.error('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.error('║  Cross-instance synchronization will NOT work.                               ║');
    console.error('║  User presence and document edits will NOT sync between server instances.    ║');
    console.error('╚══════════════════════════════════════════════════════════════════════════════╝');
    console.error('');
    return;
  }

  // Handle incoming messages from Redis
  // Use messageBuffer to receive raw binary data without string conversion corruption
  subscriberClient.on('messageBuffer', (channelBuffer, message) => {
    try {
      const channel = channelBuffer.toString();

      // Decode message to extract instance ID
      const decoded = decodeMessage(message);
      if (!decoded) {
        console.warn('[RedisPubSub] Received malformed message (missing instance ID)');
        return;
      }

      // Ignore messages from self
      if (decoded.instanceId === INSTANCE_ID) {
        return;
      }

      // Route to appropriate handler based on channel prefix
      if (channel.startsWith(AWARENESS_PREFIX)) {
        const docId = channel.slice(AWARENESS_PREFIX.length);
        const sub = documentSubscriptions.get(docId);
        if (sub?.awarenessHandler) {
          sub.awarenessHandler(decoded.data);
        }
      } else if (channel.startsWith(UPDATES_PREFIX)) {
        const docId = channel.slice(UPDATES_PREFIX.length);
        const sub = documentSubscriptions.get(docId);
        if (sub?.updateHandler) {
          sub.updateHandler(decoded.data);
        }
      }
    } catch (err) {
      console.error('[RedisPubSub] Error handling message:', err.message);
    }
  });

  // Wait for both clients to be ready — but NEVER hang. If Redis is unreachable
  // or REDIS_PASSWORD mismatches, ioredis never emits 'ready', so a bare
  // once('ready') would block init() forever: lifecycle.markInitialized() would
  // never fire and GET /ready would return 503 forever, stalling the deploy.
  // Race the ready-wait against REDIS_INIT_TIMEOUT_MS and RESOLVE (not reject)
  // on timeout so init() completes and the app becomes ready. Readiness gates on
  // Postgres, not cache (RD-4); ioredis keeps retrying in the background and
  // pub/sub degrades gracefully until the clients connect (RD-3/RD-4).
  const initTimeoutMs = Number(process.env.REDIS_INIT_TIMEOUT_MS ?? 10000);
  const readyWait = Promise.all([whenReady(subscriberClient), whenReady(publisherClient)]);
  let initTimer;
  const timedOut = Symbol('redis-init-timeout');
  const timeout = new Promise((resolve) => {
    initTimer = setTimeout(() => resolve(timedOut), initTimeoutMs);
    if (typeof initTimer.unref === 'function') initTimer.unref();
  });
  const outcome = await Promise.race([readyWait.then(() => 'ready'), timeout]);
  clearTimeout(initTimer);
  if (outcome === timedOut) {
    console.warn(`[RedisPubSub] ⚠️  Redis clients not ready within ${initTimeoutMs}ms — continuing so the app can become ready. Cross-instance pub/sub is degraded and will connect in the background (RD-3/RD-4).`);
  }

  initialized = true;

  // Clear any disabled warning interval since we're now enabled
  if (disabledWarningInterval) {
    clearInterval(disabledWarningInterval);
    disabledWarningInterval = null;
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║  ✅ REDIS PUB/SUB INITIALIZED - CROSS-INSTANCE SYNC ENABLED                  ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  console.log('║  User presence and document edits will sync across all server instances.     ║');
  console.log(`║  Instance ID: ${INSTANCE_ID}                             ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
  console.log('');
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
 * @returns {Promise<void>} Resolves when subscriptions are active
 */
async function subscribeToDocument(docId, { onAwareness, onUpdate }) {
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

  // Subscribe to both channels and wait for confirmation
  await Promise.all([
    subscriberClient.subscribe(AWARENESS_PREFIX + docId),
    subscriberClient.subscribe(UPDATES_PREFIX + docId),
  ]);
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

  // Operation-level manual span (feature 014, FR-004/RBD-1): one span per pub/sub
  // propagation op — NOT per CRDT message. Attributes are identifiers only.
  // Return the ioredis publish promise from the wrapped fn so withSpan's promise
  // branch classifies a publish failure as outcome=error (rather than always
  // seeing success). The .catch keeps the existing log-and-swallow behavior so a
  // publish failure never crashes the app and never becomes an unhandled rejection.
  withSpan('collab.operation', { 'document.guid': docId, 'collab.operation': 'pubsub.awareness' }, () =>
    publisherClient.publish(AWARENESS_PREFIX + docId, encodeMessage(update))
  ).catch((err) => {
    console.error(`[RedisPubSub] Error publishing awareness for ${docId}:`, err.message);
  });
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

  // Operation-level manual span (feature 014, FR-004/RBD-1): one span per pub/sub
  // propagation op — NOT per CRDT message. Attributes are identifiers only; the
  // update bytes NEVER become an attribute.
  // Return the ioredis publish promise from the wrapped fn so withSpan's promise
  // branch classifies a publish failure as outcome=error. The .catch keeps the
  // existing log-and-swallow behavior (no crash, no unhandled rejection).
  withSpan('collab.operation', { 'document.guid': docId, 'collab.operation': 'pubsub.update' }, () =>
    publisherClient.publish(UPDATES_PREFIX + docId, encodeMessage(update))
  ).catch((err) => {
    console.error(`[RedisPubSub] Error publishing update for ${docId}:`, err.message);
  });
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

  // Clear warning interval
  if (disabledWarningInterval) {
    clearInterval(disabledWarningInterval);
    disabledWarningInterval = null;
  }

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
  disabledWarningLogged = false;
  console.log('[RedisPubSub] Cleanup complete');
}

/**
 * Get the unique instance ID for this server
 * @returns {string}
 */
function getInstanceId() {
  return INSTANCE_ID;
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
  getInstanceId,
  // Expose encode/decode for testing and potential external use
  encodeMessage,
  decodeMessage,
  // Expose for testing
  _reset: async () => {
    // Unsubscribe from all documents
    for (const docId of documentSubscriptions.keys()) {
      unsubscribeFromDocument(docId);
    }
    documentSubscriptions.clear();

    // Close existing clients to avoid zombie connections
    if (subscriberClient) {
      await subscriberClient.quit().catch(() => {});
      subscriberClient = null;
    }
    if (publisherClient) {
      await publisherClient.quit().catch(() => {});
      publisherClient = null;
    }

    initialized = false;
    disabledWarningLogged = false;
    if (disabledWarningInterval) {
      clearInterval(disabledWarningInterval);
      disabledWarningInterval = null;
    }
  },
};
