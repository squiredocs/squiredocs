/**
 * Migration: Add OpenAI BYOK key column
 * - Adds an encrypted OpenAI API key column to the users table, mirroring the
 *   existing byok_anthropic_key / byok_google_key columns.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn('users', {
    byok_openai_key: { type: 'text', default: null },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumn('users', 'byok_openai_key');
};
