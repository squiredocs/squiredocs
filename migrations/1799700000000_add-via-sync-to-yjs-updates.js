/**
 * Migration: Add the via_sync channel marker to yjs_updates (feature 038 US2, D1).
 *
 * Records the TRANSPORT an update arrived on, never a verdict on authorship:
 * `true` = the update was produced during the synchronous application of a
 * SYNC_STEP2 frame (a reconnect catch-up reply), NULL = channel unknown.
 *
 * Nullable, NO default, NO backfill (D1): the channel of a historical row is
 * genuinely indistinguishable, and writing `false` across the log would assert a
 * certainty we do not have. Readers apply one uniform rule — only `true` means
 * sync; NULL and `false` are identical ("not known to be sync") and NULL is never
 * suspicious (D1/D5). Rolling-deploy safe for the same reason `meaningful` was
 * (023 D-8): old pods INSERT without the column and get a legal NULL.
 *
 * Attribution columns (user_id, agent_name) are untouched — via_sync is additive
 * channel metadata (FR-010). No index: readers already fetch these rows by
 * (doc_guid, clock).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('yjs_updates', {
    via_sync: { type: 'boolean', notNull: false },
  });
};

/**
 * Rollback migration (FR-016 — reversible).
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumns('yjs_updates', ['via_sync']);
};
