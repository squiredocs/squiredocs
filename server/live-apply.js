/**
 * Shared live-apply broadcast (feature 023 R7/FR-023, D-5) — extracted from
 * undo-service's H1-reviewed applyToLiveDoc so restore and undo/redo converge on
 * ONE broadcast path that is never a silent skip.
 *
 * Apply a committed update to the in-memory shared doc (when loaded on THIS
 * instance) and fan it out cross-instance:
 *  - doc loaded here → Y.applyUpdate(sharedDoc, update, origin). The WS
 *    connection handler's attached redis handler fans out (these origins are NOT
 *    on its skip-list); when no handler is attached (a doc reached via
 *    getSharedDoc, or a connection-less pod) we publish explicitly — exactly
 *    once (the H1 double-send guard);
 *  - not loaded + Redis enabled → publishUpdate so instances holding the doc apply it;
 *  - neither (no live doc here AND Redis unavailable — nobody is connected
 *    anywhere) → an observable warn tagged `label`; the durable row replays on
 *    the next load. Never silent (D-5).
 *
 * Non-fatal throughout: any live-apply or publish failure logs and never throws
 * (the row is already durable).
 */
const Y = require('yjs');

/**
 * @param {{getSharedDoc: function, redisPubSub: object}} deps
 * @param {string} docGuid
 * @param {Uint8Array} update - the committed update to broadcast
 * @param {*} origin - Yjs apply origin (e.g. ORIGIN_RESTORE / ORIGIN_INVERSE_APPLY)
 * @param {string} [label='live-apply'] - tag for the log lines
 */
function applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid, update, origin, label = 'live-apply') {
  let sharedDoc = null;
  try {
    sharedDoc = getSharedDoc ? getSharedDoc(docGuid) : null;
    if (sharedDoc) Y.applyUpdate(sharedDoc, update, origin);
  } catch (err) {
    console.error(`[${label}] live apply failed for ${docGuid}:`, err.message);
  }

  let published = false;
  try {
    // Publish only when the applied doc has no attached redis handler that would
    // already fan out (H1) — or when there is no live doc at all.
    if (redisPubSub && redisPubSub.isEnabled() && !(sharedDoc && sharedDoc._redisUpdateHandler)) {
      redisPubSub.publishUpdate(docGuid, update);
      published = true;
    }
  } catch (err) {
    console.error(`[${label}] redis fan-out failed for ${docGuid}:`, err.message);
  }

  if (!sharedDoc && !published) {
    // No live doc here and no cross-instance fan-out possible — never silent (D-5).
    console.warn(`[${label}] no delivery path for ${docGuid} — no live doc and Redis unavailable; the durable row replays on next load`);
  }
}

module.exports = { applyLiveUpdate };
