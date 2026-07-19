/**
 * Search Indexer
 *
 * Debounced pipeline that extracts text from Yjs documents,
 * generates tsvector for full-text search and embeddings for
 * vector/semantic search, and upserts into the search index tables.
 *
 * Feature 018: chunking is structure-aware (server/search/chunker.js) —
 * heading-boundary ~600-token chunks carrying a heading_path; every chunk's
 * embedded text leads with `[title, ...heading_path].join(' > ')` (DR-1);
 * multi-chunk documents get best-effort contextual preambles
 * (server/search/contextualizer.js) embedded AND keyword-indexed with the
 * chunk; the whole chunk set swaps transactionally per document. Legacy
 * fixed-window rows (`embedded_text IS NULL`) keep serving until the boot
 * repair re-chunks their documents.
 */
const crypto = require('crypto');
const { toPlainText, toStructured } = require('./mcp/yjs/serialization');
const { getSearchConfig } = require('./search/config');
const { chunkStructured, buildEmbeddedText, estimateTokens } = require('./search/chunker');

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
 * producer of hash input (017 CN-7 seam). Feature 018 (DR-1): the title joins
 * the embedded text, so the hash input widens to `title + '\n' + bodyText` —
 * a title-only change now busts the re-embed gate. Generated/derived text
 * (contextual preambles) is permanently excluded (FR-015): the seam's entire
 * input surface is (title, extractedText).
 */
function buildEmbedHashInput(title, extractedText) {
  return `${title || ''}\n${extractedText || ''}`;
}

/**
 * Deterministic fingerprint over the seam's output: SHA-256, hex (64 chars).
 * The gate consumes ONLY computeContentHash(buildEmbedHashInput(...)).
 */
function computeContentHash(input) {
  return crypto.createHash('sha256').update(input || '', 'utf8').digest('hex');
}

/**
 * Legacy fixed-window chunker (pre-018). Kept ONLY so the eval harness can
 * reproduce the old-chunking baseline variant honestly (plan D12,
 * `chunking: 'fixed'`) — the live pipeline never calls it.
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
 * Produce the chunk records for one document under a resolved config:
 * structure-aware by default; `chunking: 'fixed'` reproduces the pre-018
 * window chunker for the eval baseline (empty trails, bare text).
 * @returns {Array<{ headingPath: string[], text: string }>}
 */
function buildChunkRecords(nodes, contentText, config) {
  if (config.chunking === 'fixed') {
    return chunkText(contentText).map((text) => ({ headingPath: [], text }));
  }
  return chunkStructured(nodes, {
    targetTokens: config.chunkTargetTokens,
    headingFillRatio: config.headingFillRatio,
    overlapRatio: config.overlapRatio,
  });
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
    const structuredNodes = toStructured(xmlFragment);
    const title = ydoc.getMap('meta').get('title') || '';

    // Fingerprint of exactly this extraction — travels with the text into the
    // embed transaction so an in-flight newer edit can never be recorded
    // (017 FR-005). Title-aware since 018 (DR-1).
    const newHash = computeContentHash(buildEmbedHashInput(title, contentText));

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
    const config = getSearchConfig();
    const chunkRecords = buildChunkRecords(structuredNodes, contentText, config);
    const extraction = { title, contentText, nodes: structuredNodes, chunkRecords };
    if (chunkRecords.length === 0) {
      // Empty/unembeddable content is a terminal state (017 CN-6): delete any
      // stale chunk rows and advance the hash in one transaction, exactly once
      // (the hash-inequality gate). Runs regardless of provider-key presence —
      // there is nothing to embed, so "disabled embeddings" is irrelevant.
      if (upsertRow && storedHash !== newHash) {
        await cleanupEmptyDocument(docGuid, newHash).catch((err) => {
          console.warn(`[SearchIndexer] Empty-content chunk cleanup failed for ${docGuid}:`, err.message);
        });
      }
    } else if (storedHash === newHash) {
      // Unchanged content: zero embedding-provider calls (017 FR-003) — unless
      // some chunk row was produced by a different model (017 CN-5/FR-011) or
      // still carries the legacy fixed-window scheme (018 D7: embedded_text IS
      // NULL), in which case staleness overrides the gate. The probe runs only
      // on hash-match, the sole case where the gate could wrongly suppress repair.
      const mismatch = await pool.query(
        `SELECT EXISTS(
           SELECT 1 FROM document_embeddings de
           WHERE de.doc_id = $1
             AND (de.embedding_model IS DISTINCT FROM $2 OR de.embedded_text IS NULL)
         ) AS stale`,
        [docGuid, EMBEDDING_MODEL]
      );
      if (mismatch.rows[0] && mismatch.rows[0].stale) {
        await generateAndStoreEmbeddings(docGuid, extraction, newHash).catch((err) => {
          console.warn(`[SearchIndexer] Embedding generation failed for ${docGuid}, FTS still indexed:`, err.message);
        });
      }
    } else {
      await generateAndStoreEmbeddings(docGuid, extraction, newHash).catch((err) => {
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
 * (017 CN-6). Failure rolls back, leaving the prior hash so the next pass retries.
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
 * Generate contextual preambles for a multi-chunk document — strictly
 * best-effort (FR-016): ANY failure (missing module, provider error, missing
 * key) yields empty preambles and never blocks indexing. Called only when the
 * config enables preambles, the chunking is structure-aware, and the pass
 * produced ≥ 2 chunks (FR-012 — the gate lives HERE, at the single call site,
 * so "zero contextualizer calls for single-chunk docs" is a property of one
 * line).
 */
async function generatePreambles(title, contentText, chunkRecords, config) {
  const none = chunkRecords.map(() => '');
  if (!config.preambles || config.chunking === 'fixed' || chunkRecords.length < 2) {
    return none;
  }
  try {
    const { contextualizeChunks } = require('./search/contextualizer');
    const preambles = await contextualizeChunks({
      docTitle: title,
      fullText: contentText,
      chunks: chunkRecords.map((c) => ({ text: c.text, headingPath: c.headingPath })),
    });
    if (!Array.isArray(preambles)) return none;
    return chunkRecords.map((_, i) => (typeof preambles[i] === 'string' ? preambles[i].trim() : ''));
  } catch (err) {
    console.warn(`[SearchIndexer] Preamble generation failed for document (${chunkRecords.length} chunks), indexing without preambles:`, err.message);
    return none;
  }
}

/**
 * Generate embeddings for document chunks and store them, replacing the
 * document's chunk set transactionally (FR-010: complete old set or complete
 * new set, never partial).
 *
 * @param {string} docGuid
 * @param {object} extraction - { title, contentText, nodes, chunkRecords?, overrides? }
 *   `nodes` is toStructured() output; `chunkRecords` may be passed pre-computed
 *   (indexDocument does); `overrides` are getSearchConfig overrides (eval use).
 * @param {string} [contentHash] - fingerprint of exactly this extraction via
 *   the CN-7 seam, written atomically with the chunk swap. Callers that omit
 *   it (e.g. server/scripts/backfill-search-index.js) get the seam-derived
 *   default — TITLE-AWARE since 018 (017 review finding F3: the default must
 *   move with the seam or backfilled docs would store title-less hashes that
 *   never match and silently re-embed once more).
 * @returns {number} count of chunk rows written
 */
async function generateAndStoreEmbeddings(docGuid, extraction, contentHash) {
  const { title = '', contentText = '', overrides } = extraction || {};
  if (contentHash === undefined) {
    contentHash = computeContentHash(buildEmbedHashInput(title, contentText));
  }
  // No provider key → embeddings disabled: return BEFORE any DB write so the
  // stored hash never advances for content that was never embedded (017 CN-4).
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) return 0;

  const { embedMany } = require('ai');
  const { google } = require('@ai-sdk/google');

  const config = getSearchConfig(overrides);
  const chunkRecords = (extraction && extraction.chunkRecords)
    || buildChunkRecords((extraction && extraction.nodes) || [], contentText, config);
  if (chunkRecords.length === 0) return 0;

  // Preambles run BEFORE the swap transaction (best-effort, multi-chunk only).
  const preambles = await generatePreambles(title, contentText, chunkRecords, config);

  // Compose the exact text to embed + chunk-keyword-index (DR-1/D2). The
  // 'fixed' eval baseline embeds bare chunk text — a faithful reproduction of
  // the pre-018 pipeline (plan D12). Post-merge review F1/F2: fixed-variant
  // rows are STORED as byte-faithful legacy rows (all 018 columns NULL) so
  // (a) the baseline never matches the chunk-keyword leg — pre-018 rows have
  // no search_vector, so measuring the baseline with one inflated its FTS
  // rank on a different density scale; and (b) an interrupted eval sweep
  // cannot strand the corpus: NULL embedded_text is exactly the legacy-repair
  // discriminator, so reindexStale/the in-pass probe re-chunk them like any
  // legacy row.
  const isFixedBaseline = config.chunking === 'fixed';
  const rows = chunkRecords.map((c, i) => {
    const embeddedText = isFixedBaseline
      ? c.text
      : buildEmbeddedText({ title, headingPath: c.headingPath, preamble: preambles[i], chunkText: c.text });
    return {
      chunkText: c.text,
      headingPath: isFixedBaseline ? null : (c.headingPath || []),
      preamble: preambles[i] && !isFixedBaseline ? preambles[i] : null,
      embeddedText,
      storedEmbeddedText: isFixedBaseline ? null : embeddedText,
      tokenEstimate: isFixedBaseline ? null : estimateTokens(embeddedText),
    };
  });

  // Gemini API limit: 100 texts per batch request
  const BATCH_SIZE = 100;
  const allEmbeddings = [];
  for (let b = 0; b < rows.length; b += BATCH_SIZE) {
    const batch = rows.slice(b, b + BATCH_SIZE);
    const { embeddings } = await embedMany({
      model: google.textEmbeddingModel(EMBEDDING_MODEL),
      values: batch.map((r) => r.embeddedText),
      providerOptions: { google: { outputDimensionality: EMBEDDING_DIMENSIONS } },
    });
    allEmbeddings.push(...embeddings);
  }

  // Whole-set transactional swap: delete old chunks, insert the complete new
  // set (chunks + preambles together — RBD-7), advance the hash, commit.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM document_embeddings WHERE doc_id = $1', [docGuid]);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // embedding_model is written explicitly (017 FR-009) — never left to the
      // column default — so boot repair can trust the watermark after a
      // configured-model change.
      await client.query(
        `INSERT INTO document_embeddings
           (doc_id, chunk_index, chunk_text, embedding, embedding_model,
            heading_path, preamble_text, embedded_text, token_estimate, search_vector)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 CASE WHEN $8::text IS NULL THEN NULL ELSE to_tsvector('english', $8) END)`,
        [
          docGuid,
          i,
          row.chunkText,
          JSON.stringify(allEmbeddings[i]),
          EMBEDDING_MODEL,
          row.headingPath,
          row.preamble,
          row.storedEmbeddedText,
          row.tokenEstimate,
        ]
      );
    }

    // Advance the fingerprint atomically with the chunk swap it describes
    // (017 FR-005): a failed/rolled-back swap leaves the prior hash in place.
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
  return rows.length;
}

/**
 * Re-index documents that are stale (indexed_at < updated_at), missing from
 * the search index, recorded under a different embedding model (017), or
 * still carrying legacy fixed-window chunk rows (018 D7: embedded_text IS
 * NULL). Called on server startup after a delay; best-effort, concurrency-capped.
 */
async function reindexStale() {
  if (!pool) return;

  try {
    const result = await pool.query(`
      SELECT d.id FROM documents d
      LEFT JOIN document_search_index si ON si.doc_id = d.id
      WHERE si.doc_id IS NULL OR si.indexed_at < d.updated_at
        OR EXISTS (
          SELECT 1 FROM document_embeddings de
          WHERE de.doc_id = d.id
            AND (de.embedding_model IS DISTINCT FROM $1 OR de.embedded_text IS NULL)
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
 * EVAL-ONLY entry point (FR-025) — never called by the server. Re-index every
 * document through the normal per-doc pipeline under a variant configuration
 * (`getSearchConfig(overrides)`): `chunking: 'fixed'` reproduces the pre-018
 * pipeline faithfully (legacy chunkText windows, empty trails, bare
 * embedded_text — plan D12); `preambles` toggles the contextualizer. Runs
 * sequentially at the existing concurrency cap, best-effort per document.
 *
 * @param {object} overrides - getSearchConfig overrides describing the variant
 * @returns {Promise<{ total: number, done: number, failed: number }>}
 */
async function reindexAllForEval(overrides = {}) {
  if (!persistenceProvider || !pool) throw new Error('Search indexer not initialized');

  const result = await pool.query('SELECT id FROM documents ORDER BY updated_at DESC');
  const docs = result.rows;
  let done = 0;
  let failed = 0;

  for (let i = 0; i < docs.length; i += EMBEDDING_CONCURRENCY) {
    const batch = docs.slice(i, i + EMBEDDING_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(async (doc) => {
      const ydoc = await persistenceProvider.getYDoc(doc.id);
      const xmlFragment = ydoc.getXmlFragment('default');
      const contentText = toPlainText(xmlFragment);
      const nodes = toStructured(xmlFragment);
      const title = ydoc.getMap('meta').get('title') || '';
      // Maintain the doc-level FTS row exactly as indexDocument does (title
      // weight A, body weight B) — a variant sweep must measure the REAL
      // hybrid pipeline, doc-level keyword leg included, even for docs that
      // have never been through the live indexer.
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
        [doc.id, contentText, title]
      );
      // Bypass the hash gate deliberately: a variant re-index must rebuild
      // rows even when content is unchanged. The stored hash still advances
      // through the seam, so the next normal pass stays gated.
      await generateAndStoreEmbeddings(doc.id, { title, contentText, nodes, overrides });
    }));
    for (const s of settled) {
      if (s.status === 'fulfilled') done++;
      else failed++;
    }
  }

  return { total: docs.length, done, failed };
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

module.exports = { init, markDirty, indexDocument, reindexStale, reindexAllForEval, flushDirty, chunkText, buildChunkRecords, generateAndStoreEmbeddings, buildEmbedHashInput, computeContentHash, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
