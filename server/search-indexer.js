/**
 * Search Indexer
 *
 * Debounced pipeline that extracts text from Yjs documents,
 * generates tsvector for full-text search and embeddings for
 * vector/semantic search, and upserts into the search index tables.
 */
const crypto = require('crypto');
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
 * Build the exact input string the content hash covers. This is the ONLY
 * producer of hash input (CN-7 seam): in 017 it is the identity on the
 * extracted body text — the title never enters (CN-1), and generated/derived
 * text (e.g. feature 018's contextual preambles) is permanently excluded.
 * Feature 018 widens this to buildEmbedHashInput(title, extractedText) as a
 * signature-only change; the gate logic and content_hash semantics stay put.
 */
function buildEmbedHashInput(extractedText) {
  return extractedText;
}

/**
 * Deterministic fingerprint over the seam's output: SHA-256, hex (64 chars).
 * The gate consumes ONLY computeContentHash(buildEmbedHashInput(...)).
 */
function computeContentHash(input) {
  return crypto.createHash('sha256').update(input || '', 'utf8').digest('hex');
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

    // Fingerprint of exactly this extraction — travels with the text into the
    // embed transaction so an in-flight newer edit can never be recorded (FR-005).
    const newHash = computeContentHash(buildEmbedHashInput(contentText));

    // Step 1: Upsert FTS index (always succeeds, no external API). The upsert
    // never writes content_hash — RETURNING reads back the previously stored
    // fingerprint (the hash only advances with the chunk-swap or empty-cleanup
    // transactions below), so this doubles as the gate's stored-hash lookup.
    const upsertResult = await pool.query(
      `INSERT INTO document_search_index (doc_id, content_text, search_vector, indexed_at)
       VALUES ($1, $2,
         setweight(to_tsvector('english', COALESCE($3, '')), 'A') ||
         setweight(to_tsvector('english', COALESCE($2, '')), 'B'),
         now())
       ON CONFLICT (doc_id) DO UPDATE SET
         content_text = EXCLUDED.content_text,
         search_vector = EXCLUDED.search_vector,
         indexed_at = EXCLUDED.indexed_at
       RETURNING content_hash`,
      [docGuid, contentText, title]
    );
    // A real upsert always returns exactly one row; a missing row means we
    // could not read a stored fingerprint (degenerate pool, e.g. unit-test
    // fakes) — treat the hash as unknown and skip destructive maintenance.
    const upsertRow = upsertResult.rows[0];
    const storedHash = upsertRow ? upsertRow.content_hash : undefined;

    // Step 2: hash-gated embedding maintenance (best-effort — FTS still works)
    const chunks = chunkText(contentText);
    if (chunks.length === 0) {
      // Empty/unembeddable content is a terminal state (CN-6): delete any stale
      // chunk rows and advance the hash in one transaction, exactly once (the
      // hash-inequality gate). Runs regardless of provider-key presence —
      // there is nothing to embed, so "disabled embeddings" is irrelevant.
      if (upsertRow && storedHash !== newHash) {
        await cleanupEmptyDocument(docGuid, newHash).catch((err) => {
          console.warn(`[SearchIndexer] Empty-content chunk cleanup failed for ${docGuid}:`, err.message);
        });
      }
    } else if (storedHash === newHash) {
      // Unchanged content: zero embedding-provider calls (FR-003) — unless
      // some chunk row was produced by a different model, in which case model
      // staleness overrides the gate (CN-5/FR-011). The probe runs only on
      // hash-match, the sole case where the gate could wrongly suppress repair.
      const mismatch = await pool.query(
        `SELECT EXISTS(
           SELECT 1 FROM document_embeddings de
           WHERE de.doc_id = $1 AND de.embedding_model IS DISTINCT FROM $2
         ) AS stale`,
        [docGuid, EMBEDDING_MODEL]
      );
      if (mismatch.rows[0] && mismatch.rows[0].stale) {
        await generateAndStoreEmbeddings(docGuid, contentText, newHash).catch((err) => {
          console.warn(`[SearchIndexer] Embedding generation failed for ${docGuid}, FTS still indexed:`, err.message);
        });
      }
    } else {
      await generateAndStoreEmbeddings(docGuid, contentText, newHash).catch((err) => {
        console.warn(`[SearchIndexer] Embedding generation failed for ${docGuid}, FTS still indexed:`, err.message);
      });
    }

    // Log identifiers + sizes only — never the title text (feeds the telemetry
    // pipeline; the design doc forbids titles/search queries in logs).
    console.log(`[SearchIndexer] Indexed ${docGuid} (title ${(title || '').length} chars, ${contentText.length} content chars)`);
  } finally {
    indexingInProgress.delete(docGuid);
  }
}

/**
 * Delete a document's chunk rows and advance its content hash in one
 * transaction — the successful "regeneration" for empty/unembeddable text
 * (CN-6). Failure rolls back, leaving the prior hash so the next pass retries.
 */
async function cleanupEmptyDocument(docGuid, contentHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM document_embeddings WHERE doc_id = $1', [docGuid]);
    await client.query(
      'UPDATE document_search_index SET content_hash = $2 WHERE doc_id = $1',
      [docGuid, contentHash]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Generate embeddings for document chunks and store them. The optional
 * contentHash (fingerprint of exactly this contentText via the CN-7 seam)
 * is written atomically with the chunk swap — callers that omit it (e.g.
 * scripts/backfill-search-index.js) get the seam-derived default, which is
 * correct by construction for the text they just passed.
 */
async function generateAndStoreEmbeddings(docGuid, contentText, contentHash = computeContentHash(buildEmbedHashInput(contentText))) {
  // No provider key → embeddings disabled: return BEFORE any DB write so the
  // stored hash never advances for content that was never embedded (CN-4).
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
      // embedding_model is written explicitly (FR-009) — never left to the
      // column default — so boot repair can trust the watermark after a
      // configured-model change.
      await client.query(
        `INSERT INTO document_embeddings (doc_id, chunk_index, chunk_text, embedding, embedding_model)
         VALUES ($1, $2, $3, $4, $5)`,
        [docGuid, i, chunks[i], JSON.stringify(allEmbeddings[i]), EMBEDDING_MODEL]
      );
    }

    // Advance the fingerprint atomically with the chunk swap it describes
    // (FR-005): a failed/rolled-back swap leaves the prior hash in place.
    await client.query(
      'UPDATE document_search_index SET content_hash = $2 WHERE doc_id = $1',
      [docGuid, contentHash]
    );

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
    // Find documents missing from the search index, with stale indexed_at, or
    // owning any chunk row recorded under a different embedding model
    // (FR-010; IS DISTINCT FROM treats NULL models as stale — safe direction).
    const result = await pool.query(`
      SELECT d.id FROM documents d
      LEFT JOIN document_search_index si ON si.doc_id = d.id
      WHERE si.doc_id IS NULL OR si.indexed_at < d.updated_at
        OR EXISTS (
          SELECT 1 FROM document_embeddings de
          WHERE de.doc_id = d.id AND de.embedding_model IS DISTINCT FROM $1
        )
      ORDER BY d.updated_at DESC
    `, [EMBEDDING_MODEL]);

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

module.exports = { init, markDirty, indexDocument, reindexStale, flushDirty, chunkText, generateAndStoreEmbeddings, buildEmbedHashInput, computeContentHash, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
