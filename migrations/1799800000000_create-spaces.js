/**
 * Migration: Spaces (shared team workspaces) — feature 053, design/spaces.md D1/D2/D8.
 *
 * Adds the three tables a space is made of, plus the one column that gives a
 * document a home:
 *
 *   spaces         — the container. `created_by` is AUDIT ONLY: the owner of a
 *                    space is a `space_members` row with role 'owner', never
 *                    this column, which is why it is nullable/SET NULL.
 *   space_members  — (space, user) → role, reusing the existing `doc_role` enum
 *                    (D2). `granted_by` is NOT NULL / NO ACTION (D8): every
 *                    grant is attributable and a grantor can never be silently
 *                    cascade-deleted out from under it. The account-deletion
 *                    path (server/auth/users.js deleteUserByEmail) reassigns
 *                    these rows to the space's current owner before deleting a
 *                    user — see RBD-053-11.
 *   space_invites  — pending invites for addresses with no account yet, matched
 *                    case-insensitively. Byte-for-byte the index pair from
 *                    migrations/1787000000000_create-document-share-invites.js,
 *                    because login-time conversion scans by lower(email) across
 *                    every space.
 *
 * documents.space_id: NULL means personal, which is the state of every existing
 * row (D1 — one home per document). `ON DELETE SET NULL` IS the space-deletion
 * semantic required by FR-024: deleting a space reverts its documents to
 * personal and DELETES NO DOCUMENT. That behavior is a foreign-key action, not
 * application code, so it cannot be forgotten by a future delete path.
 *
 * Effective role (the union of a direct share and a space membership) is NOT
 * computed here — it lives in exactly one place, the `document_access` view
 * created by migration 1799820000000.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable('spaces', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    name: {
      type: 'varchar(100)',
      notNull: true,
    },
    // Audit only. Ownership is a space_members row; SET NULL so deleting the
    // creator's account never deletes a space other people are still using.
    created_by: {
      type: 'uuid',
      references: 'users(id)',
      onDelete: 'SET NULL',
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

  // Same auto-updated_at trigger the documents table uses (migrations/004).
  pgm.sql(`
    CREATE TRIGGER update_spaces_updated_at
    BEFORE UPDATE ON spaces
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  `);

  pgm.createTable('space_members', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    space_id: {
      type: 'uuid',
      notNull: true,
      references: 'spaces(id)',
      onDelete: 'CASCADE',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    role: {
      type: 'doc_role',
      notNull: true,
    },
    // D8/FR-036. NO ACTION (the default) on purpose: a grantor may not vanish
    // while the grant stands. deleteUserByEmail reassigns instead.
    granted_by: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // At most one membership per (space, user) — invariant I4. Also the index the
  // document_access view's space leg rides (d.space_id + sm.user_id).
  pgm.addConstraint('space_members', 'space_members_space_user_unique', {
    unique: ['space_id', 'user_id'],
  });
  // Postgres does not auto-index foreign keys, and user_id is the hot lookup
  // for both "my spaces" and the search-shaped access join, where user_id is
  // the only bound value.
  pgm.createIndex('space_members', 'user_id', { name: 'idx_space_members_user_id' });

  pgm.createTable('space_invites', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    space_id: {
      type: 'uuid',
      notNull: true,
      references: 'spaces(id)',
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
    // Nullable by decision (FR-036), mirroring document_share_invites: an
    // invite may outlive its inviter's account. Conversion falls back through
    // COALESCE so the resulting membership still carries a NOT NULL grantor.
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

  // One pending invite per (space, email), case-insensitive — invariant I5.
  pgm.sql(
    'CREATE UNIQUE INDEX uq_space_invite_space_lower_email ON space_invites (space_id, lower(email))'
  );
  // Lookup used by the login-time conversion hook, across all spaces.
  pgm.sql(
    'CREATE INDEX idx_space_invite_lower_email ON space_invites (lower(email))'
  );

  pgm.addColumn('documents', {
    space_id: {
      type: 'uuid',
      references: 'spaces(id)',
      onDelete: 'SET NULL',
    },
  });
  pgm.createIndex('documents', 'space_id', { name: 'idx_documents_space_id' });
};

/**
 * Rollback migration
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex('documents', 'space_id', { name: 'idx_documents_space_id' });
  pgm.dropColumn('documents', 'space_id');
  pgm.dropTable('space_invites');
  pgm.dropTable('space_members');
  pgm.sql('DROP TRIGGER IF EXISTS update_spaces_updated_at ON spaces');
  pgm.dropTable('spaces');
};
