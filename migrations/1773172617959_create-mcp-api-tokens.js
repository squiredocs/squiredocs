/**
 * Migration: Create MCP API tokens table
 *
 * Personal access tokens for MCP API access without OAuth flow.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('mcp_api_tokens', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    name: {
      type: 'varchar(255)',
      notNull: true,
    },
    token_prefix: {
      type: 'varchar(12)',
      notNull: true,
    },
    token_hash: {
      type: 'varchar(64)',
      notNull: true,
      unique: true,
    },
    scopes: {
      type: 'text[]',
      notNull: true,
      default: pgm.func("ARRAY['documents:read', 'documents:write']"),
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    last_used_at: {
      type: 'timestamptz',
    },
    revoked_at: {
      type: 'timestamptz',
    },
    expires_at: {
      type: 'timestamptz',
    },
  });

  pgm.createIndex('mcp_api_tokens', 'user_id', {
    name: 'idx_mcp_api_tokens_user_id',
  });

  pgm.sql(`
    CREATE INDEX idx_mcp_api_tokens_active
    ON mcp_api_tokens(token_hash)
    WHERE revoked_at IS NULL;
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('mcp_api_tokens');
};
