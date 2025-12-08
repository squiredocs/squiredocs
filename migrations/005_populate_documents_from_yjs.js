/**
 * Migration: Populate documents table from existing yjs_state_vectors
 * Assigns ownership of existing documents to the first user found
 * (since we don't have ownership history for legacy docs)
 * 
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Insert documents for all existing yjs docs that don't have a documents record
  // Assign to the first user (by created_at) as the owner for legacy docs
  pgm.sql(`
    INSERT INTO documents (id, owner_id)
    SELECT sv.doc_guid, (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
    FROM yjs_state_vectors sv
    WHERE NOT EXISTS (
      SELECT 1 FROM documents d WHERE d.id = sv.doc_guid
    )
    AND EXISTS (SELECT 1 FROM users)
  `);
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  // Remove documents that were auto-created from yjs_state_vectors
  // We can identify these as docs where created_at equals updated_at
  // (never been updated since auto-creation)
  // Note: This is a best-effort rollback - manually created docs will remain
  pgm.sql(`
    DELETE FROM documents 
    WHERE created_at = updated_at
  `);
};
