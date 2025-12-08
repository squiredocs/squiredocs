/**
 * Migration: Create documents and document_shares tables
 * - documents: tracks document ownership (who created each doc)
 * - document_shares: tracks which users have access to which documents
 * 
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Create documents table for tracking ownership
  pgm.createTable('documents', {
    id: {
      type: 'uuid',
      primaryKey: true,
      // No default - use the doc_guid from yjs_updates
    },
    owner_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Create index on owner_id for fast lookups of user's documents
  pgm.createIndex('documents', 'owner_id', { name: 'idx_documents_owner_id' });

  // Create trigger for auto-updating updated_at
  pgm.sql(`
    CREATE TRIGGER update_documents_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);

  // Create document_shares table for tracking shared access
  pgm.createTable('document_shares', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    doc_id: {
      type: 'uuid',
      notNull: true,
      references: 'documents(id)',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Create unique constraint to prevent duplicate shares
  pgm.addConstraint('document_shares', 'document_shares_doc_user_unique', {
    unique: ['doc_id', 'user_id'],
  });

  // Create indexes for fast lookups
  pgm.createIndex('document_shares', 'doc_id', { name: 'idx_document_shares_doc_id' });
  pgm.createIndex('document_shares', 'user_id', { name: 'idx_document_shares_user_id' });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS update_documents_updated_at ON documents');
  pgm.dropTable('document_shares');
  pgm.dropTable('documents');
};
