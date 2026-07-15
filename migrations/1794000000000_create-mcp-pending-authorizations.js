/**
 * Migration: Create mcp_pending_authorizations table (feature 008-mcp-login-bootstrap).
 *
 * The short-lived record binding one MCP `login` call to one eventual human
 * decision (device-authorization-style onboarding). No secrets in plaintext:
 * the handle and the user code are stored only as SHA-256 hex digests.
 *
 * State machine: pending → approved | denied | expired; approved → claimed |
 * expired (lazy). Every consuming transition is a single conditional
 * `UPDATE … RETURNING`; one-shot semantics are enforced by the partial unique
 * index on the outstanding code and by the NULL-guarded predicates.
 *
 * FKs: `delegation_id` → agent_delegations ON DELETE SET NULL (soft-revocation
 * is the real mechanism, mirroring the minted-by columns precedent);
 * `entered_by_user_id` / `approved_by_user_id` → users ON DELETE CASCADE.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('mcp_pending_authorizations', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    handle_hash: {
      type: 'text',
      notNull: true,
      unique: true,
    },
    user_code_hash: {
      type: 'text',
      notNull: true,
    },
    agent_name: {
      type: 'text',
      notNull: true,
    },
    state: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "state IN ('pending', 'approved', 'denied', 'expired', 'claimed')",
    },
    origin_ip: {
      type: 'inet',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    expires_at: {
      type: 'timestamptz',
      notNull: true,
    },
    code_entered_at: {
      type: 'timestamptz',
    },
    entered_by_user_id: {
      type: 'uuid',
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    approved_at: {
      type: 'timestamptz',
    },
    approved_by_user_id: {
      type: 'uuid',
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    delegation_id: {
      type: 'uuid',
      references: 'agent_delegations(id)',
      onDelete: 'SET NULL',
    },
    claim_expires_at: {
      type: 'timestamptz',
    },
    payload_delivered_at: {
      type: 'timestamptz',
    },
    claimed_at: {
      type: 'timestamptz',
    },
    claim_channel: {
      type: 'text',
      check: "claim_channel IN ('rest', 'inline')",
    },
    last_polled_at: {
      type: 'timestamptz',
    },
    required_poll_interval_seconds: {
      type: 'integer',
      notNull: true,
      default: 5,
    },
  });

  // Outstanding-code uniqueness (FR-009): a code is unique only among pending
  // rows; consumed/terminal rows free the code up. Insert retries on conflict.
  pgm.sql(`
    CREATE UNIQUE INDEX idx_mcp_pending_auth_user_code_pending
    ON mcp_pending_authorizations (user_code_hash)
    WHERE state = 'pending';
  `);

  // Per-IP outstanding cap count (FR-024) — only pending rows count.
  pgm.sql(`
    CREATE INDEX idx_mcp_pending_auth_origin_ip_pending
    ON mcp_pending_authorizations (origin_ip)
    WHERE state = 'pending';
  `);

  // Lazy auto-revoke sweep: find approved rows whose claim window has lapsed.
  pgm.sql(`
    CREATE INDEX idx_mcp_pending_auth_approved_claim_expires
    ON mcp_pending_authorizations (state, claim_expires_at)
    WHERE state = 'approved';
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('mcp_pending_authorizations');
};
