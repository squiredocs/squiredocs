/**
 * Migration: Raise the default monthly AI credit allowance from $5 to $10
 * - Changes the users.ai_credit_cents column default 500 → 1000 (applies to new users)
 * - Backfills existing users still on the old $5 default (500 → 1000), leaving
 *   any admin-customized limits untouched.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.alterColumn('users', 'ai_credit_cents', { default: 1000 });
  pgm.sql('UPDATE users SET ai_credit_cents = 1000 WHERE ai_credit_cents = 500');
};

/**
 * Rollback migration. Reverts the column default for new users. Existing rows
 * are intentionally left at their current value: the up backfill can't be
 * distinguished from users deliberately set to $10, so we don't clobber them.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.alterColumn('users', 'ai_credit_cents', { default: 500 });
};
