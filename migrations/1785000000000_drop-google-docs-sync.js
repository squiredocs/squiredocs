/**
 * Migration: Drop Google Docs sync infrastructure
 *
 * Removes the Google Drive integration tables created in
 * 1776307200000_google-docs-sync.js:
 * 1. google_doc_links  — Squire doc <-> Google Doc mapping
 * 2. connected_services — encrypted OAuth tokens for external services
 *
 * The integration was removed entirely (it required the broad restricted-tier
 * `drive` OAuth scope). `down` recreates the tables so the migration is
 * reversible if the integration is reintroduced later.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Trigger must be dropped before its table (DROP TABLE drops it too, but be
  // explicit so the intent is clear and it's safe if the table is dropped CASCADE).
  pgm.sql('DROP TRIGGER IF EXISTS update_connected_services_updated_at ON connected_services;');
  pgm.dropTable('google_doc_links');
  pgm.dropTable('connected_services');
};

exports.down = (pgm) => {
  // Recreate connected_services (mirrors 1776307200000_google-docs-sync.js)
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

  pgm.sql(`
    CREATE TRIGGER update_connected_services_updated_at
      BEFORE UPDATE ON connected_services
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  `);

  // Recreate google_doc_links (mirrors 1776307200000_google-docs-sync.js)
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
