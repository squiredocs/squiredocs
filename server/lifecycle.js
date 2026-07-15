/**
 * Shared process-lifecycle state (feature 010, US1 + US4).
 *
 * A single source of truth for two boolean flags consulted across the
 * shutdown path, the WebSocket upgrade guard, and the `/ready` endpoint:
 *
 *   - `initialized`: flips true once `server.listen` finished and
 *     `redisPubSub.init()` resolved. `/ready` returns 503 until then.
 *   - `draining`: flips true on the first SIGTERM/SIGINT. `/ready` returns
 *     503 and new WS upgrades are refused so clients fail over to a healthy
 *     replica.
 *
 * No behavior beyond the flags — the shutdown routine and the endpoints own
 * the actual reactions.
 */

let initialized = false;
let draining = false;

function isInitialized() {
  return initialized;
}

function markInitialized() {
  initialized = true;
}

function isDraining() {
  return draining;
}

/**
 * Enter the draining state. Idempotent: returns false if already draining so
 * the shutdown routine can ignore a second signal (FR-002).
 * @returns {boolean} true if this call transitioned into draining
 */
function beginDraining() {
  if (draining) return false;
  draining = true;
  return true;
}

/** Test seam — reset flags between tests. */
function _reset() {
  initialized = false;
  draining = false;
}

module.exports = {
  isInitialized,
  markInitialized,
  isDraining,
  beginDraining,
  _reset,
};
