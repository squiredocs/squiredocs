/**
 * Migration: Track when a user was sent the beta welcome email.
 * The welcome email is sent manually by an admin from the Admin page (never
 * automatically). This nullable timestamp records the last time it was sent so
 * the admin can see who has already received it and re-sends are deliberate.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('users', {
    welcome_email_sent_at: { type: 'timestamptz', notNull: false, default: null },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumns('users', ['welcome_email_sent_at']);
};
