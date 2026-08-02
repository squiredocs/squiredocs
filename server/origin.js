/**
 * Yjs transaction origin helpers
 *
 * Single source of truth for constructing and parsing the "origin"
 * value passed to ydoc.transact() and Y.applyUpdate().
 *
 * Origin formats in the wild:
 *  - Sentinel strings: 'db-load', 'redis', 'inverse-apply', 'restore', and the
 *    'sync-push' family (see `isSentinelOrigin` for the authoritative set)
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
 * Brand for a PER-PUSH sync origin. Two pushes to the same document overlap
 * freely (nothing serializes them), and an observer that can only ask "is this
 * A sync push?" attributes both pushes' changes to whichever one is watching —
 * so feature 037's changed-range observation needs origins it can tell apart
 * (a Symbol so it can never collide with a document's own data).
 *
 * Every OTHER consumer must treat a branded object exactly like the shared
 * string sentinel, which is what `isSyncPushOrigin` is for: parseOrigin returns
 * null for both (no unattributed second row), and neither is on the Redis
 * publish skip-list (both fan out cross-instance).
 */
const SYNC_PUSH_MARKER = Symbol('squire.sync-push');

/**
 * A distinguishable origin for ONE sync push. Identity is the whole point:
 * compare with `===` to recognise your own push, `isSyncPushOrigin` to
 * recognise the class.
 *
 * @param {string} [pushId] - optional debugging tag, never load-bearing
 * @returns {object}
 */
function createSyncPushOrigin(pushId) {
  return { [SYNC_PUSH_MARKER]: true, sentinel: ORIGIN_SYNC_PUSH, pushId: pushId || null };
}

/**
 * Is this origin a sync push — the shared sentinel or any per-push object?
 * The ONLY correct test outside the pushing code itself.
 *
 * @param {*} origin
 * @returns {boolean}
 */
function isSyncPushOrigin(origin) {
  if (origin === ORIGIN_SYNC_PUSH) return true;
  return !!origin && typeof origin === 'object' && origin[SYNC_PUSH_MARKER] === true;
}

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
 * Strict UUID form. Deliberately NOT fuzzy: `user_id` is a Postgres uuid column,
 * so "close enough" is not a category that exists downstream — an almost-UUID
 * (wrong length, stray character, missing group) fails the INSERT just as hard
 * as arbitrary text.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this origin one of the five server-side sentinels?
 *
 * A sentinel means "this transaction is the server replaying or relaying
 * something that is ALREADY accounted for" — a bindState load, a Redis fan-out,
 * a sync push, an undo/redo application, or a restore. The persistence listener
 * skips them, because storing one would duplicate a row that already exists.
 *
 * ⚠️ This is the AUTHORITATIVE set, and it is deliberately NOT the set used by
 * the publish and awareness skip-lists in `server/index.js`. Those two skip
 * strictly smaller subsets on purpose — a sync-push, an inverse apply and a
 * restore must still be PUBLISHED cross-instance even though they must not be
 * re-stored — so they are narrower by design, not by drift, and must stay that
 * way (042, contract C9). Do not "unify" them with this predicate.
 *
 * @param {*} origin - Transaction origin (string | object | ws | null)
 * @returns {boolean}
 */
function isSentinelOrigin(origin) {
  return origin === ORIGIN_DB_LOAD
    || origin === ORIGIN_REDIS
    || isSyncPushOrigin(origin)
    || origin === ORIGIN_INVERSE_APPLY
    || origin === ORIGIN_RESTORE;
}

/**
 * Parse any origin value into { userId, agentName }.
 * Returns null for sentinel origins (db-load, redis, sync-push, inverse-apply,
 * restore) that the persistence listener should skip entirely.
 *
 * ── DEGRADE LOUDLY, NEVER DROP (feature 038 US3, FR-017) ─────────────────────
 * A malformed origin used to be a DATA-LOSS path, not a cosmetic one: a non-UUID
 * string was passed straight through as `userId`, the INSERT failed on the uuid
 * column, the transient retries exhausted, and the row was dropped through the
 * CRITICAL persistence-failure branch — while the update was already applied and
 * broadcast. The edit stayed on everyone's screen and vanished from durable
 * history.
 *
 * So: a malformed origin degrades ATTRIBUTION (the row persists unattributed)
 * and raises a loud, alert-worthy signal. It must never make the caller skip
 * persistence, and this function must never throw. Attribution is recoverable;
 * a dropped update is not.
 *
 * The `malformedOrigin` field is additive — no existing consumer reads it. The
 * bindState listener in server/index.js is the one persistence-path consumer and
 * turns 'non-uuid-string' and 'null-or-primitive' into a notifyException page.
 * 'unrecognized-object' keeps its warn-only treatment.
 *
 * The marker is this in-memory classification, NOT a database column
 * (RBD-041-9): no consumer reads a persisted marker, and the loudness contract
 * lives in the log plus the page — exactly where the existing classes' does.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @param {*} origin - Transaction origin (string | object | ws | null)
 * @returns {{ userId: string|null, agentName: string|null,
 *   malformedOrigin?: 'non-uuid-string'|'unrecognized-object'|'null-or-primitive' } | null}
 */
function parseOrigin(origin) {
  // Sentinels first, unchanged — these are server-side paths that already
  // stored (or loaded) their row.
  if (isSentinelOrigin(origin)) {
    return null;
  }

  if (typeof origin === 'string') {
    if (UUID_RE.test(origin)) {
      return { userId: origin, agentName: null };
    }
    // Persist unattributed rather than fail the INSERT and lose the update.
    try {
      console.error(
        '[origin] Malformed string transaction origin — persisting UNATTRIBUTED. '
        + `Expected a UUID, got: ${JSON.stringify(origin)}`
      );
    } catch (_ignored) { /* logging must never break persistence */ }
    return { userId: null, agentName: null, malformedOrigin: 'non-uuid-string' };
  }

  if (origin && typeof origin === 'object') {
    // `in`-checks, not truthiness: an explicit { userId: null } (and a ws
    // connection that simply has no agentName) is a RECOGNIZED shape that means
    // "unattributed", not a malformed one. Only an object carrying neither
    // property is unrecognized.
    if (!('userId' in origin) && !('agentName' in origin)) {
      try {
        console.warn('[origin] Unrecognized object transaction origin — persisting UNATTRIBUTED.');
      } catch (_ignored) { /* logging must never break persistence */ }
      return { userId: null, agentName: null, malformedOrigin: 'unrecognized-object' };
    }
    return {
      userId: origin.userId ?? null,
      agentName: origin.agentName ?? null,
    };
  }

  // Everything left is null/undefined or a primitive (number, boolean, symbol,
  // bigint). Feature 041 (FR-017, RBD-041-9): this used to return a clean-looking
  // unattributed result with no marker and no log — indistinguishable from a
  // legitimately unattributed row, so a server-side caller that stopped passing
  // an origin down the attribution path would accumulate anonymous rows in
  // silence. Same defect class and severity as a non-UUID string, so it now
  // carries a distinct marker, an error log, and (via the bindState listener)
  // the same page. The row still persists unattributed: attribution is
  // recoverable, a dropped update is not.
  try {
    console.error(
      '[origin] Null or primitive transaction origin — persisting UNATTRIBUTED. '
      + `typeof=${typeof origin}, value=${String(origin).slice(0, 200)}`
    );
  } catch (_ignored) { /* logging must never break persistence */ }
  return { userId: null, agentName: null, malformedOrigin: 'null-or-primitive' };
}

module.exports = {
  ORIGIN_DB_LOAD,
  isSentinelOrigin,
  ORIGIN_REDIS,
  ORIGIN_SYNC_PUSH,
  createSyncPushOrigin,
  isSyncPushOrigin,
  ORIGIN_INVERSE_APPLY,
  ORIGIN_RESTORE,
  createOrigin,
  parseOrigin,
};
