/**
 * list_documents MCP Tool
 *
 * Lists all documents accessible to the authenticated agent/user.
 * Supports search, filtering, pagination, and sorting.
 */

// Persistence provider - set by init function
let persistenceProvider = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
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
  const pool = persistenceProvider.getPool();

  // Validate and sanitize inputs
  const validSortBy = ['title', 'updatedAt', 'createdAt'].includes(sortBy) ? sortBy : 'updatedAt';
  const validSortOrder = sortOrder === 'asc' ? 'ASC' : 'DESC';
  const validLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 50));
  const validOffset = Math.max(0, parseInt(offset, 10) || 0);

  // Map sortBy to SQL column names
  const sortColumnMap = {
    title: 'd.title',
    updatedAt: 'd.updated_at',
    createdAt: 'd.created_at',
  };
  const sortColumn = sortColumnMap[validSortBy];

  // Build the WHERE clause for role filter
  let roleCondition = '';
  if (filter === 'owned') {
    roleCondition = "AND ds.role = 'owner'";
  } else if (filter === 'shared_with_me') {
    roleCondition = "AND ds.role != 'owner'";
  }
  // 'all' has no additional condition

  // Build the query with search, filter, sort, and pagination
  const query = `
    SELECT
      d.id,
      d.title,
      d.created_at,
      d.updated_at,
      ds.role,
      (SELECT COUNT(*) FROM document_shares WHERE doc_id = d.id AND role != 'owner') as share_count,
      COUNT(*) OVER() as total_count
    FROM documents d
    JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $1
    WHERE ($2::text IS NULL OR d.title ILIKE '%' || $2 || '%')
    ${roleCondition}
    ORDER BY ${sortColumn} ${validSortOrder} NULLS LAST
    LIMIT $3 OFFSET $4
  `;

  const result = await pool.query(query, [userId, search, validLimit, validOffset]);

  // Extract total count from first row (or 0 if no results)
  const totalCount = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;

  // Map results to response format
  const documents = result.rows.map((row) => ({
    id: row.id,
    title: row.title || null,
    url: `${baseUrl}/d/${row.id}`,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shareCount: parseInt(row.share_count, 10),
  }));

  return {
    documents,
    pagination: {
      total: totalCount,
      limit: validLimit,
      offset: validOffset,
      hasMore: validOffset + documents.length < totalCount,
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
