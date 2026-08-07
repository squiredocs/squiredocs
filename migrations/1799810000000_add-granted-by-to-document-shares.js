/**
 * Migration: document_shares.granted_by — feature 053, design/spaces.md D8.
 *
 * Every share records who granted it. Three steps in ONE migration, therefore
 * ONE transaction (node-pg-migrate wraps a migration in a transaction by
 * default), so the column is never observably nullable-but-assumed-populated:
 *
 *   1. ADD COLUMN nullable. Instant on a live table — no rewrite, and the FK
 *      has nothing to validate yet.
 *   2. Backfill with the design's chain.
 *   3. SET NOT NULL.
 *
 * WHY THE CHAIN CANNOT YIELD NULL, in order:
 *   1. the document's current owner share — absent for an orphaned document;
 *   2. `documents.creator_id` — genuinely NULLABLE (migrations/007 sets it
 *      `ON DELETE SET NULL`), which is exactly why a third term is needed;
 *   3. the share's own `user_id` — NOT NULL since migrations/004, so the
 *      COALESCE always resolves and step 3 cannot fail.
 *
 * Backfilled values are the MOST LIKELY grantor, not a verified one (FR-033).
 * Only post-migration rows are exact.
 *
 * WHY NOT A SEPARATE BACKFILL SCRIPT (research R4): server/scripts/backfill-*
 * exists for backfills too heavy for a migration transaction (decoding every
 * CRDT update). This is one indexed UPDATE over a few thousand rows, and
 * splitting it from the constraint would buy nothing while losing atomicity —
 * a window where the column exists, is nullable, and new code assumes it is
 * populated.
 *
 * COUPLED CHANGE — NOT OPTIONAL (RBD-053-11): `granted_by` is NO ACTION, so
 * `deleteUserByEmail` (server/auth/users.js) MUST reassign rows granted by the
 * account being deleted to each document's current owner before its final
 * `DELETE FROM users`, or the synthetic wipe and the prod reset fail with a
 * foreign-key violation. That reassignment ships in the same change as this
 * migration; see server/__tests__/integration/faucet-wipe.test.js.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn('document_shares', {
    granted_by: {
      type: 'uuid',
      references: 'users(id)', // NO ACTION — a grantor may not vanish under a grant
    },
  });

  pgm.sql(`
    UPDATE document_shares ds
    SET granted_by = COALESCE(
      (SELECT o.user_id FROM document_shares o
        WHERE o.doc_id = ds.doc_id AND o.role = 'owner' LIMIT 1),
      (SELECT d.creator_id FROM documents d WHERE d.id = ds.doc_id),
      ds.user_id)
    WHERE ds.granted_by IS NULL;
  `);

  pgm.alterColumn('document_shares', 'granted_by', { notNull: true });
};

/**
 * Rollback migration. Forward-only in practice: dropping the column loses
 * attribution but breaks nothing.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumn('document_shares', 'granted_by');
};
