/**
 * Migration: Drop the yjs_state_vectors table (feature 023 US6, R9-3, FR-026).
 *
 * The table was write-once-never-read: storeUpdate wrote a state vector on the
 * first update of a document and nothing ever read it. Feature 023 removes every
 * writer (storeUpdate's first-update branch, clearDocument/clearAll DELETEs, the
 * onboarding welcome-doc reset); document birth is now just the first yjs_updates
 * row. Deploy R9-3 only AFTER the US6 code is fully rolled out (old pods still
 * write state vectors until then).
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.dropTable('yjs_state_vectors');
};

/**
 * Rollback migration. Recreates the (empty) table shape as it stood before the
 * drop — doc_guid PK, state_vector, clock, updated_at. No data is restored (the
 * table was write-once-never-read, so nothing depended on its contents).
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.createTable('yjs_state_vectors', {
    doc_guid: {
      type: 'uuid',
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
};
