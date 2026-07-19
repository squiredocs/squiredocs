/**
 * Yjs transaction origin helpers
 *
 * Single source of truth for constructing and parsing the "origin"
 * value passed to ydoc.transact() and Y.applyUpdate().
 *
 * Origin formats in the wild:
 *  - Sentinel strings: 'db-load', 'redis'
 *  - Bare userId string (legacy MCP path)
 *  - { userId, agentName } object (document-service / version-history)
 *  - WebSocket object with .userId / .agentName properties
 */

/** Sentinel: update loaded from the database during bindState */
const ORIGIN_DB_LOAD = 'db-load';

/** Sentinel: update received via Redis pub/sub cross-instance sync */
const ORIGIN_REDIS = 'redis';

/**
 * Sentinel: a two-way-sync push (feature 004) broadcast onto the live shared
 * doc AFTER applySyncPush has already stored the one attributed, on-behalf-of
 * update row. Like the other sentinels, parseOrigin returns null for it, so the
 * bindState persistence listener does NOT re-store an unattributed second row
 * (FR-008 single stored update). UNLIKE ORIGIN_DB_LOAD — which sync used before
 * F3 — it is NOT on the Redis publish skip-list, so other server instances that
 * have the doc loaded receive the push through the normal cross-instance fan-out
 * instead of silently missing it.
 */
const ORIGIN_SYNC_PUSH = 'sync-push';

/**
 * Sentinel: a log-derived undo/redo inverse (feature 016) broadcast onto the
 * live shared doc AFTER the undo service has already stored the one attributed
 * inverse row (store-then-apply, research R3). parseOrigin returns null so the
 * bindState persistence listener does NOT re-store an unattributed second row;
 * like ORIGIN_SYNC_PUSH it is deliberately NOT on the Redis publish skip-list,
 * so other instances holding the doc receive the reversion through the normal
 * cross-instance fan-out.
 */
const ORIGIN_INVERSE_APPLY = 'inverse-apply';

/**
 * Sentinel: a version restore (version-history restoreVersion) broadcast onto
 * the live shared doc AFTER restoreVersion has already stored the one
 * attributed restore-delta row via storeUpdate (store-then-apply). parseOrigin
 * returns null so the bindState persistence listener does NOT re-store a
 * second, differently-clocked copy of the same delta — storeUpdate allocates a
 * fresh max+1 clock on every call and never dedupes by content, so the old
 * "ON CONFLICT DO NOTHING prevents duplicates" reasoning was false. Like
 * ORIGIN_SYNC_PUSH / ORIGIN_INVERSE_APPLY it is deliberately NOT on the Redis
 * publish skip-list, so other instances holding the doc receive the restore
 * through the normal cross-instance fan-out.
 */
const ORIGIN_RESTORE = 'restore';

/**
 * Build a canonical origin object for a Yjs transaction.
 * Always returns { userId, agentName } — never a bare string.
 *
 * @param {string|null} userId
 * @param {string|null} [agentName]
 * @returns {{ userId: string|null, agentName: string|null }}
 */
function createOrigin(userId, agentName = null) {
  return { userId, agentName };
}

/**
 * Parse any origin value into { userId, agentName }.
 * Returns null for sentinel origins (db-load, redis) that should be skipped.
 *
 * @param {*} origin - Transaction origin (string | object | ws | null)
 * @returns {{ userId: string|null, agentName: string|null } | null}
 */
function parseOrigin(origin) {
  if (
    origin === ORIGIN_DB_LOAD
    || origin === ORIGIN_REDIS
    || origin === ORIGIN_SYNC_PUSH
    || origin === ORIGIN_INVERSE_APPLY
    || origin === ORIGIN_RESTORE
  ) {
    return null;
  }

  if (typeof origin === 'string') {
    return { userId: origin, agentName: null };
  }

  if (origin && typeof origin === 'object') {
    return {
      userId: origin.userId ?? null,
      agentName: origin.agentName ?? null,
    };
  }

  return { userId: null, agentName: null };
}

module.exports = {
  ORIGIN_DB_LOAD,
  ORIGIN_REDIS,
  ORIGIN_SYNC_PUSH,
  ORIGIN_INVERSE_APPLY,
  ORIGIN_RESTORE,
  createOrigin,
  parseOrigin,
};
