/**
 * Migration: Add the admin-set per-user chat model override column (feature 035,
 * FR-001/FR-004).
 *
 * NULL — the value every existing and every newly created account has — means
 * "follow the shared default DYNAMICALLY": the admin's app_settings default (then
 * AI_CHAT_MODEL, then DEFAULT_MODEL_KEY) is resolved fresh on every turn. The
 * default is never snapshotted onto a user row, so changing it moves every
 * un-pinned account at once.
 *
 * Deliberately:
 *   - no DEFAULT and no backfill — ADD COLUMN leaves every existing row NULL,
 *     which is exactly the required post-deploy state (US2 acceptance 4);
 *   - no CHECK / enum / FK — the legal values are a CODE-side registry
 *     (MODEL_DEFS in server/api/chat-models.js) whose eligibility additionally
 *     depends on which shared provider keys this deployment holds. A DB-side
 *     constraint would have to be migrated on every registry change and would
 *     turn a withdrawn provider key into a write error (research R2). Validation
 *     lives in the admin endpoint; resolution-time fallback covers values that
 *     go stale after they were stored (FR-006).
 *   - no index — the column is only ever read from a row already being fetched
 *     by primary key (the per-turn user-settings SELECT).
 *
 * Timestamp 1799500000000 > the current latest migration 1799400000000
 * (add-auth-ip-capture), satisfying node-pg-migrate checkOrder, and trivially
 * clears the stale >1795000000000 rolled-back-008 floor.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('users', {
    chat_model_override: {
      type: 'text',
      notNull: false,
    },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumns('users', ['chat_model_override']);
};
