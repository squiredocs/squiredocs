/**
 * Migration: Add onboarding columns to users
 *
 * Supports the welcome/onboarding flow:
 * - welcome_doc_id: the user's personal welcome document (seeded on first login).
 *   FK → documents(id) with ON DELETE SET NULL so deleting the doc doesn't break the user.
 * - onboarded_at: set once the user is "engaged" (owns a non-welcome doc with content).
 *   Once set, the welcome flow no longer triggers on login. NULL = not yet engaged.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('users', {
    welcome_doc_id: {
      type: 'uuid',
      notNull: false,
      references: 'documents(id)',
      onDelete: 'SET NULL',
    },
    onboarded_at: {
      type: 'timestamptz',
      notNull: false,
    },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumns('users', ['welcome_doc_id', 'onboarded_at']);
};
