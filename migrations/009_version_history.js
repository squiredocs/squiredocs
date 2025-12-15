/**
 * Migration: Add version history support
 * - Add user_id to yjs_updates to track authorship
 * - Create document_versions table for named versions with snapshots
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Add user_id column to yjs_updates for tracking who made each edit
  pgm.addColumn('yjs_updates', {
    user_id: {
      type: 'uuid',
      references: 'users(id)',
      onDelete: 'SET NULL',
    },
  });

  // Index for efficient author queries
  pgm.createIndex('yjs_updates', 'user_id', {
    name: 'idx_yjs_updates_user_id',
  });

  // Create document_versions table for named versions and snapshots
  pgm.createTable('document_versions', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    doc_id: {
      type: 'uuid',
      notNull: true,
    },
    name: {
      type: 'varchar(255)',
      comment: 'User-provided name (null = auto-generated timestamp)',
    },
    clock_start: {
      type: 'integer',
      notNull: true,
      comment: 'First clock value in this version',
    },
    clock_end: {
      type: 'integer',
      notNull: true,
      comment: 'Last clock value in this version',
    },
    snapshot_data: {
      type: 'bytea',
      comment: 'Cached Y.Doc state for fast loading',
    },
    created_by: {
      type: 'uuid',
      references: 'users(id)',
      onDelete: 'SET NULL',
    },
    created_at: {
      type: 'timestamp',
      default: pgm.func('current_timestamp'),
    },
  });

  // Index for efficient document version lookups
  pgm.createIndex('document_versions', 'doc_id', {
    name: 'idx_document_versions_doc_id',
  });

  // Index for efficient clock range queries
  pgm.createIndex('document_versions', ['doc_id', 'clock_end'], {
    name: 'idx_document_versions_doc_clock',
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('document_versions');
  pgm.dropIndex('yjs_updates', 'user_id', { name: 'idx_yjs_updates_user_id' });
  pgm.dropColumn('yjs_updates', 'user_id');
};
