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
const { recordRateLimitRejection } = require('./telemetry/metrics');

const MIN = 60;

// Route-class budgets: points per fixed duration window. Points are env-overridable
// (RD-1); the window is fixed by the class. keyPrefix carries the namespace.
const CLASSES = {
  auth:              { keyPrefix: 'rl:auth:ip',        points: num('RL_AUTH_PER_MIN', 30),            duration: MIN },
  token:             { keyPrefix: 'rl:token:ip',       points: num('RL_TOKEN_PER_MIN', 30),           duration: MIN },
  search:            { keyPrefix: 'rl:search:user',    points: num('RL_SEARCH_PER_MIN', 30),          duration: MIN },
  // Markdown import/export is the REST byte channel agents are TOLD to use for
  // file sync, and a sync pass touches every file in a directory (often twice:
  // a dryRun preview is charged like a push). The original 10/20 per minute
  // predated two-way sync and tripped on a single spec directory. 240/min is
  // 4/s sustained: a bulk sync never reaches it, a runaway loop still does.
  import:            { keyPrefix: 'rl:import:user',     points: num('RL_IMPORT_PER_MIN', 240),         duration: MIN },
  export:            { keyPrefix: 'rl:export:user',     points: num('RL_EXPORT_PER_MIN', 240),         duration: MIN },
  chat:              { keyPrefix: 'rl:chat:user',       points: num('RL_CHAT_PER_MIN', 30),            duration: MIN },
  upload:            { keyPrefix: 'rl:upload:user',     points: num('RL_UPLOAD_PER_MIN', 20),          duration: MIN },
  // Feature 021 render-skip beacon: client-side reports are debounced/batched,
  // so a healthy client sends at most a few per minute; 30/min absorbs bursts
  // from a badly broken document without letting a hostile client log-flood.
  collabSkip:        { keyPrefix: 'rl:collabskip:user', points: num('RL_COLLAB_SKIP_PER_MIN', 30),     duration: MIN },
  // Version-history read/write endpoints (/history*, /versions*, /restore).
  // Timeline + drill-down + diff loads fan out several requests per panel open,
  // so 60/min per user absorbs normal interactive browsing while capping a
  // client that hammers the (doc-reconstruction-heavy) diff/clock endpoints.
  versionHistory:    { keyPrefix: 'rl:versionhistory:user', points: num('RL_VERSION_HISTORY_PER_MIN', 60), duration: MIN },
  // MCP tool dispatch (POST /mcp with method tools/call, and POST /mcp/tools/call).
  // Deliberately the most generous class: many small calls is the pattern the
  // `modify` tool documentation actively TELLS agents to use, so a budget that
  // punished bursts would throttle the behavior we ask for. 120/min is 2/s
  // sustained — an interactive agent session never approaches it, while a
  // runaway loop trips in seconds. Keyed on the token's USER, not the token, so
  // minting more tokens does not buy more budget. Handshake methods
  // (initialize, tools/list) are not charged; neither is auth or registration.
  mcp:               { keyPrefix: 'rl:mcp:user',        points: num('RL_MCP_PER_MIN', 120),            duration: MIN },
};

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
 * Send the 429 over-budget response. `Retry-After` in seconds from msBeforeNext
 * when known. For the chat route class the body carries the structured
 * `rate_limited` taxonomy payload (feature 012, FR-006) so the chat client
 * renders the specific rate-limit banner. The agent-facing classes (mcp,
 * import, export) add `retryAfterSeconds` and guidance; every other route keeps
 * the uniform body (FR-009).
 */
function reject429(res, rejRes, className) {
  if (rejRes && typeof rejRes.msBeforeNext === 'number') {
    res.set('Retry-After', String(Math.max(1, Math.ceil(rejRes.msBeforeNext / 1000))));
  }
  if (className === 'chat') {
    // Lazy require avoids a load-order cycle at server startup.
    const { buildErrorPayload, CODES } = require('./api/chat-errors');
    return res.status(429).json(buildErrorPayload({ code: CODES.RATE_LIMITED }));
  }
  if (className === 'mcp') {
    // The reader here is a model, so the body says what to DO. Bare "rate limit
    // exceeded" invites an immediate retry loop, which is the behavior that
    // spent the budget.
    const secs = rejRes && typeof rejRes.msBeforeNext === 'number'
      ? Math.max(1, Math.ceil(rejRes.msBeforeNext / 1000))
      : null;
    return res.status(429).json({
      error: 'Rate limit exceeded for tool calls.',
      retryAfterSeconds: secs,
      guidance: secs
        ? `Wait ${secs}s before the next tool call. If you are making many small edits, batch them into fewer modify calls rather than retrying immediately.`
        : 'Wait before the next tool call, and batch many small edits into fewer modify calls rather than retrying immediately.',
    });
  }
  if (className === 'import' || className === 'export') {
    // Same reasoning as mcp: these routes are driven by agents running a sync
    // loop, and a bare error gets retried immediately.
    const secs = rejRes && typeof rejRes.msBeforeNext === 'number'
      ? Math.max(1, Math.ceil(rejRes.msBeforeNext / 1000))
      : null;
    return res.status(429).json({
      error: `Rate limit exceeded for markdown ${className}.`,
      retryAfterSeconds: secs,
      guidance: secs
        ? `Wait ${secs}s, then resume where you stopped. Nothing was applied by this request, so retrying it is safe.`
        : 'Wait before the next request, then resume where you stopped. Nothing was applied by this request, so retrying it is safe.',
    });
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
/**
 * Consume one point against an EXPLICIT principal key.
 *
 * `enforce` below reads `req.user`, which only browser/session auth populates.
 * MCP authenticates to `req.agentToken` and never sets `req.user`, so routing it
 * through the per-user helper would key on `undefined` and silently allow every
 * request — a limiter that looks installed and enforces nothing. Call sites with
 * a non-session principal pass their key here instead.
 *
 * @param {string} className
 * @param {string|null|undefined} key - the principal; falsy means "cannot
 *   identify the caller", which fails OPEN (the auth middleware ahead of this
 *   would have rejected an unidentified caller already)
 * @param {object} res
 * @returns {Promise<boolean>} true ⇒ allowed; false ⇒ 429 already sent
 */
async function enforceKey(className, key, res) {
  if (!limitingActive()) return true;
  if (!key) return true;
  try {
    await consume(className, key);
    return true;
  } catch (rejRes) {
    if (isBudgetRejection(rejRes)) {
      // Count the 429 by limiter category (feature 014, FR-012) — the previously
      // silent rejection is now visible. Never throws into the 429 path.
      recordRateLimitRejection(className);
      reject429(res, rejRes, className);
      return false;
    }
    console.error(`[RateLimit] ${className} limiter error (failing open):`, rejRes?.message || rejRes);
    return true;
  }
}

async function enforce(kind, className, req, res) {
  if (!limitingActive()) return true;
  const key = kind === 'ip' ? clientIp(req) : req.user?.userId;
  // A per-user limiter with no authenticated principal shouldn't key on null —
  // let it through (requireAuth runs before this and would have rejected).
  if (kind === 'user' && !key) return true;
  return enforceKey(className, key, res);
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

// NOTE: registration admission caps were removed 2026-07-18. Sign-up (POST
// /mcp/auth/register and the authorize/approve auto-register paths) is
// intentionally unlimited — we never want to gate new users. The former design
// (a per-IP 5/hr budget plus a single GLOBAL daily counter of 200) let one
// abuser lock out registration for ALL users by spending the shared global
// budget. Coarse edge-level flood protection remains via the WAF per-IP rate
// limit (2000/5min) in infra/terraform/edge.tf.

module.exports = {
  perIp,
  perUser,
  enforceUser,
  enforceKey,
  reject429,
  clientIp,
  CLASSES,
  // Test seams
  _reset: () => { limiters = null; },
};
