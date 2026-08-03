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

/**
 * Publish-only companion to applyLiveUpdate (feature 037, FR-018/FR-019).
 *
 * For updates that are ALREADY applied to the shared doc — an import's
 * append/replace, whose bytes `updateDocument` merges into the shared doc before
 * returning them (since feature 048 the transaction itself runs on an ephemeral
 * per-operation doc, but the merge means the shared doc carries the update by
 * the time a caller sees it). Calling applyLiveUpdate here would re-apply an
 * update the doc already has (a Yjs no-op, but semantically wrong) and would
 * re-derive the double-send guard too late to be meaningful.
 *
 * Restore does NOT use this: since 048 it stores first and then broadcasts
 * through applyLiveUpdate, because its live doc genuinely does not have the
 * update yet.
 *
 * NEVER applies anything, so there is no double-apply and no new origin
 * sentinel: receivers apply with ORIGIN_REDIS, which is on the publisher
 * skip-list (no feedback loop) and which parseOrigin maps to null (no second
 * persisted row).
 *
 * @param {{redisPubSub: object}} deps
 * @param {string} docGuid
 * @param {Uint8Array|null} update - bytes captured at emit time by updateDocument
 * @param {boolean} hadRedisHandler - was a Redis handler attached WHEN the
 *   update fired; if so it already published and we must not publish again
 * @param {string} [label='live-fanout']
 */
function publishIfUnhandled({ redisPubSub }, docGuid, update, hadRedisHandler, label = 'live-fanout') {
  if (!update) return;               // no-change transaction
  if (hadRedisHandler) return;       // the attached handler already fanned out
  try {
    // Redis disabled (single instance) ⇒ nothing to do, and behavior is
    // byte-identical to before this feature (FR-019).
    if (redisPubSub && redisPubSub.isEnabled()) {
      redisPubSub.publishUpdate(docGuid, update);
    }
  } catch (err) {
    // The update is already durable and the import already succeeded — a
    // fan-out failure must never turn into a failed import (ledger RBD-6).
    console.error(`[${label}] redis fan-out failed for ${docGuid}:`, err.message);
  }
}

module.exports = { applyLiveUpdate, publishIfUnhandled };
