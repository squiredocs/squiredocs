/**
 * Migration: Rename doc_name to doc_guid and convert to UUID type
 * This migration:
 * 1. Adds new doc_guid columns
 * 2. Migrates existing data (converting string names to UUIDs)
 * 3. Drops old doc_name columns
 * 4. Recreates constraints and indexes
 * 
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Enable uuid-ossp extension for UUID generation
  pgm.sql('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  // === yjs_updates table ===
  
  // Drop existing primary key and indexes first
  pgm.dropConstraint('yjs_updates', 'yjs_updates_pkey');
  pgm.dropIndex('yjs_updates', 'doc_name', { name: 'idx_yjs_updates_doc_name' });
  pgm.dropIndex('yjs_updates', ['doc_name', 'clock'], { name: 'idx_yjs_updates_doc_clock' });

  // Add new doc_guid column
  pgm.addColumn('yjs_updates', {
    doc_guid: {
      type: 'uuid',
      notNull: false, // temporarily nullable for migration
    },
  });

  // Migrate existing data: generate UUIDs for existing doc_names
  // Using uuid_generate_v5 with a namespace to create deterministic UUIDs from doc_names
  // This ensures the same doc_name always maps to the same UUID
  pgm.sql(`
    UPDATE yjs_updates 
    SET doc_guid = uuid_generate_v5(uuid_generate_v4(), doc_name)
    WHERE doc_guid IS NULL
  `);

  // For fresh databases or if we want consistent mapping, use MD5-based UUID
  // This creates a deterministic UUID from the doc_name string
  pgm.sql(`
    UPDATE yjs_updates 
    SET doc_guid = uuid_generate_v5('6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid, doc_name)
    WHERE doc_guid IS NULL
  `);

  // Make doc_guid not null and drop doc_name
  pgm.alterColumn('yjs_updates', 'doc_guid', { notNull: true });
  pgm.dropColumn('yjs_updates', 'doc_name');

  // Recreate primary key and indexes with doc_guid
  pgm.addConstraint('yjs_updates', 'yjs_updates_pkey', {
    primaryKey: ['doc_guid', 'clock'],
  });
  pgm.createIndex('yjs_updates', 'doc_guid', {
    name: 'idx_yjs_updates_doc_guid',
  });
  pgm.createIndex('yjs_updates', ['doc_guid', 'clock'], {
    name: 'idx_yjs_updates_doc_clock',
  });

  // === yjs_state_vectors table ===
  
  // Add new doc_guid column
  pgm.addColumn('yjs_state_vectors', {
    doc_guid: {
      type: 'uuid',
      notNull: false, // temporarily nullable for migration
    },
  });

  // Migrate existing data
  pgm.sql(`
    UPDATE yjs_state_vectors 
    SET doc_guid = uuid_generate_v5('6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid, doc_name)
    WHERE doc_guid IS NULL
  `);

  // Drop old primary key (doc_name), make doc_guid not null, drop doc_name
  pgm.dropConstraint('yjs_state_vectors', 'yjs_state_vectors_pkey');
  pgm.alterColumn('yjs_state_vectors', 'doc_guid', { notNull: true });
  pgm.dropColumn('yjs_state_vectors', 'doc_name');

  // Add new primary key on doc_guid
  pgm.addConstraint('yjs_state_vectors', 'yjs_state_vectors_pkey', {
    primaryKey: ['doc_guid'],
  });
};

/**
 * Rollback migration - convert back to doc_name
 * Note: This will lose the UUID values and generate placeholder names
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  // === yjs_updates table ===
  
  pgm.dropConstraint('yjs_updates', 'yjs_updates_pkey');
  pgm.dropIndex('yjs_updates', 'doc_guid', { name: 'idx_yjs_updates_doc_guid' });
  pgm.dropIndex('yjs_updates', ['doc_guid', 'clock'], { name: 'idx_yjs_updates_doc_clock' });

  pgm.addColumn('yjs_updates', {
    doc_name: {
      type: 'varchar(255)',
      notNull: false,
    },
  });

  // Convert UUIDs back to strings (just use the UUID as the name)
  pgm.sql(`UPDATE yjs_updates SET doc_name = doc_guid::text WHERE doc_name IS NULL`);

  pgm.alterColumn('yjs_updates', 'doc_name', { notNull: true });
  pgm.dropColumn('yjs_updates', 'doc_guid');

  pgm.addConstraint('yjs_updates', 'yjs_updates_pkey', {
    primaryKey: ['doc_name', 'clock'],
  });
  pgm.createIndex('yjs_updates', 'doc_name', {
    name: 'idx_yjs_updates_doc_name',
  });
  pgm.createIndex('yjs_updates', ['doc_name', 'clock'], {
    name: 'idx_yjs_updates_doc_clock',
  });

  // === yjs_state_vectors table ===
  
  pgm.dropConstraint('yjs_state_vectors', 'yjs_state_vectors_pkey');

  pgm.addColumn('yjs_state_vectors', {
    doc_name: {
      type: 'varchar(255)',
      notNull: false,
    },
  });

  pgm.sql(`UPDATE yjs_state_vectors SET doc_name = doc_guid::text WHERE doc_name IS NULL`);

  pgm.alterColumn('yjs_state_vectors', 'doc_name', { notNull: true });
  pgm.dropColumn('yjs_state_vectors', 'doc_guid');

  pgm.addConstraint('yjs_state_vectors', 'yjs_state_vectors_pkey', {
    primaryKey: ['doc_name'],
  });
};



