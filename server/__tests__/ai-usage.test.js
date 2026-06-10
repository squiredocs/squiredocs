/**
 * AI usage metering unit tests
 * Tests ai-usage.js module against a real PostgreSQL database.
 */
const aiUsage = require('../ai-usage');
const { createPool, createTestUser, cleanupTestUser } = require('./helpers/db');

describe('AI Usage', () => {
  let pool;
  let testUserId;

  beforeAll(async () => {
    pool = createPool();
    aiUsage.init(pool);

    testUserId = await createTestUser(pool, `aiusage-${Date.now()}@test.com`);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM ai_extra_credits WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM ai_usage_log WHERE user_id = $1', [testUserId]);
    await cleanupTestUser(pool, testUserId);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query('DELETE FROM ai_extra_credits WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM ai_usage_log WHERE user_id = $1', [testUserId]);
  });

  // ── computeCostCents ──────────────────────────────────────────────────────

  describe('computeCostCents', () => {
    test('computes cost for claude-haiku', () => {
      // 1000 input tokens at 100 cents/1M = 0.0001 dollars = 0.01 cents
      // 1000 output tokens at 500 cents/1M = 0.0005 dollars = 0.05 cents
      // Total: 0.06 cents → ceil → 1 cent
      const cost = aiUsage.computeCostCents('claude-haiku', 1000, 1000);
      expect(cost).toBe(1);
    });

    test('computes cost for gemini-3-flash', () => {
      // 1M input at 50 cents/1M = 50 cents
      // 1M output at 300 cents/1M = 300 cents
      // Total: 350 cents
      const cost = aiUsage.computeCostCents('gemini-3-flash', 1_000_000, 1_000_000);
      expect(cost).toBe(350);
    });

    test('uses Math.ceil to never under-count', () => {
      // Small usage that would be fractional
      const cost = aiUsage.computeCostCents('claude-haiku', 1, 1);
      expect(cost).toBe(1); // ceil of tiny fraction
    });

    test('returns 0 for zero tokens', () => {
      const cost = aiUsage.computeCostCents('claude-haiku', 0, 0);
      expect(cost).toBe(0);
    });

    test('handles large token counts', () => {
      // 10M input at 100 cents/1M = 1000 cents
      // 10M output at 500 cents/1M = 5000 cents
      const cost = aiUsage.computeCostCents('claude-haiku', 10_000_000, 10_000_000);
      expect(cost).toBe(6000);
    });

    test('falls back to claude-haiku pricing for unknown model', () => {
      const unknown = aiUsage.computeCostCents('unknown-model', 1_000_000, 1_000_000);
      const haiku = aiUsage.computeCostCents('claude-haiku', 1_000_000, 1_000_000);
      expect(unknown).toBe(haiku);
    });

    test('computes different costs for different models', () => {
      const tokens = 1_000_000;
      const haiku = aiUsage.computeCostCents('claude-haiku', tokens, tokens);
      const pro = aiUsage.computeCostCents('gemini-2.5-pro', tokens, tokens);
      expect(pro).toBeGreaterThan(haiku);
    });

    // ── cache-aware pricing ───────────────────────────────────────────────
    // claude-sonnet: input 300 cents/1M, output 1500 cents/1M.

    test('prices cache reads at 0.1x base input', () => {
      // 1M total input, all served from cache, no output.
      // 1M/1M * 300 * 0.1 = 30 cents
      const cost = aiUsage.computeCostCents('claude-sonnet', 1_000_000, 0, {
        cacheReadTokens: 1_000_000,
      });
      expect(cost).toBe(30);
    });

    test('prices cache writes at 1.25x base input', () => {
      // 1M total input, all written to cache, no output.
      // 1M/1M * 300 * 1.25 = 375 cents
      const cost = aiUsage.computeCostCents('claude-sonnet', 1_000_000, 0, {
        cacheWriteTokens: 1_000_000,
      });
      expect(cost).toBe(375);
    });

    test('splits input into regular / cache-read / cache-write buckets', () => {
      // 1M total input = 100k regular + 800k read + 100k write, no output.
      // regular:    100k/1M * 300        = 30
      // cacheRead:  800k/1M * 300 * 0.1  = 24
      // cacheWrite: 100k/1M * 300 * 1.25 = 37.5
      // total 91.5 → ceil → 92
      const cost = aiUsage.computeCostCents('claude-sonnet', 1_000_000, 0, {
        cacheReadTokens: 800_000,
        cacheWriteTokens: 100_000,
      });
      expect(cost).toBe(92);
    });

    test('cache args never increase cost vs. full-price input (no double count)', () => {
      const full = aiUsage.computeCostCents('claude-sonnet', 1_000_000, 0);
      const cached = aiUsage.computeCostCents('claude-sonnet', 1_000_000, 0, {
        cacheReadTokens: 1_000_000,
      });
      expect(full).toBe(300);
      expect(cached).toBeLessThan(full);
    });

    test('omitting the cache arg matches the pre-caching result', () => {
      // Backward compatibility: positional call is unchanged.
      expect(aiUsage.computeCostCents('claude-haiku', 1000, 1000)).toBe(1);
      expect(aiUsage.computeCostCents('claude-haiku', 1000, 1000, {})).toBe(1);
    });
  });

  // ── recordUsage ───────────────────────────────────────────────────────────

  describe('recordUsage', () => {
    test('inserts a row into ai_usage_log', async () => {
      await aiUsage.recordUsage(testUserId, {
        chatId: 'test-chat-1',
        modelKey: 'claude-haiku',
        inputTokens: 500,
        outputTokens: 100,
        costCents: 1,
      });

      const result = await pool.query(
        'SELECT * FROM ai_usage_log WHERE user_id = $1',
        [testUserId]
      );
      expect(result.rows.length).toBe(1);
      expect(result.rows[0].model_key).toBe('claude-haiku');
      expect(result.rows[0].input_tokens).toBe(500);
      expect(result.rows[0].output_tokens).toBe(100);
      expect(result.rows[0].cost_cents).toBe(1);
      expect(result.rows[0].chat_id).toBe('test-chat-1');
    });

    test('records cache token columns', async () => {
      await aiUsage.recordUsage(testUserId, {
        chatId: 'test-chat-cache',
        modelKey: 'claude-sonnet',
        inputTokens: 1000,
        outputTokens: 100,
        costCents: 1,
        cacheReadTokens: 700,
        cacheWriteTokens: 200,
      });

      const result = await pool.query(
        'SELECT * FROM ai_usage_log WHERE user_id = $1',
        [testUserId]
      );
      expect(result.rows[0].cache_read_input_tokens).toBe(700);
      expect(result.rows[0].cache_creation_input_tokens).toBe(200);
    });

    test('defaults cache token columns to 0 when omitted', async () => {
      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 100, outputTokens: 50, costCents: 1,
      });

      const result = await pool.query(
        'SELECT cache_read_input_tokens, cache_creation_input_tokens FROM ai_usage_log WHERE user_id = $1',
        [testUserId]
      );
      expect(result.rows[0].cache_read_input_tokens).toBe(0);
      expect(result.rows[0].cache_creation_input_tokens).toBe(0);
    });

    test('allows null chatId', async () => {
      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku',
        inputTokens: 100,
        outputTokens: 50,
        costCents: 1,
      });

      const result = await pool.query(
        'SELECT chat_id FROM ai_usage_log WHERE user_id = $1',
        [testUserId]
      );
      expect(result.rows[0].chat_id).toBeNull();
    });

    test('records multiple usage entries', async () => {
      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 100, outputTokens: 50, costCents: 1,
      });
      await aiUsage.recordUsage(testUserId, {
        modelKey: 'gemini-3-flash', inputTokens: 200, outputTokens: 100, costCents: 2,
      });

      const result = await pool.query(
        'SELECT * FROM ai_usage_log WHERE user_id = $1 ORDER BY id',
        [testUserId]
      );
      expect(result.rows.length).toBe(2);
      expect(result.rows[0].model_key).toBe('claude-haiku');
      expect(result.rows[1].model_key).toBe('gemini-3-flash');
    });
  });

  // ── checkQuota ────────────────────────────────────────────────────────────

  describe('checkQuota', () => {
    test('returns full allowance when no usage', async () => {
      const quota = await aiUsage.checkQuota(testUserId);

      expect(quota.allowed).toBe(true);
      expect(quota.creditCents).toBe(500); // default
      expect(quota.usedCents).toBe(0);
      expect(quota.remainingCents).toBe(500);
    });

    test('subtracts usage from allowance', async () => {
      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 1000, outputTokens: 500, costCents: 3,
      });

      const quota = await aiUsage.checkQuota(testUserId);
      expect(quota.allowed).toBe(true);
      expect(quota.usedCents).toBe(3);
      expect(quota.remainingCents).toBe(497);
    });

    test('blocks when usage meets credit limit', async () => {
      // Set credit to 5 cents
      await pool.query('UPDATE users SET ai_credit_cents = 5 WHERE id = $1', [testUserId]);

      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 1000, outputTokens: 500, costCents: 5,
      });

      const quota = await aiUsage.checkQuota(testUserId);
      expect(quota.allowed).toBe(false);
      expect(quota.usedCents).toBe(5);
      expect(quota.remainingCents).toBe(0);

      // Reset
      await pool.query('UPDATE users SET ai_credit_cents = 500 WHERE id = $1', [testUserId]);
    });

    test('blocks when usage exceeds credit limit', async () => {
      await pool.query('UPDATE users SET ai_credit_cents = 2 WHERE id = $1', [testUserId]);

      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 1000, outputTokens: 500, costCents: 5,
      });

      const quota = await aiUsage.checkQuota(testUserId);
      expect(quota.allowed).toBe(false);
      expect(quota.remainingCents).toBe(0); // clamped to 0

      await pool.query('UPDATE users SET ai_credit_cents = 500 WHERE id = $1', [testUserId]);
    });

    test('sums multiple usage entries', async () => {
      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 100, outputTokens: 50, costCents: 2,
      });
      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 200, outputTokens: 100, costCents: 3,
      });

      const quota = await aiUsage.checkQuota(testUserId);
      expect(quota.usedCents).toBe(5);
      expect(quota.remainingCents).toBe(495);
    });

    test('returns not allowed for non-existent user', async () => {
      const quota = await aiUsage.checkQuota('00000000-0000-0000-0000-000000000000');
      expect(quota.allowed).toBe(false);
      expect(quota.creditCents).toBe(0);
    });

    test('respects per-user credit override', async () => {
      await pool.query('UPDATE users SET ai_credit_cents = 1000 WHERE id = $1', [testUserId]);

      const quota = await aiUsage.checkQuota(testUserId);
      expect(quota.creditCents).toBe(1000);
      expect(quota.remainingCents).toBe(1000);

      await pool.query('UPDATE users SET ai_credit_cents = 500 WHERE id = $1', [testUserId]);
    });
  });

  // ── Extra Credits ─────────────────────────────────────────────────────────

  describe('extra credits', () => {
    afterEach(async () => {
      await pool.query('UPDATE users SET ai_credit_cents = 500 WHERE id = $1', [testUserId]);
    });

    test('grantExtraCredits inserts a row with correct fields', async () => {
      const grant = await aiUsage.grantExtraCredits(testUserId, 300, { memo: 'Beta bonus' });

      expect(grant.amountCents).toBe(300);
      expect(grant.usedCents).toBe(0);
      expect(grant.memo).toBe('Beta bonus');
      expect(grant.createdAt).toBeDefined();

      const { rows } = await pool.query('SELECT * FROM ai_extra_credits WHERE user_id = $1', [testUserId]);
      expect(rows.length).toBe(1);
      expect(rows[0].amount_cents).toBe(300);
    });

    test('grantExtraCredits supports expiresAt', async () => {
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const grant = await aiUsage.grantExtraCredits(testUserId, 100, { expiresAt: future });

      expect(grant.expiresAt).toBeDefined();
      expect(new Date(grant.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    test('checkQuota includes extra credits in effective limit', async () => {
      await aiUsage.grantExtraCredits(testUserId, 300);

      const quota = await aiUsage.checkQuota(testUserId);
      expect(quota.extraCreditCents).toBe(300);
      expect(quota.remainingCents).toBe(800); // 500 monthly + 300 extra
      expect(quota.allowed).toBe(true);
    });

    test('extra credits allow requests when monthly limit is exhausted', async () => {
      await pool.query('UPDATE users SET ai_credit_cents = 5 WHERE id = $1', [testUserId]);
      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 100, outputTokens: 50, costCents: 5,
      });

      // Without extra credits: blocked
      let quota = await aiUsage.checkQuota(testUserId);
      expect(quota.allowed).toBe(false);

      // Grant extra credits
      await aiUsage.grantExtraCredits(testUserId, 10);

      // Now allowed
      quota = await aiUsage.checkQuota(testUserId);
      expect(quota.allowed).toBe(true);
      expect(quota.remainingCents).toBe(10);
    });

    test('recordUsage debits extra credits when over monthly limit', async () => {
      await pool.query('UPDATE users SET ai_credit_cents = 5 WHERE id = $1', [testUserId]);
      await aiUsage.grantExtraCredits(testUserId, 10);

      // Record 8 cents — 5 covered by monthly, 3 overflow into extra credits
      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 100, outputTokens: 50, costCents: 8,
      });

      const { rows } = await pool.query(
        'SELECT used_cents FROM ai_extra_credits WHERE user_id = $1',
        [testUserId]
      );
      expect(rows[0].used_cents).toBe(3);
    });

    test('extra credits are debited oldest first', async () => {
      await pool.query('UPDATE users SET ai_credit_cents = 5 WHERE id = $1', [testUserId]);

      // Insert two extra credit rows
      await aiUsage.grantExtraCredits(testUserId, 5, { memo: 'first' });
      await aiUsage.grantExtraCredits(testUserId, 10, { memo: 'second' });

      // Record usage that overflows monthly by 7 cents
      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 100, outputTokens: 50, costCents: 12,
      });

      const { rows } = await pool.query(
        'SELECT memo, used_cents FROM ai_extra_credits WHERE user_id = $1 ORDER BY id',
        [testUserId]
      );
      expect(rows[0].memo).toBe('first');
      expect(rows[0].used_cents).toBe(5); // fully consumed
      expect(rows[1].memo).toBe('second');
      expect(rows[1].used_cents).toBe(2); // partial
    });

    test('fully depleted extra credits block requests', async () => {
      await pool.query('UPDATE users SET ai_credit_cents = 5 WHERE id = $1', [testUserId]);
      await aiUsage.grantExtraCredits(testUserId, 3);

      // Use all 8 cents (5 monthly + 3 extra)
      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 100, outputTokens: 50, costCents: 8,
      });

      const quota = await aiUsage.checkQuota(testUserId);
      expect(quota.allowed).toBe(false);
      expect(quota.remainingCents).toBe(0);
    });

    test('expired extra credits are ignored by checkQuota', async () => {
      // Insert an expired extra credit directly
      await pool.query(
        `INSERT INTO ai_extra_credits (user_id, amount_cents, expires_at)
         VALUES ($1, 500, now() - interval '1 day')`,
        [testUserId]
      );

      const quota = await aiUsage.checkQuota(testUserId);
      expect(quota.extraCreditCents).toBe(0);
      expect(quota.remainingCents).toBe(500); // only monthly
    });

    test('expired extra credits are not debited', async () => {
      await pool.query('UPDATE users SET ai_credit_cents = 5 WHERE id = $1', [testUserId]);

      // Insert expired credit
      await pool.query(
        `INSERT INTO ai_extra_credits (user_id, amount_cents, expires_at)
         VALUES ($1, 100, now() - interval '1 day')`,
        [testUserId]
      );
      // Insert valid credit
      await aiUsage.grantExtraCredits(testUserId, 10);

      // Overflow by 3 cents
      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 100, outputTokens: 50, costCents: 8,
      });

      const { rows } = await pool.query(
        'SELECT amount_cents, used_cents, expires_at FROM ai_extra_credits WHERE user_id = $1 ORDER BY id',
        [testUserId]
      );
      // Expired row untouched
      expect(rows[0].expires_at).not.toBeNull();
      expect(rows[0].used_cents).toBe(0);
      // Valid row debited
      expect(rows[1].used_cents).toBe(3);
    });

    test('BYOK usage does not debit extra credits', async () => {
      await pool.query('UPDATE users SET ai_credit_cents = 5 WHERE id = $1', [testUserId]);
      await aiUsage.grantExtraCredits(testUserId, 10);

      await aiUsage.recordUsage(testUserId, {
        modelKey: 'claude-haiku', inputTokens: 100, outputTokens: 50, costCents: 20, isByok: true,
      });

      const { rows } = await pool.query(
        'SELECT used_cents FROM ai_extra_credits WHERE user_id = $1',
        [testUserId]
      );
      expect(rows[0].used_cents).toBe(0);
    });
  });

});
