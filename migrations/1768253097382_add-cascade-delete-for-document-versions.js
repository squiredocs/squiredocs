/**
 * Migration: Add CASCADE delete for document_versions
 * - Adds foreign key constraint from document_versions.doc_id to documents(id)
 * - When a document is deleted, all its versions are automatically deleted
 * - This fixes a data leak where versions were orphaned after document deletion
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Add foreign key constraint with CASCADE delete
  pgm.addConstraint('document_versions', 'document_versions_doc_id_fkey', {
    foreignKeys: {
      columns: 'doc_id',
      references: 'documents(id)',
      onDelete: 'CASCADE',
    },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  // Drop the foreign key constraint
  pgm.dropConstraint('document_versions', 'document_versions_doc_id_fkey');
};
