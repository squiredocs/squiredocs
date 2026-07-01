/**
 * Migration: Add OpenRouter BYOK key column
 * - Adds an encrypted OpenRouter API key column to the users table, mirroring the
 *   existing byok_anthropic_key / byok_google_key / byok_openai_key / byok_zai_key
 *   columns. OpenRouter is BYOK-only (no shared server key), like OpenAI and z.ai.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn('users', {
    byok_openrouter_key: { type: 'text', default: null },
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumn('users', 'byok_openrouter_key');
};
