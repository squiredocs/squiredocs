/**
 * Migration: Create document_share_invites table for pending share invitations.
 * - A pending invite is created when a doc is shared with an email that does not
 *   yet belong to a registered user.
 * - On the invitee's first login, convertPendingInvites() (server/auth/users.js)
 *   turns each matching invite into a real document_shares row and deletes it.
 * - Matching is case-insensitive; uniqueness is enforced per (doc_id, lower(email)).
 * - ON DELETE CASCADE ties an invite's lifecycle to its document.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('document_share_invites', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    doc_id: {
      type: 'uuid',
      notNull: true,
      references: 'documents(id)',
      onDelete: 'CASCADE',
    },
    email: {
      type: 'text',
      notNull: true,
    },
    role: {
      type: 'doc_role',
      notNull: true,
    },
    invited_by_user_id: {
      type: 'uuid',
      references: 'users(id)',
      onDelete: 'SET NULL',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // One pending invite per (doc, email), case-insensitive on email.
  pgm.sql(
    'CREATE UNIQUE INDEX uq_invite_doc_lower_email ON document_share_invites (doc_id, lower(email))'
  );
  // Lookup used by the login-time conversion hook.
  pgm.sql(
    'CREATE INDEX idx_invite_lower_email ON document_share_invites (lower(email))'
  );
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable('document_share_invites');
};
