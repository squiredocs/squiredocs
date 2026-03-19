/**
 * Migration: Add AI extra credits table
 * - One-off credit grants that supplement the monthly allowance
 * - Credits persist until depleted or expired
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('ai_extra_credits', {
    id: { type: 'serial', primaryKey: true },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    amount_cents: { type: 'integer', notNull: true },
    used_cents: { type: 'integer', notNull: true, default: 0 },
    memo: { type: 'text' },
    granted_by: { type: 'uuid', references: 'users(id)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz' },
  });

  pgm.createIndex('ai_extra_credits', ['user_id'], { name: 'idx_ai_extra_credits_user_id' });
  pgm.addConstraint('ai_extra_credits', 'chk_used_cents_range',
    'CHECK (used_cents >= 0 AND used_cents <= amount_cents)');
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('ai_extra_credits');
};
