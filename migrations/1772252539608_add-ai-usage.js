/**
 * Migration: Add AI usage metering
 * - Adds ai_credit_cents column to users (monthly allowance in cents)
 * - Creates ai_usage_log table for per-request token usage tracking
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Add monthly AI credit allowance to users (default $5.00 = 500 cents)
  pgm.addColumn('users', {
    ai_credit_cents: {
      type: 'integer',
      notNull: true,
      default: 500,
    },
  });

  // Create append-only usage log
  pgm.createTable('ai_usage_log', {
    id: {
      type: 'serial',
      primaryKey: true,
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    chat_id: {
      type: 'text',
    },
    model_key: {
      type: 'text',
      notNull: true,
    },
    input_tokens: {
      type: 'integer',
      notNull: true,
    },
    output_tokens: {
      type: 'integer',
      notNull: true,
    },
    cost_cents: {
      type: 'integer',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  pgm.createIndex('ai_usage_log', ['user_id', 'created_at'], {
    name: 'idx_ai_usage_log_user_created',
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('ai_usage_log');
  pgm.dropColumn('users', 'ai_credit_cents');
};
