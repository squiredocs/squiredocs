/**
 * AI usage metering module
 *
 * Tracks per-request token usage and enforces monthly credit limits.
 * Usage is computed from the append-only ai_usage_log table — no
 * counters to reset at month boundaries.
 */

let pool = null;

function init(dbPool) {
  pool = dbPool;
}

// Cents per 1M tokens (from official Anthropic/Google pricing)
const PRICING = {
  'claude-haiku':     { input:  100, output:   500 },  // $1 / $5
  'gemini-2.5-flash': { input:   30, output:   250 },  // $0.30 / $2.50
  'gemini-2.5-pro':   { input:  125, output:  1000 },  // $1.25 / $10
  'gemini-3-flash':   { input:   50, output:   300 },  // $0.50 / $3
  'gemini-3-pro':     { input:  200, output:  1200 },  // $2 / $12
};

/**
 * Compute cost in cents for a request.
 * Uses Math.ceil so we never under-count.
 * @param {string} modelKey
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} cost in cents
 */
function computeCostCents(modelKey, inputTokens, outputTokens) {
  const pricing = PRICING[modelKey];
  if (!pricing) {
    console.warn(`[ai-usage] Unknown model key "${modelKey}", defaulting to claude-haiku pricing`);
    return computeCostCents('claude-haiku', inputTokens, outputTokens);
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Math.ceil(inputCost + outputCost);
}

/**
 * Check whether a user has remaining quota for the current month.
 * @param {string} userId
 * @returns {Promise<{allowed: boolean, creditCents: number, usedCents: number, remainingCents: number}>}
 */
async function checkQuota(userId) {
  if (!pool) throw new Error('ai-usage module not initialized');

  const result = await pool.query(
    `SELECT
       u.ai_credit_cents AS "creditCents",
       COALESCE(SUM(l.cost_cents), 0)::int AS "usedCents"
     FROM users u
     LEFT JOIN ai_usage_log l
       ON l.user_id = u.id
       AND l.created_at >= date_trunc('month', now())
     WHERE u.id = $1
     GROUP BY u.ai_credit_cents`,
    [userId]
  );

  if (result.rows.length === 0) {
    return { allowed: false, creditCents: 0, usedCents: 0, remainingCents: 0 };
  }

  const { creditCents, usedCents } = result.rows[0];
  const remainingCents = Math.max(0, creditCents - usedCents);

  return {
    allowed: usedCents < creditCents,
    creditCents,
    usedCents,
    remainingCents,
  };
}

/**
 * Record a usage entry in the log.
 * @param {string} userId
 * @param {{chatId?: string, modelKey: string, inputTokens: number, outputTokens: number, costCents: number}} entry
 */
async function recordUsage(userId, { chatId, modelKey, inputTokens, outputTokens, costCents }) {
  if (!pool) throw new Error('ai-usage module not initialized');

  await pool.query(
    `INSERT INTO ai_usage_log (user_id, chat_id, model_key, input_tokens, output_tokens, cost_cents)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, chatId || null, modelKey, inputTokens, outputTokens, costCents]
  );
}

/**
 * Get usage summary for a user (current month).
 * @param {string} userId
 * @returns {Promise<{creditCents: number, usedCents: number, remainingCents: number}>}
 */
async function getUsageSummary(userId) {
  const { creditCents, usedCents, remainingCents } = await checkQuota(userId);
  return { creditCents, usedCents, remainingCents };
}

module.exports = {
  init,
  computeCostCents,
  checkQuota,
  recordUsage,
  getUsageSummary,
  PRICING,
};
