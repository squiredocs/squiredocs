/**
 * AI usage metering module
 *
 * Tracks per-request token usage and enforces monthly credit limits.
 * Usage is computed from the append-only ai_usage_log table — no
 * counters to reset at month boundaries.
 *
 * Extra credits (ai_extra_credits table) supplement the monthly allowance.
 * They persist until depleted or expired and are debited oldest-first
 * when monthly usage exceeds the base limit.
 */

const { MODEL_DEFS } = require('./api/chat-models');

let pool = null;

function init(dbPool) {
  pool = dbPool;
}

/**
 * Compute cost in cents for a request.
 * Uses Math.ceil so we never under-count.
 * @param {string} modelKey
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number} cost in cents
 */
function computeCostCents(modelKey, inputTokens, outputTokens) {
  const def = MODEL_DEFS.find((d) => d.key === modelKey);
  if (!def) {
    console.warn(`[ai-usage] Unknown model key "${modelKey}", defaulting to claude-haiku pricing`);
    return computeCostCents('claude-haiku', inputTokens, outputTokens);
  }
  const pricing = def.pricing;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Math.ceil(inputCost + outputCost);
}

/**
 * Check whether a user has remaining quota for the current month.
 * Includes extra credits (non-expired, not fully used) in the effective limit.
 * @param {string} userId
 * @returns {Promise<{allowed: boolean, creditCents: number, usedCents: number, remainingCents: number, extraCreditCents: number}>}
 */
async function checkQuota(userId) {
  if (!pool) throw new Error('ai-usage module not initialized');

  const result = await pool.query(
    `SELECT
       u.ai_credit_cents AS "creditCents",
       COALESCE(usage.total, 0)::int AS "usedCents",
       COALESCE(extra.available, 0)::int AS "extraCreditCents"
     FROM users u
     LEFT JOIN (
       SELECT user_id, SUM(cost_cents) AS total
       FROM ai_usage_log
       WHERE user_id = $1
         AND created_at >= date_trunc('month', now())
         AND is_byok = false
       GROUP BY user_id
     ) usage ON usage.user_id = u.id
     LEFT JOIN (
       SELECT user_id, SUM(amount_cents - used_cents) AS available
       FROM ai_extra_credits
       WHERE user_id = $1
         AND used_cents < amount_cents
         AND (expires_at IS NULL OR expires_at > now())
       GROUP BY user_id
     ) extra ON extra.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return { allowed: false, creditCents: 0, usedCents: 0, remainingCents: 0, extraCreditCents: 0 };
  }

  const { creditCents, usedCents, extraCreditCents } = result.rows[0];
  const effectiveLimit = creditCents + extraCreditCents;
  const remainingCents = Math.max(0, effectiveLimit - usedCents);

  return {
    allowed: usedCents < effectiveLimit,
    creditCents,
    usedCents,
    remainingCents,
    extraCreditCents,
  };
}

/**
 * Debit overflow from extra credit rows, oldest first.
 * Uses FOR UPDATE locks to prevent race conditions.
 * @param {string} userId
 * @param {number} overflowCents - amount to debit
 */
async function debitExtraCredits(userId, overflowCents) {
  if (!pool || overflowCents <= 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, amount_cents - used_cents AS remaining
       FROM ai_extra_credits
       WHERE user_id = $1
         AND used_cents < amount_cents
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY id ASC
       FOR UPDATE`,
      [userId]
    );

    let toDebit = overflowCents;
    for (const row of rows) {
      if (toDebit <= 0) break;
      const debitAmount = Math.min(toDebit, row.remaining);
      await client.query(
        'UPDATE ai_extra_credits SET used_cents = used_cents + $1 WHERE id = $2',
        [debitAmount, row.id]
      );
      toDebit -= debitAmount;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record a usage entry in the log.
 * If the user is now over their monthly limit, debits extra credits.
 * @param {string} userId
 * @param {{chatId?: string, modelKey: string, inputTokens: number, outputTokens: number, costCents: number, isByok?: boolean}} entry
 */
async function recordUsage(userId, { chatId, modelKey, inputTokens, outputTokens, costCents, isByok }) {
  if (!pool) throw new Error('ai-usage module not initialized');

  await pool.query(
    `INSERT INTO ai_usage_log (user_id, chat_id, model_key, input_tokens, output_tokens, cost_cents, is_byok)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, chatId || null, modelKey, inputTokens, outputTokens, costCents, !!isByok]
  );

  // Debit extra credits if this non-BYOK request pushes past the monthly limit
  if (!isByok) {
    const { rows } = await pool.query(
      `SELECT
         u.ai_credit_cents AS "creditCents",
         COALESCE(SUM(l.cost_cents), 0)::int AS "usedCents"
       FROM users u
       LEFT JOIN ai_usage_log l
         ON l.user_id = u.id
         AND l.created_at >= date_trunc('month', now())
         AND l.is_byok = false
       WHERE u.id = $1
       GROUP BY u.ai_credit_cents`,
      [userId]
    );
    if (rows.length > 0) {
      const overflow = rows[0].usedCents - rows[0].creditCents;
      if (overflow > 0) {
        await debitExtraCredits(userId, Math.min(overflow, costCents));
      }
    }
  }
}

/**
 * Grant extra credits to a user.
 * @param {string} userId
 * @param {number} amountCents
 * @param {{memo?: string, grantedBy?: string, expiresAt?: string}} options
 * @returns {Promise<object>} The created credit record
 */
async function grantExtraCredits(userId, amountCents, { memo, grantedBy, expiresAt } = {}) {
  if (!pool) throw new Error('ai-usage module not initialized');

  const result = await pool.query(
    `INSERT INTO ai_extra_credits (user_id, amount_cents, memo, granted_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, amount_cents AS "amountCents", used_cents AS "usedCents", memo,
               granted_by AS "grantedBy", created_at AS "createdAt", expires_at AS "expiresAt"`,
    [userId, amountCents, memo || null, grantedBy || null, expiresAt || null]
  );
  return result.rows[0];
}

module.exports = {
  init,
  computeCostCents,
  checkQuota,
  recordUsage,
  grantExtraCredits,
};
