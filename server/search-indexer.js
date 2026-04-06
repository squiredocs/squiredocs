/**
 * Search Indexer
 *
 * Debounced pipeline that extracts text from Yjs documents,
 * generates tsvector for full-text search and embeddings for
 * vector/semantic search, and upserts into the search index tables.
 */
const { toPlainText } = require('./mcp/yjs/serialization');

let persistenceProvider = null;
let pool = null;

/** Map of docGuid -> setTimeout timer ID for debouncing */
const dirtyTimers = new Map();

/** Set of docGuids currently being indexed (concurrency guard) */
const indexingInProgress = new Set();

const DEBOUNCE_MS = 30_000;
const CHUNK_SIZE = 6000;
const CHUNK_OVERLAP = 500;
const MIN_CHUNK_LENGTH = 100;
const EMBEDDING_CONCURRENCY = 5;

// Shared embedding config — search.js imports these for query embeddings
// so document and query embeddings always use the same model/dimensions.
const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Initialize the search indexer with the persistence provider.
 */
function init(persistence) {
  persistenceProvider = persistence;
  pool = persistence.getPool();
}

/**
 * Mark a document as needing re-indexing. Debounces so rapid edits
 * don't trigger repeated indexing. Does NOT accept a ydoc reference —
 * the ydoc is loaded from persistence when the timer fires.
 */
function markDirty(docGuid) {
  if (!pool) return;

  // Reset existing timer if any
  if (dirtyTimers.has(docGuid)) {
    clearTimeout(dirtyTimers.get(docGuid));
  }

  const timer = setTimeout(() => {
    dirtyTimers.delete(docGuid);
    indexDocument(docGuid).catch((err) => {
      console.error(`[SearchIndexer] Failed to index ${docGuid}:`, err.message);
    });
  }, DEBOUNCE_MS);

  dirtyTimers.set(docGuid, timer);
}

/**
 * Split text into overlapping chunks for embedding.
 */
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (!text || text.length <= chunkSize) return text ? [text] : [];
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize - overlap) {
    const chunk = text.slice(i, i + chunkSize);
    if (chunk.trim().length >= MIN_CHUNK_LENGTH) chunks.push(chunk);
  }
  return chunks;
}

/**
 * Index a single document: extract text, generate tsvector, generate embeddings.
 */
async function indexDocument(docGuid) {
  if (!persistenceProvider || !pool) return;
  if (indexingInProgress.has(docGuid)) return; // already indexing

  indexingInProgress.add(docGuid);
  try {
    // Load the document from persistence (always has latest data)
    const ydoc = await persistenceProvider.getYDoc(docGuid);
    const xmlFragment = ydoc.getXmlFragment('default');
    const contentText = toPlainText(xmlFragment);
    const title = ydoc.getMap('meta').get('title') || '';

    // Step 1: Upsert FTS index (always succeeds, no external API)
    await pool.query(
      `INSERT INTO document_search_index (doc_id, content_text, search_vector, indexed_at)
       VALUES ($1, $2,
         setweight(to_tsvector('english', COALESCE($3, '')), 'A') ||
         setweight(to_tsvector('english', COALESCE($2, '')), 'B'),
         now())
       ON CONFLICT (doc_id) DO UPDATE SET
         content_text = EXCLUDED.content_text,
         search_vector = EXCLUDED.search_vector,
         indexed_at = EXCLUDED.indexed_at`,
      [docGuid, contentText, title]
    );

    // Step 2: Generate and store chunk embeddings (may fail — FTS still works)
    await generateAndStoreEmbeddings(docGuid, contentText).catch((err) => {
      console.warn(`[SearchIndexer] Embedding generation failed for ${docGuid}, FTS still indexed:`, err.message);
    });

    console.log(`[SearchIndexer] Indexed ${docGuid}: "${title}" (${contentText.length} chars)`);
  } finally {
    indexingInProgress.delete(docGuid);
  }
}

/**
 * Generate embeddings for document chunks and store them.
 */
async function generateAndStoreEmbeddings(docGuid, contentText) {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) return;

  const { embedMany } = require('ai');
  const { google } = require('@ai-sdk/google');

  const chunks = chunkText(contentText);
  if (chunks.length === 0) return;

  // Gemini API limit: 100 texts per batch request
  const BATCH_SIZE = 100;
  const allEmbeddings = [];
  for (let b = 0; b < chunks.length; b += BATCH_SIZE) {
    const batch = chunks.slice(b, b + BATCH_SIZE);
    const { embeddings } = await embedMany({
      model: google.textEmbeddingModel(EMBEDDING_MODEL),
      values: batch,
      providerOptions: { google: { outputDimensionality: EMBEDDING_DIMENSIONS } },
    });
    allEmbeddings.push(...embeddings);
  }

  // Delete old chunks, then insert new ones
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM document_embeddings WHERE doc_id = $1', [docGuid]);

    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO document_embeddings (doc_id, chunk_index, chunk_text, embedding)
         VALUES ($1, $2, $3, $4)`,
        [docGuid, i, chunks[i], JSON.stringify(allEmbeddings[i])]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Re-index documents that are stale (indexed_at < updated_at) or missing
 * from the search index. Called on server startup after a delay.
 */
async function reindexStale() {
  if (!pool) return;

  try {
    // Find documents missing from the search index or with stale indexed_at
    const result = await pool.query(`
      SELECT d.id FROM documents d
      LEFT JOIN document_search_index si ON si.doc_id = d.id
      WHERE si.doc_id IS NULL OR si.indexed_at < d.updated_at
      ORDER BY d.updated_at DESC
    `);

    const stale = result.rows;
    if (stale.length === 0) return;

    console.log(`[SearchIndexer] Found ${stale.length} stale documents to re-index`);

    // Process in batches with concurrency limit
    for (let i = 0; i < stale.length; i += EMBEDDING_CONCURRENCY) {
      const batch = stale.slice(i, i + EMBEDDING_CONCURRENCY);
      await Promise.allSettled(
        batch.map((doc) => indexDocument(doc.id))
      );
    }

    console.log(`[SearchIndexer] Stale re-indexing complete`);
  } catch (err) {
    console.error('[SearchIndexer] reindexStale failed:', err.message);
  }
}

/**
 * Immediately process all pending dirty documents. For testing only.
 */
async function flushDirty() {
  const pending = [...dirtyTimers.keys()];
  for (const docGuid of pending) {
    clearTimeout(dirtyTimers.get(docGuid));
    dirtyTimers.delete(docGuid);
  }
  await Promise.allSettled(pending.map((docGuid) => indexDocument(docGuid)));
}

module.exports = { init, markDirty, indexDocument, reindexStale, flushDirty, chunkText, generateAndStoreEmbeddings, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
