/**
 * Migration: Add Claude.ai OAuth redirect URIs
 *
 * Claude Desktop's OAuth proxy uses claude.ai/claude.com callback URLs.
 * This migration adds those URLs to the allowed redirect URIs.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Update claude-desktop agent to include claude.ai redirect URIs
  pgm.sql(`
    UPDATE registered_agents
    SET allowed_redirect_uris = ARRAY[
      'http://localhost:*',
      'http://127.0.0.1:*',
      'claude://callback',
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/api/mcp/auth_callback'
    ]
    WHERE id = 'claude-desktop';
  `);
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  // Restore original redirect URIs
  pgm.sql(`
    UPDATE registered_agents
    SET allowed_redirect_uris = ARRAY[
      'http://localhost:*',
      'http://127.0.0.1:*',
      'claude://callback'
    ]
    WHERE id = 'claude-desktop';
  `);
};
