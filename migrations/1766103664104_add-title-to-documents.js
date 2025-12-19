const { PostgresPersistence } = require('../server/postgres-persistence');

/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * Disable transaction for this migration so we can run backfill after schema changes
 */
exports.noTransaction = true;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.up = async (pgm) => {
  // Add title column to documents table for denormalized storage
  // This improves performance by avoiding the need to reconstruct
  // full Yjs documents just to display document titles in lists

  // Use SQL directly to ensure it executes immediately
  await pgm.db.query(`
    ALTER TABLE documents ADD COLUMN title varchar(255);
  `);

  await pgm.db.query(`
    COMMENT ON COLUMN documents.title IS 'Document title (denormalized from Yjs meta.title for performance)';
  `);

  // Add index for faster sorting/searching by title
  await pgm.db.query(`
    CREATE INDEX documents_title_index ON documents (title);
  `);

  // Backfill titles from Yjs documents
  // This runs as part of the migration for automatic deployment
  console.log('\nBackfilling document titles...');

  try {
    // Get database config from environment
    const dbConfig = process.env.DATABASE_URL || {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'collab_db',
      user: process.env.DB_USER || process.env.USER || 'postgres',
      password: process.env.DB_PASSWORD || ''
    };

    const persistence = new PostgresPersistence(dbConfig);

    // Get all documents that need backfilling
    const result = await pgm.db.query(
      'SELECT id FROM documents WHERE title IS NULL ORDER BY created_at ASC'
    );

    const docsToBackfill = result.rows;
    console.log(`Found ${docsToBackfill.length} documents to backfill`);

    if (docsToBackfill.length === 0) {
      console.log('No documents need backfilling.');
      await persistence.destroy();
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    // Process each document
    for (let i = 0; i < docsToBackfill.length; i++) {
      const doc = docsToBackfill[i];
      const docId = doc.id;

      try {
        // Extract title from Yjs document
        const meta = await persistence.getDocumentMeta(docId);
        const title = meta.title || null;

        // Update the documents table
        await pgm.db.query(
          'UPDATE documents SET title = $1 WHERE id = $2',
          [title, docId]
        );

        successCount++;
        console.log(`[${i + 1}/${docsToBackfill.length}] ✓ ${docId}: "${title || '(no title)'}"`);
      } catch (error) {
        errorCount++;
        console.error(`[${i + 1}/${docsToBackfill.length}] ✗ ${docId}: ${error.message}`);
      }
    }

    console.log('\n=== Backfill Complete ===');
    console.log(`Success: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Total: ${docsToBackfill.length}`);

    await persistence.destroy();
  } catch (error) {
    console.error('Error during backfill:', error);
    // Don't fail the migration if backfill fails
    // Titles will be populated as documents are edited
    console.warn('Backfill failed, but migration will continue. Titles will populate as documents are edited.');
  }

  // Record the migration
  await pgm.db.query(`
    INSERT INTO pgmigrations (name, run_on) VALUES ('1766103664104_add-title-to-documents', NOW());
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.down = async (pgm) => {
  await pgm.db.query(`DROP INDEX IF EXISTS documents_title_index;`);
  await pgm.db.query(`ALTER TABLE documents DROP COLUMN IF EXISTS title;`);
  await pgm.db.query(`DELETE FROM pgmigrations WHERE name='1766103664104_add-title-to-documents';`);
};
