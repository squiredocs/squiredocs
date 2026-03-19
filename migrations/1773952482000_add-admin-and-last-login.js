/**
 * Migration: Add admin flag and last login tracking
 * - Adds is_admin boolean to users table
 * - Adds last_login_at timestamp to users table
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('users', {
    is_admin: { type: 'boolean', notNull: true, default: false },
    last_login_at: { type: 'timestamptz', default: null },
  });

};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumns('users', ['is_admin', 'last_login_at']);
};
