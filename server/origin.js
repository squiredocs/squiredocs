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
  if (origin === ORIGIN_DB_LOAD || origin === ORIGIN_REDIS) {
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
  createOrigin,
  parseOrigin,
};
