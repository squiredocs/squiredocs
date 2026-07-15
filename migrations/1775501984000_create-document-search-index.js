const { PostgresPersistence } = require('../server/postgres-persistence');
const { toPlainText } = require('../server/mcp/yjs/serialization');

exports.shorthands = undefined;

/**
 * Disable transaction so we can run the backfill after schema changes
 */
exports.noTransaction = true;

exports.up = async (pgm) => {
  // Enable pgvector extension for vector similarity search
  await pgm.db.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  // Full-text search index — one row per document
  await pgm.db.query(`
    CREATE TABLE document_search_index (
      doc_id        UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      content_text  TEXT,
      search_vector TSVECTOR,
      indexed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Vector embeddings — one row per chunk for semantic search
  await pgm.db.query(`
    CREATE TABLE document_embeddings (
      id              SERIAL PRIMARY KEY,
      doc_id          UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index     INTEGER NOT NULL,
      chunk_text      TEXT NOT NULL,
      embedding       VECTOR(1536),
      embedding_model VARCHAR(100) DEFAULT 'gemini-embedding-001',
      UNIQUE(doc_id, chunk_index)
    );
  `);

  // GIN index for full-text search
  await pgm.db.query(`CREATE INDEX idx_search_vector_gin ON document_search_index USING GIN (search_vector);`);

  // HNSW index for vector cosine similarity
  await pgm.db.query(`CREATE INDEX idx_embeddings_hnsw ON document_embeddings USING hnsw (embedding vector_cosine_ops);`);

  // Lookup embeddings by document
  await pgm.db.query(`CREATE INDEX idx_embeddings_doc_id ON document_embeddings (doc_id);`);

  // Find stale index entries
  await pgm.db.query(`CREATE INDEX idx_search_indexed_at ON document_search_index (indexed_at);`);

  // Backfill tsvector for existing documents (not embeddings — those require API calls)
  console.log('\nBackfilling search index (tsvector only)...');

  try {
    const dbConfig = process.env.DATABASE_URL || {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'collab_db',
      user: process.env.DB_USER || process.env.USER || 'postgres',
      password: process.env.DB_PASSWORD || ''
    };

    // Opt out of the per-session statement_timeout: this backfill walks the full
    // update log and can legitimately exceed the 30s runtime cap on a large
    // restore (feature 010 review F6). Runtime app sessions keep the timeout.
    const persistence = new PostgresPersistence(dbConfig, { statementTimeout: false });

    const result = await pgm.db.query(
      'SELECT id, title FROM documents ORDER BY created_at ASC'
    );

    const docs = result.rows;
    console.log(`Found ${docs.length} documents to index`);

    if (docs.length === 0) {
      console.log('No documents to index.');
      await persistence.destroy();
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      try {
        const ydoc = await persistence.getYDoc(doc.id);
        const xmlFragment = ydoc.getXmlFragment('default');
        const contentText = toPlainText(xmlFragment);
        const title = doc.title || '';

        await pgm.db.query(
          `INSERT INTO document_search_index (doc_id, content_text, search_vector, indexed_at)
           VALUES ($1, $2,
             setweight(to_tsvector('english', COALESCE($3, '')), 'A') ||
             setweight(to_tsvector('english', COALESCE($2, '')), 'B'),
             now())
           ON CONFLICT (doc_id) DO NOTHING`,
          [doc.id, contentText, title]
        );

        successCount++;
        console.log(`[${i + 1}/${docs.length}] ✓ ${doc.id}: "${title || '(no title)'}" (${contentText.length} chars)`);
      } catch (error) {
        errorCount++;
        console.error(`[${i + 1}/${docs.length}] ✗ ${doc.id}: ${error.message}`);
      }
    }

    console.log('\n=== Search Index Backfill Complete ===');
    console.log(`Success: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Total: ${docs.length}`);
    console.log('Note: Embeddings not backfilled. Run `node server/scripts/backfill-search-index.js` to generate embeddings.');

    await persistence.destroy();
  } catch (error) {
    console.error('Error during backfill:', error);
    console.warn('Backfill failed, but migration will continue. Index will populate as documents are edited.');
  }
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS document_embeddings;`);
  await pgm.db.query(`DROP TABLE IF EXISTS document_search_index;`);
  // Don't drop the vector extension — other things may depend on it
};
