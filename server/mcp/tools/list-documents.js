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

With "search", performs hybrid content search (keyword + semantic) across document bodies, ranked by relevance with snippets. Without "search", lists documents with optional filtering and sorting.

PARAMETERS:
- search: Search query — keywords or natural language. Searches document content, not just titles.
- searchMode: "hybrid" (default, keyword + semantic), "fulltext" (keyword only), "semantic" (meaning-based only).
- filter: "owned" | "shared_with_me" | "all" (default: "all")
- sortBy: "relevance" (default when searching) | "updatedAt" (default when listing) | "createdAt"
- sortOrder: "asc" | "desc" (default: "desc")
- limit: 1-100 (default 50 listing, 10 search)
- offset: pagination offset (default 0)
- distanceThreshold: max cosine distance for vector results (default 0.5; lower = stricter; semantic/hybrid only).
- updatedAfter: ISO-8601. Search path only (requires search): only docs with updatedAt strictly after this instant, filtered inside each engine before ranking (totals too). Not combinable with updatedSince.
- updatedSince: ISO-8601. Only documents whose last content edit is after this time. List path only (not combinable with search); filters on actual edits, unlike updatedAfter's updatedAt basis.

RETURNS:
- documents: Array of { id, title, url, role, updatedAt, ... }
  - When searching: includes snippet and score
  - When listing: includes createdAt, shareCount, clock (update counter) and
    lastModifiedAt (last content edit, null if never edited; not bumped by
    merely opening the doc - use with updatedSince for incremental sync).
- pagination: { total, limit, offset, hasMore }

EXAMPLES:
// List all documents
list_documents()

// Keyword-only search
list_documents({ search: "TODO refactor", searchMode: "fulltext" })

// Search only recently updated documents
list_documents({ search: "deploy", updatedAfter: "2026-07-01T00:00:00Z" })

// List owned documents, oldest first
list_documents({ filter: "owned", sortBy: "createdAt", sortOrder: "asc" })`;

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
    distanceThreshold: {
      type: 'number',
      minimum: 0.1,
      maximum: 1.5,
      description:
        'Max cosine distance for vector search results (0=identical, 1=orthogonal). ' +
        'Lower values return fewer, more relevant results. Default: 0.5. Only applies to semantic/hybrid search.',
    },
    updatedAfter: {
      type: 'string',
      description:
        'ISO-8601 timestamp. Search path only (requires "search"): admit only documents whose ' +
        'last-updated time (the updatedAt field on results, also bumped by opening a doc) is ' +
        'STRICTLY AFTER this instant — filtered inside each search engine before ranking, so ' +
        'rankings and totals reflect only recent documents. Distinct from updatedSince, which ' +
        'is list-path only and filters on last content edit. Not combinable with updatedSince.',
    },
    updatedSince: {
      type: 'string',
      description:
        'ISO-8601 timestamp (e.g. "2026-07-01T00:00:00Z"). Only return documents whose last '
        + 'content edit (yjs update log) is after this time — reflects actual edits, unlike '
        + 'updatedAt, which is also bumped when a document is opened. List path only: '
        + 'cannot be combined with search.',
    },
  },
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('list_documents tool not initialized');

  const userId = agentToken.userId;
  const baseUrl = agentToken.baseUrl || '';

  // Content search path: when a search query is provided
  if (args.search && args.search.trim()) {
    if (args.updatedSince) {
      throw new Error(
        'updatedSince is not supported together with search. Omit search to filter by '
        + 'last-edit time, or filter the search results client-side.'
      );
    }
    // Feature 017: validate updatedAfter before searching — an unparseable
    // value is a tool error, never a silently unfiltered result (CN-3).
    let updatedAfter;
    if (args.updatedAfter !== undefined) {
      updatedAfter = search.parseUpdatedAfter(args.updatedAfter, { hasContentSearch: true });
    }
    const { rows, pagination } = await search.searchDocuments(userId, args.search, {
      mode: args.searchMode,
      filter: args.filter,
      sortBy: args.sortBy || 'relevance',
      sortOrder: args.sortOrder,
      limit: args.limit,
      offset: args.offset,
      distanceThreshold: args.distanceThreshold,
      updatedAfter,
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

  // List path: no search query — updatedAfter is search-only (CN-3): reject
  // rather than silently ignore a filter the caller believes is applied.
  if (args.updatedAfter !== undefined) {
    throw new Error(
      'updatedAfter requires a content search: provide "search". To filter the '
      + 'list path by last content edit, use updatedSince.'
    );
  }

  const { rows, total } = await documents.getAccessibleDocuments(userId, {
    filter: args.filter,
    sortBy: args.sortBy || 'updatedAt',
    sortOrder: args.sortOrder,
    limit: args.limit || 50,
    offset: args.offset || 0,
    updatedSince: args.updatedSince,
  });

  return {
    documents: rows.map((row) => ({
      id: row.doc_id,
      title: row.title || null,
      url: `${baseUrl}/d/${row.doc_id}`,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      clock: row.last_clock == null ? null : Number(row.last_clock),
      lastModifiedAt: row.last_modified_at,
      shareCount: parseInt(row.share_count, 10),
    })),
    pagination: {
      total,
      limit: args.limit || 50,
      offset: args.offset || 0,
      hasMore: (args.offset || 0) + rows.length < total,
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
