/**
 * Migration: Add z.ai BYOK key column
 * - Adds an encrypted z.ai (Zhipu GLM) API key column to the users table,
 *   mirroring the existing byok_anthropic_key / byok_google_key / byok_openai_key
 *   columns. z.ai is BYOK-only (no shared server key), like OpenAI.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn('users', {
    byok_zai_key: { type: 'text', default: null },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumn('users', 'byok_zai_key');
};
