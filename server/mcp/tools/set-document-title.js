/**
 * set_document_title MCP Tool
 *
 * Sets the title of a document by updating its metadata.
 */
const Y = require('yjs');
const documentService = require('../../document-service');
const documents = require('../../documents');

// Persistence provider - set by init function
let persistenceProvider = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
  // Access derivation now runs through the shared documents module (feature
  // 053), so it must be wired to the same pool — the list_documents tool has
  // done this since it was written.
  if (persistence && persistence.getPool) {
    documents.init(persistence.getPool());
  }
}

/**
 * Tool definition for MCP discovery
 */
const name = 'set_document_title';

const description = 'Update the title of a document. Changes the document title metadata and syncs to all users viewing the document.';

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

  // Check if user has edit access to the document.
  //
  // Feature 053: this used to be an inline document_shares join, which would
  // have made space members invisible to this one tool. Access derivation lives
  // in exactly one place now (documents.getRole → the document_access view).
  // The error strings are preserved byte-for-byte — agents are trained on them.
  const role = await documents.getRole(docGuid, userId);
  if (!role) {
    throw new Error('Document not found or you do not have access');
  }
  if (documents.ROLES[role] < documents.ROLES.editor) {
    throw new Error('You do not have edit permission for this document');
  }

  // Apply changes through the application layer (document service)
  // This ensures updates are broadcast to all connected WebSocket clients
  // and persisted to the database with proper user attribution
  // Two-phase (feature 049): the permission checks already ran above and stay
  // there, so nothing here can fail — the compute phase returns the closure.
  await documentService.updateDocument(
    docGuid,
    () => (ydoc) => {
      const meta = ydoc.getMap('meta');
      meta.set('title', title);
    },
    { userId, agentName: agentToken.agentName }
  );

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
