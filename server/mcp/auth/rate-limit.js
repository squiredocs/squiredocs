/**
 * Fixed-window rate limiter for the MCP login bootstrap (feature 008, research R7).
 *
 * There is no rate-limit middleware in the codebase, and the login flow's abuse
 * counters are ephemeral (unlike the pending-authorization caps, which are true
 * COUNTs in Postgres). So this is a small counter: `INCR key` + `EXPIRE key
 * window` on the first hit when Redis is available, and an in-process Map with
 * lazy pruning otherwise (the test environment and single-process dev). No new
 * dependency.
 *
 * Keys are per-concern strings the callers build, e.g. `login:ip:<ip>`,
 * `code:user:<id>`, `code:ip:<ip>`, `claim:ip:<ip>`.
 */
const { getRedisClient, isRedisEnabled, isRedisReady } = require('../../redis');

// In-process fallback store: key -> { count, resetAt (ms epoch) }.
const memory = new Map();

function pruneMemory(now) {
  for (const [key, entry] of memory) {
    if (entry.resetAt <= now) memory.delete(key);
  }
}

function consumeMemory(key, limit, windowSeconds, now) {
  // Opportunistic prune so the map can't grow unbounded under churn.
  if (memory.size > 5000) pruneMemory(now);

  let entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowSeconds * 1000 };
    memory.set(key, entry);
  }
  entry.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  return {
    allowed: entry.count <= limit,
    count: entry.count,
    retryAfterSeconds,
  };
}

async function consumeRedis(key, limit, windowSeconds) {
  const client = getRedisClient();
  const redisKey = `ratelimit:${key}`;
  const count = await client.incr(redisKey);
  if (count === 1) {
    await client.expire(redisKey, windowSeconds);
  }
  let ttl = await client.ttl(redisKey);
  // TTL can be -1 (no expiry set — shouldn't happen) or -2 (missing); clamp.
  if (ttl < 0) {
    await client.expire(redisKey, windowSeconds);
    ttl = windowSeconds;
  }
  return {
    allowed: count <= limit,
    count,
    retryAfterSeconds: Math.max(1, ttl),
  };
}

/**
 * Increment the fixed-window counter for `key` and report whether the caller is
 * within `limit` per `windowSeconds`. Non-destructive: it never blocks or sleeps
 * — the caller decides what to do with `allowed === false` (return a retriable
 * rate-limited result, add a slow_down, etc.).
 *
 * @returns {Promise<{ allowed: boolean, count: number, retryAfterSeconds: number }>}
 */
async function consume(key, limit, windowSeconds) {
  // Test seam: the abuse suite forces the in-process counter so that _reset()
  // gives a deterministic clean slate (Redis readiness is nondeterministic under
  // jest, and shared-Redis counters outlive a single test). Production never
  // sets this, so it uses Redis whenever it is enabled and ready.
  const forceMemory = process.env.LOGIN_RATE_LIMIT_FORCE_MEMORY === '1';
  if (!forceMemory && isRedisEnabled() && isRedisReady()) {
    try {
      return await consumeRedis(key, limit, windowSeconds);
    } catch (err) {
      // Redis hiccup must not take down the login surface — fall back to memory.
      console.error('[rate-limit] Redis error, falling back to in-process:', err.message);
    }
  }
  return consumeMemory(key, limit, windowSeconds, Date.now());
}

/**
 * Clear all in-process counters. Tests call this between cases. (Redis-backed
 * counters expire on their own; tests that need a clean slate run without Redis
 * or use distinct keys.)
 */
function _reset() {
  memory.clear();
}

module.exports = {
  consume,
  _reset,
};
