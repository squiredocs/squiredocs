/**
 * Migration: Add a per-user email_enabled flag.
 * Outbound user-initiated share email (invites + share notifications) is gated
 * on this flag. Default false during public beta — admins flip it on per user
 * to mark them "trusted". Existing admins are grandfathered to true so the
 * owner isn't locked out of their own invites.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('users', {
    email_enabled: { type: 'boolean', notNull: true, default: false },
  });
  pgm.sql('UPDATE users SET email_enabled = true WHERE is_admin = true');
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumns('users', ['email_enabled']);
};
