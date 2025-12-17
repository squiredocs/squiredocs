/**
 * update_document MCP Tool
 *
 * Updates document content using structured node operations.
 */
const Y = require('yjs');
const documentService = require('../../document-service');
const { buildYjsNode } = require('../yjs/node-builder');
const { validateNode } = require('../yjs/validation');

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
const name = 'update_document';

const description = `Update document content using structured nodes.

Operations:
- replace: Replace entire document with new nodes
- append: Add nodes to end of document
- insert: Insert nodes at specific position (node index, not character position)
- delete: Remove nodes by position and count

Node types:
- paragraph: { type: "paragraph", content: "text" }
- heading: { type: "heading", level: 1-3, content: "text" }
- bulletList/orderedList: { type: "bulletList", children: [{ type: "listItem", content: "text" }] }
- codeBlock: { type: "codeBlock", language: "javascript", content: "code" }

Text formatting:
- Plain text: content: "plain text"
- With marks: content: [{ text: "bold", marks: ["bold"] }, " plain"]
- Available marks: "bold", "italic", "underline", "strike"
- Links: { text: "link text", marks: [{ type: "link", href: "url" }] }
- Multiple marks: marks: ["bold", "italic"]

Examples:
- Simple paragraph: { type: "paragraph", content: "Hello world" }
- Bold text: { type: "paragraph", content: [{ text: "Important", marks: ["bold"] }] }
- Mixed: { type: "paragraph", content: ["Normal ", { text: "bold", marks: ["bold"] }, " text"] }`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'Document UUID',
    },
    operation: {
      type: 'string',
      enum: ['replace', 'insert', 'delete', 'append'],
      description:
        'Operation: "replace" replaces all content, "insert" inserts at position, "delete" removes nodes, "append" adds to end',
    },
    nodes: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Array of structured nodes to insert/append/replace. Each node has type, optional content/children, and type-specific properties.',
    },
    position: {
      type: 'integer',
      minimum: 0,
      description: 'Node position (0-indexed) for insert/delete operations',
    },
    count: {
      type: 'integer',
      minimum: 1,
      description: 'Number of nodes to delete (required for delete operation)',
    },
  },
  required: ['docGuid', 'operation'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.operation - Operation type
 * @param {Array} args.nodes - Structured nodes
 * @param {number} args.position - Position for insert/delete
 * @param {number} args.count - Count for delete
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { success, message, docGuid }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('update_document tool not initialized');

  const { docGuid, operation, nodes, position, count } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Validate required parameters for each operation
  if (['replace', 'insert', 'append'].includes(operation)) {
    if (!nodes || !Array.isArray(nodes) || nodes.length === 0) {
      throw new Error(`nodes array required for ${operation} operation`);
    }
    // Validate each node
    nodes.forEach((node) => validateNode(node));
  }

  if (operation === 'insert' && position === undefined) {
    throw new Error('position required for insert operation');
  }

  if (operation === 'delete') {
    if (position === undefined) {
      throw new Error('position required for delete operation');
    }
    if (count === undefined) {
      throw new Error('count required for delete operation');
    }
  }

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
  let message;

  await documentService.updateDocument(
    docGuid,
    (ydoc) => {
      const xmlFragment = ydoc.get('default', Y.XmlFragment);

      switch (operation) {
        case 'replace': {
          // Clear entire document
          while (xmlFragment.length > 0) {
            xmlFragment.delete(0, 1);
          }

          // Insert new nodes
          const yjsNodes = nodes.map((node) => buildYjsNode(node));
          xmlFragment.insert(0, yjsNodes);

          message = `Replaced document with ${nodes.length} node${nodes.length !== 1 ? 's' : ''}`;
          break;
        }

        case 'append': {
          const yjsNodes = nodes.map((node) => buildYjsNode(node));
          xmlFragment.insert(xmlFragment.length, yjsNodes);

          message = `Appended ${nodes.length} node${nodes.length !== 1 ? 's' : ''} to document`;
          break;
        }

        case 'insert': {
          const insertPos = Math.min(position, xmlFragment.length);
          const yjsNodes = nodes.map((node) => buildYjsNode(node));
          xmlFragment.insert(insertPos, yjsNodes);

          message = `Inserted ${nodes.length} node${nodes.length !== 1 ? 's' : ''} at position ${insertPos}`;
          break;
        }

        case 'delete': {
          const actualCount = Math.min(count, xmlFragment.length - position);
          if (actualCount > 0) {
            xmlFragment.delete(position, actualCount);
            message = `Deleted ${actualCount} node${actualCount !== 1 ? 's' : ''} starting at position ${position}`;
          } else {
            message = `No nodes deleted (position ${position} out of range)`;
          }
          break;
        }

        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    },
    userId
  );

  // Update document timestamp
  await pool.query('UPDATE documents SET updated_at = now() WHERE id = $1', [docGuid]);

  return {
    success: true,
    message,
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
