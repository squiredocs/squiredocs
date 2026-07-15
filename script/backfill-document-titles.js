#!/usr/bin/env node

/**
 * Backfill document titles from Yjs documents to the documents table
 *
 * This script:
 * 1. Finds all documents with NULL titles
 * 2. Reconstructs each Yjs document
 * 3. Extracts the title from meta.title
 * 4. Updates the documents table
 *
 * Run after the add-title-to-documents migration:
 * node script/backfill-document-titles.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const { PostgresPersistence } = require('../server/postgres-persistence');

const POSTGRES_CONFIG = process.env.DATABASE_URL || {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'collab_db',
  user: process.env.DB_USER || process.env.USER || 'postgres',
  password: process.env.DB_PASSWORD || ''
};

async function backfillTitles() {
  const pool = new Pool(
    typeof POSTGRES_CONFIG === 'string'
      ? { connectionString: POSTGRES_CONFIG }
      : POSTGRES_CONFIG
  );

  const persistence = new PostgresPersistence(POSTGRES_CONFIG, { statementTimeout: false });

  try {
    // Get all documents that need titles backfilled
    const result = await pool.query(
      'SELECT id FROM documents WHERE title IS NULL ORDER BY created_at ASC'
    );

    const docsToBackfill = result.rows;
    console.log(`Found ${docsToBackfill.length} documents to backfill`);

    if (docsToBackfill.length === 0) {
      console.log('No documents need backfilling. Done!');
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
        await pool.query(
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

  } catch (error) {
    console.error('Error during backfill:', error);
    process.exit(1);
  } finally {
    await pool.end();
    await persistence.destroy();
  }
}

// Run the backfill
backfillTitles().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
