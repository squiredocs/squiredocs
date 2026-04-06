/**
 * list_documents MCP Tool
 *
 * Lists all documents accessible to the authenticated agent/user.
 * Supports content search (hybrid FTS + vector), filtering, pagination, and sorting.
 * When a search query is provided, uses hybrid content search with snippets.
 * Without a query, lists documents with filter/sort options.
 */

const documents = require('../../documents');
const search = require('../../search');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
  if (persistence && persistence.getPool) {
    documents.init(persistence.getPool());
  }
}

const name = 'list_documents';

const description = `List and search documents accessible to you.

When "search" is provided, performs hybrid content search (keyword + semantic) across document bodies and returns results ranked by relevance with snippets. Use "searchMode" to control search behavior.

Without "search", lists documents with optional filtering and sorting.

PARAMETERS:
- search: Search query — keywords or natural language. Searches document content, not just titles.
- searchMode: "hybrid" (default, keyword + semantic), "fulltext" (keyword only), "semantic" (meaning-based only). Only applies when search is provided.
- filter: "owned" | "shared_with_me" | "all" (default: "all")
- sortBy: "relevance" (default when searching) | "updatedAt" (default when listing) | "createdAt"
- sortOrder: "asc" | "desc" (default: "desc")
- limit: 1-100 (default: 50 for listing, 10 for search)
- offset: pagination offset (default: 0)

RETURNS:
- documents: Array of { id, title, url, role, updatedAt, ... }
  - When searching: includes snippet and score
  - When listing: includes createdAt and shareCount
- pagination: { total, limit, offset, hasMore }

EXAMPLES:
// List all documents
list_documents()

// Search document content
list_documents({ search: "authentication login flow" })

// Keyword-only search
list_documents({ search: "TODO refactor", searchMode: "fulltext" })

// List owned documents, oldest first
list_documents({ filter: "owned", sortBy: "createdAt", sortOrder: "asc" })

// Paginate through results
list_documents({ limit: 10, offset: 0 })`;

const inputSchema = {
  type: 'object',
  properties: {
    search: {
      type: 'string',
      description: 'Search query — keywords or natural language. Searches document content.',
    },
    searchMode: {
      type: 'string',
      enum: ['hybrid', 'fulltext', 'semantic'],
      default: 'hybrid',
      description: 'Search mode (only applies when search is provided): "hybrid" (keyword + semantic), "fulltext" (keyword only), or "semantic" (meaning-based)',
    },
    filter: {
      type: 'string',
      enum: ['owned', 'shared_with_me', 'all'],
      default: 'all',
      description: 'Filter by ownership: "owned", "shared_with_me", or "all"',
    },
    sortBy: {
      type: 'string',
      enum: ['relevance', 'updatedAt', 'createdAt'],
      default: 'updatedAt',
      description: 'Sort by: "relevance" (default when searching), "updatedAt" (default when listing), or "createdAt"',
    },
    sortOrder: {
      type: 'string',
      enum: ['asc', 'desc'],
      default: 'desc',
      description: 'Sort direction',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 50,
      description: 'Maximum number of documents to return (1-100)',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      default: 0,
      description: 'Number of documents to skip for pagination',
    },
  },
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('list_documents tool not initialized');

  const userId = agentToken.userId;
  const baseUrl = agentToken.baseUrl || '';

  // Content search path: when a search query is provided
  if (args.search && args.search.trim()) {
    const { rows, pagination } = await search.searchDocuments(userId, args.search, {
      mode: args.searchMode,
      filter: args.filter,
      sortBy: args.sortBy || 'relevance',
      sortOrder: args.sortOrder,
      limit: args.limit,
      offset: args.offset,
    });

    return {
      documents: rows.map((row) => ({
        id: row.doc_id,
        title: row.title || null,
        url: `${baseUrl}/d/${row.doc_id}`,
        role: row.role,
        updatedAt: row.updated_at,
        snippet: row.snippet,
        score: row.score,
      })),
      pagination,
    };
  }

  // List path: no search query
  const limit = Math.max(1, Math.min(100, parseInt(args.limit, 10) || 50));
  const offset = Math.max(0, parseInt(args.offset, 10) || 0);

  const { rows, total } = await documents.getAccessibleDocuments(userId, {
    filter: args.filter,
    sortBy: args.sortBy || 'updatedAt',
    sortOrder: args.sortOrder,
    limit,
    offset,
  });

  return {
    documents: rows.map((row) => ({
      id: row.doc_id,
      title: row.title || null,
      url: `${baseUrl}/d/${row.doc_id}`,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      shareCount: parseInt(row.share_count, 10),
    })),
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    },
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
