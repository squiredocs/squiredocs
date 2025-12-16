/**
 * get_document MCP Tool
 *
 * Reads document content and metadata.
 */
const Y = require('yjs');
const { toPlainText, toStructured, loadYDoc } = require('../yjs/serialization');

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
const name = 'get_document';

const description = 'Read document content and metadata';

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    format: {
      type: 'string',
      enum: ['plain-text', 'structured'],
      default: 'plain-text',
      description:
        'Output format: "plain-text" for readable text, "structured" for hierarchical JSON with node types',
    },
  },
  required: ['docGuid'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.format - Output format
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { docGuid, content, format, role, updatedAt }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('get_document tool not initialized');

  const { docGuid, format = 'plain-text' } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has access to the document
  const accessResult = await pool.query(
    `SELECT d.id, d.updated_at, ds.role
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  const { role, updated_at: updatedAt } = accessResult.rows[0];

  // Load the Yjs document
  const ydoc = await loadYDoc(pool, docGuid);
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Convert to requested format
  let content;
  if (format === 'structured') {
    content = toStructured(xmlFragment);
  } else {
    content = toPlainText(xmlFragment);
  }

  return {
    docGuid,
    content,
    format,
    role,
    updatedAt,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
