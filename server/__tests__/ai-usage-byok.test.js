/**
 * AI usage BYOK integration tests
 * Verifies that BYOK usage is recorded correctly and excluded from quota.
 */
const aiUsage = require('../ai-usage');
const { createPool, createTestUser, cleanupTestUser } = require('./helpers/db');

describe('AI Usage — BYOK', () => {
  let pool;
  let testUserId;

  beforeAll(async () => {
    pool = createPool();
    aiUsage.init(pool);
    testUserId = await createTestUser(pool, `aiusage-byok-${Date.now()}@test.com`);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM ai_usage_log WHERE user_id = $1', [testUserId]);
    await cleanupTestUser(pool, testUserId);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query('DELETE FROM ai_usage_log WHERE user_id = $1', [testUserId]);
  });

  test('records isByok flag as true', async () => {
    await aiUsage.recordUsage(testUserId, {
      modelKey: 'claude-sonnet', inputTokens: 100, outputTokens: 50, costCents: 5, isByok: true,
    });

    const result = await pool.query(
      'SELECT is_byok FROM ai_usage_log WHERE user_id = $1', [testUserId]
    );
    expect(result.rows[0].is_byok).toBe(true);
  });

  test('records isByok flag as false by default', async () => {
    await aiUsage.recordUsage(testUserId, {
      modelKey: 'claude-haiku', inputTokens: 100, outputTokens: 50, costCents: 1,
    });

    const result = await pool.query(
      'SELECT is_byok FROM ai_usage_log WHERE user_id = $1', [testUserId]
    );
    expect(result.rows[0].is_byok).toBe(false);
  });

  test('BYOK usage does not count against quota', async () => {
    await pool.query('UPDATE users SET ai_credit_cents = 10 WHERE id = $1', [testUserId]);

    // Record 8 cents of BYOK usage
    await aiUsage.recordUsage(testUserId, {
      modelKey: 'claude-opus', inputTokens: 1000, outputTokens: 500, costCents: 8, isByok: true,
    });

    // Quota should still show 0 used
    const quota = await aiUsage.checkQuota(testUserId);
    expect(quota.usedCents).toBe(0);
    expect(quota.remainingCents).toBe(10);
    expect(quota.allowed).toBe(true);

    await pool.query('UPDATE users SET ai_credit_cents = 500 WHERE id = $1', [testUserId]);
  });

  test('only non-BYOK usage counts against quota', async () => {
    await pool.query('UPDATE users SET ai_credit_cents = 10 WHERE id = $1', [testUserId]);

    // Record BYOK usage — should not count
    await aiUsage.recordUsage(testUserId, {
      modelKey: 'claude-opus', inputTokens: 1000, outputTokens: 500, costCents: 100, isByok: true,
    });
    // Record non-BYOK usage — should count
    await aiUsage.recordUsage(testUserId, {
      modelKey: 'claude-haiku', inputTokens: 100, outputTokens: 50, costCents: 7,
    });

    const quota = await aiUsage.checkQuota(testUserId);
    expect(quota.usedCents).toBe(7);
    expect(quota.remainingCents).toBe(3);
    expect(quota.allowed).toBe(true);

    await pool.query('UPDATE users SET ai_credit_cents = 500 WHERE id = $1', [testUserId]);
  });

  test('quota blocks when non-BYOK usage exceeds limit, ignoring BYOK', async () => {
    await pool.query('UPDATE users SET ai_credit_cents = 5 WHERE id = $1', [testUserId]);

    await aiUsage.recordUsage(testUserId, {
      modelKey: 'claude-opus', inputTokens: 1000, outputTokens: 500, costCents: 999, isByok: true,
    });
    await aiUsage.recordUsage(testUserId, {
      modelKey: 'claude-haiku', inputTokens: 100, outputTokens: 50, costCents: 6,
    });

    const quota = await aiUsage.checkQuota(testUserId);
    expect(quota.usedCents).toBe(6);
    expect(quota.allowed).toBe(false);

    await pool.query('UPDATE users SET ai_credit_cents = 500 WHERE id = $1', [testUserId]);
  });
});
