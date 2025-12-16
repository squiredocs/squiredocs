/**
 * Migration: Create MCP agent delegation tables
 *
 * This migration creates tables to support AI agent authentication via OAuth delegation:
 *
 * 1. agent_delegations: Tracks which users have authorized which agents
 * 2. agent_activity_log: Audit log of all agent actions
 *
 * Mental model: Users delegate their permissions to AI agents. Agents act on behalf
 * of users with the same permissions, but actions are tracked separately.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Create agent_delegations table
  pgm.createTable('agent_delegations', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
      comment: 'User who delegated permissions to the agent',
    },
    agent_id: {
      type: 'varchar(255)',
      notNull: true,
      comment: 'Unique agent identifier (e.g., "claude-code:abc123")',
    },
    agent_name: {
      type: 'varchar(255)',
      notNull: true,
      comment: 'Human-readable agent name (e.g., "Claude Code")',
    },
    agent_metadata: {
      type: 'jsonb',
      notNull: false,
      default: '{}',
      comment: 'Additional agent information (version, capabilities, etc.)',
    },
    scopes: {
      type: 'text[]',
      notNull: true,
      default: pgm.func("ARRAY['documents:read', 'documents:write']"),
      comment: 'Granted scopes/permissions',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    last_used_at: {
      type: 'timestamptz',
      notNull: false,
      comment: 'Last time this delegation was used',
    },
    revoked_at: {
      type: 'timestamptz',
      notNull: false,
      comment: 'When the delegation was revoked (NULL = active)',
    },
    expires_at: {
      type: 'timestamptz',
      notNull: false,
      comment: 'When the delegation expires (NULL = no expiration)',
    },
  });

  // Unique constraint: one delegation per user-agent pair
  pgm.addConstraint('agent_delegations', 'agent_delegations_user_agent_unique', {
    unique: ['user_id', 'agent_id'],
  });

  // Indexes for fast lookups
  pgm.createIndex('agent_delegations', 'user_id', {
    name: 'idx_agent_delegations_user',
  });

  pgm.createIndex('agent_delegations', 'agent_id', {
    name: 'idx_agent_delegations_agent',
  });

  // Partial index for non-revoked delegations (expiration checked at query time)
  pgm.sql(`
    CREATE INDEX idx_agent_delegations_active
    ON agent_delegations(user_id, agent_id)
    WHERE revoked_at IS NULL;
  `);

  // Create agent_activity_log table
  pgm.createTable('agent_activity_log', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    delegation_id: {
      type: 'uuid',
      notNull: true,
      references: 'agent_delegations(id)',
      onDelete: 'CASCADE',
    },
    agent_id: {
      type: 'varchar(255)',
      notNull: true,
      comment: 'Agent identifier (denormalized for faster queries)',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
      comment: 'User on whose behalf the action was performed',
    },
    action: {
      type: 'varchar(100)',
      notNull: true,
      comment: 'Action type (e.g., "document:read", "document:update")',
    },
    doc_guid: {
      type: 'uuid',
      notNull: false,
      references: 'documents(id)',
      onDelete: 'SET NULL',
      comment: 'Document affected by the action (if applicable)',
    },
    metadata: {
      type: 'jsonb',
      notNull: false,
      default: '{}',
      comment: 'Additional action details (operation type, size, etc.)',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Indexes for common audit queries
  pgm.createIndex('agent_activity_log', ['user_id', 'created_at'], {
    name: 'idx_agent_activity_user_time',
  });

  pgm.createIndex('agent_activity_log', ['doc_guid', 'created_at'], {
    name: 'idx_agent_activity_doc_time',
  });

  pgm.createIndex('agent_activity_log', ['agent_id', 'created_at'], {
    name: 'idx_agent_activity_agent_time',
  });

  pgm.createIndex('agent_activity_log', 'created_at', {
    name: 'idx_agent_activity_time',
  });

  // Add comments to tables
  pgm.sql(`
    COMMENT ON TABLE agent_delegations IS 'OAuth delegations allowing AI agents to act on behalf of users';
    COMMENT ON TABLE agent_activity_log IS 'Audit log of all actions performed by AI agents';
  `);
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('agent_activity_log');
  pgm.dropTable('agent_delegations');
};
