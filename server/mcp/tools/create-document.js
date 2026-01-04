/**
 * create_document MCP Tool
 *
 * Creates a new document with a title.
 * Uses the same application logic as regular user document creation.
 * Content should be added separately via the modify tool.
 */
const Y = require('yjs');
const { randomUUID } = require('crypto');
const documentService = require('../../document-service');

// Persistence provider and documents module - set by init function
let persistenceProvider = null;
let documents = null;

/**
 * Initialize the tool with a persistence provider and documents module
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
  // Import documents module here to avoid circular dependencies
  documents = require('../../documents');
}

/**
 * Tool definition for MCP discovery
 */
const name = 'create_document';

const description = 'Create a new document with a title. Use the modify tool to add content after creation.';

const inputSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'The title for the new document',
    },
  },
  required: ['title'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.title - Document title
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { docGuid, title, message }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider || !documents) throw new Error('create_document tool not initialized');

  const { title } = args;
  const userId = agentToken.userId;

  // Generate UUID (same approach as client-side, but using Node.js crypto)
  const docGuid = randomUUID();

  const pool = persistenceProvider.getPool();

  // Create the document using the same application logic as regular users
  // This ensures consistent behavior: creates document record and sets owner role
  await documents.createDocument(docGuid, userId);

  // Update the title in the database
  await pool.query('UPDATE documents SET title = $1 WHERE id = $2', [title, docGuid]);

  // Also set the document title in Yjs metadata for consistency
  // This ensures it goes through the normal Yjs update flow and persistence
  await documentService.updateDocument(
    docGuid,
    (ydoc) => {
      const meta = ydoc.getMap('meta');
      meta.set('title', title);
    },
    userId
  );

  return {
    docGuid,
    title,
    message: `Created document "${title}"`,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
