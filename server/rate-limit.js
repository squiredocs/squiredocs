/**
 * Rate limiting, registration admission caps & the 429 responder (feature 010, US2).
 *
 * Backed by `rate-limiter-flexible`: a `RateLimiterRedis` over the shared ioredis
 * client (budgets survive restart and span both replicas — FR-007), with a
 * per-process `RateLimiterMemory` `insuranceLimiter` so a Redis outage degrades
 * to per-process enforcement of the same budget rather than crashing or
 * rejecting all traffic (RD-3 / FR-008). When Redis is disabled (no REDIS_HOST)
 * or `RL_FORCE_MEMORY=1`, the memory limiter is used directly via the same code
 * path (dev + deterministic tests).
 *
 * Keys are namespaced per route class (`rl:auth:ip:`, `rl:chat:user:`, …) so a
 * later merge with the 008/009 login budgets composes without collision
 * (FR-013/RD-9 — vacuous in this worktree).
 *
 * Budgets are env-overridable (RD-1); see specs/010.../contracts/rate-limiting.md.
 */
const { RateLimiterRedis, RateLimiterMemory } = require('rate-limiter-flexible');
const { getRedisClient, isRedisEnabled } = require('./redis');

const MIN = 60;
const HOUR = 60 * 60;
const DAY = 24 * 60 * 60;

// Route-class budgets: points per fixed duration window. Points are env-overridable
// (RD-1); the window is fixed by the class. keyPrefix carries the namespace.
const CLASSES = {
  auth:              { keyPrefix: 'rl:auth:ip',        points: num('RL_AUTH_PER_MIN', 30),            duration: MIN },
  token:             { keyPrefix: 'rl:token:ip',       points: num('RL_TOKEN_PER_MIN', 30),           duration: MIN },
  register:          { keyPrefix: 'rl:register:ip',    points: num('RL_REGISTER_PER_HOUR', 5),        duration: HOUR },
  'register:global': { keyPrefix: 'rl:register:global', points: num('RL_REGISTER_GLOBAL_PER_DAY', 200), duration: DAY },
  search:            { keyPrefix: 'rl:search:user',    points: num('RL_SEARCH_PER_MIN', 30),          duration: MIN },
  import:            { keyPrefix: 'rl:import:user',     points: num('RL_IMPORT_PER_MIN', 10),          duration: MIN },
  export:            { keyPrefix: 'rl:export:user',     points: num('RL_EXPORT_PER_MIN', 20),          duration: MIN },
  chat:              { keyPrefix: 'rl:chat:user',       points: num('RL_CHAT_PER_MIN', 30),            duration: MIN },
  upload:            { keyPrefix: 'rl:upload:user',     points: num('RL_UPLOAD_PER_MIN', 20),          duration: MIN },
};

// Constant sub-key for the single global registration counter.
const GLOBAL_KEY = 'all';

function num(envVar, def) {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function forceMemory() {
  return process.env.RL_FORCE_MEMORY === '1';
}

/**
 * Whether limiting is active. Disabled by default under NODE_ENV=test so the
 * shared (Redis) budgets don't accumulate across unrelated suites and throttle
 * them — the rate-limit suites opt in with RL_TEST_ENABLE=1. Always active in
 * development/production (a normal interactive user stays far under the generous
 * default budgets — SC-009), so this changes no shipped behavior.
 */
function limitingActive() {
  if (process.env.NODE_ENV === 'test' && process.env.RL_TEST_ENABLE !== '1') return false;
  return true;
}

// Lazily-built limiter cache (rebuilt by _reset in tests).
let limiters = null;

function buildLimiters() {
  const useRedis = isRedisEnabled() && !forceMemory();
  const map = {};
  for (const [name, cfg] of Object.entries(CLASSES)) {
    const base = { keyPrefix: cfg.keyPrefix, points: cfg.points, duration: cfg.duration };
    if (useRedis) {
      // Insurance limiter kicks in when Redis errors (RD-3): same budget,
      // per-process. Distinct keyPrefix avoids collision in the memory store.
      const insuranceLimiter = new RateLimiterMemory({
        keyPrefix: cfg.keyPrefix + ':mem',
        points: cfg.points,
        duration: cfg.duration,
      });
      map[name] = new RateLimiterRedis({
        storeClient: getRedisClient(),
        ...base,
        insuranceLimiter,
      });
    } else {
      map[name] = new RateLimiterMemory(base);
    }
  }
  return map;
}

function getLimiters() {
  if (!limiters) limiters = buildLimiters();
  return limiters;
}

function getLimiter(className) {
  const l = getLimiters()[className];
  if (!l) throw new Error(`Unknown rate-limit class: ${className}`);
  return l;
}

/** Extract the true client IP (correct only because trust proxy is numeric — FR-015). */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Send the uniform 429 (FR-009). `Retry-After` in seconds from msBeforeNext when known.
 */
function reject429(res, rejRes) {
  if (rejRes && typeof rejRes.msBeforeNext === 'number') {
    res.set('Retry-After', String(Math.max(1, Math.ceil(rejRes.msBeforeNext / 1000))));
  }
  res.status(429).json({ error: 'Rate limit exceeded. Retry later.' });
}

// A rejection that is a real Error (limiter malfunctioned even after insurance)
// rather than an over-budget RateLimiterRes. Fail open in that case (RD-3: never
// reject all traffic).
function isBudgetRejection(rejRes) {
  return rejRes && typeof rejRes.msBeforeNext === 'number' && !(rejRes instanceof Error);
}

async function consume(className, key) {
  return getLimiter(className).consume(key, 1);
}

/**
 * Consume one point for a request, sending the uniform 429 when over budget.
 * Fails open (returns true) on a limiter malfunction so limiting never rejects
 * all traffic (RD-3).
 * @param {'ip'|'user'} kind
 * @param {string} className
 * @param {object} req
 * @param {object} res
 * @returns {Promise<boolean>} true ⇒ allowed (caller proceeds); false ⇒ 429 sent
 */
async function enforce(kind, className, req, res) {
  if (!limitingActive()) return true;
  const key = kind === 'ip' ? clientIp(req) : req.user?.userId;
  // A per-user limiter with no authenticated principal shouldn't key on null —
  // let it through (requireAuth runs before this and would have rejected).
  if (kind === 'user' && !key) return true;
  try {
    await consume(className, key);
    return true;
  } catch (rejRes) {
    if (isBudgetRejection(rejRes)) {
      reject429(res, rejRes);
      return false;
    }
    console.error(`[RateLimit] ${className} ${kind} limiter error (failing open):`, rejRes?.message || rejRes);
    return true;
  }
}

/** Boolean helper for call sites that limit conditionally (e.g. content search). */
function enforceUser(className, req, res) {
  return enforce('user', className, req, res);
}

/**
 * Per-IP middleware factory. Keys on the true client IP.
 * @param {string} className
 */
function perIp(className) {
  return async function perIpMiddleware(req, res, next) {
    if (await enforce('ip', className, req, res)) next();
  };
}

/**
 * Per-user middleware factory. Must be mounted after requireAuth. Keys on
 * req.user.userId so a user's budget is shared across their IPs/connections (FR-006).
 * @param {string} className
 */
function perUser(className) {
  return async function perUserMiddleware(req, res, next) {
    if (await enforce('user', className, req, res)) next();
  };
}

/**
 * Registration admission (FR-011, RD-2): consume BOTH the per-IP `register`
 * budget and the global daily counter before any new registered_agents row is
 * written. Over either bound ⇒ not allowed (caller returns 429, no row).
 * Shared per-IP key across handleRegister / handleAuthorize / handleApprove.
 * @param {string} ip
 * @returns {Promise<{allowed: boolean, retryAfterSec: number|null}>}
 */
async function checkRegistrationAdmission(ip) {
  if (!limitingActive()) return { allowed: true, retryAfterSec: null };
  const key = ip || 'unknown';
  try {
    await consume('register', key);
  } catch (rejRes) {
    if (isBudgetRejection(rejRes)) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(rejRes.msBeforeNext / 1000)) };
    }
    // limiter malfunction → fail open on the per-IP bound, still try global below.
    console.error('[RateLimit] register per-IP limiter error (failing open):', rejRes?.message || rejRes);
  }
  try {
    await consume('register:global', GLOBAL_KEY);
  } catch (rejRes) {
    if (isBudgetRejection(rejRes)) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(rejRes.msBeforeNext / 1000)) };
    }
    console.error('[RateLimit] register global limiter error (failing open):', rejRes?.message || rejRes);
  }
  return { allowed: true, retryAfterSec: null };
}

/**
 * Express guard for the /register route: runs admission, sends the uniform 429
 * (no row written) when over budget, else continues.
 */
function registrationAdmissionMiddleware() {
  return async function registrationAdmission(req, res, next) {
    const { allowed, retryAfterSec } = await checkRegistrationAdmission(clientIp(req));
    if (allowed) return next();
    if (retryAfterSec) res.set('Retry-After', String(retryAfterSec));
    res.status(429).json({ error: 'Rate limit exceeded. Retry later.' });
  };
}

module.exports = {
  perIp,
  perUser,
  enforceUser,
  checkRegistrationAdmission,
  registrationAdmissionMiddleware,
  reject429,
  clientIp,
  CLASSES,
  // Test seams
  _reset: () => { limiters = null; },
};
