/**
 * Migration: Enhance MCP auth for production OAuth flow
 *
 * This migration adds support for OAuth 2.0 authorization flow with PKCE:
 *
 * 1. Add refresh token support to agent_delegations
 * 2. Create registered_agents table (allowlist of known agents)
 * 3. Create mcp_auth_codes table (short-lived authorization codes)
 * 4. Add agent_client_id and agent_instance_id to agent_delegations
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // 1. Add refresh token support to delegations
  pgm.addColumns('agent_delegations', {
    refresh_token_hash: {
      type: 'varchar(64)',
      comment: 'SHA-256 hash of current refresh token',
    },
    refresh_token_version: {
      type: 'integer',
      notNull: true,
      default: 0,
      comment: 'Incremented on each refresh, enables rotation',
    },
    refresh_token_expires_at: {
      type: 'timestamptz',
      comment: 'When the refresh token expires',
    },
  });

  // 2. Create registered agents table
  pgm.createTable('registered_agents', {
    id: {
      type: 'varchar(64)',
      primaryKey: true,
      comment: 'Agent client ID (e.g., "claude-code")',
    },
    name: {
      type: 'varchar(255)',
      notNull: true,
      comment: 'Display name for consent screen',
    },
    description: {
      type: 'text',
      comment: 'Description shown during authorization',
    },
    icon_url: {
      type: 'varchar(512)',
      comment: 'URL to agent icon for consent screen',
    },
    allowed_scopes: {
      type: 'text[]',
      notNull: true,
      default: pgm.func("ARRAY['documents:read']"),
      comment: 'Maximum scopes this agent can request',
    },
    default_scopes: {
      type: 'text[]',
      notNull: true,
      default: pgm.func("ARRAY['documents:read']"),
      comment: 'Default scopes if none specified',
    },
    allowed_redirect_uris: {
      type: 'text[]',
      notNull: true,
      default: '{}',
      comment: 'Allowed redirect URIs for this agent',
    },
    is_public_client: {
      type: 'boolean',
      notNull: true,
      default: true,
      comment: 'True for clients that cannot keep secrets (CLI tools)',
    },
    client_secret_hash: {
      type: 'varchar(64)',
      comment: 'For confidential clients only',
    },
    is_enabled: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // 3. Create authorization codes table (short-lived, could use Redis instead)
  pgm.createTable('mcp_auth_codes', {
    code_hash: {
      type: 'varchar(64)',
      primaryKey: true,
      comment: 'SHA-256 hash of authorization code',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    agent_client_id: {
      type: 'varchar(64)',
      notNull: true,
      references: 'registered_agents(id)',
      onDelete: 'CASCADE',
    },
    agent_instance_id: {
      type: 'varchar(255)',
      comment: 'Unique identifier for this agent instance',
    },
    scopes: {
      type: 'text[]',
      notNull: true,
    },
    code_challenge: {
      type: 'varchar(128)',
      notNull: true,
      comment: 'PKCE code challenge',
    },
    code_challenge_method: {
      type: 'varchar(10)',
      notNull: true,
      default: 'S256',
    },
    redirect_uri: {
      type: 'varchar(512)',
      notNull: true,
    },
    expires_at: {
      type: 'timestamptz',
      notNull: true,
    },
    used_at: {
      type: 'timestamptz',
      comment: 'Set when code is exchanged (prevents reuse)',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Index for cleanup job
  pgm.createIndex('mcp_auth_codes', 'expires_at', {
    name: 'idx_mcp_auth_codes_expires',
  });

  // 4. Update agent_delegations to reference registered agent
  pgm.addColumns('agent_delegations', {
    agent_client_id: {
      type: 'varchar(64)',
      references: 'registered_agents(id)',
      onDelete: 'SET NULL',
      comment: 'Reference to registered agent (NULL for legacy delegations)',
    },
    agent_instance_id: {
      type: 'varchar(255)',
      comment: 'Unique identifier for this agent instance',
    },
  });

  // 5. Seed initial registered agents
  pgm.sql(`
    INSERT INTO registered_agents (id, name, description, allowed_scopes, default_scopes, allowed_redirect_uris, is_public_client)
    VALUES
      ('claude-code', 'Claude Code', 'AI coding assistant for VS Code and CLI',
       ARRAY['documents:read', 'documents:write'],
       ARRAY['documents:read', 'documents:write'],
       ARRAY['http://localhost:*', 'http://127.0.0.1:*', 'vscode://anthropic.claude-code/*'],
       true),
      ('claude-desktop', 'Claude Desktop', 'Claude AI desktop application',
       ARRAY['documents:read', 'documents:write'],
       ARRAY['documents:read'],
       ARRAY['http://localhost:*', 'http://127.0.0.1:*', 'claude://callback'],
       true)
    ON CONFLICT (id) DO NOTHING;
  `);

  // 6. Add table comments
  pgm.sql(`
    COMMENT ON TABLE registered_agents IS 'Allowlist of AI agents that can request authorization';
    COMMENT ON TABLE mcp_auth_codes IS 'Short-lived authorization codes for OAuth flow';
  `);
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('mcp_auth_codes');
  pgm.dropTable('registered_agents');
  pgm.dropColumns('agent_delegations', [
    'refresh_token_hash',
    'refresh_token_version',
    'refresh_token_expires_at',
    'agent_client_id',
    'agent_instance_id',
  ]);
};
