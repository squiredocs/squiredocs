/**
 * Migration: Index yjs_updates (user_id, created_at) for last-activity lookups.
 *
 * The admin users list derives each user's last-activity timestamp with a
 * MAX(created_at) GROUP BY user_id over yjs_updates (~130k rows in prod and
 * growing with every edit). The existing idx_yjs_updates_user_id can find a
 * user's rows but still has to visit all of them to take the max; this
 * composite index makes the aggregate an index-only backward scan. Partial on
 * user_id IS NOT NULL — attribution-less rows can never win a per-user max,
 * and the admin query filters them out.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createIndex('yjs_updates', ['user_id', 'created_at'], {
    name: 'idx_yjs_updates_user_created',
    where: 'user_id IS NOT NULL',
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex('yjs_updates', ['user_id', 'created_at'], {
    name: 'idx_yjs_updates_user_created',
  });
};
