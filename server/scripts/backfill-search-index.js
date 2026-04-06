#!/usr/bin/env node
/**
 * Backfill Search Index — Embedding Generation
 *
 * Generates vector embeddings for documents that have tsvector but no embeddings.
 * The migration backfills tsvector; this script handles embedding backfill separately
 * since it requires API access and rate limiting.
 *
 * Usage: node server/scripts/backfill-search-index.js
 *
 * Requires GOOGLE_GENERATIVE_AI_API_KEY to be set.
 */
require('dotenv').config();

const { Pool } = require('pg');
const { PostgresPersistence } = require('../postgres-persistence');
const { toPlainText } = require('../mcp/yjs/serialization');
const { embedMany } = require('ai');
const { google } = require('@ai-sdk/google');

const CHUNK_SIZE = 6000;
const CHUNK_OVERLAP = 500;
const MIN_CHUNK_LENGTH = 100;
const DELAY_MS = 200;

function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (!text || text.length <= chunkSize) return text ? [text] : [];
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize - overlap) {
    const chunk = text.slice(i, i + chunkSize);
    if (chunk.trim().length >= MIN_CHUNK_LENGTH) chunks.push(chunk);
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    console.error('Error: GOOGLE_GENERATIVE_AI_API_KEY is required');
    process.exit(1);
  }

  const dbConfig = process.env.DATABASE_URL || {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'collab_db',
    user: process.env.DB_USER || process.env.USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  };

  const pool = new Pool(typeof dbConfig === 'string' ? { connectionString: dbConfig } : dbConfig);
  const persistence = new PostgresPersistence(dbConfig);

  try {
    // Find documents that need embedding backfill:
    // - Have a search index entry (tsvector) but no embedding rows
    // - Or have fewer embedding rows than expected (re-chunked)
    const result = await pool.query(`
      SELECT si.doc_id, d.title
      FROM document_search_index si
      JOIN documents d ON d.id = si.doc_id
      LEFT JOIN document_embeddings de ON de.doc_id = si.doc_id
      WHERE de.doc_id IS NULL
      ORDER BY d.updated_at DESC
    `);

    const docs = result.rows;
    console.log(`Found ${docs.length} documents needing embedding backfill\n`);

    if (docs.length === 0) {
      console.log('All documents already have embeddings. Nothing to do.');
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const progress = `[${i + 1}/${docs.length}]`;

      try {
        // Load document and extract text
        const ydoc = await persistence.getYDoc(doc.doc_id);
        const xmlFragment = ydoc.getXmlFragment('default');
        const contentText = toPlainText(xmlFragment);

        if (!contentText || contentText.trim().length === 0) {
          console.log(`${progress} ⊘ ${doc.doc_id}: "${doc.title || '(no title)'}" — empty content, skipping`);
          continue;
        }

        // Chunk and batch-embed (Gemini API limit: 100 texts per batch)
        const chunks = chunkText(contentText);
        const BATCH_SIZE = 100;
        const allEmbeddings = [];
        for (let b = 0; b < chunks.length; b += BATCH_SIZE) {
          const batch = chunks.slice(b, b + BATCH_SIZE);
          const { embeddings } = await embedMany({
            model: google.textEmbeddingModel('gemini-embedding-001'),
            values: batch,
            providerOptions: { google: { outputDimensionality: 1536 } },
          });
          allEmbeddings.push(...embeddings);
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM document_embeddings WHERE doc_id = $1', [doc.doc_id]);

          for (let j = 0; j < chunks.length; j++) {
            await client.query(
              `INSERT INTO document_embeddings (doc_id, chunk_index, chunk_text, embedding)
               VALUES ($1, $2, $3, $4)`,
              [doc.doc_id, j, chunks[j], JSON.stringify(allEmbeddings[j])]
            );
          }

          await client.query('COMMIT');
          successCount++;
          console.log(`${progress} ✓ ${doc.doc_id}: "${doc.title || '(no title)'}" — ${chunks.length} chunk(s), ${contentText.length} chars`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }

        // Rate limit between documents
        await sleep(DELAY_MS);
      } catch (err) {
        errorCount++;
        console.error(`${progress} ✗ ${doc.doc_id}: "${doc.title || '(no title)'}" — ${err.message}`);
      }
    }

    console.log('\n=== Embedding Backfill Complete ===');
    console.log(`Success: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Total: ${docs.length}`);
  } finally {
    await persistence.destroy();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
