/**
 * Search Query Module
 *
 * Hybrid search combining full-text search (PostgreSQL tsvector) and
 * vector/semantic search (pgvector) using Reciprocal Rank Fusion (RRF).
 */

const sanitizeHtml = require('sanitize-html');
const { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } = require('./search-indexer');

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
 * @param {number} options.limit - Max results (default 10, max 50)
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
    return semanticSearch(userId, query, limit, offset, filter, sortBy, sortOrder);
  } else {
    return hybridSearch(userId, query, limit, offset, filter, sortBy, sortOrder);
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
 * Full-text search only.
 */
async function fulltextSearch(userId, query, limit, offset, filter, sortBy, sortOrder) {
  const roleCondition = buildRoleCondition(filter);
  const roleCondition2 = buildRoleCondition(filter, 'ds2');
  const orderClause = buildSearchOrderClause(sortBy, sortOrder, 'f.rank DESC');

  const result = await pool.query(
    `WITH fts AS (
       SELECT
         si.doc_id,
         ts_rank_cd(si.search_vector, websearch_to_tsquery('english', $2)) AS rank,
         ts_headline('english', si.content_text, websearch_to_tsquery('english', $2),
           'StartSel=<mark>, StopSel=</mark>, MaxWords=60, MinWords=20, MaxFragments=2') AS snippet
       FROM document_search_index si
       JOIN document_shares ds ON ds.doc_id = si.doc_id AND ds.user_id = $1${roleCondition}
       WHERE si.search_vector @@ websearch_to_tsquery('english', $2)
     )
     SELECT
       f.doc_id,
       d.title,
       d.updated_at,
       ds2.role,
       owner_user.name AS owner_name,
       owner_user.email AS owner_email,
       f.snippet,
       f.rank AS score,
       COUNT(*) OVER() AS total_count
     FROM fts f
     JOIN documents d ON d.id = f.doc_id
     JOIN document_shares ds2 ON ds2.doc_id = f.doc_id AND ds2.user_id = $1${roleCondition2}
     LEFT JOIN document_shares owner_share ON d.id = owner_share.doc_id AND owner_share.role = 'owner'
     LEFT JOIN users owner_user ON owner_share.user_id = owner_user.id
     ${orderClause}
     LIMIT $3 OFFSET $4`,
    [userId, query, limit, offset]
  );

  return formatResults(result.rows, limit, offset);
}

/**
 * Semantic (vector) search only.
 */
async function semanticSearch(userId, query, limit, offset, filter, sortBy, sortOrder) {
  const queryEmbedding = await getQueryEmbedding(query);
  const roleCondition = buildRoleCondition(filter);
  const roleCondition2 = buildRoleCondition(filter, 'ds2');
  const orderClause = buildSearchOrderClause(sortBy, sortOrder, 'v.distance ASC');

  const result = await pool.query(
    `WITH vec AS (
       SELECT DISTINCT ON (de.doc_id)
         de.doc_id,
         de.chunk_text AS snippet,
         (de.embedding <=> $2::vector) AS distance
       FROM document_embeddings de
       JOIN document_shares ds ON ds.doc_id = de.doc_id AND ds.user_id = $1${roleCondition}
       ORDER BY de.doc_id, distance ASC
     )
     SELECT
       v.doc_id,
       d.title,
       d.updated_at,
       ds2.role,
       owner_user.name AS owner_name,
       owner_user.email AS owner_email,
       LEFT(v.snippet, 300) AS snippet,
       (1.0 - v.distance) AS score,
       COUNT(*) OVER() AS total_count
     FROM vec v
     JOIN documents d ON d.id = v.doc_id
     JOIN document_shares ds2 ON ds2.doc_id = v.doc_id AND ds2.user_id = $1${roleCondition2}
     LEFT JOIN document_shares owner_share ON d.id = owner_share.doc_id AND owner_share.role = 'owner'
     LEFT JOIN users owner_user ON owner_share.user_id = owner_user.id
     ${orderClause}
     LIMIT $3 OFFSET $4`,
    [userId, JSON.stringify(queryEmbedding), limit, offset]
  );

  return formatResults(result.rows, limit, offset);
}

/**
 * Hybrid search using Reciprocal Rank Fusion (RRF).
 */
async function hybridSearch(userId, query, limit, offset, filter, sortBy, sortOrder) {
  const queryEmbedding = await getQueryEmbedding(query);
  const roleCondition = buildRoleCondition(filter);
  const roleCondition2 = buildRoleCondition(filter, 'ds2');
  const orderClause = buildSearchOrderClause(sortBy, sortOrder, 'r.rrf_score DESC');

  const result = await pool.query(
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
     vec AS (
       SELECT DISTINCT ON (de.doc_id)
         de.doc_id,
         de.chunk_text AS chunk_snippet
       FROM document_embeddings de
       JOIN document_shares ds ON ds.doc_id = de.doc_id AND ds.user_id = $1${roleCondition}
       ORDER BY de.doc_id, (de.embedding <=> $3::vector) ASC
     ),
     vec_ranked AS (
       SELECT
         v.doc_id,
         v.chunk_snippet,
         ROW_NUMBER() OVER (
           ORDER BY (SELECT MIN(de2.embedding <=> $3::vector)
                     FROM document_embeddings de2 WHERE de2.doc_id = v.doc_id)
         ) AS rank
       FROM vec v
     ),
     rrf AS (
       SELECT
         COALESCE(f.doc_id, vr.doc_id) AS doc_id,
         COALESCE(f.snippet, LEFT(vr.chunk_snippet, 300)) AS snippet,
         COALESCE(1.0 / (60 + f.rank), 0) + COALESCE(1.0 / (60 + vr.rank), 0) AS rrf_score
       FROM fts f
       FULL OUTER JOIN vec_ranked vr ON f.doc_id = vr.doc_id
     )
     SELECT
       r.doc_id,
       d.title,
       d.updated_at,
       ds2.role,
       owner_user.name AS owner_name,
       owner_user.email AS owner_email,
       r.snippet,
       r.rrf_score AS score,
       COUNT(*) OVER() AS total_count
     FROM rrf r
     JOIN documents d ON d.id = r.doc_id
     JOIN document_shares ds2 ON ds2.doc_id = r.doc_id AND ds2.user_id = $1${roleCondition2}
     LEFT JOIN document_shares owner_share ON d.id = owner_share.doc_id AND owner_share.role = 'owner'
     LEFT JOIN users owner_user ON owner_share.user_id = owner_user.id
     ${orderClause}
     LIMIT $4 OFFSET $5`,
    [userId, query, JSON.stringify(queryEmbedding), limit, offset]
  );

  return formatResults(result.rows, limit, offset);
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
