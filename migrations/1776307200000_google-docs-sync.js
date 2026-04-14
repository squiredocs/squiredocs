/**
 * Migration: Google Docs sync infrastructure
 *
 * Creates two tables:
 * 1. connected_services — stores encrypted OAuth tokens for external service
 *    connections (Google Drive now, extensible for Gmail, Outlook, etc.)
 * 2. google_doc_links — persistent mapping between Squire docs and Google Docs
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Table 1: Connected external services
  pgm.createTable('connected_services', {
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
    service: {
      type: 'varchar(50)',
      notNull: true,
    },
    service_email: {
      type: 'varchar(255)',
    },
    refresh_token: {
      type: 'text',
      notNull: true,
    },
    key_version: {
      type: 'integer',
      notNull: true,
      default: 1,
    },
    token_status: {
      type: 'varchar(20)',
      default: "'active'",
    },
    error_message: {
      type: 'text',
    },
    expires_at: {
      type: 'timestamptz',
    },
    connected_at: {
      type: 'timestamptz',
      default: pgm.func('now()'),
    },
    last_used_at: {
      type: 'timestamptz',
    },
    revoked_at: {
      type: 'timestamptz',
    },
    created_at: {
      type: 'timestamptz',
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint('connected_services', 'connected_services_user_service_unique', {
    unique: ['user_id', 'service'],
  });

  pgm.createIndex('connected_services', ['user_id', 'service'], {
    where: 'revoked_at IS NULL',
    name: 'idx_connected_services_active',
  });

  // Apply the existing updated_at trigger
  pgm.sql(`
    CREATE TRIGGER update_connected_services_updated_at
      BEFORE UPDATE ON connected_services
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  // Table 2: Google Doc links (Squire doc <-> Google Doc mapping)
  pgm.createTable('google_doc_links', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    doc_id: {
      type: 'uuid',
      notNull: true,
      references: 'documents(id)',
      onDelete: 'CASCADE',
    },
    google_doc_id: {
      type: 'varchar(255)',
      notNull: true,
    },
    google_doc_url: {
      type: 'text',
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'CASCADE',
    },
    last_export_at: {
      type: 'timestamptz',
    },
    last_import_at: {
      type: 'timestamptz',
    },
    google_modified_time: {
      type: 'timestamptz',
    },
    created_at: {
      type: 'timestamptz',
      default: pgm.func('now()'),
    },
  });

  pgm.addConstraint('google_doc_links', 'google_doc_links_doc_gdoc_unique', {
    unique: ['doc_id', 'google_doc_id'],
  });

  pgm.createIndex('google_doc_links', ['user_id'], {
    name: 'idx_google_doc_links_user',
  });

  pgm.createIndex('google_doc_links', ['doc_id'], {
    name: 'idx_google_doc_links_doc',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('google_doc_links');
  pgm.dropTable('connected_services');
};
