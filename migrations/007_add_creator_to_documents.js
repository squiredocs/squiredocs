/**
 * Migration: Add creator_id to documents table
 * Creator is immutable audit info - who originally created the doc
 * (separate from owner role, which can be transferred)
 * 
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Add creator_id column (nullable initially for existing docs)
  pgm.addColumn('documents', {
    creator_id: {
      type: 'uuid',
      references: 'users(id)',
      onDelete: 'SET NULL', // Keep doc even if creator is deleted
    },
  });

  // For existing documents, set creator to the current owner
  pgm.sql(`
    UPDATE documents d
    SET creator_id = ds.user_id
    FROM document_shares ds
    WHERE ds.doc_id = d.id 
      AND ds.role = 'owner'
      AND d.creator_id IS NULL
  `);

  // Create index for looking up docs by creator
  pgm.createIndex('documents', 'creator_id', { name: 'idx_documents_creator_id' });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex('documents', 'creator_id', { name: 'idx_documents_creator_id' });
  pgm.dropColumn('documents', 'creator_id');
};
