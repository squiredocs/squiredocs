/**
 * Migration: Create waitlist table for email signups
 * Stores potential users who sign up before launch
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('waitlist', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    email: {
      type: 'varchar(255)',
      notNull: true,
      unique: true,
    },
    role: {
      type: 'varchar(100)',
      notNull: false,
    },
    org_size: {
      type: 'varchar(50)',
      notNull: false,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Create index for email lookups
  pgm.createIndex('waitlist', 'email', { name: 'idx_waitlist_email' });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('waitlist');
};
