/**
 * Migration: Add Anthropic prompt-caching token columns to ai_usage_log
 * - cache_read_input_tokens: tokens served from cache (~0.1x input price)
 * - cache_creation_input_tokens: tokens written to cache (~1.25x input price, 5m TTL)
 *
 * Defaults of 0 keep the existing column-less inserts (e.g. reserveCredits's
 * pending row) valid and make pre-caching rows read as "no cache activity".
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('ai_usage_log', {
    cache_read_input_tokens: { type: 'integer', notNull: true, default: 0 },
    cache_creation_input_tokens: { type: 'integer', notNull: true, default: 0 },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumns('ai_usage_log', ['cache_read_input_tokens', 'cache_creation_input_tokens']);
};
