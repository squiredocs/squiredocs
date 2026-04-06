/**
 * search_documents MCP Tool
 *
 * Searches document content using hybrid full-text + vector/semantic search.
 * Unlike list_documents (which searches titles only), this searches the
 * actual content of documents using PostgreSQL tsvector and pgvector embeddings.
 */

const search = require('../../search');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
  if (persistence && persistence.getPool) {
    search.init(persistence.getPool());
  }
}

const name = 'search_documents';

const description = `Search document content using full-text and semantic search. Returns documents whose content matches the query, with relevant snippets.

Use this tool when you need to find documents by their content (not just title). Supports keyword search and natural language queries.

PARAMETERS:
- query (required): Search query — keywords or natural language
- mode: "hybrid" (default, combines keyword + semantic), "fulltext" (keyword only), "semantic" (meaning-based only)
- limit: 1-50 (default: 10)
- offset: pagination offset (default: 0)

RETURNS:
- results: Array of { id, title, url, role, snippet, score }
- pagination: { total, limit, offset, hasMore }

EXAMPLES:
// Find documents about authentication
search_documents({ query: "authentication login flow" })

// Keyword-only search
search_documents({ query: "TODO refactor", mode: "fulltext" })

// Paginate results
search_documents({ query: "API design", limit: 5, offset: 0 })`;

const inputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search query — keywords or natural language question',
    },
    mode: {
      type: 'string',
      enum: ['hybrid', 'fulltext', 'semantic'],
      default: 'hybrid',
      description: 'Search mode: "hybrid" (keyword + semantic), "fulltext" (keyword only), or "semantic" (meaning-based)',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 10,
      description: 'Maximum number of results (1-50)',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      default: 0,
      description: 'Pagination offset',
    },
  },
  required: ['query'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('search_documents tool not initialized');

  const { query, mode = 'hybrid', limit = 10, offset = 0 } = args;
  const userId = agentToken.userId;
  const baseUrl = agentToken.baseUrl || '';

  if (!query || !query.trim()) {
    return { results: [], pagination: { total: 0, limit, offset, hasMore: false } };
  }

  const { rows, pagination } = await search.searchDocuments(userId, query, { mode, limit, offset });

  const results = rows.map((row) => ({
    id: row.doc_id,
    title: row.title || null,
    url: `${baseUrl}/d/${row.doc_id}`,
    role: row.role,
    snippet: row.snippet,
    score: row.score,
  }));

  return { results, pagination };
}

module.exports = { init, name, description, inputSchema, handler };
