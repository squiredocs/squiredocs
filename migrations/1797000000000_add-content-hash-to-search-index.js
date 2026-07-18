/**
 * Migration: Add content_hash to document_search_index (feature 017).
 * SHA-256 hex fingerprint of the extracted body text whose embeddings were
 * last successfully generated (or whose empty-content chunk cleanup completed).
 * Nullable, no default, no backfill, no index: NULL means "no successful embed
 * recorded under 017" and simply regenerates on the next real indexing event;
 * rows are only ever reached via the doc_id primary key.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('document_search_index', {
    content_hash: { type: 'text', notNull: false },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumns('document_search_index', ['content_hash']);
};
