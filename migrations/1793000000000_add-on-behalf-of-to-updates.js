/**
 * Migration: add on_behalf_of provenance to yjs_updates (feature 004, D8).
 *
 * Two-way sync pushes (mode=sync) may carry optional on-behalf-of metadata
 * ({name?, email?, commit?, url?}) supplied by the sync tooling. Version-history
 * entries derive per yjs_updates row, which carries only user_id + agent_name
 * (TEXT) and no free-form metadata column — so structured, per-entry provenance
 * needs a durable home. This nullable JSONB column is the minimum satisfaction:
 * additive, no default, no backfill, no index. Written only by sync pushes
 * (null for every other caller); read by the version-history query path.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn('yjs_updates', {
    on_behalf_of: { type: 'jsonb', default: null, notNull: false },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumn('yjs_updates', 'on_behalf_of');
};
