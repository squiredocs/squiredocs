/**
 * create_document MCP Tool
 *
 * Creates a new document with optional initial content.
 * Uses the same application logic as regular user document creation.
 */
const Y = require('yjs');
const { randomUUID } = require('crypto');
const documentService = require('../../document-service');
const { buildYjsNode } = require('../yjs/node-builder');

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

const description = 'Create a new document with optional initial content';

const inputSchema = {
  type: 'object',
  properties: {
    content: {
      type: 'string',
      description: 'Optional initial text content for the document',
    },
  },
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.content - Optional initial content
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { docGuid, message }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider || !documents) throw new Error('create_document tool not initialized');

  const { content } = args;
  const userId = agentToken.userId;

  // Generate UUID (same approach as client-side, but using Node.js crypto)
  const docGuid = randomUUID();

  // Create the document using the same application logic as regular users
  // This ensures consistent behavior: creates document record and sets owner role
  await documents.createDocument(docGuid, userId);

  // If content was provided, add it using the same update path as regular edits
  // This ensures the content goes through the normal Yjs update flow and persistence
  if (content) {
    // Convert plain text content to structured nodes (paragraphs)
    // Split by newlines and create paragraph nodes, preserving empty lines as empty paragraphs
    const lines = content.split('\n');
    const nodes = lines.map(line => ({
      type: 'paragraph',
      content: line || '' // Empty lines become empty paragraphs
    }));

    // Use documentService.updateDocument to apply initial content
    // This ensures it goes through the same code path as regular updates:
    // - Broadcasts to WebSocket clients
    // - Persists via storeUpdate (which now updates updated_at automatically)
    // - Uses the same attribution and version history tracking
    await documentService.updateDocument(
      docGuid,
      (ydoc) => {
        const xmlFragment = ydoc.get('default', Y.XmlFragment);
        const yjsNodes = nodes.map((node) => buildYjsNode(node));
        xmlFragment.insert(0, yjsNodes);
      },
      userId
    );
  }

  return {
    docGuid,
    message: content
      ? `Created document with ${content.length} characters of initial content`
      : 'Created empty document',
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
