/**
 * Migration: Add role column to document_shares and migrate ownership
 * Roles: 'owner', 'editor', 'viewer'
 * 
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Create role enum type
  pgm.createType('doc_role', ['owner', 'editor', 'viewer']);

  // Add role column to document_shares
  pgm.addColumn('document_shares', {
    role: {
      type: 'doc_role',
      notNull: true,
      default: 'editor',
    },
  });

  // Migrate existing owners from documents table to document_shares
  pgm.sql(`
    INSERT INTO document_shares (doc_id, user_id, role)
    SELECT id, owner_id, 'owner'::doc_role
    FROM documents
    ON CONFLICT (doc_id, user_id) DO UPDATE SET role = 'owner'::doc_role
  `);

  // Remove owner_id from documents table (no longer needed)
  pgm.dropColumn('documents', 'owner_id');
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  // Re-add owner_id column
  pgm.addColumn('documents', {
    owner_id: {
      type: 'uuid',
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
  });

  // Restore owner_id from document_shares
  pgm.sql(`
    UPDATE documents d
    SET owner_id = ds.user_id
    FROM document_shares ds
    WHERE ds.doc_id = d.id AND ds.role = 'owner'
  `);

  // Make owner_id not null
  pgm.alterColumn('documents', 'owner_id', { notNull: true });

  // Remove owner shares (they're represented by owner_id now)
  pgm.sql(`DELETE FROM document_shares WHERE role = 'owner'`);

  // Drop role column and type
  pgm.dropColumn('document_shares', 'role');
  pgm.dropType('doc_role');
};
