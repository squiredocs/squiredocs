/**
 * Presence-claim coordinator (feature 015-agent-presence-dedup).
 *
 * Owns all Redis interaction for the cluster-wide agent presence claim:
 * key `agent-presence:{userId}:{agentId}:{docGuid}` whose value is this
 * instance's ID. Only the claim-holding instance announces the agent in
 * awareness; the claim follows the work (takeover on tool call + pub/sub
 * nudge); heartbeats refresh held claims and probe for freed ones.
 * Contract: specs/015-agent-presence-dedup/contracts/presence-claim.md.
 *
 * Hard rules:
 * - No function ever throws/rejects due to Redis state (FR-013). Errors and
 *   timeouts resolve to fail-open, holder-favoring results (RBD-2).
 * - Every Redis op is raced against AGENT_CLAIM_OP_TIMEOUT_MS (RBD-5).
 * - With no REDIS_HOST the module is inert: holder-favoring answers, zero
 *   Redis I/O, zero timers (FR-012).
 * - Claim commands use the shared command client (server/redis.js), never
 *   the pub/sub clients (research R1).
 */

const { getRedisClient, isRedisEnabled } = require('../redis');
const redisPubSub = require('../redis-pubsub');

// Same env-fallback idiom as server/rate-limit.js
function num(envVar, def) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Env config (RBD-1, RBD-5) — read at load; overridable per-test via _setDepsForTests.
const config = {
  ttlMs: num('AGENT_CLAIM_TTL_MS', 15000),
  heartbeatMs: num('AGENT_CLAIM_HEARTBEAT_MS', 5000),
  opTimeoutMs: num('AGENT_CLAIM_OP_TIMEOUT_MS', 500),
};

// Default dependencies (production). Tests may replace any of these via
// _setDepsForTests to point two isolated module instances at one fake Redis
// with distinct identities (research R8).
function defaultDeps() {
  return {
    enabled: () => isRedisEnabled(),
    getClient: () => getRedisClient(),
    instanceId: () => redisPubSub.getInstanceId(),
    subscribeTakeover: (handler) => redisPubSub.subscribeToPresenceClaims(handler),
    publishTakeover: (claimKey) => redisPubSub.publishPresenceClaimTakeover(claimKey),
  };
}

let deps = defaultDeps();

// claimKey -> { claimKey, held, failOpen, heartbeatTimer } (data-model Entity 3)
const claimRecords = new Map();

// Callbacks wired by agent-presence.js via init()
const callbacks = { onLost: null, onAcquired: null };

let nudgeSubscribed = false;
let commandsDefined = false;

const OP_TIMED_OUT = Symbol('presence-claim-op-timeout');

function log(message, claimKey) {
  console.log(`[presence-claim] ${message} key=${claimKey} instance=${deps.instanceId()}`);
}

/**
 * Get (or create) the local bookkeeping record for a claim key.
 */
function record(claimKey) {
  let r = claimRecords.get(claimKey);
  if (!r) {
    r = { claimKey, held: false, failOpen: false, heartbeatTimer: null };
    claimRecords.set(claimKey, r);
  }
  return r;
}

/**
 * The shared command client with the two Lua owner-checked commands
 * registered (ioredis defineCommand — EVALSHA-cached; research R2).
 * Test fakes ship claimRefresh/claimRelease as plain methods, in which
 * case defineCommand is skipped.
 */
function client() {
  const c = deps.getClient();
  if (!commandsDefined) {
    if (typeof c.claimRefresh !== 'function' && typeof c.defineCommand === 'function') {
      c.defineCommand('claimRefresh', {
        numberOfKeys: 1,
        lua: "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end",
      });
      c.defineCommand('claimRelease', {
        numberOfKeys: 1,
        lua: "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      });
    }
    commandsDefined = true;
  }
  return c;
}

/**
 * Run one Redis op, raced against the op timeout (RBD-5). Never throws.
 * @param {Function} fn - () => Promise of the Redis command result
 * @returns {Promise<{ok: true, value: *} | {ok: false, error: Error}>}
 */
async function runOp(fn) {
  let timer = null;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(OP_TIMED_OUT), config.opTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const op = Promise.resolve().then(fn);
    // Swallow the losing promise's eventual settlement so an op that errors
    // AFTER the timeout won can never become an unhandled rejection (RBD-5).
    op.catch(() => {});
    const result = await Promise.race([op, timeout]);
    if (result === OP_TIMED_OUT) {
      return { ok: false, error: new Error(`claim op timed out after ${config.opTimeoutMs}ms`) };
    }
    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Mark a claim as failing open (op error/timeout): behave as holder, log the
 * transition once — not per op (RBD-2, plan Decision 5).
 */
function enterFailOpen(r, error) {
  if (!r.failOpen) {
    r.failOpen = true;
    console.warn(
      `[presence-claim] fail-open enter key=${r.claimKey} instance=${deps.instanceId()}: ${error.message}`
    );
  }
}

/**
 * Mark a successful op: clears fail-open (logged once per transition).
 */
function opSucceeded(r) {
  if (r.failOpen) {
    r.failOpen = false;
    log('fail-open recover', r.claimKey);
  }
}

/**
 * Build the Redis claim key (FR-001). Components are the same raw strings
 * as the in-memory sessionKey; agentId falls back to 'default'.
 */
function buildClaimKey(userId, agentId, docGuid) {
  return `agent-presence:${userId}:${agentId || 'default'}:${docGuid}`;
}

/**
 * Wire the lost/acquired callbacks and subscribe the takeover nudge channel
 * (via redis-pubsub; registration before redisPubSub.init() is safe — the
 * SUBSCRIBE is issued when it initializes). Idempotent.
 */
function init({ onLost, onAcquired } = {}) {
  callbacks.onLost = onLost || null;
  callbacks.onAcquired = onAcquired || null;
  if (!nudgeSubscribed) {
    nudgeSubscribed = true;
    deps.subscribeTakeover(handleTakeoverNudge);
  }
}

/**
 * Handle a takeover nudge from another instance: if we believed we held the
 * claim, we no longer do — silence via onLost. Unknown / already-silent
 * claims are a no-op (idempotent; spec edge case).
 */
function handleTakeoverNudge(payload) {
  const claimKey = payload && payload.claimKey;
  if (!claimKey) return;
  const r = claimRecords.get(claimKey);
  if (!r || !r.held) return;
  r.held = false;
  log('silenced (nudge)', claimKey);
  if (callbacks.onLost) {
    try {
      callbacks.onLost(claimKey);
    } catch (err) {
      console.error(`[presence-claim] onLost callback failed for ${claimKey}:`, err.message);
    }
  }
}

/**
 * Synchronous local belief about holding a claim. Holder-favoring when
 * claims are disabled or the claim is failing open.
 */
function isHeld(claimKey) {
  if (!deps.enabled()) return true;
  const r = claimRecords.get(claimKey);
  return !!(r && (r.held || r.failOpen));
}

/**
 * Reset all module state (tests only): stop timers, drop records, restore
 * production dependencies.
 */
function _resetForTests() {
  for (const r of claimRecords.values()) {
    if (r.heartbeatTimer) clearInterval(r.heartbeatTimer);
  }
  claimRecords.clear();
  callbacks.onLost = null;
  callbacks.onAcquired = null;
  nudgeSubscribed = false;
  commandsDefined = false;
  deps = defaultDeps();
  config.ttlMs = num('AGENT_CLAIM_TTL_MS', 15000);
  config.heartbeatMs = num('AGENT_CLAIM_HEARTBEAT_MS', 5000);
  config.opTimeoutMs = num('AGENT_CLAIM_OP_TIMEOUT_MS', 500);
}

/**
 * Override dependencies/config (tests only). Pass any subset of:
 * { enabled, getClient, instanceId, subscribeTakeover, publishTakeover,
 *   config: { ttlMs, heartbeatMs, opTimeoutMs } }
 */
function _setDepsForTests(overrides = {}) {
  const { config: cfg, ...rest } = overrides;
  deps = { ...deps, ...rest };
  if (cfg) Object.assign(config, cfg);
}

module.exports = {
  init,
  buildClaimKey,
  isHeld,
  _resetForTests,
  _setDepsForTests,
};
