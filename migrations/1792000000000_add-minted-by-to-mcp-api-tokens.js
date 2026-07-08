/**
 * Migration: Add minted-by provenance columns to mcp_api_tokens
 *
 * Temporary tokens minted by the create_access_token MCP tool record which
 * credential created them: an OAuth delegation (agent JWT principal) or a
 * parent API token (PAT principal). The columns drive the write-time
 * revocation cascade (revoking the minter revokes its children) and the
 * per-minter cap. ON DELETE SET NULL, not CASCADE: soft-revocation
 * (revoked_at) is the real mechanism; a hard delete of the parent row must
 * not hard-delete child tokens.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns('mcp_api_tokens', {
    minted_by_delegation_id: {
      type: 'uuid',
      references: 'agent_delegations(id)',
      onDelete: 'SET NULL',
    },
    minted_by_api_token_id: {
      type: 'uuid',
      references: 'mcp_api_tokens(id)',
      onDelete: 'SET NULL',
    },
  });

  // Partial indexes for the cascade UPDATEs and per-minter cap counts, which
  // only ever look at active (unrevoked) minted rows.
  pgm.sql(`
    CREATE INDEX idx_mcp_api_tokens_minted_by_delegation
    ON mcp_api_tokens(minted_by_delegation_id)
    WHERE revoked_at IS NULL AND minted_by_delegation_id IS NOT NULL;
  `);
  pgm.sql(`
    CREATE INDEX idx_mcp_api_tokens_minted_by_api_token
    ON mcp_api_tokens(minted_by_api_token_id)
    WHERE revoked_at IS NULL AND minted_by_api_token_id IS NOT NULL;
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumns('mcp_api_tokens', [
    'minted_by_delegation_id',
    'minted_by_api_token_id',
  ]);
};
