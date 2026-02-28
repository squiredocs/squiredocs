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
    await pool.query('DELETE FROM ai_usage_log WHERE user_id = $1', [testUserId]);
    await cleanupTestUser(pool, testUserId);
    await pool.end();
  });

  afterEach(async () => {
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

});
