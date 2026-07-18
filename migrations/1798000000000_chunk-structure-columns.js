/**
 * Migration: chunk-structure columns on document_embeddings (feature 018, D1).
 *
 * Extends the existing chunk table in place — NO new table (RBD-2 decision):
 *   heading_path   TEXT[]   ordered h1→…→hN trail at chunk start ('{}' = unheaded)
 *   preamble_text  TEXT     1–3 generated situating sentences (NULL = absent)
 *   embedded_text  TEXT     the exact composed text that was embedded + FTS-indexed;
 *                           NULL marks a legacy fixed-window row (rollout discriminator)
 *   token_estimate INTEGER  ceil(len(embedded_text)/4), for recall@token-budget costing
 *   search_vector  TSVECTOR to_tsvector('english', embedded_text); feeds the
 *                           chunk-keyword leg (GIN indexed). NULL on legacy rows,
 *                           so they never match the chunk-keyword sub-select.
 *
 * All nullable, no backfill, no re-embedding here: legacy rows keep serving the
 * semantic leg until the background re-chunk (extended reindexStale) migrates
 * their documents (FR-011/SC-012). GIN creation is transactional (no HNSW
 * involved) — no noTransaction escape needed.
 *
 * Contract: specs/018-search-chunking-and-eval/contracts/chunk-record.md
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('document_embeddings', {
    heading_path: { type: 'text[]', notNull: false },
    preamble_text: { type: 'text', notNull: false },
    embedded_text: { type: 'text', notNull: false },
    token_estimate: { type: 'integer', notNull: false },
    search_vector: { type: 'tsvector', notNull: false },
  });

  pgm.createIndex('document_embeddings', 'search_vector', {
    name: 'idx_embeddings_search_vector_gin',
    method: 'gin',
  });
};

/**
 * Rollback migration — symmetric drop.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex('document_embeddings', 'search_vector', {
    name: 'idx_embeddings_search_vector_gin',
  });
  pgm.dropColumns('document_embeddings', [
    'heading_path',
    'preamble_text',
    'embedded_text',
    'token_estimate',
    'search_vector',
  ]);
};
