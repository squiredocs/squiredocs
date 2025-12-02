/**
 * Initial migration: Create Yjs persistence tables
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Create table for storing Yjs document updates
  pgm.createTable('yjs_updates', {
    doc_name: {
      type: 'varchar(255)',
      notNull: true,
    },
    clock: {
      type: 'integer',
      notNull: true,
    },
    update_data: {
      type: 'bytea',
      notNull: true,
    },
    created_at: {
      type: 'timestamp',
      default: pgm.func('current_timestamp'),
    },
  });

  // Create primary key
  pgm.addConstraint('yjs_updates', 'yjs_updates_pkey', {
    primaryKey: ['doc_name', 'clock'],
  });

  // Create table for storing state vectors
  pgm.createTable('yjs_state_vectors', {
    doc_name: {
      type: 'varchar(255)',
      primaryKey: true,
    },
    state_vector: {
      type: 'bytea',
      notNull: true,
    },
    clock: {
      type: 'integer',
      notNull: true,
    },
    updated_at: {
      type: 'timestamp',
      default: pgm.func('current_timestamp'),
    },
  });

  // Create indexes for better query performance
  pgm.createIndex('yjs_updates', 'doc_name', {
    name: 'idx_yjs_updates_doc_name',
  });
  pgm.createIndex('yjs_updates', ['doc_name', 'clock'], {
    name: 'idx_yjs_updates_doc_clock',
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('yjs_updates');
  pgm.dropTable('yjs_state_vectors');
};

