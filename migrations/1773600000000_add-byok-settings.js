/**
 * Migration: Add BYOK (Bring Your Own Key) settings
 * - Adds encrypted API key columns to users table
 * - Adds selected model key column to users table
 * - Adds is_byok flag to ai_usage_log for tracking
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('users', {
    byok_enabled: { type: 'boolean', notNull: true, default: false },
    byok_anthropic_key: { type: 'text', default: null },
    byok_google_key: { type: 'text', default: null },
    byok_model_key: { type: 'text', default: null },
  });

  pgm.addColumn('ai_usage_log', {
    is_byok: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumn('ai_usage_log', 'is_byok');
  pgm.sql(`ALTER TABLE users
    DROP COLUMN IF EXISTS byok_enabled,
    DROP COLUMN IF EXISTS byok_anthropic_key,
    DROP COLUMN IF EXISTS byok_google_key,
    DROP COLUMN IF EXISTS byok_model_key`);
};
