/**
 * list_documents MCP Tool
 *
 * Lists all documents accessible to the authenticated agent/user.
 * Supports search, filtering, pagination, and sorting.
 * Uses the shared documents.getAccessibleDocuments function.
 */

const documents = require('../../documents');

// Persistence provider - set by init function (needed for pool access in documents module)
let persistenceProvider = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
  // Ensure documents module is initialized with the pool
  if (persistence && persistence.getPool) {
    documents.init(persistence.getPool());
  }
}

/**
 * Tool definition for MCP discovery
 */
const name = 'list_documents';

const description = `List documents accessible to you with search, filtering, and pagination.

PARAMETERS:
- search: Search by title (case-insensitive partial match)
- filter: "owned" | "shared_with_me" | "all" (default: "all")
- sortBy: "title" | "updatedAt" | "createdAt" (default: "updatedAt")
- sortOrder: "asc" | "desc" (default: "desc")
- limit: 1-100 (default: 50)
- offset: pagination offset (default: 0)

RETURNS:
- documents: Array of { id, title, url, role, createdAt, updatedAt, shareCount }
- pagination: { total, limit, offset, hasMore }

EXAMPLES:
// List all documents
list_documents()

// Search by title
list_documents({ search: "project" })

// List owned documents, sorted by title
list_documents({ filter: "owned", sortBy: "title", sortOrder: "asc" })

// Paginate through results
list_documents({ limit: 10, offset: 0 })   // Page 1
list_documents({ limit: 10, offset: 10 })  // Page 2`;

const inputSchema = {
  type: 'object',
  properties: {
    search: {
      type: 'string',
      description: 'Search documents by title (case-insensitive partial match)',
    },
    filter: {
      type: 'string',
      enum: ['owned', 'shared_with_me', 'all'],
      default: 'all',
      description: 'Filter by ownership: "owned", "shared_with_me", or "all"',
    },
    sortBy: {
      type: 'string',
      enum: ['title', 'updatedAt', 'createdAt'],
      default: 'updatedAt',
      description: 'Field to sort by',
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

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {object} agentToken - Decoded agent JWT token (includes baseUrl)
 * @returns {Promise<object>} { documents: Array, pagination: object }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('list_documents tool not initialized');

  const {
    search = null,
    filter = 'all',
    sortBy = 'updatedAt',
    sortOrder = 'desc',
    limit = 50,
    offset = 0,
  } = args;

  const userId = agentToken.userId;
  const baseUrl = agentToken.baseUrl || '';

  // Use shared function from documents module
  const { rows, total } = await documents.getAccessibleDocuments(userId, {
    search,
    filter,
    sortBy,
    sortOrder,
    limit,
    offset,
  });

  // Validate limit for pagination response
  const validLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 50));
  const validOffset = Math.max(0, parseInt(offset, 10) || 0);

  // Map results to response format
  const documentList = rows.map((row) => ({
    id: row.doc_id,
    title: row.title || null,
    url: `${baseUrl}/d/${row.doc_id}`,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shareCount: parseInt(row.share_count, 10),
  }));

  return {
    documents: documentList,
    pagination: {
      total,
      limit: validLimit,
      offset: validOffset,
      hasMore: validOffset + documentList.length < total,
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
