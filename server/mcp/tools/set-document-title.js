/**
 * set_document_title MCP Tool
 *
 * Sets the title of a document by updating its metadata.
 */
const Y = require('yjs');
const documentService = require('../../document-service');

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
const name = 'set_document_title';

const description = 'Set the title of a document';

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    title: {
      type: 'string',
      description: 'The new title for the document',
    },
  },
  required: ['docGuid', 'title'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.title - New document title
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { success, message, title }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('set_document_title tool not initialized');

  const { docGuid, title } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has edit access to the document
  const accessResult = await pool.query(
    `SELECT ds.role
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  const { role } = accessResult.rows[0];
  if (role !== 'owner' && role !== 'editor') {
    throw new Error('You do not have edit permission for this document');
  }

  // Apply changes through the application layer (document service)
  // This ensures updates are broadcast to all connected WebSocket clients
  // and persisted to the database with proper user attribution
  await documentService.updateDocument(
    docGuid,
    (ydoc) => {
      const meta = ydoc.getMap('meta');
      meta.set('title', title);
    },
    userId
  ); // Pass userId for attribution

  // Note: updated_at is now automatically updated by storeUpdate in postgres-persistence.js
  // This ensures unified behavior for both regular user updates and MCP tool updates

  return {
    success: true,
    message: `Document title set to "${title}"`,
    title,
    docGuid,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
