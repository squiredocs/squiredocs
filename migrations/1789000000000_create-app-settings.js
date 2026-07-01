/**
 * Migration: Create app_settings table
 * - A small key/value store for global, admin-editable configuration.
 * - First use: the shared-assistant default chat model ('shared_default_model'),
 *   editable from the Admin page (see server/api/app-settings.js). When unset,
 *   the model falls back to the AI_CHAT_MODEL env var / DEFAULT_MODEL_KEY constant.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('app_settings', {
    key: {
      type: 'text',
      primaryKey: true,
    },
    value: {
      type: 'text',
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('app_settings');
};
