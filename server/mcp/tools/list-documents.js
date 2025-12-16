/**
 * list_documents MCP Tool
 *
 * Lists all documents accessible to the authenticated agent/user.
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

const description = 'List all documents accessible to the authenticated user';

const inputSchema = {
  type: 'object',
  properties: {
    filter: {
      type: 'string',
      enum: ['owned', 'shared_with_me', 'all'],
      default: 'all',
      description: 'Filter documents by ownership: "owned" for documents you own, "shared_with_me" for documents shared with you, "all" for both',
    },
  },
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.filter - Filter type ('owned', 'shared_with_me', 'all')
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { documents: Array }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('list_documents tool not initialized');

  const { filter = 'all' } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  let query;
  const params = [userId];

  if (filter === 'owned') {
    query = `
      SELECT
        d.id,
        d.created_at,
        d.updated_at,
        ds.role,
        (SELECT COUNT(*) FROM document_shares WHERE doc_id = d.id) as share_count
      FROM documents d
      JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $1
      WHERE ds.role = 'owner'
      ORDER BY d.updated_at DESC
    `;
  } else if (filter === 'shared_with_me') {
    query = `
      SELECT
        d.id,
        d.created_at,
        d.updated_at,
        ds.role,
        (SELECT COUNT(*) FROM document_shares WHERE doc_id = d.id) as share_count
      FROM documents d
      JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $1
      WHERE ds.role != 'owner'
      ORDER BY d.updated_at DESC
    `;
  } else {
    // 'all' - return all accessible documents
    query = `
      SELECT
        d.id,
        d.created_at,
        d.updated_at,
        ds.role,
        (SELECT COUNT(*) FROM document_shares WHERE doc_id = d.id) as share_count
      FROM documents d
      JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $1
      ORDER BY d.updated_at DESC
    `;
  }

  const result = await pool.query(query, params);

  // Get all documents with metadata (titles) from Yjs documents
  const allDocsWithMeta = await persistenceProvider.getAllDocumentsWithMeta();

  // Build a map of docId -> title
  const titleMap = new Map();
  for (const doc of allDocsWithMeta) {
    titleMap.set(doc.docGuid, doc.title);
  }

  const documents = result.rows.map((row) => ({
    id: row.id,
    title: titleMap.get(row.id) || null,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    shareCount: parseInt(row.share_count, 10),
  }));

  return { documents };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
