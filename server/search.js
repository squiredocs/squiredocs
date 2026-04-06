/**
 * Search Query Module
 *
 * Hybrid search combining full-text search (PostgreSQL tsvector) and
 * vector/semantic search (pgvector) using Reciprocal Rank Fusion (RRF).
 */

const sanitizeHtml = require('sanitize-html');
const { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = require('./search-indexer');

// Max cosine distance for vector search results (0 = identical, 1 = orthogonal).
// 0.5 ≈ cosine similarity ≥ 0.5. Agents can override via the distanceThreshold option.
const DEFAULT_DISTANCE_THRESHOLD = 0.5;

// Safety cap on the HNSW iterative scan. This is not a relevance filter — the
// distance threshold is the primary relevance gate. At typical corpus sizes
// (< 5K chunks) this cap is never hit. With 1-3 chunks/doc it covers 300-1000 docs.
const VECTOR_CANDIDATE_LIMIT = 1000;

let pool = null;

function init(p) {
  pool = p;
}

/**
 * Build a SQL fragment for filtering by document ownership role.
 * @param {string} filter - 'all', 'owned', or 'shared_with_me'
 * @param {string} alias - The document_shares table alias (e.g. 'ds', 'ds2')
 * @returns {string} SQL fragment (empty string or ' AND ...')
 */
function buildRoleCondition(filter, alias = 'ds') {
  if (filter === 'owned') return ` AND ${alias}.role = 'owner'`;
  if (filter === 'shared_with_me') return ` AND ${alias}.role != 'owner'`;
  return '';
}

/**
 * Build the ORDER BY clause for search results.
 * @param {string} sortBy - 'relevance', 'updatedAt', or 'createdAt'
 * @param {string} sortOrder - 'asc' or 'desc'
 * @param {string} scoreExpr - The SQL expression for relevance score (varies by search mode)
 * @returns {string} SQL ORDER BY clause
 */
function buildSearchOrderClause(sortBy, sortOrder, scoreExpr) {
  const dir = sortOrder === 'asc' ? 'ASC' : 'DESC';
  if (sortBy === 'updatedAt') return `ORDER BY d.updated_at ${dir} NULLS LAST`;
  if (sortBy === 'createdAt') return `ORDER BY d.created_at ${dir} NULLS LAST`;
  // Default: relevance
  return `ORDER BY ${scoreExpr}`;
}

/**
 * Search documents by content using hybrid FTS + vector search.
 *
 * @param {string} userId - The user performing the search
 * @param {string} query - Search query (keywords or natural language)
 * @param {object} options
 * @param {string} options.mode - 'hybrid' (default), 'fulltext', or 'semantic'
 * @param {string} options.filter - 'all' (default), 'owned', or 'shared_with_me'
 * @param {string} options.sortBy - 'relevance' (default), 'updatedAt', or 'createdAt'
 * @param {string} options.sortOrder - 'asc' or 'desc' (default: 'desc')
 * @param {number} options.limit - Max results (default 10, max 100)
 * @param {number} options.offset - Pagination offset (default 0)
 * @returns {Promise<{rows: Array, pagination: object}>}
 */
async function searchDocuments(userId, query, options = {}) {
  if (!pool) throw new Error('Search module not initialized');
  if (!query || !query.trim()) return { rows: [], pagination: { total: 0, limit: 0, offset: 0, hasMore: false } };

  const mode = options.mode || 'hybrid';
  const filter = options.filter || 'all';
  const sortBy = options.sortBy || 'relevance';
  const sortOrder = options.sortOrder || 'desc';
  const limit = Math.max(1, Math.min(100, parseInt(options.limit, 10) || 10));
  const offset = Math.max(0, parseInt(options.offset, 10) || 0);
  const distanceThreshold = parseFloat(options.distanceThreshold) || DEFAULT_DISTANCE_THRESHOLD;

  // Determine effective mode: fall back to fulltext if no embeddings or no API key
  let effectiveMode = mode;
  if (effectiveMode !== 'fulltext') {
    const hasEmbeddings = await checkEmbeddingsExist();
    const hasApiKey = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!hasEmbeddings || !hasApiKey) {
      effectiveMode = 'fulltext';
    }
  }

  if (effectiveMode === 'fulltext') {
    return fulltextSearch(userId, query, limit, offset, filter, sortBy, sortOrder);
  } else if (effectiveMode === 'semantic') {
    return semanticSearch(userId, query, limit, offset, filter, sortBy, sortOrder, distanceThreshold);
  } else {
    return hybridSearch(userId, query, limit, offset, filter, sortBy, sortOrder, distanceThreshold);
  }
}

/**
 * Check if any embeddings exist in the database.
 */
let _embeddingsExist = null;
let _embeddingsCheckTime = 0;
async function checkEmbeddingsExist() {
  // Cache for 60 seconds to avoid repeated queries
  if (_embeddingsExist !== null && Date.now() - _embeddingsCheckTime < 60_000) {
    return _embeddingsExist;
  }
  const result = await pool.query('SELECT EXISTS(SELECT 1 FROM document_embeddings LIMIT 1) as has_rows');
  _embeddingsExist = result.rows[0].has_rows;
  _embeddingsCheckTime = Date.now();
  return _embeddingsExist;
}

/**
 * Generate a query embedding using the Google AI SDK.
 */
async function getQueryEmbedding(query) {
  const { embed } = require('ai');
  const { google } = require('@ai-sdk/google');
  const { embedding } = await embed({
    model: google.textEmbeddingModel(EMBEDDING_MODEL),
    value: query,
    providerOptions: { google: { outputDimensionality: EMBEDDING_DIMENSIONS } },
  });
  return embedding;
}

/**
 * Build the top_chunks CTE for HNSW-accelerated vector search.
 * Returns the nearest chunks filtered by distance threshold, capped at VECTOR_CANDIDATE_LIMIT.
 */
function buildVectorCTE(embeddingParam, thresholdParam, roleCondition) {
  return `top_chunks AS (
       SELECT de.doc_id, de.chunk_text,
              (de.embedding <=> $${embeddingParam}::vector) AS distance
       FROM document_embeddings de
       JOIN document_shares ds ON ds.doc_id = de.doc_id AND ds.user_id = $1${roleCondition}
       WHERE (de.embedding <=> $${embeddingParam}::vector) < $${thresholdParam}
       ORDER BY de.embedding <=> $${embeddingParam}::vector
       LIMIT ${VECTOR_CANDIDATE_LIMIT}
     )`;
}

/**
 * Run a search CTE with standard detail joins for document metadata.
 * The CTE SQL must end with a CTE alias `cte` that outputs: doc_id, snippet, score.
 * Params array must have userId as $1, limit and offset as the last two.
 */
async function runSearchQuery(cteSql, params, { filter, sortBy, sortOrder }) {
  const roleCondition = buildRoleCondition(filter, 'ds2');
  const orderClause = buildSearchOrderClause(sortBy, sortOrder, 'cte.score DESC');
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const result = await pool.query(
    `${cteSql}
     SELECT
       cte.doc_id,
       d.title,
       d.updated_at,
       ds2.role,
       owner_user.name AS owner_name,
       owner_user.email AS owner_email,
       cte.snippet,
       cte.score,
       (SELECT COUNT(*) FROM document_shares WHERE doc_id = cte.doc_id) AS share_count,
       COUNT(*) OVER() AS total_count
     FROM cte
     JOIN documents d ON d.id = cte.doc_id
     JOIN document_shares ds2 ON ds2.doc_id = cte.doc_id AND ds2.user_id = $1${roleCondition}
     LEFT JOIN document_shares owner_share ON d.id = owner_share.doc_id AND owner_share.role = 'owner'
     LEFT JOIN users owner_user ON owner_share.user_id = owner_user.id
     ${orderClause}
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  return formatResults(result.rows, params[limitIdx - 1], params[offsetIdx - 1]);
}

/**
 * Full-text search only.
 */
async function fulltextSearch(userId, query, limit, offset, filter, sortBy, sortOrder) {
  const roleCondition = buildRoleCondition(filter);

  return runSearchQuery(
    `WITH cte AS (
       SELECT
         si.doc_id,
         ts_headline('english', si.content_text, websearch_to_tsquery('english', $2),
           'StartSel=<mark>, StopSel=</mark>, MaxWords=60, MinWords=20, MaxFragments=2') AS snippet,
         ts_rank_cd(si.search_vector, websearch_to_tsquery('english', $2)) AS score
       FROM document_search_index si
       JOIN document_shares ds ON ds.doc_id = si.doc_id AND ds.user_id = $1${roleCondition}
       WHERE si.search_vector @@ websearch_to_tsquery('english', $2)
     )`,
    [userId, query, limit, offset],
    { filter, sortBy, sortOrder }
  );
}

/**
 * Semantic (vector) search only.
 */
async function semanticSearch(userId, query, limit, offset, filter, sortBy, sortOrder, distanceThreshold) {
  const queryEmbedding = await getQueryEmbedding(query);
  const roleCondition = buildRoleCondition(filter);

  return runSearchQuery(
    `WITH ${buildVectorCTE(2, 3, roleCondition)},
     cte AS (
       SELECT DISTINCT ON (doc_id)
         doc_id,
         LEFT(chunk_text, 300) AS snippet,
         (1.0 - distance) AS score
       FROM top_chunks
       ORDER BY doc_id, distance ASC
     )`,
    [userId, JSON.stringify(queryEmbedding), distanceThreshold, limit, offset],
    { filter, sortBy, sortOrder }
  );
}

/**
 * Hybrid search using Reciprocal Rank Fusion (RRF).
 */
async function hybridSearch(userId, query, limit, offset, filter, sortBy, sortOrder, distanceThreshold) {
  const queryEmbedding = await getQueryEmbedding(query);
  const roleCondition = buildRoleCondition(filter);

  return runSearchQuery(
    `WITH fts AS (
       SELECT
         si.doc_id,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(si.search_vector, websearch_to_tsquery('english', $2)) DESC) AS rank,
         ts_headline('english', si.content_text, websearch_to_tsquery('english', $2),
           'StartSel=<mark>, StopSel=</mark>, MaxWords=60, MinWords=20, MaxFragments=2') AS snippet
       FROM document_search_index si
       JOIN document_shares ds ON ds.doc_id = si.doc_id AND ds.user_id = $1${roleCondition}
       WHERE si.search_vector @@ websearch_to_tsquery('english', $2)
     ),
     ${buildVectorCTE(3, 4, roleCondition)},
     vec AS (
       SELECT DISTINCT ON (doc_id) doc_id, chunk_text AS chunk_snippet, distance
       FROM top_chunks
       ORDER BY doc_id, distance ASC
     ),
     vec_ranked AS (
       SELECT v.doc_id, v.chunk_snippet,
         ROW_NUMBER() OVER (ORDER BY v.distance ASC) AS rank
       FROM vec v
     ),
     cte AS (
       SELECT
         COALESCE(f.doc_id, vr.doc_id) AS doc_id,
         COALESCE(f.snippet, LEFT(vr.chunk_snippet, 300)) AS snippet,
         COALESCE(1.0 / (60 + f.rank), 0) + COALESCE(1.0 / (60 + vr.rank), 0) AS score
       FROM fts f
       FULL OUTER JOIN vec_ranked vr ON f.doc_id = vr.doc_id
     )`,
    [userId, query, JSON.stringify(queryEmbedding), distanceThreshold, limit, offset],
    { filter, sortBy, sortOrder }
  );
}

/**
 * Sanitize a ts_headline snippet: allow only <mark> tags from ts_headline output.
 */
function sanitizeSnippet(snippet) {
  if (!snippet) return snippet;
  return sanitizeHtml(snippet, { allowedTags: ['mark'], allowedAttributes: {} });
}

/**
 * Format query results into a consistent response shape.
 */
function formatResults(rows, limit, offset) {
  const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;

  return {
    rows: rows.map((row) => ({
      doc_id: row.doc_id,
      title: row.title,
      updated_at: row.updated_at,
      role: row.role,
      owner_name: row.owner_name,
      owner_email: row.owner_email,
      snippet: sanitizeSnippet(row.snippet),
      score: parseFloat(row.score) || 0,
      share_count: parseInt(row.share_count, 10) || 0,
    })),
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    },
  };
}

// Reset embeddings cache (for testing)
function _resetCache() {
  _embeddingsExist = null;
  _embeddingsCheckTime = 0;
}

module.exports = { init, searchDocuments, _resetCache };
