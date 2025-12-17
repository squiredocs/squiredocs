/**
 * Migration: Add agent_name to yjs_updates
 * - Add agent_name column to track when updates are made by AI agents
 * - Agent name format: "Agent Name (Human Name)" e.g. "Claude Desktop (Sam Goldstein)"
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Add agent_name column to yjs_updates for tracking AI agent authorship
  pgm.addColumn('yjs_updates', {
    agent_name: {
      type: 'varchar(255)',
      comment: 'Name of AI agent if update was made by an agent (null = human user)',
    },
  });

  // Index for efficient agent queries
  pgm.createIndex('yjs_updates', 'agent_name', {
    name: 'idx_yjs_updates_agent_name',
    where: 'agent_name IS NOT NULL',
  });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex('yjs_updates', 'agent_name', { name: 'idx_yjs_updates_agent_name' });
  pgm.dropColumn('yjs_updates', 'agent_name');
};
