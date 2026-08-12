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

// Presence-claim takeover nudges (feature 015): one global channel — claim
// events are rare and tiny, so no per-doc suffix (research R5).
const PRESENCE_CLAIM_CHANNEL = 'presence-claim';

// Separate Redis clients for pub/sub (required by Redis - can't mix pub/sub with commands)
let subscriberClient = null;
let publisherClient = null;

// Track subscribed documents: docId -> { awarenessHandler, updateHandler }
const documentSubscriptions = new Map();

// Presence-claim nudge handlers. Handlers may be registered BEFORE init()
// (agent-presence initializes from server/mcp/tools/index.js well before
// redisPubSub.init() runs in the server.listen callback); registration only
// records the handler and init() issues the actual channel SUBSCRIBE.
const presenceClaimHandlers = [];
let presenceClaimSubscribed = false;

// Subscriber-ready handlers (feature 057, FR-005). Registered like the
// presence-claim handlers above — possibly before init() — and invoked every
// time the subscriber connection becomes usable, first connect included.
const subscriberReadyHandlers = [];
let subscriberReadyWired = false;

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
 * ── THE AWARENESS OWNERSHIP TRAILER (multi-replica review M4) ────────────────
 *
 * An awareness relay message tells the receiving instance WHICH clientIDs
 * changed, but not WHO they belong to — so `ws-awareness-guard` could only
 * record them under the `REMOTE_PRINCIPAL` placeholder, and a participant who
 * reconnected onto a DIFFERENT instance was then refused permission to speak as
 * their own clientID (reproduced: presence invisible for up to ~5.5 minutes per
 * cross-pod reconnect, with the legitimate user logged as a spoofer).
 *
 * The publishing instance DOES know: it authenticated that connection. So it
 * vouches for its own participants, in the same message, as an OPTIONAL TRAILER
 * appended after the awareness bytes:
 *
 *   [36-byte instance UUID][':'][awareness update][owners JSON][uint32BE len][MAGIC]
 *
 * WHY A TRAILER AND NOT A NEW ENVELOPE OR A SECOND CHANNEL:
 *  - `y-protocols`' `applyAwarenessUpdate` reads exactly the entry count the
 *    update declares and IGNORES anything after it (verified against
 *    y-protocols/dist/awareness.cjs). An instance running the previous build
 *    therefore keeps working byte-for-byte on these messages, which is what
 *    makes a rolling deploy of two replicas safe in BOTH directions: old→new
 *    messages simply carry no trailer, new→old messages are read as before.
 *    A prefix or a length-framed envelope would break that; a second channel
 *    would double the publish rate on the hottest cross-instance path and would
 *    not reach an instance that joined the document after the announcement.
 *  - Owners ride on EVERY awareness publish, not just the first, so an instance
 *    that loads the document late still learns the mapping on the next cursor
 *    move or 15 s presence heartbeat.
 *
 * TRUST: the trailer is only as trustworthy as the Redis channel itself, which
 * is a server-to-server bus — anything able to publish here can already forge
 * presence outright. Ownership learned this way is therefore trusted exactly as
 * far as the relayed awareness bytes beside it, and no further: the guard still
 * refuses a DIFFERENT local principal's attempt to assert a relayed id.
 */
const OWNERS_MAGIC = Buffer.from('sqdOWNR1', 'ascii');
const OWNERS_FOOTER_BYTES = OWNERS_MAGIC.length + 4;

/** Bound on a trailer we will parse — a sanity limit, not a security boundary. */
const MAX_OWNERS_JSON_BYTES = 64 * 1024;

/**
 * Encode an awareness message, optionally vouching for the clientIDs it carries.
 * @param {Buffer|Uint8Array} update - encoded awareness update
 * @param {Object|null} owners - `{ [clientId]: principal }` for LOCAL participants only
 * @returns {Buffer}
 */
function encodeAwarenessMessage(update, owners) {
  const base = encodeMessage(update);
  if (!owners) return base;
  const keys = Object.keys(owners);
  if (keys.length === 0) return base;

  let json;
  try {
    json = Buffer.from(JSON.stringify(owners), 'utf8');
  } catch {
    return base; // never let a bad owners map cost us the awareness update
  }
  if (json.length > MAX_OWNERS_JSON_BYTES) return base;

  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  return Buffer.concat([base, json, len, OWNERS_MAGIC]);
}

/**
 * Split an awareness payload into the update bytes and the owners map.
 * Total and throw-free: anything that is not exactly a well-formed trailer is
 * treated as plain awareness bytes (which is also what a pre-trailer instance
 * publishes).
 * @param {Buffer} data - the payload after the instance-ID prefix
 * @returns {{ update: Buffer, owners: Object|null }}
 */
function splitAwarenessPayload(data) {
  if (!data || data.length < OWNERS_FOOTER_BYTES + 1) return { update: data, owners: null };
  const magicAt = data.length - OWNERS_MAGIC.length;
  if (!data.slice(magicAt).equals(OWNERS_MAGIC)) return { update: data, owners: null };

  const jsonLen = data.readUInt32BE(magicAt - 4);
  const jsonAt = magicAt - 4 - jsonLen;
  if (jsonLen === 0 || jsonLen > MAX_OWNERS_JSON_BYTES || jsonAt <= 0) {
    return { update: data, owners: null };
  }
  let owners;
  try {
    owners = JSON.parse(data.slice(jsonAt, magicAt - 4).toString('utf8'));
  } catch {
    return { update: data, owners: null };
  }
  if (!owners || typeof owners !== 'object' || Array.isArray(owners)) {
    return { update: data, owners: null };
  }
  return { update: data.slice(0, jsonAt), owners };
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

  // Feature 057 (FR-005): attach BEFORE the ready-wait below, so the very first
  // connect fires the hook too — the bind-to-subscribe window is a blind window
  // exactly like a reconnect.
  wireSubscriberReady();

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
          // The publishing instance may vouch for the clientIDs it is relaying
          // (M4). Absent trailer ⇒ `owners` is null and the receiver falls back
          // to the pre-existing REMOTE_PRINCIPAL placeholder.
          const { update, owners } = splitAwarenessPayload(decoded.data);
          sub.awarenessHandler(update, owners);
        }
      } else if (channel.startsWith(UPDATES_PREFIX)) {
        const docId = channel.slice(UPDATES_PREFIX.length);
        const sub = documentSubscriptions.get(docId);
        if (sub?.updateHandler) {
          sub.updateHandler(decoded.data);
        }
      } else if (channel === PRESENCE_CLAIM_CHANNEL) {
        let payload;
        try {
          payload = JSON.parse(decoded.data.toString());
        } catch (parseErr) {
          console.warn('[RedisPubSub] Dropping malformed presence-claim payload');
          return;
        }
        for (const handler of presenceClaimHandlers) {
          try {
            handler(payload);
          } catch (handlerErr) {
            console.error('[RedisPubSub] presence-claim handler error:', handlerErr.message);
          }
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

  // Issue the presence-claim channel SUBSCRIBE for handlers registered before
  // init() ran (feature 015 contract C: pre-init registrations are never
  // silently dropped).
  if (presenceClaimHandlers.length > 0 && !presenceClaimSubscribed) {
    presenceClaimSubscribed = true;
    subscriberClient.subscribe(PRESENCE_CLAIM_CHANNEL).catch((err) => {
      console.error('[RedisPubSub] Error subscribing to presence-claim channel:', err.message);
    });
  }

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
 * Subscribe to Redis channels for a document.
 *
 * IDEMPOTENT BY DOCUMENT ID, AND THE HANDLERS ALWAYS WIN (multi-replica review
 * M3). The handlers passed here close over ONE in-memory Y.Doc instance, and a
 * document can be REBUILT under the same id while this instance is running: a
 * refused bind (`refuseBind`, feature 041) evicts and destroys the doc, its
 * clients reconnect, and y-websocket builds a fresh one. The caller cannot tell
 * whether an existing subscription's handlers belong to the doc it is holding —
 * only that some subscription exists.
 *
 * This function used to answer that with "Already subscribed" and KEEP the old
 * handlers. Reproduced against two instances (a document load failed on one of
 * them, the client reconnected before the evicted socket's lagging 'close'
 * landed): the channels stayed wired to the DEAD doc, the fresh doc had
 * `_redisSyncInitialized` set and so never re-subscribed, and that instance
 * silently stopped applying every other instance's edits — while still
 * publishing its own, so the divergence was one-way and invisible from the
 * editing side.
 *
 * So a duplicate subscribe now REBINDS: the channels are already open (Redis
 * SUBSCRIBE is per-channel, not per-handler, and re-issuing it would be a
 * no-op), but the newest caller's handlers replace the old ones. The newest
 * caller is by construction the doc the y-websocket registry currently holds —
 * `server/index.js` resolves the doc from the registry and subscribes in the
 * same synchronous turn, so these calls cannot interleave out of order.
 *
 * Tearing DOWN stays guarded on doc identity at the call site
 * (`isCurrentDoc` in server/index.js), so a straggler close from the dead doc
 * cannot unsubscribe the live one.
 *
 * @param {string} docId - Document ID
 * @param {Object} handlers - Message handlers
 * @param {Function} handlers.onAwareness - Handler for awareness updates
 *   `(buffer, owners)` — `owners` is the publishing instance's `{clientId:
 *   principal}` vouching map, or null (see `publishAwareness`).
 * @param {Function} handlers.onUpdate - Handler for document updates
 * @returns {Promise<void>} Resolves when subscriptions are active
 */
async function subscribeToDocument(docId, { onAwareness, onUpdate }) {
  if (!isEnabled()) {
    return;
  }

  const alreadySubscribed = documentSubscriptions.has(docId);

  // Bind the handlers FIRST, so that even the rebind case leaves the newest
  // caller's doc receiving, whatever happens to the SUBSCRIBE below.
  documentSubscriptions.set(docId, {
    awarenessHandler: onAwareness,
    updateHandler: onUpdate,
  });

  if (alreadySubscribed) {
    console.log(`[RedisPubSub] Rebinding handlers for doc ${docId} (channels already subscribed)`);
    return;
  }

  console.log(`[RedisPubSub] Subscribing to doc ${docId}`);

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
 * @param {Object|null} [owners] - `{ [clientId]: principal }` for the LOCAL
 *   participants this instance is vouching for (M4; see the trailer note above).
 *   Omitting it publishes exactly the pre-M4 bytes.
 */
function publishAwareness(docId, update, owners = null) {
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
    publisherClient.publish(AWARENESS_PREFIX + docId, encodeAwarenessMessage(update, owners))
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
 * Register a handler for presence-claim takeover nudges (feature 015).
 * Safe to call before init(): the handler is recorded and the channel
 * SUBSCRIBE is issued by init(); if init() already ran, the SUBSCRIBE is
 * issued immediately. Handlers receive the decoded JSON payload
 * ({ claimKey }) from OTHER instances only (self-messages are filtered by
 * the instance-ID framing).
 * @param {Function} handler - handler(payloadObject)
 */
function subscribeToPresenceClaims(handler) {
  presenceClaimHandlers.push(handler);
  if (initialized && subscriberClient && !presenceClaimSubscribed) {
    presenceClaimSubscribed = true;
    subscriberClient.subscribe(PRESENCE_CLAIM_CHANNEL).catch((err) => {
      console.error('[RedisPubSub] Error subscribing to presence-claim channel:', err.message);
    });
  }
}

/**
 * Run `cb` whenever the subscriber connection becomes usable — on first
 * connect AND on every re-establishment (feature 057, FR-005).
 *
 * WHY THIS EXISTS: ioredis resubscribes to its channels automatically after a
 * reconnect, but nothing REPLAYS what was published while the socket was down.
 * Those messages are simply gone. From the pod's point of view the document is
 * still bound and still apparently in sync, so the divergence is permanent and
 * invisible — the reconnect is the one moment the pod can know it has a blind
 * window, and this is how it finds out.
 *
 * `ready` is the right event rather than `connect`: ioredis emits it once the
 * connection is authenticated and commands will be accepted, and it emits it
 * again after each successful reconnect, which is exactly the "usable again"
 * edge. Handlers are invoked on a later tick and their failures are contained,
 * because this fires on the pub/sub client's own event path.
 *
 * Safe to call before init(); handlers are recorded and wired when the
 * subscriber client is created.
 *
 * @param {Function} cb - invoked with no arguments
 */
function onSubscriberReady(cb) {
  if (typeof cb !== 'function') return;
  subscriberReadyHandlers.push(cb);
  wireSubscriberReady();
  // Registered after the connection was already up: the 'ready' edge has
  // passed, so run once now rather than waiting for a reconnect that may never
  // come (same posture as subscribeToPresenceClaims issuing a late SUBSCRIBE).
  if (subscriberClient && subscriberClient.status === 'ready') {
    setImmediate(() => runSubscriberReadyHandler(cb));
  }
}

/** Invoke one handler with every failure contained. */
function runSubscriberReadyHandler(handler) {
  try {
    Promise.resolve(handler()).catch((err) => {
      console.error('[RedisPubSub] subscriber-ready handler failed:', err?.message || err);
    });
  } catch (err) {
    console.error('[RedisPubSub] subscriber-ready handler threw:', err?.message || err);
  }
}

/** Attach the 'ready' listener to the subscriber client, exactly once. */
function wireSubscriberReady() {
  if (subscriberReadyWired || !subscriberClient || typeof subscriberClient.on !== 'function') return;
  subscriberReadyWired = true;
  subscriberClient.on('ready', () => {
    for (const handler of subscriberReadyHandlers) runSubscriberReadyHandler(handler);
  });
}

/**
 * Publish a presence-claim takeover nudge (feature 015). Fire-and-forget:
 * errors are logged, never thrown — delivery is best-effort (the heartbeat
 * ownership check backstops a lost nudge).
 * @param {string} claimKey - agent-presence:{userId}:{agentId}:{docGuid}
 */
function publishPresenceClaimTakeover(claimKey) {
  if (!isEnabled()) {
    return;
  }
  publisherClient
    .publish(PRESENCE_CLAIM_CHANNEL, encodeMessage(Buffer.from(JSON.stringify({ claimKey }))))
    .catch((err) => {
      console.error(`[RedisPubSub] Error publishing presence-claim takeover for ${claimKey}:`, err.message);
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

  // Unsubscribe the presence-claim channel (handlers stay registered so a
  // later re-init resubscribes them)
  if (presenceClaimSubscribed) {
    subscriberClient?.unsubscribe(PRESENCE_CLAIM_CHANNEL);
    presenceClaimSubscribed = false;
  }

  // The subscriber-ready listener belongs to the client being discarded, so a
  // re-init must attach a fresh one. Handlers themselves stay registered, like
  // the presence-claim handlers above.
  subscriberReadyWired = false;

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
  subscribeToPresenceClaims,
  publishPresenceClaimTakeover,
  onSubscriberReady,
  getSubscriptionCount,
  isSubscribed,
  cleanup,
  getInstanceId,
  // Expose encode/decode for testing and potential external use
  encodeMessage,
  decodeMessage,
  encodeAwarenessMessage,
  splitAwarenessPayload,
  // Expose for testing
  _reset: async () => {
    // Unsubscribe from all documents
    for (const docId of documentSubscriptions.keys()) {
      unsubscribeFromDocument(docId);
    }
    documentSubscriptions.clear();

    // Drop presence-claim channel state (handlers cleared for test isolation)
    if (presenceClaimSubscribed) {
      subscriberClient?.unsubscribe(PRESENCE_CLAIM_CHANNEL);
    }
    presenceClaimHandlers.length = 0;
    presenceClaimSubscribed = false;

    // Drop subscriber-ready state (feature 057) for test isolation.
    subscriberReadyHandlers.length = 0;
    subscriberReadyWired = false;

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
