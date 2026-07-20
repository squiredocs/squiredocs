/**
 * Migration: Drop document_versions.snapshot_data (feature 023 US3, R9-2, FR-013).
 *
 * Named versions become PURE clock-range labels — name, clock range, creator,
 * timestamps all preserved; only the content blob is dropped. Version content is
 * always the replay of yjs_updates to clock_end under the gap-tolerant read path
 * (replay is the sole source of truth). No content backfill: replay reproduces
 * the content, and a pre-023 diverged frozen blob heals silently to the replayed
 * truth by ratified design (D-6). Deploy R9-2 only AFTER the US3 code is fully
 * rolled out (old pods still INSERT snapshot_data until then — the column is
 * nullable, so their inserts stay legal right up to the drop).
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.dropColumns('document_versions', ['snapshot_data']);
};

/**
 * Rollback migration. Re-adds the column (nullable bytea); the historical
 * content is unrecoverable by ratified design — replay is truth.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.addColumns('document_versions', {
    snapshot_data: {
      type: 'bytea',
      notNull: false,
      comment: 'Removed in feature 023 — content is now always log replay. Re-added empty on rollback.',
    },
  });
};
