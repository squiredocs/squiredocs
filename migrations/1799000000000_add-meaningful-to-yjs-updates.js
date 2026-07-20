/**
 * Migration: Add meaningful classification to yjs_updates (feature 023 US4, R9-1).
 *
 * Write-time meaningful-vs-noise classification: does this update change the
 * document's extractXml output? `true` = meaningful, `false` = noise (CRDT
 * bookkeeping), NULL = unknown. Nullable, NO default, NO in-migration backfill:
 * old pods during the rolling deploy write NULL legally (D-8), and every reader
 * treats NULL as meaningful (fail-visible — noise may temporarily appear, but a
 * real edit is never hidden, D-3). The one-time classification of historical
 * rows is done out-of-band by
 * server/scripts/backfill-meaningful-classification.js (idempotent, NULL-only).
 *
 * The timeline reads these exact rows already (WHERE doc_guid ORDER BY clock),
 * so no index and no side table — a column on the hot rows is the whole change.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('yjs_updates', {
    meaningful: { type: 'boolean', notNull: false },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumns('yjs_updates', ['meaningful']);
};
